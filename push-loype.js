// Laster en løype (definert som ren data i loype.json) opp til Garmin Connect.
//
// Kjør:
//   node push-loype.js              # push løypa i loype.json
//   node push-loype.js --dry-run    # vis hva som ville blitt sendt
//   node push-loype.js --list       # list løypene dine (med id)
//   node push-loype.js --delete ID  # slett en løype
//
// Fila lages av finn-loype.js med --lagre:
//   node finn-loype.js --sted "Tromsø" --km 20 --rundtur --lagre loype.json
//
// Delingen finnes fordi søket og opplastingen hører hjemme på hver sin maskin:
// søket kan kjøres hvor som helst (bare åpne API-er), mens opplastingen krever
// Garmin-tokens, som finnes lokalt på maskina di og som repo-secrets i
// GitHub Actions. Ved å legge ruta i en fil blir det også *nøyaktig* den ruta
// som ble vurdert som blir lastet opp — søket kjøres ikke på nytt i skya, der
// Overpass kan svare noe annet eller ikke svare i det hele tatt.
//
// loype.json-formatet:
//   {
//     "navn": "20 km rundtur",           // Garmin-navnet
//     "beskrivelse": "...",
//     "meter": 18550,                    // total lengde
//     "stigningMeter": 662,
//     "fallMeter": 662,
//     "geoPoints": [                     // ruta, punkt for punkt
//       { "latitude": 69.65, "longitude": 18.96, "elevation": 4.8, "distance": 0 }
//     ]
//   }
//
// Pushen er idempotent: finnes det allerede en løype med samme navn, slettes
// den først, så en justering gir aldri duplikater på klokka.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, getDisplayName, endpoints } from './lib/garmin.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const API = 'https://connectapi.garmin.com';

/** Laster løypa opp til Garmin Connect. Returnerer courseId. */
export async function pushLoype(loype) {
    const gc = await connect();
    const dn = await getDisplayName(gc);

    // Rydd bort forgjengeren, slik push-workout.js gjør for dagsøkter.
    try {
        const eksisterende = await gc.client.get(...endpoints.courses(dn));
        for (const k of eksisterende ?? []) {
            if (k.courseName === loype.navn) {
                await gc.client.delete(`${API}/course-service/course/${k.courseId}`);
                console.log(`Slettet forrige «${k.courseName}» (id ${k.courseId})`);
            }
        }
    } catch (err) {
        console.warn(`  advarsel: fikk ikke listet/slettet gamle løyper (${err.message}) — fortsetter`);
    }

    // NB: feltnavnene her avviker fra GET-svaret (activityTypePk/rulePK/
    // distanceMeter, ikke activityType/privacyRule/distanceInMeters), og alle
    // fire toppfeltene er påkrevd. Se README under «Løyper (courses)».
    const svar = await gc.client.post(`${API}/course-service/course`, {
        courseName: loype.navn,
        description: loype.beskrivelse ?? '',
        activityTypePk: 1,          // 1 = løping
        rulePK: 2,                  // 2 = privat
        sourceTypeId: 3,
        distanceMeter: loype.meter,
        elevationGainMeter: loype.stigningMeter,
        elevationLossMeter: loype.fallMeter,
        startPoint: {
            latitude: loype.geoPoints[0].latitude,
            longitude: loype.geoPoints[0].longitude,
        },
        geoPoints: loype.geoPoints,
    });

    const id = svar?.courseId ?? svar?.id ?? '?';
    console.log(`Løype «${loype.navn}» opprettet i Garmin Connect (id ${id}).`);
    console.log('Send den til klokka i Garmin Connect-appen: Løyper → velg → send til enhet.');
    return id;
}

// --- CLI --------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
    const args = process.argv.slice(2);

    if (args.includes('--list')) {
        const gc = await connect();
        const dn = await getDisplayName(gc);
        for (const k of (await gc.client.get(...endpoints.courses(dn))) ?? []) {
            console.log(`${k.courseId}  ${k.courseName}  (${k.distanceInMeters ?? '?'} m)`);
        }
        process.exit(0);
    }

    const slett = args.includes('--delete') ? args[args.indexOf('--delete') + 1] : null;
    if (slett) {
        const gc = await connect();
        await gc.client.delete(`${API}/course-service/course/${slett}`);
        console.log(`Slettet løype ${slett}`);
        process.exit(0);
    }

    const loype = JSON.parse(readFileSync(join(ROOT, 'loype.json'), 'utf8'));
    if (args.includes('--dry-run')) {
        console.log(`«${loype.navn}» — ${(loype.meter / 1000).toFixed(2)} km, ${loype.stigningMeter} hm, ${loype.geoPoints.length} punkter`);
        console.log(loype.beskrivelse);
        console.log(`start: ${loype.geoPoints[0].latitude}, ${loype.geoPoints[0].longitude}`);
        process.exit(0);
    }
    await pushLoype(loype);
}
