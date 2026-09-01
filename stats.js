// Statistikk fra lokal Garmin-data (kjør sync.js først).
//
// Kjør:  node stats.js [--weeks N]
//
// Viser per uke: løpsvolum, antall økter, tid, snittpuls, tempofordeling
// (rolig/moderat/hardt), lengste tur — pluss ferskeste VO2max, Garmins
// løpsprediksjoner, terskelfart, restitusjonsdata og nedtelling til løpene.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, DATA } from './lib/paths.js';

const RUN_TYPES = new Set(['running', 'track_running', 'trail_running', 'treadmill_running', 'street_running']);

const loadJson = (path, fallback) =>
    existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;

const fmtPace = (secPerKm) => {
    const m = Math.floor(Math.round(secPerKm) / 60);
    const s = Math.round(secPerKm) % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
};

const fmtDur = (seconds) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    return h ? `${h}t${String(m).padStart(2, '0')}` : `${m} min`;
};

const fmtRaceTime = (seconds) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.round(seconds % 60);
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
             : `${m}:${String(s).padStart(2, '0')}`;
};

// ISO-ukenummer (samme uke-definisjon som Garmin/kalenderen)
function weekKey(dateStr) {
    const d = new Date(dateStr);
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
    const week = Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7);
    return `${t.getUTCFullYear()}-U${String(week).padStart(2, '0')}`;
}

function loadRuns() {
    const dir = join(DATA, 'activities');
    const acts = existsSync(dir)
        ? readdirSync(dir).filter((f) => f.endsWith('.json')).flatMap((f) => loadJson(join(dir, f), []))
        : loadJson(join(DATA, 'activities.json'), null); // eldre monolitt-format
    if (!acts || !acts.length) {
        console.error('Ingen data — kjør først:  node sync.js');
        process.exit(1);
    }
    return acts.filter(
        (a) => RUN_TYPES.has(a.activityType?.typeKey) && a.distance && a.duration
    );
}

function showCountdown() {
    const cfg = loadJson(join(ROOT, 'config.json'), null);
    if (!cfg) return;
    console.log('\n--- Nedtelling ---');
    for (const race of cfg.races ?? []) {
        const left = Math.ceil((new Date(race.date) - Date.now()) / 86_400_000);
        console.log(`${race.name}: ${race.date} — ${left} dager (${Math.floor(left / 7)} uker) | mål: ${race.goal}`);
    }
}

function weeklyTable(runs, weeks) {
    const byWeek = new Map();
    for (const r of runs) {
        const k = weekKey(r.startTimeLocal);
        if (!byWeek.has(k)) byWeek.set(k, []);
        byWeek.get(k).push(r);
    }
    const keys = [...byWeek.keys()].sort().slice(-weeks);

    const pad = (v, n) => String(v).padStart(n);
    console.log(`\n${'Uke'.padEnd(9)}${pad('Km', 7)}${pad('Økter', 7)}${pad('Tid', 8)}${pad('Snittpuls', 11)}${pad('Lengste', 9)}  Tempo rolig/mod/hardt`);
    console.log('-'.repeat(78));

    for (const k of keys) {
        const wk = byWeek.get(k);
        const km = wk.reduce((s, r) => s + r.distance, 0) / 1000;
        const dur = wk.reduce((s, r) => s + r.duration, 0);
        const hrDur = wk.filter((r) => r.averageHR);
        const avgHr = hrDur.length
            ? hrDur.reduce((s, r) => s + r.averageHR * r.duration, 0) / hrDur.reduce((s, r) => s + r.duration, 0)
            : 0;
        const longest = Math.max(...wk.map((r) => r.distance)) / 1000;

        // grov intensitetsfordeling på økt-nivå etter snittfart (justér gjerne)
        let easy = 0, mod = 0, hard = 0;
        for (const r of wk) {
            const pace = r.duration / (r.distance / 1000); // sek/km
            const d = r.distance / 1000;
            if (pace > 330) easy += d;        // roligere enn 5:30/km
            else if (pace > 285) mod += d;    // 4:45–5:30/km
            else hard += d;                   // raskere enn 4:45/km
        }
        console.log(
            k.padEnd(9) + pad(km.toFixed(1), 7) + pad(wk.length, 7) + pad(fmtDur(dur), 8) +
            pad(avgHr ? Math.round(avgHr) : '-', 11) + pad(longest.toFixed(1), 9) +
            `  ${Math.round(easy)}/${Math.round(mod)}/${Math.round(hard)} km`
        );
    }
}

function showStatus() {
    const s = loadJson(join(DATA, 'status.json'), null);
    if (!s) return;
    console.log('\n--- Formstatus ---');

    const gen = s.max_metrics?.[0]?.generic
        ?? s.max_metrics?.generic
        ?? s.training_status?.mostRecentVO2Max?.generic;
    if (gen?.vo2MaxPreciseValue) {
        console.log(`VO2max (løp): ${gen.vo2MaxPreciseValue} (${gen.calendarDate})`);
    }

    const rp = Array.isArray(s.race_predictions) ? s.race_predictions[0] : s.race_predictions;
    if (rp) {
        for (const [key, label] of [['time5K', '5 km'], ['time10K', '10 km'], ['timeHalfMarathon', 'Halvmaraton'], ['timeMarathon', 'Maraton']]) {
            if (rp[key]) console.log(`Garmin-prediksjon ${label}: ${fmtRaceTime(rp[key])}`);
        }
    }

    const ltSpeed = s.lactate_threshold_speed?.at(-1)?.value; // m/s delt på 10
    const ltHr = s.lactate_threshold_hr?.at(-1)?.value;
    if (ltSpeed) {
        console.log(`Terskelfart: ${fmtPace(100 / ltSpeed)}/km` + (ltHr ? ` @ ${ltHr} slag/min` : ''));
    }
}

function showRecentDaily(days = 7) {
    const dir = join(DATA, 'daily');
    if (!existsSync(dir)) return;
    const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort().slice(-days);

    console.log(`\n--- Siste ${files.length} dager (restitusjon) ---`);
    const pad = (v, n) => String(v ?? '').padStart(n);
    console.log('Dato'.padEnd(12) + pad('Hvilepuls', 10) + pad('HRV natt', 10) + pad('Søvn', 7) + pad('Klarhet', 9));

    for (const f of files) {
        const d = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        const rhr = d.rhr?.allMetrics?.metricsMap?.WELLNESS_RESTING_HEART_RATE?.[0]?.value;
        const hrv = d.hrv?.hrvSummary?.lastNightAvg;
        const sleepSec = d.sleep?.dailySleepDTO?.sleepTimeSeconds;
        const sleep = sleepSec ? `${(sleepSec / 3600).toFixed(1)}t` : '';
        const tr = Array.isArray(d.training_readiness) ? d.training_readiness[0]?.score : d.training_readiness?.score;
        console.log(d.date.padEnd(12) + pad(rhr, 10) + pad(hrv, 10) + pad(sleep, 7) + pad(tr, 9));
    }
}

// --- main ---
const args = process.argv.slice(2);
const weeks = args.includes('--weeks') ? Number(args[args.indexOf('--weeks') + 1]) : 12;

const runs = loadRuns();
console.log(`Totalt ${runs.length} løpeturer i datasettet`);
showCountdown();
weeklyTable(runs, weeks);
showStatus();
showRecentDaily();
