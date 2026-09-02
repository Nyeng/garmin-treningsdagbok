// Bygger dashboard.html — et selvstendig, statisk dashboard over framgang mot
// løpene, generert fra data/summary.json + config.json. Kjøres av sync-workflowen
// etter hver synk (og kan kjøres lokalt: node build-dashboard.js).
//
// Bevisst IKKE publisert på GitHub Pages: Pages-sider er alltid offentlige på
// Free/Pro-plan (tilgangsstyring finnes kun på Enterprise), og dette er helsedata.
// Åpne fila lokalt, eller be Claude vise den.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT, DATA } from './lib/paths.js';

const summary = JSON.parse(readFileSync(join(DATA, 'summary.json'), 'utf8'));
const cfg = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));
const planPath = join(DATA, 'plan.json');
const plan = existsSync(planPath) ? JSON.parse(readFileSync(planPath, 'utf8')) : null;
// Sykdoms-/skadeperioder — hører hjemme i data-repoet (privat), samme grunn
// som plan.json: hvilke uker du var syk er helseinformasjon.
const markersPath = join(DATA, 'markers.json');
const markers = existsSync(markersPath) ? JSON.parse(readFileSync(markersPath, 'utf8')) : { illness: [] };

// --- hjelpere ---------------------------------------------------------------

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const fmtRaceTime = (sec) => {
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.round(sec % 60);
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};
// timer:minutt — for akseetiketter der h:mm:ss blir for bredt
const fmtHm = (sec) => `${Math.floor(sec / 3600)}:${String(Math.round((sec % 3600) / 60)).padStart(2, '0')}`;
const fmtPace = (secPerKm) => {
    const m = Math.floor(Math.round(secPerKm) / 60), s = Math.round(secPerKm) % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
};
const fmtDur = (sec) => {
    const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    return h ? `${h}t ${String(m).padStart(2, '0')}m` : `${m} min`;
};
const shortDate = (iso) => `${Number(iso.slice(8, 10))}.${Number(iso.slice(5, 7))}`;
// Full dato på norsk form (dag.måned.år). Datoene lagres som ISO fordi det er
// formatet som sorterer og sammenlignes riktig — men ingenting som vises fram
// skal stå på ISO-form.
const fullDate = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
const fullTimestamp = (iso) => `${fullDate(iso.slice(0, 10))} ${iso.slice(11, 16)}`;

// ISO-ukenummer (samme som stats.js)
function weekKey(dateStr) {
    const d = new Date(dateStr);
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
    const week = Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7);
    return `${t.getUTCFullYear()}-U${String(week).padStart(2, '0')}`;
}

// Periodene i range-picker'en over grafene. `days: 0` betyr "alt". Delt
// mellom Node (tegner knappene) og klientskriptet (filtrerer punktene) —
// selve tallene lever bare her.
const RANGES = [
    { days: 1, label: 'Siste dag' },
    { days: 7, label: '7 dager' },
    { days: 30, label: '30 dager' },
    { days: 90, label: '3 måneder' },
    { days: 182, label: '6 måneder' },
    { days: 365, label: '1 år' },
    { days: 0, label: 'Alt' }
];
const DEFAULT_RANGE_DAYS = 90;

// --- datapreparering --------------------------------------------------------

const days = summary.days;
const today = new Date().toISOString().slice(0, 10);
const st = summary.status ?? {};

// ukentlig løpsvolum, siste 16 uker
const byWeek = new Map();
for (const d of days) {
    for (const r of d.runs ?? []) {
        const k = weekKey(d.date);
        if (!byWeek.has(k)) byWeek.set(k, { km: 0, n: 0, time: 0 });
        const w = byWeek.get(k);
        w.km += r.km ?? 0;
        w.n += 1;
        w.time += r.time_s ?? 0;
    }
}
// sammenhengende akse: hver ISO-uke fra første dag i datasettet til i dag,
// også uker uten løp (0 km). Full historikk i stedet for en fast 16-ukers
// grense, så "1 år"/"Alt" i range-picker'en har noe å vise — klientfilteret
// avgjør hvor mye av dette som faktisk tegnes.
const weekOrder = [];
const weekDateOf = new Map();
const firstDay = days[0]?.date ?? today;
for (let d = new Date(`${firstDay}T12:00:00`); d <= new Date(`${today}T12:00:00`); d.setDate(d.getDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    const k = weekKey(iso);
    if (!weekDateOf.has(k)) { weekDateOf.set(k, iso); weekOrder.push(k); }
}

// Hvilke ISO-uker en sykdomsperiode overlapper, så volumfallet får en synlig
// forklaring i grafen i stedet for å se ut som et uforklart dropp i formen.
const sickWeekKeys = new Set();
for (const period of markers.illness ?? []) {
    for (let d = new Date(`${period.start}T12:00:00`); d <= new Date(`${period.end}T12:00:00`); d.setDate(d.getDate() + 1)) {
        sickWeekKeys.add(weekKey(d.toISOString().slice(0, 10)));
    }
}

const weekly = weekOrder.map((k) => {
    const w = byWeek.get(k) ?? { km: 0, n: 0, time: 0 };
    const sick = sickWeekKeys.has(k);
    return {
        date: weekDateOf.get(k), label: k.slice(5), value: w.km, cls: sick ? 'bar bar-sick' : 'bar',
        tip: `${k} · ${w.km.toFixed(1)} km · ${w.n} økter · ${fmtDur(w.time)}${sick ? ' · sykdom' : ''}`
    };
});

// Full historikk her, ikke et fast antall dager — range-picker'en i
// nettleseren avgjør hvor mye som faktisk vises (se filterableChart).
const seriesOf = (field) =>
    days.filter((d) => d[field] != null).map((d) => ({ date: d.date, value: d[field] }));

const rhrSeries = seriesOf('rhr').map((p) => ({ ...p, tip: `${shortDate(p.date)} · hvilepuls ${p.value}` }));
const sykdomsBands = (markers.illness ?? []).map((m) => ({ from: m.start, to: m.end, label: m.label }));
// Søylefarge etter søvn-score (kvalitet), ikke stadium-fordeling — det som
// faktisk svarer på "hvor bra sov jeg", uten å måtte tolke tre stablede lag.
// Grensene følger Garmins egne score-band (poor/fair/good/excellent).
function søvnKlasse(score) {
    if (score == null) return 'bar';
    if (score >= 90) return 'bar sleep-excellent';
    if (score >= 80) return 'bar sleep-good';
    if (score >= 60) return 'bar sleep-fair';
    return 'bar sleep-poor';
}
const sleepSeries = days.filter((d) => d.sleep_h != null).map((d) => {
    const scoreTxt = d.sleep_score ? ` · score ${d.sleep_score}` : ' · ingen score';
    return {
        date: d.date, label: shortDate(d.date), value: d.sleep_h, cls: søvnKlasse(d.sleep_score),
        tip: `${shortDate(d.date)} · ${d.sleep_h.toFixed(1)} t søvn${scoreTxt}`
    };
});
// HRV og treningsklarhet er UTELATT med vilje: klokka rapporterer aldri disse
// feltene (0 av 366 dager har verdi, bekreftet empirisk) — grafer for dem
// ville bare vist "ikke nok data" for alltid, ikke en reell mangel på historikk.

// formhistorikk (data/history.json) — punktene kommer når Garmin oppdaterer
// dem, ikke hver dag, så disse to tegnes på tidsakse
const history = summary.history ?? [];
const thresholdSeries = history.filter((h) => h.threshold_pace_s).map((h) => ({
    date: h.date,
    value: h.threshold_pace_s,
    tip: `${shortDate(h.date)} · terskel ${fmtPace(h.threshold_pace_s)}/km${h.threshold_hr ? ` @ ${h.threshold_hr} slag/min` : ''}`
}));
// Garmin gir fire løpsprediksjoner, og alle fire ligger i history.json med ett
// punkt per dato. Hvilke som VISES styres av PREDIKSJONER under — de fire er
// samme graf med ulike tall, så de bygges av samme kode i stedet for å
// kopieres.
const DISTANSER = {
    // `tittel` står for hånd fordi norsk setter sammen ord uten bindestrek,
    // mens et tall foran krever den: «5 km-prediksjon», «maratonprediksjon».
    k5: { navn: '5 km', tittel: '5 km-prediksjon', km: 5, felt: 'pred_k5_s', tickSteps: [5, 10, 15, 30, 60] },
    k10: { navn: '10 km', tittel: '10 km-prediksjon', km: 10, felt: 'pred_k10_s', tickSteps: [10, 15, 30, 60, 120] },
    half: { navn: 'halvmaraton', tittel: 'halvmaratonprediksjon', km: 21.0975, felt: 'pred_half_s', tickSteps: [30, 60, 120, 300] },
    marathon: { navn: 'maraton', tittel: 'maratonprediksjon', km: 42.195, felt: 'pred_marathon_s', tickSteps: [60, 120, 300, 600] }
};

// Rekkefølgen her er rekkefølgen på dashboardet, og lista speiler målene i
// config.json: 5 og 10 km er delmålene, halvmaraton er hovedmålet. Maraton er
// utelatt fordi det ikke er et mål — grafen ville vært et tall uten en linje å
// måle det mot. Bytt fritt, alle fire ligger i history.json uansett.
const PREDIKSJONER = ['k5', 'k10', 'half'];

// Målet fra config.json kobles til distansen på ±15 %, så «21.1» og «21.0975»
// treffer samme graf og en 10 km-milvariant ikke faller mellom to stoler.
function målFor(km) {
    return (cfg.races ?? []).find((r) => Math.abs(r.distance_km - km) / km < 0.15);
}

function prediksjonsGraf(nøkkel) {
    const d = DISTANSER[nøkkel];
    const mål = målFor(d.km);
    const points = history.filter((h) => h[d.felt]).map((h) => ({
        date: h.date,
        value: h[d.felt],
        tip: `${shortDate(h.date)} · ${d.navn} ${fmtRaceTime(h[d.felt])}`
            + ` · ${fmtPace(h[d.felt] / d.km)}/km`
    }));
    return filterableChart({
        id: `chart-pred-${nøkkel}`, kind: 'line',
        title: `Garmins ${d.tittel} over tid (raskere er høyere)`,
        points, fmtKey: 'racetime', tickFmtKey: 'hm', tickSteps: d.tickSteps, timeAxis: true, invert: true,
        goal: mål?.goal_seconds ?? null,
        goalLabel: mål ? `mål ${fmtRaceTime(mål.goal_seconds)}` : ''
    });
}

// --- SVG-generering ---------------------------------------------------------

const W = 560, H = 240, PAD = { t: 16, r: 16, b: 28, l: 44 };
const plotW = W - PAD.l - PAD.r, plotH = H - PAD.t - PAD.b;

// `steps` er de tillatte trinnstørrelsene. Standardlista skaleres etter
// størrelsesorden; tidsserier sender inn faste trinn i sekunder i stedet, så
// aksen lander på hele halvminutt og ikke på 2,5 sekunder.
function niceTicks(min, max, n = 4, steps = null) {
    const span = max - min || 1;
    const candidates = steps ?? [1, 2, 2.5, 5, 10].map((m) => m * 10 ** Math.floor(Math.log10(span / n)));
    const step = candidates.reduce((best, s) => (Math.abs(span / s - n) < Math.abs(span / best - n) ? s : best));
    const ticks = [];
    for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) ticks.push(Number(v.toFixed(6)));
    return ticks;
}

function gridAndAxis(ticks, yOf, fmt = (v) => v) {
    return ticks.map((v) =>
        `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${yOf(v)}" y2="${yOf(v)}" class="grid"/>` +
        `<text x="${PAD.l - 6}" y="${yOf(v) + 3.5}" class="tick" text-anchor="end">${fmt(v)}</text>`
    ).join('');
}

function xLabels(points, labelOf, xOf) {
    const every = Math.ceil(points.length / 6);
    return points.map((p, i) => (i % every === 0 || i === points.length - 1)
        ? `<text x="${xOf(i)}" y="${H - 8}" class="tick" text-anchor="middle">${esc(labelOf(p))}</text>` : ''
    ).join('');
}

// stolpediagram: 4px avrundede data-ender mot toppen, forankret i grunnlinja, 2px mellomrom
// `cls` (valgfritt per punkt) overstyrer søyle-fargen — brukes til å farge
// etter kvalitet/status (f.eks. søvn-score, sykdomsuke) i stedet for én fast
// serie-farge for alle søyler.
//
// Forsøkte en tidsakse-variant her (samme prinsipp som lineChart) for å vise
// hull i serien som faktisk mellomrom, men ga ikke et godt nok resultat i
// praksis — droppet igjen. Indeksbasert jevn fordeling, som før.
function barChart({ title, data, unit = '' }) {
    if (!data.length) return '';
    const max = Math.max(...data.map((d) => d.value)) * 1.1;
    const yOf = (v) => PAD.t + plotH * (1 - v / max);
    const slot = plotW / data.length;
    const bw = Math.max(4, Math.min(slot - 2, 32));
    const bars = data.map((d, i) => {
        const x = PAD.l + i * slot + (slot - bw) / 2;
        const y = yOf(d.value), h = Math.max(0, H - PAD.b - y);
        const r = Math.min(4, bw / 2, h);
        const cls = d.cls ?? 'bar';
        return `<path d="M${x},${H - PAD.b} v${-(h - r)} q0,${-r} ${r},${-r} h${bw - 2 * r} q${r},0 ${r},${r} v${h - r} z" class="${cls}" data-tip="${esc(d.tip)}"/>`;
    }).join('');
    const last = data[data.length - 1];
    const label = `<text x="${PAD.l + (data.length - 0.5) * slot}" y="${yOf(last.value) - 6}" class="direct" text-anchor="middle">${last.value.toFixed(1)}${unit}</text>`;
    return gridAndAxis(niceTicks(0, max), yOf) +
        `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${H - PAD.b}" y2="${H - PAD.b}" class="axis"/>` +
        bars + label + xLabels(data, (d) => d.label, (i) => PAD.l + (i + 0.5) * slot);
}

// linjediagram: 2px linje, markør + direkte verdi på siste punkt, usynlige hover-flater
//
// - `timeAxis` plasserer punktene etter dato i stedet for etter rekkefølge.
//   Nødvendig for formhistorikken, som har hull (Garmin oppdaterer terskelen
//   bare på økter som kvalifiserer) — jevn fordeling ville løyet om tempoet.
// - `invert` snur y-aksen, for serier der lavere er bedre (tempo og løpstider).
//   Da peker linja oppover når formen blir bedre, som i tempografer ellers.
// - `goal` tegner en stiplet målstrek, og tvinger målet innenfor y-aksen.
// - `tickFmt` er for serier der aksen trenger et kortere format enn
//   sluttverdien (h:mm på aksen, h:mm:ss på punktet) — 9px-etikettene har bare
//   PAD.l å gå på før de klippes av venstremargen.
function lineChart({ title, data, fmt = (v) => v, tickFmt = null, tickSteps = null, timeAxis = false, invert = false, goal = null, goalLabel = '', bands = [], labelOf = (d) => shortDate(d.date) }) {
    if (data.length < 2) return '';
    const vals = [...data.map((d) => d.value), ...(goal != null ? [goal] : [])];
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const pad = (hi - lo || 1) * 0.15;
    const min = lo - pad, max = hi + pad;
    const frac = (v) => (v - min) / (max - min);
    const yOf = (v) => PAD.t + plotH * (invert ? frac(v) : 1 - frac(v));

    const times = data.map((d) => new Date(d.date).getTime());
    const span = times[times.length - 1] - times[0];
    const xOf = timeAxis && span > 0
        ? (i) => PAD.l + (plotW * (times[i] - times[0])) / span
        : (i) => PAD.l + (plotW * i) / (data.length - 1);

    // Skraverte perioder (f.eks. sykdom) — matcher på faktiske datapunkter i
    // stedet for å regne x-posisjon fra rådatoer, så den treffer riktig
    // uansett om aksen er tidsbasert eller indeksbasert.
    const bandRects = bands.map((b) => {
        const idxs = data.map((_, i) => i).filter((i) => data[i].date >= b.from && data[i].date <= b.to);
        if (!idxs.length) return '';
        const x1 = xOf(Math.min(...idxs)), x2 = Math.max(xOf(Math.max(...idxs)), x1 + 2);
        return `<rect x="${x1.toFixed(1)}" y="${PAD.t}" width="${(x2 - x1).toFixed(1)}" height="${plotH}" class="band" data-tip="${esc(b.label ?? '')}"/>` +
            `<text x="${(x1 + 3).toFixed(1)}" y="${PAD.t + 9}" class="band-label">${esc(b.label ?? '')}</text>`;
    }).join('');

    const path = data.map((d, i) => `${i ? 'L' : 'M'}${xOf(i).toFixed(1)},${yOf(d.value).toFixed(1)}`).join('');
    // treffflatene deler avstanden til naboene, så de følger punktene også når
    // punktene står ujevnt (tidsakse)
    const hits = data.map((d, i) => {
        const left = i === 0 ? PAD.l : (xOf(i - 1) + xOf(i)) / 2;
        const right = i === data.length - 1 ? W - PAD.r : (xOf(i) + xOf(i + 1)) / 2;
        return `<rect x="${left.toFixed(1)}" y="${PAD.t}" width="${(right - left).toFixed(1)}" height="${plotH}" class="hit" data-tip="${esc(d.tip)}" data-x="${xOf(i).toFixed(1)}" data-y="${yOf(d.value).toFixed(1)}"/>`;
    }).join('');
    const li = data.length - 1;
    const endMark = `<circle cx="${xOf(li)}" cy="${yOf(data[li].value)}" r="4" class="dot"/>` +
        `<text x="${xOf(li) - 8}" y="${yOf(data[li].value) - 8}" class="direct" text-anchor="end">${fmt(data[li].value)}</text>`;
    const goalLine = goal == null ? '' :
        `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${yOf(goal)}" y2="${yOf(goal)}" class="goal"/>` +
        `<text x="${W - PAD.r}" y="${yOf(goal) + (invert ? 12 : -5)}" class="goal-label" text-anchor="end">${esc(goalLabel)}</text>`;
    return bandRects +
        gridAndAxis(niceTicks(min, max, 4, tickSteps), yOf, tickFmt ?? fmt) + goalLine +
        `<path d="${path}" class="line"/>` + endMark + hits +
        `<circle class="hover-dot" r="4" style="display:none"/>` +
        xLabels(data, labelOf, xOf);
}

// `id` er valgfri — satt på filtrerbare grafer, som klientskriptet fyller inn
// og skriver om ved bytte av tidsperiode (se range-picker-scriptet nederst).
function svgCard(title, inner, id = null) {
    return `<figure class="card">
  <figcaption>${esc(title)}</figcaption>
  <svg${id ? ` id="${id}"` : ''} viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${inner}</svg>
</figure>`;
}

// Grafer som skal kunne filtreres på tidsperiode i nettleseren (range-picker
// nederst i HTML-en) registreres her med FULL, ufiltrert punktserie. Node
// tegner bare det tomme skjelettet — samme lineChart/barChart-funksjoner
// kjøres på nytt klientsidig (via .toString()) når brukeren bytter periode,
// så det finnes bare ÉN implementasjon av selve tegnelogikken.
const chartRegistry = [];
function filterableChart(entry) {
    chartRegistry.push(entry);
    return svgCard(entry.title, '', entry.id);
}

// --- fliser (hero-tall) -----------------------------------------------------

// Prediksjonen på løps-flisa slås opp på distanse. Tidligere var bare halv og
// maraton med, så et 5- eller 10 km-løp i config.json sto uten prediksjon.
const predByKm = [
    [5, st.predictions_s?.k5],
    [10, st.predictions_s?.k10],
    [21.0975, st.predictions_s?.half],
    [42.195, st.predictions_s?.marathon]
];
const predFor = (km) => (predByKm.find(([d]) => Math.abs(d - km) / km < 0.15) ?? [])[1];
const raceTiles = (cfg.races ?? []).map((race) => {
    // `date` er valgfri: et mål kan være en ambisjon uten løp bak seg ennå
    // («sub 17 på 5 km»). Uten dato droppes nedtellingen, og flisa viser gapet
    // til prediksjonen i stedet — som er det tallet som betyr noe uansett.
    const daysLeft = race.date
        ? Math.ceil((new Date(race.date) - Date.now()) / 86_400_000)
        : null;
    const pred = predFor(race.distance_km);
    const gap = pred ? pred - race.goal_seconds : null;
    const hoved = daysLeft != null
        ? `${daysLeft} <span class="tile-unit">dager</span>`
        : `${esc(race.goal)}`;
    const under = daysLeft != null
        ? `mål ${esc(race.goal)}`
        : 'mål uten dato';
    return `<div class="tile">
  <div class="tile-label">${esc(race.name)}</div>
  <div class="tile-value">${hoved}</div>
  <div class="tile-sub">${under}${pred ? ` · Garmin-prediksjon ${fmtRaceTime(pred)} <span class="${gap > 0 ? 'behind' : 'ahead'}">(${gap > 0 ? '+' : '−'}${fmtRaceTime(Math.abs(gap))})</span>` : ''}</div>
</div>`;
}).join('');

const vo2Tile = st.vo2max ? `<div class="tile">
  <div class="tile-label">VO2max (løp)</div>
  <div class="tile-value">${st.vo2max.value}</div>
  <div class="tile-sub">per ${esc(st.vo2max.date ? fullDate(st.vo2max.date) : '')}${st.threshold ? ` · terskel ${fmtPace(st.threshold.pace_s_per_km)}/km @ ${st.threshold.hr}` : ''}</div>
</div>` : '';
// Ingen treningsklarhet-flis: klokka rapporterer feltet aldri (se merknad ved
// seriesOf over) — flisa ville aldri vist noe uansett.

// --- ramp rate: volumendring mot siste FULLFØRTE uke ------------------------
//
// Sammenligner de to siste FULLFØRTE ukene, ikke inneværende uke — en uke som
// bare er halvveis kjørt ville se ut som et voldsomt fall i volum og gitt et
// falskt alarmerende tall. weekly[siste] er inneværende (mulig delvis) uke.
const sisteFulle = weekly.at(-2);
const foranDen = weekly.at(-3);
const rampPct = sisteFulle && foranDen && foranDen.value > 0
    ? ((sisteFulle.value - foranDen.value) / foranDen.value) * 100
    : null;
const rampTile = (sisteFulle && foranDen) ? `<div class="tile">
  <div class="tile-label">Volumendring, siste fullførte uke</div>
  <div class="tile-value">${rampPct == null ? '–' : `${rampPct > 0 ? '+' : ''}${rampPct.toFixed(0)}<span class="tile-unit">%</span>`}</div>
  <div class="tile-sub">${sisteFulle.value.toFixed(1)} km vs ${foranDen.value.toFixed(1)} km uka før${rampPct != null && rampPct > 10 ? ' · <span class="behind">over 10 %-regelen</span>' : ''}</div>
</div>` : '';

// --- personlige rekorder -----------------------------------------------------

const prCard = st.personal_records?.length ? `<figure class="card">
  <figcaption>Personlige rekorder</figcaption>
  <table>
    <thead><tr><th>Distanse</th><th>Tid</th><th>Dato</th></tr></thead>
    <tbody>
${st.personal_records.map((r) => `      <tr><td>${esc(r.distanse)}</td><td>${fmtRaceTime(r.tid_s)}</td><td>${r.dato ? fullDate(r.dato) : '–'}</td></tr>`).join('\n')}
    </tbody>
  </table>
</figure>` : '';

// --- kommende økter (fra plan.json) -----------------------------------------

const fmtHrRange = (hr) => {
    if (!hr) return '';
    if (hr.min != null && hr.max != null) return `${hr.min}–${hr.max}`;
    if (hr.max != null) return `<${hr.max}`;
    if (hr.min != null) return `>${hr.min}`;
    return '';
};
const fmtStepLen = (s) => (s.km != null ? `${s.km} km` : s.minutes != null ? `${s.minutes} min` : s.seconds != null ? `${s.seconds} sek` : '');

// Menneskelesbar oppsummering av stegene, samme grupperingsregel som
// lib/workout-spec.js: "repeat" på et drag sluker pausen rett etter, så
// «4 x 6 min med 2 min pause» blir énregel — ikke drag og pause hver for seg.
function describeSteps(steps = []) {
    const parts = [];
    for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        const kind = s.kind ?? s.step;
        if (kind === 'ramp') continue; // implementasjonsdetalj, ikke del av lesbar plan
        const len = fmtStepLen(s);
        const hr = s.hr ? ` @ puls ${fmtHrRange(s.hr)}` : '';
        if (kind === 'warmup') { parts.push(`${len} oppvarming${hr}`); continue; }
        if (kind === 'cooldown') { parts.push(`${len} nedjogg`); continue; }
        if (kind === 'recovery') { parts.push(`${len} pause`); continue; }
        if (kind === 'interval') {
            let piece = `${len}${hr}`;
            if (s.repeat) {
                const neste = steps[i + 1];
                const nesteKind = neste?.kind ?? neste?.step;
                if (neste && nesteKind === 'recovery' && neste.repeat == null) {
                    piece += ` m/ ${fmtStepLen(neste)} pause`;
                    i++; // pausen er lest inn i denne linja
                }
                piece = `${s.repeat} x ${piece}`;
            }
            parts.push(piece);
        }
    }
    return parts.join(' · ');
}

const weekdayOf = (iso) => {
    const navn = new Date(`${iso}T12:00:00`).toLocaleDateString('nb-NO', { weekday: 'long' });
    return navn.charAt(0).toUpperCase() + navn.slice(1);
};

// Denne uka (mandag–søndag), slått sammen til én liste: dager med et faktisk
// registrert løp viser RESULTATET (inkl. drag/laps for strukturerte økter),
// dager uten viser PLANEN i stedet. Det avgjøres per dag på om det finnes en
// faktisk økt, ikke på om datoen er i fortiden — så "i dag" viser resultatet
// med én gang økta er logget, i stedet for å vise gårsdagens plan hele dagen.
function startOfIsoWeek(dateStr) {
    const d = new Date(`${dateStr}T12:00:00`);
    const dag = d.getDay() || 7; // mandag=1 .. søndag=7
    d.setDate(d.getDate() - (dag - 1));
    return d.toISOString().slice(0, 10);
}
function endOfIsoWeek(dateStr) {
    const d = new Date(`${dateStr}T12:00:00`);
    const dag = d.getDay() || 7;
    d.setDate(d.getDate() + (7 - dag));
    return d.toISOString().slice(0, 10);
}
const ukeDatoer = [];
for (let d = new Date(`${startOfIsoWeek(today)}T12:00:00`); d.toISOString().slice(0, 10) <= endOfIsoWeek(today); d.setDate(d.getDate() + 1)) {
    ukeDatoer.push(d.toISOString().slice(0, 10));
}

// Kompakt drag-for-drag-oppsummering for en økt med gyldige splits — samme
// fallgruve-filter som pulsdrift-grafen (ugyldige/for korte lap droppes).
function lapsSammendrag(run) {
    if (!run?.id) return '';
    const path = join(DATA, 'splits', `${run.id}.json`);
    if (!existsSync(path)) return '';
    let splits;
    try { splits = JSON.parse(readFileSync(path, 'utf8')); } catch { return ''; }
    const laps = (splits.lapDTOs ?? []).filter((l) =>
        l.averageHR != null && l.duration >= 30 && l.averageSpeed <= l.maxSpeed + 0.001);
    if (laps.length < 2) return '';
    return laps.map((l, i) => `#${i + 1} ${fmtPace(l.duration / (l.distance / 1000))}/km @ ${Math.round(l.averageHR)}`).join(' · ');
}

const ukeRader = ukeDatoer.map((dato) => {
    const planer = (plan?.workouts ?? []).filter((w) => w.date === dato);
    const faktiskeLøp = days.find((d) => d.date === dato)?.runs ?? [];
    const gjort = faktiskeLøp.length > 0;
    const erFortid = dato < today;
    const naar = `${dato === today ? 'I dag' : weekdayOf(dato)} <span class="plan-date">${shortDate(dato)}</span>`;

    if (gjort) {
        const planTekst = planer.length ? `<div class="plan-steps">Plan: ${esc(planer.map((w) => w.name).join(' + '))}</div>` : '';
        const resultatHtml = faktiskeLøp.map((r) => {
            const laps = lapsSammendrag(r);
            const linje = `${r.km ?? '?'} km${r.pace_s ? ` · ${fmtPace(r.pace_s)}/km` : ''}${r.hr ? ` @ puls ${r.hr}` : ''}`;
            return `<div class="plan-actual">${esc(linje)}${r.name ? ` <span class="plan-actual-name">(${esc(r.name)})</span>` : ''}</div>` +
                (laps ? `<div class="plan-laps">${esc(laps)}</div>` : '');
        }).join('');
        return `<div class="plan-item done${dato === today ? ' today' : ''}">
  <div class="plan-when">${naar}</div>
  <div class="plan-body">
    <div class="plan-name">✓ Gjennomført</div>
    ${planTekst}
    ${resultatHtml}
  </div>
</div>`;
    }

    if (!planer.length) return '';
    return planer.map((w) => `<div class="plan-item${dato === today ? ' today' : ''}${erFortid ? ' missed' : ''}">
  <div class="plan-when">${naar}</div>
  <div class="plan-body">
    <div class="plan-name">${erFortid ? '— ' : ''}${esc(w.name)}</div>
    <div class="plan-steps">${esc(describeSteps(w.steps))}</div>
    ${w.rationale && !erFortid ? `<div class="plan-rationale">${esc(w.rationale)}</div>` : ''}
  </div>
</div>`).join('\n');
}).filter(Boolean);

const ukeHtml = ukeRader.length ? `<div class="plan">\n${ukeRader.join('\n')}\n</div>` : '';

// --- tabellvisning (tilgjengelighet + rask lesing) --------------------------

const tableRows = days.slice(-14).map((d) => {
    const km = (d.runs ?? []).reduce((s, r) => s + (r.km ?? 0), 0);
    return `<tr><td>${fullDate(d.date)}</td><td>${km ? km.toFixed(1) : '–'}</td><td>${d.rhr ?? '–'}</td><td>${d.hrv ?? '–'}</td><td>${d.sleep_h?.toFixed(1) ?? '–'}</td><td>${d.readiness ?? '–'}</td></tr>`;
}).join('\n');

// --- HTML -------------------------------------------------------------------

const html = `<!doctype html>
<html lang="no">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Løpedagbok</title>
<style>
:root {
  color-scheme: light;
  --page: #f9f9f7; --surface: #fcfcfb;
  --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
  --grid: #e1e0d9; --axis: #c3c2b7; --border: rgba(11,11,11,0.10);
  --series: #2a78d6; --good: #006300; --bad: #d03b3b;
  --sleep-fair: #c98a1f; --sleep-good: #6a9c2e;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --page: #0d0d0d; --surface: #1a1a19;
    --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10);
    --series: #3987e5; --good: #0ca30c; --bad: #e66767;
    --sleep-fair: #d9a13f; --sleep-good: #8ec14a;
  }
}
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px 48px; background: var(--page); color: var(--ink);
  font: 15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1100px; margin: 0 auto; }
h1 { font-size: 1.35rem; margin: 0 0 2px; }
.updated { color: var(--muted); font-size: 0.8rem; margin: 0 0 20px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 12px; margin-bottom: 20px; }
.tile { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
.tile-label { color: var(--ink-2); font-size: 0.8rem; }
.tile-value { font-size: 1.9rem; font-weight: 650; margin: 2px 0; }
.tile-unit { font-size: 0.9rem; font-weight: 400; color: var(--ink-2); }
.tile-sub { color: var(--ink-2); font-size: 0.78rem; }
.behind { color: var(--bad); } .ahead { color: var(--good); }
h2 { font-size: 1rem; margin: 22px 0 8px; }
.range-picker { display: flex; gap: 6px; margin: 14px 0 12px; flex-wrap: wrap; }
.range-picker button { font: inherit; font-size: 0.78rem; padding: 5px 12px; border-radius: 999px;
  border: 1px solid var(--border); background: var(--surface); color: var(--ink-2); cursor: pointer; }
.range-picker button:hover { color: var(--ink); }
.range-picker button.active { background: var(--series); border-color: var(--series); color: #fff; }
.plan { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
.plan-item { display: flex; gap: 14px; background: var(--surface); border: 1px solid var(--border);
  border-radius: 10px; padding: 10px 14px; align-items: baseline; }
.plan-item.today { border-color: var(--series); border-width: 1.5px; }
.plan-item.missed { opacity: 0.7; }
.plan-item.done { border-color: var(--good); }
.plan-item.done .plan-name { color: var(--good); }
.plan-when { flex: 0 0 auto; width: 92px; font-size: 0.8rem; color: var(--ink-2); }
.plan-date { display: block; color: var(--muted); font-size: 0.75rem; }
.plan-body { flex: 1 1 auto; min-width: 0; }
.plan-name { font-weight: 600; font-size: 0.9rem; }
.plan-steps, .plan-actual { color: var(--ink-2); font-size: 0.8rem; margin-top: 2px; }
.plan-actual-name { color: var(--muted); }
.plan-laps { color: var(--muted); font-size: 0.75rem; margin-top: 2px; font-variant-numeric: tabular-nums; }
.plan-rationale { color: var(--muted); font-size: 0.78rem; margin-top: 4px; font-style: italic; }
.bar-sick { fill: var(--muted); opacity: 0.5; }
.band { fill: var(--bad); opacity: 0.08; }
.band-label { fill: var(--muted); font-size: 9.5px; }
.charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 14px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px 8px; margin: 0; cursor: zoom-in; }
.card.expanded { grid-column: 1 / -1; cursor: zoom-out; }
.card.expanded svg { max-height: 78vh; }
.card figcaption { font-size: 0.92rem; font-weight: 600; margin: 0 0 6px 2px; }
svg { width: 100%; height: auto; display: block; }
.grid { stroke: var(--grid); stroke-width: 1; }
.axis { stroke: var(--axis); stroke-width: 1; }
.tick { fill: var(--ink-2); font-size: 11px; }
.direct { fill: var(--ink); font-size: 12px; font-weight: 700; }
.bar { fill: var(--series); }
.sleep-poor { fill: var(--bad); } .sleep-fair { fill: var(--sleep-fair); }
.sleep-good { fill: var(--sleep-good); } .sleep-excellent { fill: var(--good); }
.bar:hover { opacity: 0.85; }
.line { fill: none; stroke: var(--series); stroke-width: 2; stroke-linejoin: round; }
.goal { stroke: var(--good); stroke-width: 1.5; stroke-dasharray: 4 3; }
.goal-label { fill: var(--good); font-size: 9px; font-weight: 600; }
.dot, .hover-dot { fill: var(--series); stroke: var(--surface); stroke-width: 2; }
.hit { fill: transparent; }
details { margin-top: 20px; }
summary { cursor: pointer; color: var(--ink-2); font-size: 0.85rem; }
table { border-collapse: collapse; margin-top: 8px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; font-variant-numeric: tabular-nums; }
th, td { padding: 5px 12px; font-size: 0.8rem; text-align: right; }
th:first-child, td:first-child { text-align: left; }
th { color: var(--ink-2); border-bottom: 1px solid var(--grid); }
#tip { position: fixed; pointer-events: none; display: none; background: var(--surface); color: var(--ink);
  border: 1px solid var(--border); border-radius: 6px; padding: 4px 8px; font-size: 0.75rem;
  box-shadow: 0 2px 8px rgba(0,0,0,0.12); z-index: 10; white-space: nowrap; }
</style>
</head>
<body>
<main>
<h1>Løpedagbok</h1>
<p class="updated">Data synket ${esc(st.synced_at ? fullTimestamp(st.synced_at) : '?')} UTC · dashboard bygget ${esc(fullTimestamp(new Date().toISOString()))} UTC</p>
${ukeHtml ? `<h2>Denne uka</h2>\n${ukeHtml}` : ''}
<div class="tiles">
${vo2Tile}
${rampTile}
</div>
<div class="range-picker" role="group" aria-label="Tidsperiode for grafene">
${RANGES.map((r) => `<button type="button" data-range="${r.days}">${esc(r.label)}</button>`).join('\n')}
</div>
<div class="charts">
${filterableChart({ id: 'chart-weekly', kind: 'bar', title: 'Ukentlig løpsvolum (km)', points: weekly })}
${filterableChart({
    id: 'chart-threshold', kind: 'line', title: 'Terskelfart over tid (min/km — raskere er høyere)',
    points: thresholdSeries, fmtKey: 'pace', tickSteps: [5, 10, 15, 30, 60], timeAxis: true, invert: true
})}
${filterableChart({ id: 'chart-rhr', kind: 'line', title: 'Hvilepuls (slag/min)', points: rhrSeries, bands: sykdomsBands, timeAxis: true })}
${filterableChart({ id: 'chart-sleep', kind: 'bar', title: 'Søvn, farget etter score (timer)', points: sleepSeries })}
${PREDIKSJONER.map(prediksjonsGraf).join('\n')}
${prCard}
</div>
<div class="tiles">
${raceTiles}
</div>
<details>
<summary>Tabell: siste 14 dager</summary>
<table>
<thead><tr><th>Dato</th><th>Km</th><th>Hvilepuls</th><th>HRV</th><th>Søvn (t)</th><th>Klarhet</th></tr></thead>
<tbody>
${tableRows}
</tbody>
</table>
</details>
</main>
<div id="tip"></div>
<script>
// Tooltip: delegert på document i stedet for bundet per element, fordi
// range-picker'en under skriver om SVG-innholdet — bundne lyttere ville
// forsvunnet med de gamle elementene ved hvert periodebytte.
const tip = document.getElementById('tip');
document.addEventListener('mousemove', (e) => {
  const el = e.target.closest('[data-tip]');
  if (!el) { tip.style.display = 'none'; return; }
  tip.textContent = el.dataset.tip;
  tip.style.display = 'block';
  tip.style.left = Math.min(e.clientX + 12, window.innerWidth - tip.offsetWidth - 8) + 'px';
  tip.style.top = (e.clientY - 32) + 'px';
  if (el.classList.contains('hit')) {
    const dot = el.closest('svg')?.querySelector('.hover-dot');
    if (dot) { dot.setAttribute('cx', el.dataset.x); dot.setAttribute('cy', el.dataset.y); dot.style.display = 'block'; }
  }
});
document.addEventListener('mouseout', (e) => {
  if (!e.relatedTarget) tip.style.display = 'none';
});

// --- range-picker: filtrerer grafene på tidsperiode -------------------------
// Samme tegnefunksjoner som Node kjører ved bygging (niceTicks/gridAndAxis/
// xLabels/lineChart/barChart), limt inn her via .toString() ved bygging — så
// det aldri finnes to implementasjoner av selve tegnelogikken som kan gli fra
// hverandre. Node tegner bare skjelettet (svgCard med tomt <svg>); denne
// koden fyller inn innholdet, både ved sidelast og ved periodebytte.
const W = ${W}, H = ${H}, PAD = ${JSON.stringify(PAD)};
const plotW = W - PAD.l - PAD.r, plotH = H - PAD.t - PAD.b;
const esc = ${esc.toString()};
const shortDate = ${shortDate.toString()};
const fmtPace = ${fmtPace.toString()};
const fmtRaceTime = ${fmtRaceTime.toString()};
const fmtHm = ${fmtHm.toString()};
${niceTicks.toString()}
${gridAndAxis.toString()}
${xLabels.toString()}
${lineChart.toString()}
${barChart.toString()}

const FORMATTERS = { plain: (v) => v, pace: fmtPace, racetime: fmtRaceTime, hm: fmtHm };
const CHART_DATA = ${JSON.stringify(chartRegistry)};

function renderChart(cfg, rangeDays) {
  const svg = document.getElementById(cfg.id);
  if (!svg) return;
  const cutoff = rangeDays > 0 ? new Date(Date.now() - rangeDays * 86400000).toISOString().slice(0, 10) : null;
  const points = cutoff ? cfg.points.filter((p) => p.date >= cutoff) : cfg.points;
  const opts = {
    title: cfg.title, data: points,
    fmt: FORMATTERS[cfg.fmtKey] || FORMATTERS.plain,
    tickFmt: cfg.tickFmtKey ? FORMATTERS[cfg.tickFmtKey] : null,
    tickSteps: cfg.tickSteps || null, timeAxis: !!cfg.timeAxis, invert: !!cfg.invert,
    goal: cfg.goal ?? null, goalLabel: cfg.goalLabel || '', bands: cfg.bands || []
  };
  const inner = cfg.kind === 'bar' ? barChart(opts) : lineChart(opts);
  svg.innerHTML = inner || '<text x="' + (W / 2) + '" y="' + (H / 2) + '" text-anchor="middle" class="tick">Ikke nok data i valgt periode</text>';
}

function applyRange(rangeDays) {
  CHART_DATA.forEach((cfg) => renderChart(cfg, rangeDays));
  localStorage.setItem('dashboardRange', String(rangeDays));
  document.querySelectorAll('.range-picker button').forEach((b) => {
    b.classList.toggle('active', Number(b.dataset.range) === rangeDays);
  });
}

document.querySelectorAll('.range-picker button').forEach((b) => {
  b.addEventListener('click', () => applyRange(Number(b.dataset.range)));
});

applyRange(Number(localStorage.getItem('dashboardRange') ?? ${DEFAULT_RANGE_DAYS}));

// Klikk på et kort for å se grafen større — samme SVG (viewBox er fast),
// bare gitt mer plass, så den skalerer skarpt opp uten noen ny rendering.
// Bare ett kort av gangen er utvidet.
document.querySelectorAll('.charts .card').forEach((card) => {
  card.addEventListener('click', () => {
    const wasExpanded = card.classList.contains('expanded');
    document.querySelectorAll('.charts .card.expanded').forEach((c) => c.classList.remove('expanded'));
    if (!wasExpanded) card.classList.add('expanded');
  });
});
</script>
</body>
</html>
`;

// Dashboardet skrives til datamappa, ikke repoet: det er avledet av
// data/summary.json og inneholder de samme helsedataene i grafform. Ligger
// det sammen med dataene, følger det automatisk med til det private
// data-repoet og kan aldri havne i det offentlige kode-repoet ved et uhell.
mkdirSync(DATA, { recursive: true });
const utfil = join(DATA, 'dashboard.html');
writeFileSync(utfil, html);
console.log(`Dashboard bygget: ${utfil}`);
