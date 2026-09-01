// Henter og leser developer fields fra en aktivitets FIT-fil.
//
// Bakgrunn: Connect-API-et gir sammendrag og runde-data, men *ikke* feltene
// en Connect IQ-app skriver (developer fields). Stryd-kraft, form power og
// beinstivhet finnes bare der. Eneste veien til dem er å laste ned original-
// FIT-fila (en zip fra download-service) og lese den.
//
// Verifisert mot @garmin/fitsdk 21.x: dekoderen legger feltbeskrivelsene i
// messages.fieldDescriptionMesgs (med `key`, `fieldName`, `units`), og verdiene
// på hver record under `developerFields`, nøklet på samme `key`.

import { Decoder, Stream } from '@garmin/fitsdk';
import { unzipSync } from 'fflate';

const DOWNLOAD = 'https://connectapi.garmin.com/download-service/files/activity';

/** Gjennomsnitt/maks for en tallserie, avrundet så JSON-fila holder seg lesbar. */
function stats(values) {
    const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x));
    if (!v.length) return null;
    const avg = v.reduce((a, b) => a + b, 0) / v.length;
    return {
        avg: Math.round(avg * 100) / 100,
        min: Math.round(Math.min(...v) * 100) / 100,
        max: Math.round(Math.max(...v) * 100) / 100,
        n: v.length
    };
}

/** Laster ned FIT-zipen for en aktivitet og pakker ut selve .fit-fila. */
async function downloadFit(gc, activityId) {
    const zip = await gc.client.get(`${DOWNLOAD}/${activityId}`, { responseType: 'arraybuffer' });
    const entries = unzipSync(new Uint8Array(zip));
    const name = Object.keys(entries).find((n) => n.toLowerCase().endsWith('.fit'));
    if (!name) throw new Error(`fant ingen .fit i zipen (innhold: ${Object.keys(entries).join(', ')})`);
    return entries[name];
}

/**
 * Leser developer fields fra en aktivitet og returnerer et kompakt sammendrag:
 *
 *   { activityId, fields: [{ name, units }], samples, overall: { <felt>: {avg,min,max,n} },
 *     laps: [{ lap, <felt>: {avg,...} }] }
 *
 * Returnerer alltid et objekt — også når aktiviteten ikke har developer fields
 * (da er `fields` tom). Det er med vilje: resultatet lagres uansett, slik at
 * synken slipper å laste ned den samme FIT-fila om og om igjen.
 */
export async function developerFieldSummary(gc, activityId) {
    const bytes = await downloadFit(gc, activityId);
    const decoder = new Decoder(Stream.fromByteArray(bytes));
    if (!decoder.isFIT()) throw new Error('nedlastet fil er ikke en FIT-fil');

    const { messages } = decoder.read({ applyScaleAndOffset: true, expandSubFields: true });
    const descriptions = messages.fieldDescriptionMesgs ?? [];
    const records = messages.recordMesgs ?? [];

    const byKey = new Map(descriptions.map((d) => [d.key, { name: d.fieldName, units: d.units }]));
    const result = {
        activityId,
        fields: [...byKey.values()],
        samples: records.length,
        overall: {},
        laps: []
    };
    if (!byKey.size) return result;

    // Verdiene ligger per record; samles per felt for hele økta og per runde.
    const series = new Map([...byKey.keys()].map((k) => [k, []]));
    const timestamps = [];
    for (const r of records) {
        timestamps.push(r.timestamp instanceof Date ? r.timestamp.getTime() : null);
        for (const [key, list] of series) list.push(r.developerFields?.[key] ?? null);
    }
    for (const [key, list] of series) {
        const s = stats(list);
        if (s) result.overall[byKey.get(key).name] = s;
    }

    // Runde-inndelingen fra FIT-fila, så tallene kan legges ved siden av
    // Garmins egne runder i data/splits/.
    const laps = messages.lapMesgs ?? [];
    laps.forEach((lap, i) => {
        const start = lap.startTime instanceof Date ? lap.startTime.getTime() : null;
        const end = start != null && lap.totalElapsedTime != null
            ? start + lap.totalElapsedTime * 1000
            : null;
        if (start == null || end == null) return;
        const row = { lap: i + 1 };
        for (const [key, list] of series) {
            const inLap = list.filter((_, idx) => timestamps[idx] >= start && timestamps[idx] < end);
            const s = stats(inLap);
            if (s) row[byKey.get(key).name] = s;
        }
        result.laps.push(row);
    });

    return result;
}
