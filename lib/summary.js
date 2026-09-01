// Bygger data/summary.json — et kompakt destillat av data/daily/, data/activities/,
// data/status.json og data/history.json. Én linje per dag med bare feltene som brukes i analyse og
// dashboard, så treningsforslag-rutinen slipper å lese rå Garmin-DTO-er (~90 KB/dag).
// Rådataene beholdes urørt; dette er et avledet lag som trygt kan regenereres.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const RUN_TYPES = new Set(['running', 'track_running', 'trail_running', 'treadmill_running', 'street_running']);

const round = (v, dec = 0) => (v == null ? null : Number(v.toFixed(dec)));

const loadJson = (path, fallback) =>
    existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;

function loadActivities(DATA) {
    const dir = join(DATA, 'activities');
    if (existsSync(dir)) {
        return readdirSync(dir)
            .filter((f) => f.endsWith('.json'))
            .flatMap((f) => loadJson(join(dir, f), []));
    }
    return loadJson(join(DATA, 'activities.json'), []); // eldre monolitt-format
}

// Developer fields fra FIT-fila (Stryd m.m.), lagret av sync.js. Tas med i
// destillatet så analysen slipper å åpne data/devfields/ for hånd. Feltnavnene
// bestemmes av Connect IQ-appen, så de leses som de er i stedet for å mappes.
function developerFields(DATA, activityId) {
    const dev = loadJson(join(DATA, 'devfields', `${activityId}.json`), null);
    if (!dev?.overall || !Object.keys(dev.overall).length) return null;
    const out = {};
    for (const [navn, s] of Object.entries(dev.overall)) out[navn] = s.avg;
    return out;
}

// Styrkeøkter: Garmin lagrer sett, reps og tyngste vekt per øvelse i
// summarizedExerciseSets. Uten dette når vektene aldri fram hit, og
// den vanlige progresjonsregelen ("øk vekten når alle sett går med
// 1-2 reps i reserve") kan ikke etterprøves uten å grave i data/activities/ —
// den blir en følelse i stedet for et tall. Vekter kommer i gram fra Garmin.
//
// `vol` (totalvolum) er med fordi `kg` bare er den TYNGSTE vekten. Er alle sett
// kjørt likt, er vol = reps x kg; avviker de, er det fordi settene hadde ulik
// vekt — og differansen sier hvor mye. Uten vol ser en økt der du gikk NED i
// vekt underveis identisk ut med en der du holdt toppvekta hele veien. Det er
// forskjellen på "24 kg gikk fint" og "24 kg røk etter første runde".
// Bygger det samme sammendraget fra enkeltsettene i data/exercisesets/. De er
// ferskere enn aktivitetens summarizedExerciseSets på to måter: Garmin oppdaterer
// aggregatet med forsinkelse etter en retting, og en økt utenfor synkevinduet får
// aldri aktivitetsposten sin hentet på nytt i det hele tatt. Rettes 18. august i
// dag, er det bare her det synes.
function fraEnkeltsett(DATA, activityId) {
    const fil = loadJson(join(DATA, 'exercisesets', `${activityId}.json`), null);
    const sets = (fil?.exerciseSets ?? []).filter((s) => s.setType === 'ACTIVE');
    if (!sets.length) return null;
    const per = new Map();
    for (const s of sets) {
        const e = s.exercises?.[0];
        if (!e?.category) continue;
        const nøkkel = e.name ? `${e.category}/${e.name}` : e.category;
        const rad = per.get(nøkkel) ?? { ex: nøkkel, sets: 0, reps: 0, gram: 0, maksGram: 0 };
        rad.sets += 1;
        rad.reps += s.repetitionCount ?? 0;
        if (s.weight > 0) {
            rad.gram += (s.repetitionCount ?? 0) * s.weight;
            rad.maksGram = Math.max(rad.maksGram, s.weight);
        }
        per.set(nøkkel, rad);
    }
    return [...per.values()].map(({ gram, maksGram, ...rad }) => {
        if (maksGram) rad.kg = round(maksGram / 1000, 1);
        if (gram) rad.vol = round(gram / 1000, 1);
        if (!rad.reps) delete rad.reps;
        return rad;
    });
}

function summarizeExercises(a, corrections, DATA) {
    const fraSett = DATA ? fraEnkeltsett(DATA, a.activityId) : null;
    if (fraSett?.length) {
        applyCorrections(fraSett, corrections?.activities?.[a.activityId], a.activityId);
        return fraSett;
    }
    const sets = a.summarizedExerciseSets;
    if (!Array.isArray(sets) || !sets.length) return null;
    const out = sets.map((s) => {
        const ex = {
            ex: s.subCategory ? `${s.category}/${s.subCategory}` : s.category,
            sets: s.sets ?? null,
            reps: s.reps || null,
            kg: s.maxWeight ? round(s.maxWeight / 1000, 1) : null,
            vol: s.volume ? round(s.volume / 1000, 1) : null
        };
        for (const k of Object.keys(ex)) if (ex[k] == null) delete ex[k];
        return ex;
    });
    applyCorrections(out, corrections?.activities?.[a.activityId], a.activityId);
    return out.length ? out : null;
}

// Rettelser til Garmins rådata, fra data/corrections.json. De hører hjemme her og
// ikke i data/activities/: sync.js gjør byId.set(a.activityId, a) for hver hentede
// økt, så en håndredigering av rådataene blir overskrevet uten varsel — med én gang
// hvis økta er innenfor synkevinduet, ellers første gang noen kjører --full. Rådata
// er et speil av Garmin; rettelsene er et lag over.
//
// Hver rettelse oppgir tilstanden den forventer å finne. Treffer den ikke, gjør den
// ingenting og sier fra — en rettelse som er blitt overflødig fordi økta er rettet i
// Garmin skal be om å bli slettet, ikke råtne i stillhet.
function applyCorrections(out, entry, activityId) {
    for (const fix of entry?.fixes ?? []) {
        const treff = out.find(
            (e) => e.ex === fix.ex && (fix.kg == null || e.kg === fix.kg)
        );
        if (!treff) {
            console.warn(
                `  ! corrections.json: ${activityId} "${fix.ex}"${fix.kg != null ? ` @ ${fix.kg} kg` : ''} finnes ikke lenger — rettelsen er overflødig og kan slettes`
            );
            continue;
        }
        Object.assign(treff, fix.to);
    }
}

// Leses én gang per summary-bygg; fila er liten, men summarizeActivity kalles for
// hver eneste aktivitet i historikken.
let correctionsFor = null;
function loadCorrections(DATA) {
    const path = join(DATA, 'corrections.json');
    if (correctionsFor?.path !== path) {
        correctionsFor = { path, data: loadJson(path, null) };
    }
    return correctionsFor.data;
}

function summarizeActivity(a, DATA) {
    const km = a.distance ? a.distance / 1000 : null;
    const out = {
        // trengs for å slå opp data/splits/<id>.json og data/devfields/<id>.json
        id: a.activityId ?? null,
        name: a.activityName ?? null,
        type: a.activityType?.typeKey ?? null,
        km: round(km, 2),
        time_s: round(a.duration),
        pace_s: km && a.duration ? round(a.duration / km) : null,
        hr: round(a.averageHR),
        max_hr: round(a.maxHR),
        elev_m: round(a.elevationGain),
        te: round(a.aerobicTrainingEffect, 1),
        // styrkeøkter: totaler; per-øvelse-detaljene legges på som .ex under
        sets: round(a.totalSets),
        reps: round(a.totalReps),
        // stigningsjustert tempo — mer rettferdig enn pace_s på terreng-/bakkeløp
        gap_s: a.avgGradeAdjustedSpeed ? round(1000 / a.avgGradeAdjustedSpeed) : null,
        // fra pulsbelte (HRM Pro Plus) når det er brukt; mangler ellers
        power_w: round(a.avgPower),
        cad: round(a.averageRunningCadenceInStepsPerMinute),
        gct_ms: round(a.avgGroundContactTime),
        vert_osc_cm: round(a.avgVerticalOscillation, 1),
        vert_ratio_pct: round(a.avgVerticalRatio, 1),
        gct_balance_pct: round(a.avgGroundContactBalance, 1)
    };
    for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
    const dev = DATA ? developerFields(DATA, a.activityId) : null;
    if (dev) out.dev = dev;
    const ex = summarizeExercises(a, DATA ? loadCorrections(DATA) : null, DATA);
    if (ex) out.ex = ex;
    return out;
}

// Vekt fra data/status.json → { '<dato>': { kg, fat_pct } }. Endepunktet er
// ikke verifisert og de to variantene svarer med hver sin form (se lib/garmin.js),
// så begge leses her. Garmin oppgir gram; verdier over 1000 tolkes som gram og
// deles ned, slik at en fremtidig kg-variant også lander riktig.
//
// TO FELLER, begge observert i ekte data. En dag kan f.eks. se slik ut:
//
//   06:46  <vekt A> g  INDEX_SCALE   fett 19,8 %
//   06:49  <vekt B> g  INDEX_SCALE   fett 21,3 %   (2 kg tyngre, 3 min senere)
//   19:27  <vekt B> g  USER_SETTING
//
// 1. `latestWeight` er ikke nødvendigvis en veiing. En `USER_SETTING` —
//    profilvekta i Garmin, tastet inn for hånd — er ofte den ferskeste, og
//    her pekte `latestWeight` på den. Derfor filtreres det på ekte vektkilder.
//
// 2. Selv blant ekte veiinger kan én dag ha innbyrdes umulige tall. To
//    INDEX_SCALE-målinger tre minutter fra hverandre skilte 2,0 kg og 1,5
//    prosentpoeng fett. Da er den ene feil, og retningen er kjent: en ny
//    påstigning minutter etter den første kan bare legge til vekt (klær,
//    gjenstander, feil profil på vekta), aldri fjerne den.
//
// Regelen er derfor DAGENS FØRSTE veiing, ikke den siste — som også er
// konvensjonen for vektlogging: morgenvekt, før dagen legger på seg. Både
// nabodagene og fettprosenten pekte samme vei da regelen ble utledet.
//
// Avviket skjules ikke: er det mer enn 1 kg mellom veiingene samme dag,
// legges `weight_spread_kg` på dagen, så en vekt som tilordner målinger til
// feil profil blir synlig i stedet for å bli stilltiende midlet bort.
const SCALE_SOURCES = new Set(['INDEX_SCALE', 'CONNECTED_SCALE', 'THIRD_PARTY']);

function pickWeighing(summary) {
    const målinger = (summary.allWeightMetrics ?? []).filter((m) => m.weight != null);
    const fraVekt = målinger.filter((m) => SCALE_SOURCES.has(m.sourceType));
    if (!fraVekt.length) return { måling: summary.latestWeight ?? målinger.at(-1) ?? null, spread: 0 };
    const tidligst = fraVekt.reduce((a, b) => ((b.timestampGMT ?? 0) < (a.timestampGMT ?? 0) ? b : a));
    const vekter = fraVekt.map((m) => m.weight);
    return { måling: tidligst, spread: (Math.max(...vekter) - Math.min(...vekter)) / 1000 };
}

function weightByDate(status) {
    const w = status?.weight;
    if (!w) return new Map();
    const rows = [
        ...(w.dailyWeightSummaries ?? []).map((r) => [r.summaryDate ?? r.calendarDate, pickWeighing(r)]),
        ...(w.dateWeightList ?? []).map((r) => [r.calendarDate ?? r.summaryDate, { måling: r, spread: 0 }])
    ];
    const out = new Map();
    for (const [date, { måling, spread }] of rows) {
        if (!date || måling?.weight == null) continue;
        out.set(date, {
            kg: round(måling.weight > 1000 ? måling.weight / 1000 : måling.weight, 1),
            fat_pct: måling.bodyFat ?? null,
            spread: spread > 1 ? round(spread, 1) : null
        });
    }
    return out;
}

function summarizeDay(daily, dayActivities, DATA, weight) {
    const d = daily ?? {};
    const tr = Array.isArray(d.training_readiness) ? d.training_readiness[0] : d.training_readiness;
    const sleepSec = d.sleep?.dailySleepDTO?.sleepTimeSeconds;
    const out = {
        rhr: d.rhr?.allMetrics?.metricsMap?.WELLNESS_RESTING_HEART_RATE?.[0]?.value ?? null,
        hrv: d.hrv?.hrvSummary?.lastNightAvg ?? null,
        hrv_status: d.hrv?.hrvSummary?.status ?? null,
        sleep_h: sleepSec ? round(sleepSec / 3600, 2) : null,
        sleep_score: d.sleep?.dailySleepDTO?.sleepScores?.overall?.value ?? null,
        stress: d.stress?.avgStressLevel ?? null,
        readiness: tr?.score ?? null,
        weight_kg: weight?.kg ?? null,
        body_fat_pct: weight?.fat_pct ?? null,
        weight_spread_kg: weight?.spread ?? null
    };
    for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
    const runs = dayActivities.filter((a) => RUN_TYPES.has(a.activityType?.typeKey));
    const other = dayActivities.filter((a) => !RUN_TYPES.has(a.activityType?.typeKey));
    if (runs.length) out.runs = runs.map((a) => summarizeActivity(a, DATA));
    if (other.length) out.other = other.map((a) => summarizeActivity(a, DATA));
    return out;
}

// Garmins personalRecord-endepunkt gir bare et numerisk typeId, ikke navn.
// Kartlagt empirisk mot faktiske rekorder (5 km-verdien traff 17:xx, som
// stemmer med kjent 5 km-form; 10 km traff tilsvarende) — udokumenterte,
// verifiser mot nye typeId-er hvis de dukker opp uten treff i denne lista.
const PR_TYPER = { 1: '1 km', 2: '1 mile', 3: '5 km', 4: '10 km' };

function summarizePersonalRecords(records) {
    if (!Array.isArray(records)) return null;
    const out = records
        .filter((r) => r.status === 'ACCEPTED' && PR_TYPER[r.typeId])
        .map((r) => ({
            distanse: PR_TYPER[r.typeId],
            tid_s: round(r.value),
            dato: (r.activityStartDateTimeLocalFormatted ?? '').slice(0, 10) || null,
            aktivitet: r.activityName ?? null
        }));
    return out.length ? out : null;
}

function summarizeStatus(s) {
    if (!s) return null;
    const vo2 = s.max_metrics?.[0]?.generic
        ?? s.max_metrics?.generic
        ?? s.training_status?.mostRecentVO2Max?.generic;
    const rp = Array.isArray(s.race_predictions) ? s.race_predictions[0] : s.race_predictions;
    const ltSpeed = s.lactate_threshold_speed?.at(-1)?.value;
    return {
        synced_at: s.synced_at ?? null,
        vo2max: vo2?.vo2MaxPreciseValue != null
            ? { value: vo2.vo2MaxPreciseValue, date: vo2.calendarDate ?? null }
            : null,
        predictions_s: rp
            ? { k5: rp.time5K ?? null, k10: rp.time10K ?? null, half: rp.timeHalfMarathon ?? null, marathon: rp.timeMarathon ?? null }
            : null,
        threshold: ltSpeed
            ? { pace_s_per_km: round(100 / ltSpeed), hr: s.lactate_threshold_hr?.at(-1)?.value ?? null }
            : null,
        endurance: s.endurance_score?.overallScore != null
            ? { score: s.endurance_score.overallScore, classification: s.endurance_score.classification ?? null }
            : null,
        personal_records: summarizePersonalRecords(s.personal_records)
    };
}

export function buildSummary(DATA) {
    const activities = loadActivities(DATA);
    const byDate = new Map();
    for (const a of activities) {
        const date = (a.startTimeLocal ?? '').slice(0, 10);
        if (!date) continue;
        if (!byDate.has(date)) byDate.set(date, []);
        byDate.get(date).push(a);
    }

    const dailyDir = join(DATA, 'daily');
    const dailyDates = existsSync(dailyDir)
        ? readdirSync(dailyDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, 10))
        : [];
    const status = loadJson(join(DATA, 'status.json'), null);
    const weights = weightByDate(status);
    // Vektdatoene er med i unionen: en måling på en dag uten øktdata eller
    // daglig helsedata skal fortsatt havne i summary.
    const allDates = [...new Set([...dailyDates, ...byDate.keys(), ...weights.keys()])].sort();

    const days = allDates.map((date) => ({
        date,
        ...summarizeDay(loadJson(join(dailyDir, `${date}.json`), null), byDate.get(date) ?? [], DATA, weights.get(date))
    }));

    return {
        note: 'Avledet fra data/daily, data/activities, data/status.json og data/history.json — regenereres av sync.js, ikke rediger for hånd.',
        status: summarizeStatus(status),
        // Formmålerne over tid, tatt med som de er fra data/history.json (som
        // er ekte lagret historikk, ikke avledet — se lib/history.js).
        history: loadJson(join(DATA, 'history.json'), []),
        days
    };
}

export function writeSummary(DATA) {
    const summary = buildSummary(DATA);
    writeFileSync(join(DATA, 'summary.json'), JSON.stringify(summary, null, 1));
    return summary;
}
