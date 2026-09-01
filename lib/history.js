// Bygger data/history.json — ett øyeblikksbilde per dato av formmålerne
// (VO2max, terskelfart/-puls, løpsprediksjoner, endurance score).
//
// Hvorfor en egen fil: Garmin gir bare *siste* verdi for prediksjonene og
// VO2max, så trenden finnes ingen andre steder enn her. Fila er append-only og
// vokser med ett punkt per synk. I motsetning til data/summary.json kan den
// IKKE regenereres fra rådataene — slettes den, er historikken tapt.
//
// Terskeldataene er unntaket: de har dato per måling og hentes for et helt år
// ved hver synk, så de fyller seg selv inn bakover.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const round = (v, dec = 0) => (v == null ? null : Number(v.toFixed(dec)));

const loadJson = (path, fallback) =>
    existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;

// Slår sammen felt for felt: en kilde som bare kjenner terskelen skal ikke
// viske ut prediksjonene som allerede står på samme dato.
function merge(byDate, date, fields) {
    const set = Object.fromEntries(Object.entries(fields).filter(([, v]) => v != null));
    if (!date || !Object.keys(set).length) return;
    byDate.set(date, { ...(byDate.get(date) ?? {}), ...set, date });
}

function predictionFields(p) {
    return {
        pred_k5_s: p.time5K ?? null,
        pred_k10_s: p.time10K ?? null,
        pred_half_s: p.timeHalfMarathon ?? null,
        pred_marathon_s: p.timeMarathon ?? null
    };
}

// Bygger den nye historikken av et status.json-øyeblikksbilde lagt oppå det
// som allerede er samlet. Eksportert for seg selv så den kan kjøres over gamle
// revisjoner av status.json (backfill fra git-historikken).
export function historyFrom(status, existing = []) {
    const byDate = new Map(existing.filter((e) => e?.date).map((e) => [e.date, { ...e }]));
    if (!status) return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));

    // Terskel: en serie med én oppføring per måling. `value` er m/s delt på 10.
    const ltHr = new Map((status.lactate_threshold_hr ?? []).map((e) => [e.until ?? e.from, e.value]));
    for (const e of status.lactate_threshold_speed ?? []) {
        if (!e?.value) continue;
        const date = e.until ?? e.from;
        merge(byDate, date, {
            threshold_pace_s: round(100 / e.value),
            threshold_hr: ltHr.get(date) ?? null
        });
    }

    // Prediksjoner: `latest` gir ett punkt (i dag). `daily` gir en serie når
    // endepunktet svarer — er den null, bygges trenden av de daglige punktene.
    const latest = Array.isArray(status.race_predictions) ? status.race_predictions[0] : status.race_predictions;
    const preds = [...(status.race_predictions_daily ?? []), ...(latest ? [latest] : [])];
    for (const p of preds) {
        if (p?.calendarDate) merge(byDate, p.calendarDate, predictionFields(p));
    }

    const vo2 = status.max_metrics?.[0]?.generic ?? status.training_status?.mostRecentVO2Max?.generic;
    if (vo2) merge(byDate, vo2.calendarDate, { vo2max: vo2.vo2MaxPreciseValue ?? vo2.vo2MaxValue ?? null });

    const es = status.endurance_score;
    if (es) merge(byDate, es.calendarDate, { endurance: es.overallScore ?? null });

    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function updateHistory(DATA) {
    const history = historyFrom(
        loadJson(join(DATA, 'status.json'), null),
        loadJson(join(DATA, 'history.json'), [])
    );
    writeFileSync(join(DATA, 'history.json'), JSON.stringify(history, null, 1));
    return history;
}
