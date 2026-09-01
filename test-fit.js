// Test for lib/fit.js: bygger en syntetisk FIT-fil med developer fields (slik
// Stryds Connect IQ-felt skriver dem), zipper den, og kjører parseren mot en
// falsk Garmin-klient. Verifiserer feltnavn, gjennomsnitt og runde-inndeling
// uten å røre nettverket.
//
// Kjør:  node test-fit.js

import { Encoder, Profile } from '@garmin/fitsdk';
import { zipSync } from 'fflate';
import { developerFieldSummary } from './lib/fit.js';

const FIT_UINT16 = 0x84;
const START = new Date('2026-01-01T09:00:00Z');

function byggFitFil({ powers, formPowers, lapLengths }) {
    const devId = { developerDataIndex: 0, applicationId: Array(16).fill(1), applicationVersion: 1 };
    const felt = [
        { developerDataIndex: 0, fieldDefinitionNumber: 0, fitBaseTypeId: FIT_UINT16, fieldName: 'Power', units: 'Watts', nativeMesgNum: Profile.MesgNum.RECORD },
        { developerDataIndex: 0, fieldDefinitionNumber: 1, fitBaseTypeId: FIT_UINT16, fieldName: 'Form Power', units: 'Watts', nativeMesgNum: Profile.MesgNum.RECORD }
    ];

    const enc = new Encoder();
    felt.forEach((f, i) => enc.addDeveloperField(i, devId, f));
    enc.onMesg(Profile.MesgNum.FILE_ID, { type: 'activity', manufacturer: 'garmin', product: 1, timeCreated: START, serialNumber: 1 });
    enc.onMesg(Profile.MesgNum.DEVELOPER_DATA_ID, devId);
    felt.forEach((f) => enc.onMesg(Profile.MesgNum.FIELD_DESCRIPTION, f));

    powers.forEach((p, i) => {
        enc.onMesg(Profile.MesgNum.RECORD, {
            timestamp: new Date(START.getTime() + i * 1000),
            heartRate: 130 + (i % 5),
            developerFields: { 0: p, 1: formPowers[i] }
        });
    });

    let offset = 0;
    for (const lengde of lapLengths) {
        enc.onMesg(Profile.MesgNum.LAP, {
            startTime: new Date(START.getTime() + offset * 1000),
            totalElapsedTime: lengde,
            totalTimerTime: lengde
        });
        offset += lengde;
    }
    return enc.close();
}

function fakeKlient(fitBytes, { zipNavn = '23898036294_ACTIVITY.fit' } = {}) {
    const zip = zipSync({ [zipNavn]: fitBytes });
    return { client: { get: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) } };
}

function sjekk(navn, faktisk, forventet) {
    const ok = JSON.stringify(faktisk) === JSON.stringify(forventet);
    console.log(`${ok ? '  ok  ' : ' FEIL '} ${navn}${ok ? '' : `\n         forventet ${JSON.stringify(forventet)}\n         fikk      ${JSON.stringify(faktisk)}`}`);
    return ok;
}

// 10 målinger: kraft 200..209, form power fast 60. To runder à 5 sekunder.
const powers = Array.from({ length: 10 }, (_, i) => 200 + i);
const formPowers = Array.from({ length: 10 }, () => 60);
const fit = byggFitFil({ powers, formPowers, lapLengths: [5, 5] });

const resultat = await developerFieldSummary(fakeKlient(fit), 23898036294);

let alleOk = true;
alleOk &= sjekk('feltnavn og enheter leses ut',
    resultat.fields, [{ name: 'Power', units: 'Watts' }, { name: 'Form Power', units: 'Watts' }]);
alleOk &= sjekk('antall målinger', resultat.samples, 10);
alleOk &= sjekk('snitt/min/maks for hele økta',
    resultat.overall.Power, { avg: 204.5, min: 200, max: 209, n: 10 });
alleOk &= sjekk('felt uten variasjon', resultat.overall['Form Power'], { avg: 60, min: 60, max: 60, n: 10 });
alleOk &= sjekk('runde 1 dekker de fem første målingene',
    resultat.laps[0].Power, { avg: 202, min: 200, max: 204, n: 5 });
alleOk &= sjekk('runde 2 dekker de fem siste',
    resultat.laps[1].Power, { avg: 207, min: 205, max: 209, n: 5 });

// En FIT-fil uten developer fields skal gi tomt resultat, ikke krasj — det er
// tilfellet for alle økter kjørt uten Connect IQ-felt.
const utenFelt = new Encoder();
utenFelt.onMesg(Profile.MesgNum.FILE_ID, { type: 'activity', manufacturer: 'garmin', product: 1, timeCreated: START, serialNumber: 1 });
utenFelt.onMesg(Profile.MesgNum.RECORD, { timestamp: START, heartRate: 130 });
const tomt = await developerFieldSummary(fakeKlient(utenFelt.close()), 1);
alleOk &= sjekk('økt uten developer fields gir tom feltliste', tomt.fields, []);
alleOk &= sjekk('økt uten developer fields gir tomt sammendrag', tomt.overall, {});

console.log(alleOk ? '\nAlle tester passerte.' : '\nNoen tester feilet.');
process.exit(alleOk ? 0 : 1);
