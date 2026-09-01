// Finner bakker å kjøre intervaller i: strekninger med jevn stigning i et
// valgt bånd, av OpenStreetMap-veinettet og Kartverkets terrengmodell.
//
// Søsterfil til finn-loype.js. Der er flathet målet; her er det motsatte — men
// kriteriet er *ikke* «bratteste bakke». En bratt bakke som slipper i et platå
// halvveis ødelegger settet: draget som er langt nok til å nå platået blir
// merkbart tyngre enn de andre, og settet er ikke lenger sammenlignbart.
// Derfor rangerer dette søket på **jevnhet først**: hvor stor del av
// strekningen som faktisk ligger i båndet, og hvor lang den verste flate
// biten er.
//
// Kjør:
//   node finn-bakke.js --sted "Tromsø" --stigning 6-10 --sekunder 90
//   node finn-bakke.js --lat 69.64960 --lon 18.95600 --sekunder 60 --km 1.5
//   node finn-bakke.js --sted "Tromsø" --meter 400 --lagre loype.json
//
// Flagg:
//   --stigning <a-b>  ønsket stigningsbånd i prosent, standard 6-12
//   --sekunder <n>    ønsket dragvarighet, standard 60 — regnes om til meter
//   --meter <n>       ønsket lengde direkte, overstyrer --sekunder
//   --km <n>          søkeradius i km, standard 2
//   --antall <n>      antall forslag, standard 5
//   --fast            bare fast dekke (standard: grus og sti tillatt — bakker
//                     er sjelden asfaltert, og din egen er komprimert grus)
//   --tunneler        ikke filtrer bort tunneler
//   --lagre <fil>     skriv beste bakke til fil som løype, bunn → topp
//   --navn <navn>     løypenavn i Garmin

import { writeFileSync } from 'node:fs';
import {
    hentVeinett, byggGraf, avstand, fortett, hoyder, geokode, HARDT_DEKKE,
} from './lib/kart.js';

const args = process.argv.slice(2);
const flagg = (navn, standard = null) => {
    const i = args.indexOf(`--${navn}`);
    return i >= 0 ? args[i + 1] : standard;
};
const harFlagg = (navn) => args.includes(`--${navn}`);

const [lav, hoy] = flagg('stigning', '6-12').split('-').map(Number);
const sekunder = Number(flagg('sekunder', '60'));
const radiusM = Number(flagg('km', '2')) * 1000;
const antallForslag = Number(flagg('antall', '5'));
const baraFast = harFlagg('fast');
const taTunneler = harFlagg('tunneler');
const lagreTil = flagg('lagre');

if (!(lav > 0) || !(hoy > lav)) {
    console.error('--stigning må være to prosenttall, laveste først, f.eks. 6-10');
    process.exit(1);
}

// Trinn 1 tynner veinettet til noder ca. så tett, trinn 2 måler de beste
// kandidatene på nytt så tett. 50 m holder til å se hvor det stiger; 25 m
// trengs for å se om det er jevnt.
const GROVT_STEG = 50;
const FINT_STEG = 25;
const HOYDETAK = 2500;

// --- hvor fort går det oppover ----------------------------------------------

// Minettis energikostnad for løping i motbakke, J/kg/m, med gradienten som
// brøk. Ved samme metabolske effekt går farten omvendt med kostnaden, så
// kostnad(0)/kostnad(i) sier hvor mye tregere en gitt bakke er enn flatmark.
const kostnad = (i) =>
    155.4 * i ** 5 - 30.4 * i ** 4 - 43.3 * i ** 3 + 46.3 * i ** 2 + 19.5 * i + 3.6;

// Kalibrert på én bakkeøkt: åtte 60-sekundersdrag på ~16,5 % dekket i snitt
// 152 meter langs veien, altså 2,53 m/s. Konstanten under er den
// flatmarksfarten som gir det tallet gjennom Minetti — den er «fart i et
// 60-sekundersdrag», ikke terskelfart. Varighetsleddet trekker den ned for
// lengre drag, omtrent som Riegel.
//
// JUSTER DENNE TIL DITT EGET NIVÅ. Den er kalibrert på én løper, én økt og ett
// bratthetsbånd, og påvirker bare hvor lang en bakke må være for å gi ønsket
// dragvarighet. Tidsanslagene er til å velge bakke med, ikke til å pace etter.
const FLATFART_60S = 5.45;
const fart = (i, sek) =>
    FLATFART_60S * (kostnad(0) / kostnad(i)) * (60 / Math.max(sek, 10)) ** 0.06;

/** Hvor mange sekunder en gitt bakke tar, løst ved å gjenta anslaget. */
function sekunderFor(meter, i) {
    let t = meter / fart(i, 60);
    for (let k = 0; k < 5; k++) t = meter / fart(i, t);
    return t;
}

// --- veinettet --------------------------------------------------------------

/**
 * Jevner ut nodeavstanden i veinettet: kryss og veiender beholdes alltid — uten
 * dem rakner grafen — formpunkter tettere enn `steg` droppes, og lange strekk
 * får innskutte punkter. Halverer antallet høydeoppslag i et tettbygd veinett
 * uten å miste en eneste forbindelse.
 */
function jevnUt({ noder, veier }, steg) {
    const antall = new Map();
    for (const v of veier) for (const n of v.noder) antall.set(n, (antall.get(n) ?? 0) + 1);

    const nyeNoder = new Map(noder);
    let nesteId = -1;

    const nyeVeier = veier.map((v) => {
        const ut = [];
        let sist = null;
        v.noder.forEach((n, i) => {
            const p = noder.get(n);
            const ma = antall.get(n) > 1 || i === 0 || i === v.noder.length - 1;
            if (sist == null) { ut.push(n); sist = p; return; }

            const d = avstand(sist, p);
            if (!ma && d < steg) return;               // for tett — la den ligge

            // Langt strekk mellom to punkter vi må beholde: skyt inn nye, så
            // ingen kant blir så lang at stigningen inni den blir usynlig.
            const deler = Math.floor(d / (steg * 1.5));
            for (let k = 1; k <= deler; k++) {
                const t = k / (deler + 1);
                const id = nesteId--;
                nyeNoder.set(id, {
                    lat: sist.lat + (p.lat - sist.lat) * t,
                    lon: sist.lon + (p.lon - sist.lon) * t,
                });
                ut.push(id);
            }
            ut.push(n);
            sist = p;
        });
        return { ...v, noder: ut };
    });

    return { noder: nyeNoder, veier: nyeVeier };
}

// --fast krever *kjent* fast dekke, så utagget vei faller ut der. Men i
// merkingen av forslagene holdes de to fra hverandre: mange veier mangler
// surface-tag i OSM uten å være grus, og «grus/sti» på en boliggate er en
// opplysning som er verre enn ingen.
const erLost = (vei) => !HARDT_DEKKE.has(vei.dekke);
const erKjentLost = (vei) => vei.dekke != null && !HARDT_DEKKE.has(vei.dekke);

/** Hva som skal stå om dekket bak veinavnene i et forslag. */
function dekkemerke(kanter) {
    if (kanter.some((k) => erKjentLost(k.vei))) return ' (grus/sti)';
    if (kanter.some((k) => k.vei.dekke == null)) return ' (dekke ikke tagget i OSM)';
    return '';
}

// --- klatresøk --------------------------------------------------------------

/**
 * Følger stigningen oppover fra én node til bakken tar slutt.
 *
 * Ved hvert veivalg velges fortsettelsen som holder den samlede stigningen
 * nærmest midt i båndet — bakker er stort sett lineære, men et kryss midt i
 * bakken skal ikke kunne velte søket ned en sidevei.
 *
 * Stoppkriteriet er det viktige: samlet stigning er treg og merker ikke at
 * bakken slapp for 100 meter siden, så det er *de siste 60 meterne* som
 * avgjør. Det er nettopp et platå midt i bakken denne regelen fanger.
 */
function klatreFra(graf, noder, z, start, maksMeter) {
    const kanter = [];
    let node = start, forrige = null, meter = 0, stigning = 0;

    while (meter < maksMeter) {
        const ut = (graf.get(node) ?? [])
            .filter((k) => k.til !== forrige && k.meter > 1 && z.get(k.til) != null)
            .map((k) => ({ ...k, dz: z.get(k.til) - z.get(node) }));
        if (!ut.length) break;

        // Nærmest midt i båndet vinner, regnet på strekningen som helhet.
        const bandMidt = (lav + hoy) / 200;
        const valg = ut.reduce((a, b) => {
            const kost = (k) => Math.abs((stigning + k.dz) / (meter + k.meter) - bandMidt);
            return kost(b) < kost(a) ? b : a;
        });

        if (valg.dz < -1) break;                       // reelt fall, ikke støy
        const nyMeter = meter + valg.meter;
        const nySnitt = (stigning + valg.dz) / nyMeter;
        if (nyMeter > 60 && (nySnitt < (lav / 100) * 0.7 || nySnitt > (hoy / 100) * 1.4)) break;

        kanter.push({ fra: node, til: valg.til, meter: valg.meter, dz: valg.dz, vei: valg.vei });
        forrige = node;
        node = valg.til;
        meter = nyMeter;
        stigning += valg.dz;

        // Har de siste 60 meterne flatet ut, er bakken slutt — uansett hva
        // snittet sier.
        if (meter > 100 && halestigning(kanter, 60) < (lav / 100) * 0.4) break;
    }
    return kanter;
}

/** Stigning som brøk over de siste `vindu` meterne av en kjede. */
function halestigning(kanter, vindu) {
    let m = 0, dz = 0;
    for (let i = kanter.length - 1; i >= 0 && m < vindu; i--) {
        m += kanter[i].meter;
        dz += kanter[i].dz;
    }
    return m > 0 ? dz / m : 0;
}

/** Samme, men de første `vindu` meterne. */
function hodestigning(kanter, vindu) {
    let m = 0, dz = 0;
    for (let i = 0; i < kanter.length && m < vindu; i++) {
        m += kanter[i].meter;
        dz += kanter[i].dz;
    }
    return m > 0 ? dz / m : 0;
}

/** Skreller flate biter av begge ender, så bakken begynner og slutter der den stiger. */
function trimFlate(kanter) {
    const terskel = (lav / 100) * 0.5;
    let a = 0, b = kanter.length;
    while (b - a > 1 && halestigning(kanter.slice(a, b), 60) < terskel) b--;
    while (b - a > 1 && hodestigning(kanter.slice(a, b), 60) < terskel) a++;
    return kanter.slice(a, b);
}

/**
 * Stigning i prosent gjennom en strekning, målt i et glidende vindu i stedet
 * for per kant. Terrengmodellen støyer med noen desimeter, og fordelt på en
 * 20 m kant blir det fort flere prosent — vinduet er det som gjør at tallene
 * lenger nede betyr noe. Både målingen og kurven under bruker denne, så de kan
 * ikke fortelle to forskjellige historier.
 */
function stigningsprofil(punkter, z, vindu = 40) {
    const etapper = [];
    let lengde = 0;
    for (let i = 1; i < punkter.length; i++) {
        const d = avstand(punkter[i - 1], punkter[i]);
        etapper.push({ d, dz: (z[i] ?? 0) - (z[i - 1] ?? 0), fra: lengde, til: lengde + d });
        lengde += d;
    }
    return etapper.map((e) => {
        const midt = (e.fra + e.til) / 2;
        let m = 0, dz = 0;
        for (const f of etapper) {
            if (f.til < midt - vindu / 2 || f.fra > midt + vindu / 2) continue;
            m += f.d; dz += f.dz;
        }
        return { ...e, grad: m > 0 ? (dz / m) * 100 : 0 };
    });
}

/**
 * Måler en kjede: lengde, stigning, og de to tallene rangeringen faktisk hviler
 * på — hvor stor del av lengden som ligger i båndet, og hvor lang den verste
 * sammenhengende flate biten er.
 */
function mal(punkter, z) {
    const etapper = stigningsprofil(punkter, z);
    const lengde = etapper.reduce((s, e) => s + e.d, 0);

    let iBand = 0, flate = 0, versteFlate = 0, opp = 0;
    for (const e of etapper) {
        if (e.dz > 0) opp += e.dz;
        if (e.grad >= lav && e.grad <= hoy) { iBand += e.d; flate = 0; }
        else if (e.grad < lav) { flate += e.d; versteFlate = Math.max(versteFlate, flate); }
        else flate = 0;
    }

    const total = (z[z.length - 1] ?? 0) - (z[0] ?? 0);
    return {
        lengde,
        stigning: total,
        opp,
        snitt: lengde > 0 ? (total / lengde) * 100 : 0,
        iBand: lengde > 0 ? iBand / lengde : 0,
        versteFlate,
    };
}

/**
 * Kostnaden en kandidat rangeres på. Lavere er bedre, og leddene er vektet
 * etter hva som faktisk ødelegger en bakkeøkt:
 *
 *   jevnhet     dobbelt så tungt som alt annet — en bakke som slipper midt i
 *               draget er verdiløs uansett hvor fin resten er
 *   verste flate et enkelt dødpunkt på 50 m koster like mye som å ligge 40 %
 *               for kort
 *   for kort    kvadratisk: 10 % for kort er til å leve med, 40 % for kort er
 *               en annen økt enn den du ba om, og skal tape mot en ujevn bakke
 *               som i det minste varer draget ut
 *   for lang    straffes nesten ikke — du stopper bare tidligere i bakken
 *   avstand     du må jogge dit, og tilbake, mellom hvert drag
 */
function kostnadFor(m, avstandTilStart, malMeter) {
    const forKort = Math.max(0, (malMeter - m.lengde) / malMeter);
    const forLang = Math.max(0, (m.lengde - malMeter) / malMeter);
    return (1 - m.iBand) * 2
        + (m.versteFlate / 50)
        + forKort ** 2 * 6
        + forLang * 0.15
        + (avstandTilStart / 1000) * 0.5;
}

/** Forkaster kandidater som deler mesteparten av traseen med en bedre. */
function ulike(kandidater, antall) {
    const valgt = [];
    for (const k of kandidater) {
        const overlapp = valgt.some((v) => {
            const felles = k.noder.filter((n) => v.noder.includes(n)).length;
            return felles / Math.min(k.noder.length, v.noder.length) > 0.4;
        });
        if (!overlapp) valgt.push(k);
        if (valgt.length >= antall) break;
    }
    return valgt;
}

// --- kjøring ----------------------------------------------------------------

let start;
const sted = flagg('sted');
if (sted) {
    start = await geokode(sted);
    console.log(`Sted: ${start.navn}`);
} else if (flagg('lat') && flagg('lon')) {
    start = { lat: Number(flagg('lat')), lon: Number(flagg('lon')) };
} else {
    console.error('Oppgi enten --sted "Navn" eller --lat <n> --lon <n>');
    process.exit(1);
}

// Ønsket lengde: enten oppgitt rett, eller regnet ut fra hvor langt et drag på
// så mange sekunder rekker i midten av stigningsbåndet.
const midtGrad = (lav + hoy) / 200;
const malMeter = flagg('meter')
    ? Number(flagg('meter'))
    : Math.round(fart(midtGrad, sekunder) * sekunder);

console.log(`Søker bakker på ${lav}–${hoy} % innen ${(radiusM / 1000).toFixed(1)} km `
    + `fra ${start.lat.toFixed(5)}, ${start.lon.toFixed(5)}`);
console.log(flagg('meter')
    ? `Ønsket lengde: ${malMeter} m`
    : `Ønsket lengde: ${malMeter} m — et ${sekunder} s drag på ${((lav + hoy) / 2).toFixed(0)} %`);
console.log(`Filter: ${baraFast ? 'bare fast dekke' : 'grus og sti tillatt'}, `
    + `${taTunneler ? 'tunneler tillatt' : 'ingen tunneler'}\n`);

const raatt = await hentVeinett({ ...start, radiusM, taTunneler });
const nett = jevnUt(
    { ...raatt, veier: baraFast ? raatt.veier.filter((v) => !erLost(v)) : raatt.veier },
    GROVT_STEG,
);
console.log(`OpenStreetMap: ${nett.veier.length} veier`);

const graf = byggGraf(nett);
const brukte = [...graf.keys()];
if (!brukte.length) { console.error('Fant ingen vei i nærheten.'); process.exit(1); }
if (brukte.length > HOYDETAK) {
    console.error(`${brukte.length} punkter å høydesjekke er for mye — kjør med lavere --km.`);
    process.exit(1);
}

console.log(`Henter høyder for ${brukte.length} punkter …`);
const grovZ = await hoyder(brukte.map((id) => nett.noder.get(id)));
const z = new Map(brukte.map((id, i) => [id, grovZ[i]]));

// Trinn 1: klatre oppover fra hver eneste node. Kjeder som starter midt i en
// bakke blir delmengder av kjeden fra bunnen, og lukes bort av ulike().
const maksMeter = Math.max(malMeter * 2.5, 600);
const kjeder = [];
for (const id of brukte) {
    if (z.get(id) == null) continue;
    const kanter = trimFlate(klatreFra(graf, nett.noder, z, id, maksMeter));
    const lengde = kanter.reduce((s, k) => s + k.meter, 0);
    if (lengde < malMeter * 0.5 || lengde < 80) continue;

    const noder = [kanter[0].fra, ...kanter.map((k) => k.til)];
    const punkter = noder.map((n) => nett.noder.get(n));
    const m = mal(punkter, noder.map((n) => z.get(n)));
    if (m.snitt < lav * 0.7) continue;

    kjeder.push({
        noder,
        veier: new Set(kanter.map((k) => k.vei.navn ?? k.vei.type)),
        dekke: dekkemerke(kanter),
        avstandTilStart: avstand(start, punkter[0]),
        kost: kostnadFor(m, avstand(start, punkter[0]), malMeter),
    });
}

if (!kjeder.length) {
    console.error(`Fant ingen sammenhengende stigning på ${lav}–${hoy} % her.`);
    console.error('Prøv et bredere --stigning, større --km, eller kortere --sekunder.');
    process.exit(1);
}

kjeder.sort((a, b) => a.kost - b.kost);
const kandidater = ulike(kjeder, antallForslag * 2);
console.log(`Fant ${kjeder.length} stigninger, måler de ${kandidater.length} mest ulike nøyaktig …`);

// Trinn 2: samme strekninger, men med punkt hver 25. meter — det er den
// oppløsningen som avgjør om stigningen er jevn eller bare ser jevn ut.
const resultater = [];
for (const k of kandidater) {
    const punkter = fortett(k.noder.map((n) => nett.noder.get(n)), FINT_STEG);
    const fintZ = await hoyder(punkter);
    const m = mal(punkter, fintZ);
    resultater.push({
        ...k, punkter, z: fintZ, ...m,
        kost: kostnadFor(m, k.avstandTilStart, malMeter),
    });
    process.stdout.write('.');
}
console.log('\n');

resultater.sort((a, b) => a.kost - b.kost);
const beste = ulike(resultater, antallForslag);

console.log(`Forslag, jevneste først:\n`);
beste.forEach((r, i) => {
    const bunn = r.punkter[0];
    const topp = r.punkter[r.punkter.length - 1];
    const sek = sekunderFor(r.lengde, r.snitt / 100);

    console.log(`${i + 1}. ${Math.round(r.lengde)} m à ${r.snitt.toFixed(1)} %  ·  `
        + `${r.stigning.toFixed(0)} hm  ·  ~${Math.round(sek)} s i draget`);
    console.log(`   jevnhet: ${(r.iBand * 100).toFixed(0)} % av lengden i båndet`
        + `  ·  verste flate ${Math.round(r.versteFlate)} m`);
    console.log(`   ${[...r.veier].filter(Boolean).slice(0, 3).join(' → ')}${r.dekke}`
        + `  ·  ${Math.round(r.avstandTilStart)} m fra start`);
    console.log(`   bunn ${bunn.lat.toFixed(5)}, ${bunn.lon.toFixed(5)}`
        + `  →  topp ${topp.lat.toFixed(5)}, ${topp.lon.toFixed(5)}`);
    console.log(`   kart: https://www.openstreetmap.org/directions?engine=fossgis_osrm_foot`
        + `&route=${bunn.lat.toFixed(5)}%2C${bunn.lon.toFixed(5)}`
        + `%3B${topp.lat.toFixed(5)}%2C${topp.lon.toFixed(5)}`);
    console.log(`   ${sparkline(r)}`);
    console.log();
});

/**
 * Etappene som hører til bolk `b` av `antall`, plassert etter midtpunktet sitt.
 * En etappe som krysser en bolkegrense må havne i én av dem og bare én — teller
 * den i begge, summerer høydemeterne i tabellen seg til mer enn bakken stiger.
 */
function iBolk(etapper, lengde, b, antall) {
    const fra = (b * lengde) / antall, til = ((b + 1) * lengde) / antall;
    return etapper.filter((e) => {
        const midt = (e.fra + e.til) / 2;
        return midt >= fra && (midt < til || b === antall - 1);
    });
}

/**
 * Stigningen gjennom bakken som ett strekk med blokktegn, bunn til topp.
 * Samme glidende vindu som målingen, så en tom rute her *er* et dødpunkt som
 * teller mot «verste flate», ikke bare støy i terrengmodellen.
 */
function sparkline(r) {
    const TEGN = ' ▁▂▃▄▅▆▇█';
    const BOTTER = 28;
    const etapper = stigningsprofil(r.punkter, r.z);
    const lengde = etapper.reduce((s, e) => s + e.d, 0);

    const ut = [];
    for (let b = 0; b < BOTTER; b++) {
        // Her snittes en stigning, ikke summeres høydemeter, så etapper som
        // krysser en rutegrense skal telle i begge — motsatt av iBolk(). Deler
        // man dem i stedet, blir ruter uten noe midtpunkt i seg stående tomme.
        const fra = (b * lengde) / BOTTER, til = ((b + 1) * lengde) / BOTTER;
        const i = etapper.filter((e) => e.til > fra && e.fra < til);
        const g = i.length ? i.reduce((s, e) => s + e.grad, 0) / i.length : 0;
        // Skalert så båndets øvre grense er full høyde.
        const n = Math.round((Math.max(0, g) / hoy) * (TEGN.length - 1));
        ut.push(TEGN[Math.min(TEGN.length - 1, n)]);
    }
    return `${ut.join('')}  (tom rute = under ${(hoy / (TEGN.length - 1)).toFixed(1)} %, full = ${hoy} %+)`;
}

/** Stigning per 50. meter for beste forslag — det er her en bakke avslører seg. */
function profiltabell(r) {
    const etapper = stigningsprofil(r.punkter, r.z);
    const lengde = etapper.reduce((s, e) => s + e.d, 0);
    const bolker = Math.max(1, Math.round(lengde / 50));
    const rader = [];
    for (let b = 0; b < bolker; b++) {
        const fra = (b * lengde) / bolker, til = ((b + 1) * lengde) / bolker;
        const i = iBolk(etapper, lengde, b, bolker);
        const m = i.reduce((s, e) => s + e.d, 0);
        const dz = i.reduce((s, e) => s + e.dz, 0);
        const g = m > 0 ? (dz / m) * 100 : 0;
        const merk = g < lav ? '  ← under båndet' : g > hoy ? '  ← over båndet' : '';
        rader.push(`  ${Math.round(fra).toString().padStart(4)}–${Math.round(til).toString().padEnd(4)} m: `
            + `${g >= 0 ? '+' : ''}${dz.toFixed(1)} m  ${g.toFixed(1)} %  `
            + `${'█'.repeat(Math.max(1, Math.round(Math.max(0, g))))}${merk}`);
    }
    return rader.join('\n');
}

console.log(`Profil for forslag 1, bunn til topp:\n`);
console.log(profiltabell(beste[0]));
console.log();

if (!lagreTil) {
    console.log('Legg til --lagre loype.json for å skrive beste bakke som løype (bunn → topp),');
    console.log('som GitHub Actions laster opp til Garmin Connect når fila pushes.');
    process.exit(0);
}

// --- beste bakke som løypedata ----------------------------------------------

const b = beste[0];
let kumulativ = 0;
const geoPoints = b.punkter.map((p, i) => {
    if (i > 0) kumulativ += avstand(b.punkter[i - 1], p);
    return {
        latitude: Number(p.lat.toFixed(6)),
        longitude: Number(p.lon.toFixed(6)),
        elevation: Number((b.z[i] ?? 0).toFixed(1)),
        distance: Math.round(kumulativ),
    };
});

const loype = {
    navn: flagg('navn', `Bakke ${Math.round(b.lengde)} m à ${b.snitt.toFixed(0)} %`),
    beskrivelse: `Fra ${sted ?? `${start.lat.toFixed(5)}, ${start.lon.toFixed(5)}`}. `
        + `${Math.round(b.lengde)} m, ${b.stigning.toFixed(0)} høydemeter, snitt ${b.snitt.toFixed(1)} %. `
        + `${(b.iBand * 100).toFixed(0)} % av lengden i ${lav}–${hoy} %-båndet. `
        + `Veier: ${[...b.veier].filter(Boolean).slice(0, 3).join(' → ')}.`,
    meter: Math.round(kumulativ),
    stigningMeter: Math.round(b.opp),
    fallMeter: 0,
    geoPoints,
};

writeFileSync(lagreTil, `${JSON.stringify(loype, null, 1)}\n`);
console.log(`Skrev ${lagreTil}: «${loype.navn}», ${geoPoints.length} punkter.`);
console.log('Commit og push fila, så laster GitHub Actions den opp til Garmin Connect.');
