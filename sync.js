// Henter treningsdata fra Garmin Connect og lagrer lokalt i data/.
//
// Kjør:  node sync.js [--days N] [--full]
//
// - Aktiviteter lagres i data/activities/<år>.json (dedupet på activityId).
// - Splits for løpeturer lagres i data/splits/<activityId>.json.
// - Developer fields fra FIT-fila (Stryd-kraft m.m.) i data/devfields/<activityId>.json.
// - Daglig helsedata (søvn, HRV, hvilepuls, stress, treningsklarhet) i data/daily/<dato>.json.
// - Statusdata (VO2max, treningsstatus, løpsprediksjoner, rekorder) i data/status.json.
// - Formmålerne per dato i data/history.json (append-only, se lib/history.js).
// - Kompakt destillat av alt over i data/summary.json (se lib/summary.js).
//
// Inkrementell: husker siste synk i data/last_sync.txt og henter bare nye dager.
// Første kjøring (eller --full) henter DEFAULT_BACKFILL_DAYS dager historikk.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { connect, getDisplayName, endpoints, TOKEN_DIR } from './lib/garmin.js';
import { writeSummary } from './lib/summary.js';
import { updateHistory } from './lib/history.js';
import { developerFieldSummary } from './lib/fit.js';
import { DATA, DATA_ER_EKSTERN } from './lib/paths.js';

const SPLITS = join(DATA, 'splits');
const DEVFIELDS = join(DATA, 'devfields');
const DAILY = join(DATA, 'daily');
const ACTIVITIES = join(DATA, 'activities');
const EXERCISESETS = join(DATA, 'exercisesets');
const LAST_SYNC = join(DATA, 'last_sync.txt');

const DEFAULT_BACKFILL_DAYS = 365; // historikk ved første kjøring
const DEVFIELDS_DAYS = 45; // hvor langt bakover FIT-filer hentes for developer fields
const DEVFIELDS_MAX_PER_RUN = 20; // tak per kjøring, så en backfill ikke tar evigheter
const RUN_TYPES = new Set(['running', 'track_running', 'trail_running', 'treadmill_running', 'street_running']);

const log = (msg) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${msg}`);
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 86_400_000);

function loadJson(path, fallback) {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
}

// null-verdier bærer ingen informasjon i Garmins DTO-er, men utgjør godt over
// halvparten av volumet — fjernes før lagring (konsumentene bruker ?.-kjeder).
function stripNulls(v) {
    if (Array.isArray(v)) return v.map(stripNulls);
    if (v && typeof v === 'object') {
        const out = {};
        for (const [k, val] of Object.entries(v)) {
            if (val !== null) out[k] = stripNulls(val);
        }
        return out;
    }
    return v;
}

function saveJson(path, obj) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(stripNulls(obj), null, 1));
}

const yearOf = (a) => (a.startTimeLocal ?? '').slice(0, 4);

function loadActivityShards() {
    if (!existsSync(ACTIVITIES)) return [];
    return readdirSync(ACTIVITIES)
        .filter((f) => f.endsWith('.json'))
        .flatMap((f) => loadJson(join(ACTIVITIES, f), []));
}

async function syncActivities(gc, start, end) {
    const existing = loadActivityShards();
    const byId = new Map(existing.map((a) => [a.activityId, a]));

    const fetched = await gc.get(...endpoints.activitiesByDate(iso(start), iso(end)));
    const fresh = fetched.filter((a) => !byId.has(a.activityId));
    for (const a of fetched) byId.set(a.activityId, a);

    const merged = [...byId.values()].sort((a, b) =>
        (b.startTimeLocal ?? '').localeCompare(a.startTimeLocal ?? '')
    );
    // skriv kun års-shardene synkevinduet faktisk berørte, så gamle år ligger i ro i git
    const touchedYears = new Set(fetched.map(yearOf).filter(Boolean));
    for (const year of touchedYears) {
        saveJson(join(ACTIVITIES, `${year}.json`), merged.filter((a) => yearOf(a) === year));
    }
    log(`Aktiviteter: ${fetched.length} hentet (${fresh.length} nye), ${merged.length} totalt`);

    // Splits for nye løpeturer
    for (const a of fresh) {
        if (!RUN_TYPES.has(a.activityType?.typeKey)) continue;
        const path = join(SPLITS, `${a.activityId}.json`);
        if (existsSync(path)) continue;
        try {
            saveJson(path, await gc.get(...endpoints.splits(a.activityId)));
            log(`  splits lagret for ${a.activityName ?? a.activityId} (${(a.startTimeLocal ?? '').slice(0, 10)})`);
        } catch (e) {
            log(`  ADVARSEL: klarte ikke hente splits for ${a.activityId}: ${e.message}`);
        }
    }

    // Øvelsessett for styrkeøkter. Sammendraget Garmin legger på aktiviteten
    // (summarizedExerciseSets) har bare totaler per øvelse — sett, reps, TYNGSTE
    // vekt og volum. Gikk du ned i vekt underveis, eller bommet på ett sett da du
    // rettet i appen, må det regnes bakover fra volumet, og flere svar kan gi
    // samme tall. Enkeltsettene fjerner gjetningen.
    //
    // Går over HELE synkevinduet, ikke bare nye økter, og overskriver: en
    // styrkeøkt rettes typisk i appen i etterkant, og da skal den ferskeste
    // versjonen ligge her. Sammendraget henger dessuten etter enkeltsettene i
    // Garmins eget svar, så dette er den mest oppdaterte kilden.
    //
    // I tillegg backfilles styrkeøkter UTENFOR vinduet som ennå ikke har fil.
    // Uten det ville en økt rettet i ettertid aldri bli oppdatert i repoet:
    // synkevinduet er «siste synk minus én dag», så 18. august kommer aldri
    // innom igjen av seg selv. Backfillen går én gang per økt og stopper der.
    const medFil = (a) => existsSync(join(EXERCISESETS, `${a.activityId}.json`));
    const styrke = [
        ...fetched.filter((a) => a.activityType?.typeKey === 'strength_training'),
        ...merged.filter((a) => a.activityType?.typeKey === 'strength_training' && !medFil(a))
    ];
    for (const a of new Map(styrke.map((a) => [a.activityId, a])).values()) {
        try {
            saveJson(join(EXERCISESETS, `${a.activityId}.json`), await gc.get(...endpoints.exerciseSets(a.activityId)));
            log(`  øvelsessett lagret for ${a.activityName ?? a.activityId} (${(a.startTimeLocal ?? '').slice(0, 10)})`);
        } catch (e) {
            log(`  ADVARSEL: klarte ikke hente øvelsessett for ${a.activityId}: ${e.message}`);
        }
    }

    // Developer fields (Stryd-kraft m.m.) krever nedlasting av hele FIT-fila.
    // Går over løpeturene i synkevinduet — ikke bare de nye — så en økt som
    // feilet forrige gang blir forsøkt igjen. Resultatet lagres også når økta
    // ikke har slike felt: da vet vi at den er sjekket, og fila lastes aldri
    // ned på nytt. Grensene under holder kjøretiden nede ved full backfill.
    const kandidater = fetched
        .filter((a) => RUN_TYPES.has(a.activityType?.typeKey))
        .filter((a) => (a.startTimeLocal ?? '') >= iso(addDays(end, -DEVFIELDS_DAYS)))
        .filter((a) => !existsSync(join(DEVFIELDS, `${a.activityId}.json`)))
        .slice(0, DEVFIELDS_MAX_PER_RUN);
    for (const a of kandidater) {
        try {
            const summary = await developerFieldSummary(gc, a.activityId);
            saveJson(join(DEVFIELDS, `${a.activityId}.json`), summary);
            const navn = summary.fields.map((f) => f.name).join(', ');
            log(`  developer fields for ${a.activityId}: ${navn || 'ingen'}`);
        } catch (e) {
            // Aldri la dette velte synken — resten av dataene er viktigere.
            log(`  ADVARSEL: klarte ikke lese FIT-fila for ${a.activityId}: ${e.message}`);
        }
    }
}

async function fetchDaily(gc, date) {
    const day = iso(date);
    const dn = await getDisplayName(gc);
    const out = { date: day };
    const fetchers = {
        sleep: () => gc.getSleepData(new Date(`${day}T12:00:00`)),
        hrv: () => gc.get(...endpoints.hrv(day)),
        rhr: () => gc.get(...endpoints.restingHeartRate(dn, day)),
        stress: () => gc.get(...endpoints.stress(day)),
        training_readiness: () => gc.get(...endpoints.trainingReadiness(day))
    };
    for (const [key, fn] of Object.entries(fetchers)) {
        try {
            out[key] = await fn();
        } catch (e) {
            out[key] = null;
            log(`  ADVARSEL: ${key} for ${day} feilet: ${e.message}`);
        }
    }
    return out;
}

async function syncDaily(gc, start, end) {
    const today = iso(new Date());
    let count = 0;
    for (let d = start; iso(d) <= iso(end); d = addDays(d, 1)) {
        const path = join(DAILY, `${iso(d)}.json`);
        // I dag re-hentes alltid (dagen er ikke ferdig); historiske dager kun hvis de mangler
        if (!existsSync(path) || iso(d) === today) {
            saveJson(path, await fetchDaily(gc, d));
            count++;
        }
    }
    log(`Daglig helsedata: ${count} dager oppdatert`);
}

// Prøver flere endepunktvarianter og returnerer den første som svarer med noe.
// Finnes fordi vektendepunktet ikke er verifisert (se lib/garmin.js) — kaster
// den siste feilen videre hvis ingen svarer, så fetcher-loopen logger den.
async function firstAnswering(gc, variants) {
    let lastError;
    for (const args of variants) {
        try {
            const res = await gc.get(...args);
            if (res) return res;
        } catch (e) {
            lastError = e;
        }
    }
    if (lastError) throw lastError;
    return null;
}

async function syncStatus(gc) {
    const today = iso(new Date());
    // Terskel og prediksjoner hentes for et helt år: begge er serier med dato
    // per måling, så et bredt vindu fyller data/history.json bakover gratis.
    const yearAgo = iso(addDays(new Date(), -365));
    const dn = await getDisplayName(gc);
    const status = { synced_at: new Date().toISOString() };
    const fetchers = {
        max_metrics: () => gc.get(...endpoints.maxMetrics(today)), // VO2max m.m.
        training_status: () => gc.get(...endpoints.trainingStatus(today)),
        race_predictions: () => gc.get(...endpoints.racePredictions(dn)),
        race_predictions_daily: () => gc.get(...endpoints.racePredictionsRange(dn, yearAgo, today)),
        personal_records: () => gc.get(...endpoints.personalRecords(dn)),
        lactate_threshold_speed: () => gc.get(...endpoints.lactateThresholdSpeed(yearAgo, today)),
        lactate_threshold_hr: () => gc.get(...endpoints.lactateThresholdHeartRate(yearAgo, today)),
        endurance_score: () => gc.get(...endpoints.enduranceScore(today)),
        user_summary: () => gc.get(...endpoints.userSummary(dn, today)),
        // Hele året i én spørring: vekt er en serie med måling per dato, så et
        // bredt vindu gir trenden gratis — samme grunn som for terskelen over.
        weight: () => firstAnswering(gc, [
            endpoints.weightRange(yearAgo, today),
            endpoints.weightDateRange(yearAgo, today)
        ])
    };
    for (const [key, fn] of Object.entries(fetchers)) {
        try {
            status[key] = await fn();
        } catch (e) {
            status[key] = null;
            log(`  ADVARSEL: ${key} feilet: ${e.message}`);
        }
    }
    saveJson(join(DATA, 'status.json'), status);
    log('Status (VO2max, treningsstatus, prediksjoner) lagret');

    // Legger dagens formmålere til i data/history.json. Append-only — Garmin
    // gir bare siste verdi, så trenden finnes ingen andre steder.
    const history = updateHistory(DATA);
    log(`Formhistorikk: ${history.length} datoer i data/history.json`);
}

// --- main ---
const args = process.argv.slice(2);
const daysArg = args.includes('--days') ? Number(args[args.indexOf('--days') + 1]) : null;
const full = args.includes('--full');

const today = new Date();
let start;
if (daysArg) {
    start = addDays(today, -daysArg);
} else if (full || !existsSync(LAST_SYNC)) {
    start = addDays(today, -DEFAULT_BACKFILL_DAYS);
} else {
    const last = new Date(readFileSync(LAST_SYNC, 'utf8').trim());
    start = addDays(last, -1); // litt overlapp i tilfelle sen synk fra klokka
}

log(`Synker ${iso(start)} → ${iso(today)}`);
// Si hvor det skrives. En synk legger igjen titalls MB, og det er verdt å se
// med én gang om den havner i det private data-repoet eller i ./data her —
// glemt GARMIN_DATA_DIR er ellers en feil som først merkes når dataene mangler.
log(`Data → ${DATA}${DATA_ER_EKSTERN ? '' : '  (GARMIN_DATA_DIR er ikke satt)'}`);
const gc = await connect();
await syncActivities(gc, start, today);
await syncDaily(gc, start, today);
await syncStatus(gc);

writeSummary(DATA);
log(`Kompakt destillat lagret i ${join(DATA, 'summary.json')}`);

// oauth2-token kan ha blitt fornyet underveis — lagre på nytt
gc.exportTokenToFile(TOKEN_DIR);

writeFileSync(LAST_SYNC, iso(today));
log('Ferdig ✓');
