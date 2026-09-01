// Bygger dashboard.html — et selvstendig, statisk dashboard over framgang mot
// løpene, generert fra data/summary.json + config.json. Kjøres av sync-workflowen
// etter hver synk (og kan kjøres lokalt: node build-dashboard.js).
//
// Bevisst IKKE publisert på GitHub Pages: Pages-sider er alltid offentlige på
// Free/Pro-plan (tilgangsstyring finnes kun på Enterprise), og dette er helsedata.
// Åpne fila lokalt, eller be Claude vise den.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT, DATA } from './lib/paths.js';

const summary = JSON.parse(readFileSync(join(DATA, 'summary.json'), 'utf8'));
const cfg = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));

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

// --- datapreparering --------------------------------------------------------

const days = summary.days;
const today = new Date().toISOString().slice(0, 10);

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
// sammenhengende akse: alle 16 siste uker, også uker uten løp (0 km)
const weekKeys = Array.from({ length: 16 }, (_, i) =>
    weekKey(new Date(Date.now() - (15 - i) * 7 * 86_400_000).toISOString().slice(0, 10)));
const weekly = weekKeys.map((k) => {
    const w = byWeek.get(k) ?? { km: 0, n: 0, time: 0 };
    return { label: k.slice(5), value: w.km, tip: `${k} · ${w.km.toFixed(1)} km · ${w.n} økter · ${fmtDur(w.time)}` };
});

const seriesOf = (field, n) =>
    days.filter((d) => d[field] != null).slice(-n)
        .map((d) => ({ date: d.date, value: d[field] }));

const rhrSeries = seriesOf('rhr', 60).map((p) => ({ ...p, tip: `${shortDate(p.date)} · hvilepuls ${p.value}` }));
const hrvSeries = seriesOf('hrv', 60).map((p) => ({ ...p, tip: `${shortDate(p.date)} · HRV ${p.value} ms` }));
const sleepSeries = seriesOf('sleep_h', 30).map((p) => {
    const score = days.find((d) => d.date === p.date)?.sleep_score;
    return { label: shortDate(p.date), value: p.value, tip: `${shortDate(p.date)} · ${p.value.toFixed(1)} t søvn${score ? ` · score ${score}` : ''}` };
});
const readinessSeries = seriesOf('readiness', 30).map((p) => ({ ...p, tip: `${shortDate(p.date)} · klarhet ${p.value}` }));

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
    const data = history.filter((h) => h[d.felt]).map((h) => ({
        date: h.date,
        value: h[d.felt],
        tip: `${shortDate(h.date)} · ${d.navn} ${fmtRaceTime(h[d.felt])}`
            + ` · ${fmtPace(h[d.felt] / d.km)}/km`
    }));
    return lineChart({
        title: `Garmins ${d.tittel} over tid (raskere er høyere)`,
        data, fmt: fmtRaceTime, tickFmt: fmtHm, tickSteps: d.tickSteps, timeAxis: true, invert: true,
        goal: mål?.goal_seconds ?? null,
        goalLabel: mål ? `mål ${fmtRaceTime(mål.goal_seconds)}` : ''
    });
}

// --- SVG-generering ---------------------------------------------------------

const W = 520, H = 200, PAD = { t: 14, r: 14, b: 26, l: 38 };
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
function barChart({ title, data, unit = '' }) {
    if (!data.length) return '';
    const max = Math.max(...data.map((d) => d.value)) * 1.1;
    const yOf = (v) => PAD.t + plotH * (1 - v / max);
    const slot = plotW / data.length;
    const bw = Math.max(4, slot - 2);
    const bars = data.map((d, i) => {
        const x = PAD.l + i * slot + (slot - bw) / 2;
        const y = yOf(d.value), h = Math.max(0, H - PAD.b - y);
        const r = Math.min(4, bw / 2, h);
        return `<path d="M${x},${H - PAD.b} v${-(h - r)} q0,${-r} ${r},${-r} h${bw - 2 * r} q${r},0 ${r},${r} v${h - r} z" class="bar" data-tip="${esc(d.tip)}"/>`;
    }).join('');
    const last = data[data.length - 1];
    const label = `<text x="${PAD.l + (data.length - 0.5) * slot}" y="${yOf(last.value) - 6}" class="direct" text-anchor="middle">${last.value.toFixed(1)}${unit}</text>`;
    return svgCard(title,
        gridAndAxis(niceTicks(0, max), yOf) +
        `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${H - PAD.b}" y2="${H - PAD.b}" class="axis"/>` +
        bars + label + xLabels(data, (d) => d.label, (i) => PAD.l + (i + 0.5) * slot));
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
function lineChart({ title, data, fmt = (v) => v, tickFmt = null, tickSteps = null, timeAxis = false, invert = false, goal = null, goalLabel = '' }) {
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
    return svgCard(title,
        gridAndAxis(niceTicks(min, max, 4, tickSteps), yOf, tickFmt ?? fmt) + goalLine +
        `<path d="${path}" class="line"/>` + endMark + hits +
        `<circle class="hover-dot" r="4" style="display:none"/>` +
        xLabels(data, (d) => shortDate(d.date), xOf));
}

function svgCard(title, inner) {
    return `<figure class="card">
  <figcaption>${esc(title)}</figcaption>
  <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${inner}</svg>
</figure>`;
}

// --- fliser (hero-tall) -----------------------------------------------------

const st = summary.status ?? {};
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

const latestReadiness = [...days].reverse().find((d) => d.readiness != null);
const vo2Tile = st.vo2max ? `<div class="tile">
  <div class="tile-label">VO2max (løp)</div>
  <div class="tile-value">${st.vo2max.value}</div>
  <div class="tile-sub">per ${esc(st.vo2max.date ? fullDate(st.vo2max.date) : '')}${st.threshold ? ` · terskel ${fmtPace(st.threshold.pace_s_per_km)}/km @ ${st.threshold.hr}` : ''}</div>
</div>` : '';
const readinessTile = latestReadiness ? `<div class="tile">
  <div class="tile-label">Treningsklarhet</div>
  <div class="tile-value">${latestReadiness.readiness}<span class="tile-unit">/100</span></div>
  <div class="tile-sub">per ${esc(fullDate(latestReadiness.date))}</div>
</div>` : '';

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
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --page: #0d0d0d; --surface: #1a1a19;
    --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10);
    --series: #3987e5; --good: #0ca30c; --bad: #e66767;
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
.charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 12px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px 12px 6px; margin: 0; }
.card figcaption { font-size: 0.85rem; font-weight: 600; margin: 0 0 4px 4px; }
svg { width: 100%; height: auto; display: block; }
.grid { stroke: var(--grid); stroke-width: 1; }
.axis { stroke: var(--axis); stroke-width: 1; }
.tick { fill: var(--muted); font-size: 9px; }
.direct { fill: var(--ink-2); font-size: 10px; font-weight: 600; }
.bar { fill: var(--series); }
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
<div class="tiles">
${raceTiles}
${vo2Tile}
${readinessTile}
</div>
<div class="charts">
${barChart({ title: 'Ukentlig løpsvolum, siste 16 uker (km)', data: weekly })}
${lineChart({
    title: 'Terskelfart over tid (min/km — raskere er høyere)',
    data: thresholdSeries, fmt: fmtPace, tickSteps: [5, 10, 15, 30, 60], timeAxis: true, invert: true
})}
${PREDIKSJONER.map(prediksjonsGraf).join('\n')}
${lineChart({ title: 'HRV natt, siste 60 dager (ms)', data: hrvSeries })}
${lineChart({ title: 'Hvilepuls, siste 60 dager (slag/min)', data: rhrSeries })}
${barChart({ title: 'Søvn, siste 30 dager (timer)', data: sleepSeries })}
${lineChart({ title: 'Treningsklarhet, siste 30 dager (0–100)', data: readinessSeries })}
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
const tip = document.getElementById('tip');
document.querySelectorAll('[data-tip]').forEach((el) => {
  el.addEventListener('mousemove', (e) => {
    tip.textContent = el.dataset.tip;
    tip.style.display = 'block';
    tip.style.left = Math.min(e.clientX + 12, window.innerWidth - tip.offsetWidth - 8) + 'px';
    tip.style.top = (e.clientY - 32) + 'px';
    if (el.classList.contains('hit')) {
      const dot = el.closest('svg').querySelector('.hover-dot');
      dot.setAttribute('cx', el.dataset.x);
      dot.setAttribute('cy', el.dataset.y);
      dot.style.display = 'block';
    }
  });
  el.addEventListener('mouseleave', () => {
    tip.style.display = 'none';
    const dot = el.closest('svg')?.querySelector('.hover-dot');
    if (dot) dot.style.display = 'none';
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
