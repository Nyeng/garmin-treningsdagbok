// Kartdata for løypesøk: veinettet fra OpenStreetMap og høyder fra Kartverket.
//
// Ingen API-nøkler kreves for noen av delene. Begge er gratis fellestjenester,
// så kallene her er bevisst nøkterne: én Overpass-spørring per søk, og
// høydeoppslag med tak på seks samtidige forespørsler pluss disk-cache.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, 'data', 'kart-cache.json');

// Overpass er en gratis fellestjeneste med varierende kapasitet: den svarer
// 429/504 når den er travel, og 406 uten User-Agent. Derfor speil og retry.
const OVERPASS_SPEIL = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
];
const HOYDE = 'https://ws.geonorge.no/hoydedata/v1/punkt';
// Reservevei når alle Overpass-speilene er nede: OpenStreetMaps eget API.
// Det kan ikke filtrere på highway og returnerer alt innenfor en boks — også
// bygninger og adressepunkter — så det er tyngre og brukes bare som fallback.
const OSM_API = 'https://api.openstreetmap.org/api/0.6/map';
const UA = 'treningsdagbok/1.0 (privat løpedagbok)';

// --- cache ------------------------------------------------------------------

// Både veinett og høyder havner her. Fila er ren mellomlagring og ligger i
// .gitignore — slettes den, hentes alt på nytt.
let cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};
function lagreCache() {
    mkdirSync(dirname(CACHE), { recursive: true });
    writeFileSync(CACHE, JSON.stringify(cache));
}

// --- geometri ---------------------------------------------------------------

const R = 6_371_000;
const rad = (d) => (d * Math.PI) / 180;

/** Avstand i meter mellom to punkter { lat, lon }. */
export function avstand(a, b) {
    const dLat = rad(b.lat - a.lat);
    const dLon = rad(b.lon - a.lon);
    const s =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
}

/** Kompasskurs i grader fra a til b — brukes til å straffe svinger. */
export function kurs(a, b) {
    const dLon = rad(b.lon - a.lon);
    const y = Math.sin(dLon) * Math.cos(rad(b.lat));
    const x =
        Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
        Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(dLon);
    return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}

/** Minste vinkelforskjell mellom to kurser, 0–180 grader. */
export function kursdiff(a, b) {
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
}

/** Setter inn mellompunkter så ingen etappe er lengre enn maks meter. */
export function fortett(punkter, maks = 100) {
    const ut = [];
    for (let i = 0; i < punkter.length - 1; i++) {
        const a = punkter[i], b = punkter[i + 1];
        const n = Math.max(1, Math.ceil(avstand(a, b) / maks));
        for (let k = 0; k < n; k++) {
            ut.push({ lat: a.lat + ((b.lat - a.lat) * k) / n, lon: a.lon + ((b.lon - a.lon) * k) / n });
        }
    }
    ut.push(punkter[punkter.length - 1]);
    return ut;
}

// --- OpenStreetMap ----------------------------------------------------------

// Veityper som er uaktuelle å løpe på. Motorvei og motortrafikkvei er forbudt,
// resten er enten trapper, heiser eller ting som ikke finnes ennå.
const UTELUKK = new Set([
    'motorway', 'motorway_link', 'trunk', 'trunk_link',
    'steps', 'elevator', 'construction', 'proposed', 'raceway', 'busway',
]);

/** Dekker som er faste nok til fartsarbeid. Alt annet er grus, sti eller ukjent. */
export const HARDT_DEKKE = new Set([
    'asphalt', 'paved', 'concrete', 'paving_stones', 'chipseal',
]);

/** Slår opp et stedsnavn i Nominatim og gir koordinatene. */
export async function geokode(sted) {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(sted)}`;
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`Nominatim svarte ${res.status}`);
    const treff = await res.json();
    if (!treff.length) throw new Error(`Fant ikke stedet «${sted}»`);
    return { lat: Number(treff[0].lat), lon: Number(treff[0].lon), navn: treff[0].display_name };
}

/**
 * Spør Overpass, med retry og bytte av speil når et av dem er nede.
 * Svaret caches på disk: tjenesten er gratis og blir fort sur av gjentatte
 * tunge spørringer, og veinettet i et område endrer seg ikke fra time til time.
 */
async function overpass(q) {
    const id = `osm:${[...q].reduce((h, c) => (h * 33 + c.charCodeAt(0)) >>> 0, 5381).toString(36)}`;
    if (cache[id]) return cache[id];

    let sist;
    for (let forsok = 0; forsok < OVERPASS_SPEIL.length * 2; forsok++) {
        const url = OVERPASS_SPEIL[forsok % OVERPASS_SPEIL.length];
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
                body: new URLSearchParams({ data: q }),
            });
            if (!res.ok) throw new Error(`${new URL(url).host} svarte ${res.status}`);
            const data = await res.json();
            cache[id] = data;
            lagreCache();
            return data;
        } catch (err) {
            sist = err;
            console.warn(`  advarsel: ${err.message} — prøver neste speil`);
            await new Promise((r) => setTimeout(r, 1500 * (1 + Math.floor(forsok / OVERPASS_SPEIL.length))));
        }
    }
    throw new Error(`Overpass utilgjengelig: ${sist.message}`);
}

/** Avkoder de fem XML-entitetene OSM faktisk bruker i attributtverdier. */
function avXml(t) {
    return t.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, e) =>
        ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" })[e]);
}

/**
 * Leser OSM-XML til samme elementform som Overpass gir i JSON, slik at resten
 * av fila ikke trenger å vite hvor dataene kom fra.
 *
 * Regex og ikke en XML-parser: OSM-XML er maskingenerert og flatt — noder og
 * veier på ett nivå, ingen namespaces, ingen CDATA — og en avhengighet til for
 * en reservevei som sjelden brukes er dyrere enn de tolv linjene her.
 */
function lesOsmXml(xml) {
    const elements = [];
    // Åpningstaggen holder for noder; vi trenger bare id og posisjon, ikke
    // taggene deres. Mønsteret treffer både <node .../> og <node ...>…</node>.
    for (const m of xml.matchAll(/<node\s([^>]*?)\/?>/g)) {
        const a = m[1];
        const id = a.match(/\bid="(\d+)"/)?.[1];
        const lat = a.match(/\blat="(-?[\d.]+)"/)?.[1];
        const lon = a.match(/\blon="(-?[\d.]+)"/)?.[1];
        if (id && lat && lon) elements.push({ type: 'node', id: Number(id), lat: Number(lat), lon: Number(lon) });
    }
    for (const m of xml.matchAll(/<way\s([^>]*?)>([\s\S]*?)<\/way>/g)) {
        const id = m[1].match(/\bid="(\d+)"/)?.[1];
        if (!id) continue;
        const nodes = [...m[2].matchAll(/<nd ref="(\d+)"/g)].map((n) => Number(n[1]));
        const tags = {};
        for (const t of m[2].matchAll(/<tag k="([^"]*)" v="([^"]*)"/g)) tags[avXml(t[1])] = avXml(t[2]);
        elements.push({ type: 'way', id: Number(id), nodes, tags });
    }
    return elements;
}

/**
 * Henter én boks fra OSM-API-et, og deler den i fire hvis den sprenger
 * nodetaket. Taket er 50 000 noder per forespørsel, og hvor stort areal det
 * tilsvarer avhenger helt av hvor tett bebygd området er — derfor deles det
 * etter svaret i stedet for å gjettes på forhånd.
 */
async function osmBoks(sor, vest, nord, ost, dybde = 0) {
    const res = await fetch(`${OSM_API}?bbox=${vest},${sor},${ost},${nord}`, { headers: { 'User-Agent': UA } });
    if (res.status === 400 && dybde < 6) {
        const tekst = await res.text();
        if (!/too many nodes/i.test(tekst)) throw new Error(`OSM-API svarte 400: ${tekst.slice(0, 120)}`);
        const mLat = (sor + nord) / 2, mLon = (vest + ost) / 2;
        const deler = [
            [sor, vest, mLat, mLon], [sor, mLon, mLat, ost],
            [mLat, vest, nord, mLon], [mLat, mLon, nord, ost],
        ];
        const ut = [];
        for (const d of deler) ut.push(...await osmBoks(d[0], d[1], d[2], d[3], dybde + 1));
        return ut;
    }
    if (!res.ok) throw new Error(`OSM-API svarte ${res.status}`);
    return lesOsmXml(await res.text());
}

/**
 * Reservevei for veinettet når Overpass er utilgjengelig — som i skyøkter,
 * der alle speilene ble målt blokkert 30.08.2026.
 *
 * Resultatet er ikke identisk med Overpass-spørringen: den henter en sirkel,
 * denne en boks, så grafen blir litt større i hjørnene. For et løypesøk spiller
 * det ingen rolle — søket rangerer på profil og svinger, ikke på hvor mange
 * veier det hadde å velge mellom.
 */
async function osmApiElementer({ lat, lon, radiusM }) {
    const dLat = radiusM / 111_320;
    const dLon = radiusM / (111_320 * Math.cos(lat * Math.PI / 180));
    const elements = await osmBoks(lat - dLat, lon - dLon, lat + dLat, lon + dLon);
    // Boksene overlapper ikke, men en vei som krysser en boksgrense kommer med
    // fra begge sider. Duplikater ville gitt doble kanter i grafen.
    const sett = new Set();
    return elements.filter((e) => {
        const n = `${e.type}${e.id}`;
        if (sett.has(n)) return false;
        sett.add(n);
        return true;
    });
}

/**
 * Henter veinettet rundt et punkt fra Overpass.
 * Tunneler filtreres bort her — de er hovedgrunnen til at denne fila finnes.
 */
export async function hentVeinett({ lat, lon, radiusM, taTunneler = false }) {
    const q = `[out:json][timeout:60];
        way(around:${Math.round(radiusM)},${lat},${lon})[highway];
        (._;>;);
        out body;`;

    let elements;
    try {
        ({ elements } = await overpass(q));
    } catch (err) {
        console.warn(`  ${err.message} — faller tilbake på OpenStreetMaps eget API`);
        elements = await osmApiElementer({ lat, lon, radiusM });
    }

    const noder = new Map();
    for (const e of elements) if (e.type === 'node') noder.set(e.id, { lat: e.lat, lon: e.lon });

    const veier = [];
    for (const e of elements) {
        if (e.type !== 'way' || !e.tags?.highway) continue;
        if (UTELUKK.has(e.tags.highway)) continue;
        if (!taTunneler && e.tags.tunnel && e.tags.tunnel !== 'no') continue;
        if (e.tags.access === 'private' || e.tags.foot === 'no') continue;
        veier.push({
            id: e.id,
            noder: e.nodes.filter((n) => noder.has(n)),
            navn: e.tags.name ?? e.tags.ref ?? null,
            ref: e.tags.ref ?? null,
            type: e.tags.highway,
            dekke: e.tags.surface ?? null,
            tunnel: Boolean(e.tags.tunnel && e.tags.tunnel !== 'no'),
        });
    }
    return { noder, veier };
}

/**
 * Bygger en nabolisteskrevet graf av veinettet. Hver kant kjenner veien den
 * kom fra, så et søk kan foretrekke å bli på samme vei.
 */
export function byggGraf({ noder, veier }) {
    const graf = new Map();
    const kant = (a, b, vei) => {
        if (!graf.has(a)) graf.set(a, []);
        graf.get(a).push({ til: b, meter: avstand(noder.get(a), noder.get(b)), vei });
    };
    for (const vei of veier) {
        for (let i = 0; i < vei.noder.length - 1; i++) {
            const a = vei.noder[i], b = vei.noder[i + 1];
            kant(a, b, vei);
            kant(b, a, vei);
        }
    }
    return graf;
}

/** Nærmeste graf-node til et punkt. */
export function naermesteNode(noder, graf, punkt) {
    let best = null, bestD = Infinity;
    for (const id of graf.keys()) {
        const d = avstand(noder.get(id), punkt);
        if (d < bestD) { bestD = d; best = id; }
    }
    return { id: best, meter: bestD };
}

// --- høyder -----------------------------------------------------------------

const nokkel = (p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;

async function hentEnHoyde(p) {
    const url = `${HOYDE}?ost=${p.lon}&nord=${p.lat}&koordsys=4258`;
    for (let forsok = 0; forsok < 3; forsok++) {
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`status ${res.status}`);
            const { punkter } = await res.json();
            return punkter?.[0]?.z ?? null;
        } catch (err) {
            if (forsok === 2) {
                console.warn(`  advarsel: høyde feilet for ${nokkel(p)} (${err.message})`);
                return null;
            }
            await new Promise((r) => setTimeout(r, 400 * 2 ** forsok));
        }
    }
}

/**
 * Høyde i meter for en liste punkter, fra Kartverkets terrengmodell (DTM1 der
 * den finnes — 1 meters oppløsning, langt bedre enn de globale datasettene).
 * Resultatene caches på disk, så gjentatte søk i samme område er gratis.
 */
export async function hoyder(punkter, { samtidige = 6 } = {}) {
    const mangler = punkter.filter((p) => cache[nokkel(p)] === undefined);
    for (let i = 0; i < mangler.length; i += samtidige) {
        const bolk = mangler.slice(i, i + samtidige);
        const z = await Promise.all(bolk.map(hentEnHoyde));
        bolk.forEach((p, k) => { cache[nokkel(p)] = z[k]; });
    }
    if (mangler.length) lagreCache();
    return punkter.map((p) => cache[nokkel(p)]);
}

/** Stigning, fall og bratteste parti for en høydeprofil. */
export function profil(punkter, z) {
    let opp = 0, ned = 0, maksStigning = 0, lengde = 0;
    for (let i = 1; i < punkter.length; i++) {
        const d = avstand(punkter[i - 1], punkter[i]);
        lengde += d;
        if (z[i] == null || z[i - 1] == null) continue;
        const dz = z[i] - z[i - 1];
        if (dz > 0) opp += dz; else ned -= dz;
        if (d > 5) maksStigning = Math.max(maksStigning, Math.abs((dz / d) * 100));
    }
    return { lengde, opp, ned, maksStigning };
}
