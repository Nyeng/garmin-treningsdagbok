// Diagnoseverktøy: skriver ut hva Garmin faktisk har lagret på en aktivitet —
// hvilke datastrømmer den inneholder, om noen av dem kommer fra en Connect
// IQ-app (developer fields, f.eks. Stryd) i stedet for fra klokka selv, og
// hvilke øvelsessett som ligger på en styrkeøkt.
//
// Kjør:
//   node inspect-activity.js            # nyeste aktivitet
//   node inspect-activity.js <id>       # en bestemt aktivitet
//
// Finnes fordi synken henter aktivitetssammendrag og runde-data, og de
// endepunktene tar ikke med developer fields. Når et eksternt måleinstrument
// (Stryd, andre pods) ikke dukker opp i dagboka, er dette skriptet måten å
// finne ut om dataene i det hele tatt ble lagret hos Garmin.
//
// Skriver alt til stdout — kjøres via .github/workflows/inspect-activity.yml
// i skyøkter, der Garmin-tokenene ligger som repo-secrets.

import { connect } from './lib/garmin.js';

const API = 'https://connectapi.garmin.com';

const gc = await connect();

async function get(url, params) {
    try {
        return await gc.client.get(url, params ? { params } : undefined);
    } catch (err) {
        console.log(`  (feilet: ${err?.response?.status ?? err.message})`);
        return null;
    }
}

let activityId = process.argv[2];
if (!activityId) {
    const list = await gc.getActivities(0, 1);
    activityId = list?.[0]?.activityId;
    console.log(`Ingen id oppgitt — bruker nyeste aktivitet: ${activityId}`);
}

console.log(`\n=== AKTIVITET ${activityId} ===`);
const activity = await get(`${API}/activity-service/activity/${activityId}`);
if (activity) {
    console.log('navn:', activity.activityName);
    console.log('type:', activity.activityTypeDTO?.typeKey);
    console.log('enhet:', activity.metadataDTO?.manufacturer, activity.metadataDTO?.deviceId);
    for (const key of Object.keys(activity.metadataDTO ?? {})) {
        if (/connectiq|developer|app|sensor|pod/i.test(key)) {
            console.log(`metadata.${key}:`, JSON.stringify(activity.metadataDTO[key]).slice(0, 500));
        }
    }
}

// Øvelsessett: det Garmin har lagret per sett på en styrkeøkt (øvelse, reps,
// vekt). Sammendraget i data/activities/ har bare totaler per øvelse, så dette
// er eneste måten å se hvilke enkeltsett som faktisk avviker — og om settene har
// egne id-er, som avgjør om de kan rettes programmatisk i stedet for i GUI-et.
console.log('\n=== ØVELSESSETT ===');
const sets = await get(`${API}/activity-service/activity/${activityId}/exerciseSets`);
if (!sets) {
    console.log('Endepunktet svarte ikke — se statuskoden over.');
} else {
    const liste = Array.isArray(sets) ? sets : (sets.exerciseSets ?? []);
    console.log(`antall sett: ${liste.length}`);
    console.log('nøkler på svaret:', Array.isArray(sets) ? '(array)' : Object.keys(sets).join(', '));
    for (const [i, st] of liste.entries()) {
        const ex = st.exercises?.[0];
        console.log(
            `  ${String(i + 1).padStart(2)} ${st.setType ?? '?'} ${ex?.category ?? ''}/${ex?.name ?? ''}` +
            ` reps=${st.repetitionCount ?? '-'} vekt=${st.weight ?? '-'} varighet=${Math.round(st.duration ?? 0)}s`
        );
    }
    if (liste.length) {
        console.log('\nFELTNAVN på ett sett (avgjør om sett kan adresseres enkeltvis):');
        console.log(JSON.stringify(liste[0], null, 2).slice(0, 1200));
    }
}

// Hvilke HTTP-metoder klienten i det hele tatt kan sende. Garmin-klienten er
// ikke en rå axios-instans — den har bare get/post/put/delete, ingen generisk
// request(), så OPTIONS kan ikke sendes og endepunktet kan ikke spørres om hva
// det tillater. Skriving må derfor verifiseres på annen måte; se README under
// «Øvelsessett».
console.log('\n=== HTTP-METODER KLIENTEN STØTTER ===');
console.log([
    ...Object.getOwnPropertyNames(gc.client),
    ...Object.getOwnPropertyNames(Object.getPrototypeOf(gc.client) ?? {})
].filter((k) => typeof gc.client[k] === 'function' && /^(get|post|put|delete)$/.test(k)).join(', '));

console.log('\n=== DATASTRØMMER (metricDescriptors) ===');
const details = await get(`${API}/activity-service/activity/${activityId}/details`, {
    maxChartSize: 10,
    maxPolylineSize: 10,
    maxHeatMapSize: 10
});
const descriptors = details?.metricDescriptors ?? [];
console.log(`antall strømmer: ${descriptors.length}`);
const developerFields = [];
for (const d of descriptors) {
    const isDev = d.appID != null || d.developerFieldNumber != null || /developer/i.test(d.key ?? '');
    console.log(` ${isDev ? '*' : ' '} ${d.key}${d.unit?.key ? ` (${d.unit.key})` : ''}`);
    if (isDev) developerFields.push(d);
}

console.log('\n=== KONKLUSJON ===');
if (developerFields.length) {
    console.log(`${developerFields.length} felt kommer fra en Connect IQ-app (developer fields):`);
    for (const d of developerFields) console.log('  ', JSON.stringify(d).slice(0, 400));
    console.log('Dataene ER lagret hos Garmin og kan hentes inn i dagboka.');
} else {
    console.log('Ingen developer fields på aktiviteten — ingen Connect IQ-app skrev data.');
    console.log('En pod som bare er paret som sensor (fart/distanse) legger ikke igjen');
    console.log('egne felt; da finnes kraftdataene kun i podens egen app.');
}
