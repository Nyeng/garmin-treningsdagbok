// Diagnoseverktøy: finner hvor Garmin lagrer terskelverdiene — laktatterskel-puls
// (LTHR) og terskelfart — slik at de kan RETTES, ikke bare leses.
//
// Kjør:
//   node inspect-threshold.js
//
// Finnes fordi Garmin autodetekterer terskelen etter harde økter, og en enkelt
// korrupt lap kan sette den grovt feil — typisk en baneøkt der klokka snapper
// lap-distansen til banegeometrien og påstår flere hundre meter for mye.
// Konsekvensen er at alle pulssoner, all intensitetsfordeling og alle
// løpsprediksjoner blir skjeve, uten at noe har skjedd med formen.
//
// Synken LESER allerede terskelen (lib/garmin.js: lactateThresholdSpeed /
// lactateThresholdHeartRate under biometric-service/stats). De endepunktene er
// statistikk-serier og tar neppe imot skriving. Dette skriptet leter etter
// innstillingen bak dem: hvilket endepunkt som holder gjeldende verdi, hvilket
// skjema det bruker, og om det svarer på annet enn GET.
//
// Skriver ALDRI noe til Garmin — bare GET og OPTIONS. Kjøres via
// .github/workflows/inspect-threshold.yml i skyøkter, der tokenene ligger som
// repo-secrets.

import { connect, getDisplayName } from './lib/garmin.js';

const API = 'https://connectapi.garmin.com';

const gc = await connect();
const dn = await getDisplayName(gc);
console.log(`Bruker: ${dn}\n`);

/** GET som aldri kaster — vi prøver mange endepunkter og de fleste bommer. */
async function probe(navn, url, params) {
    try {
        const data = await gc.client.get(url, params ? { params } : undefined);
        const json = JSON.stringify(data);
        console.log(`\n✓ ${navn}`);
        console.log(`  ${url}`);
        console.log(`  ${json.length} tegn`);
        // Hele svaret når det er lite, ellers toppnøklene + et utdrag. Vi leter
        // etter feltnavn, ikke etter verdier.
        console.log(json.length <= 2500 ? `  ${json}` : `  nøkler: ${Object.keys(data ?? {}).join(', ')}\n  ${json.slice(0, 2000)}…`);
        return data;
    } catch (err) {
        const status = err?.response?.status ?? err.message;
        console.log(`✗ ${navn.padEnd(38)} ${status}`);
        return null;
    }
}

// Kandidatene er gjettet ut fra hvordan Garmin Connect-nettappen er bygget:
// terskelpuls settes under pulssoner, terskelfart under fartssoner, og begge
// speiles i brukerprofilens innstillinger. Vi vet ikke hvilke som finnes —
// det er hele poenget med å prøve.
console.log('=== BRUKERINNSTILLINGER ===');
const settings = await probe('user-settings', `${API}/userprofile-service/userprofile/user-settings`);
await probe('personal-information', `${API}/userprofile-service/userprofile/personal-information`);
await probe('settings', `${API}/userprofile-service/userprofile/settings`);

console.log('\n=== SONER ===');
await probe('heartRateZones', `${API}/biometric-service/heartRateZones`);
await probe('heartRateZones/sport/running', `${API}/biometric-service/heartRateZones/sport/running`);
await probe('paceZones', `${API}/biometric-service/paceZones`);
await probe('speedZones', `${API}/biometric-service/speedZones`);
await probe('powerZones', `${API}/biometric-service/powerZones`);

console.log('\n=== TERSKEL SOM STATISTIKK (det synken bruker i dag) ===');
const today = new Date().toISOString().slice(0, 10);
const monthAgo = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
await probe('stats/lactateThresholdSpeed', `${API}/biometric-service/stats/lactateThresholdSpeed/range/${monthAgo}/${today}`, { aggregation: 'daily' });
await probe('stats/lactateThresholdHeartRate', `${API}/biometric-service/stats/lactateThresholdHeartRate/range/${monthAgo}/${today}`, { aggregation: 'daily' });

console.log('\n=== ANDRE STEDER TERSKELEN KAN LIGGE ===');
await probe('biometricprofile', `${API}/biometric-service/biometricprofile`);
await probe('biometricprofile/range', `${API}/biometric-service/biometric/${dn}`);
await probe('metrics/lactatethreshold', `${API}/metrics-service/metrics/lactatethreshold/${today}`);

// Hvis user-settings finnes, er det trolig der rettelsen skal skje: den typen
// endepunkt tar som regel imot hele objektet på nytt med PUT. Vi skriver ikke
// noe her, men vi kan si hvilke felter som ser ut til å gjelde terskel — det
// er dem et fix-skript må sette.
if (settings) {
    console.log('\n=== FELTER SOM NEVNER TERSKEL/SONE I user-settings ===');
    const treff = [];
    const gå = (o, sti = '') => {
        if (o === null || typeof o !== 'object') return;
        for (const [k, v] of Object.entries(o)) {
            const p = sti ? `${sti}.${k}` : k;
            if (/threshold|lactate|zone|maxhr|resthr|vo2|ftp/i.test(k)) treff.push(`  ${p} = ${JSON.stringify(v)?.slice(0, 200)}`);
            gå(v, p);
        }
    };
    gå(settings);
    console.log(treff.length ? treff.join('\n') : '  (ingen)');
}

console.log('\nFerdig. Ingenting er skrevet til Garmin.');
