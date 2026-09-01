// Retter terskelverdiene i Garmin Connect — laktatterskel-puls (LTHR) og
// terskelfart — når autodeteksjonen har satt dem feil.
//
// Kjør:
//   node fix-threshold.js               # bruker threshold-fix.json
//   node fix-threshold.js --dry-run     # vis diffen, send ingenting
//   node fix-threshold.js <fil>         # annen rettelsesfil
//
// Skjemaet i threshold-fix.json:
//
//   {
//     "why": "fritekst — hvorfor rettelsen finnes",
//     "apply": false,          // false = tørrkjøring uansett. Sikringen.
//     "expect": { "hr": 175 }, // tilstanden rettelsen forventer å finne
//     "hr": 168,               // ny LTHR (slag/min)
//     "pace": "4:30",          // ny terskelfart (min:sek per km)
//     "stopAutoDetect": false  // sett thresholdHeartRateAutoDetected = false
//   }
//
// "expect" er samme sikring som i fix-strength.js: treffer den ikke, gjør
// skriptet ingenting og sier fra — så en rettelse som er blitt overflødig
// (fordi verdien alt er rettet) råtner ikke i det stille.
//
// BAKGRUNN. Garmin autodetekterer terskelen etter harde økter, og én korrupt
// lap holder til å sette den grovt feil. Den vanligste kilden er baneøkter:
// i `track_running`-modus snapper klokka lap-distanser til banegeometrien, og
// en enkelt lap kan bli hundrevis av meter for lang uten at noe annet ser feil
// ut. Følgene treffer alt nedenfor: pulssonene blir for høye, sone 4–5-minutter
// forsvinner fra harde økter, og løpsprediksjonene hopper over natta uten at
// noe har skjedd med formen.
//
// Autodeteksjonen kan slås av i Garmin-appen (Puls → Automatisk registrering).
// Gjør du det, oppdaterer ikke tallet seg selv lenger — da må det vedlikeholdes
// herfra, ellers undervurderer Garmin deg like systematisk som det overvurderte
// deg. Se README under «Terskelverdier».
//
// API-ET (verifisert 30.08.2026 med inspect-threshold.js):
//
//   GET/PUT https://connectapi.garmin.com/userprofile-service/userprofile/user-settings
//   { id, userData: { lactateThresholdHeartRate, lactateThresholdSpeed, … }, … }
//
// `lactateThresholdSpeed` er m/s delt på 10 — tempo i sek/km er 100 / verdien,
// samme enhet som stats-serien synken leser. Hele objektet sendes tilbake med
// bare de endrede feltene rørt; endepunktet erstatter, så en delvis kropp ville
// kunne nulle ut vekt, søvnvinduer og resten av profilen.
//
// Pulssonene ligger for seg i /biometric-service/heartRateZones og er avledet
// av LTHR (`zone5Floor` ER terskelen). Skriptet leser dem etterpå og sier fra
// om de fulgte med av seg selv — gjorde de ikke det, må de settes i Connect.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { connect } from './lib/garmin.js';
import { DATA } from './lib/paths.js';

const API = 'https://connectapi.garmin.com';
const SETTINGS = `${API}/userprofile-service/userprofile/user-settings`;
const ZONES = `${API}/biometric-service/heartRateZones`;

const args = process.argv.slice(2);
const tørrkjør = args.includes('--dry-run');
const fil = args.find((a) => !a.startsWith('--')) ?? 'threshold-fix.json';

const spec = JSON.parse(readFileSync(fil, 'utf8'));

/** "4:30" → 270 sekunder. */
function paceTilSek(t) {
    const m = String(t).match(/^(\d+):(\d{1,2})$/);
    if (!m) throw new Error(`Ugyldig pace "${t}" — bruk formen "4:30"`);
    return Number(m[1]) * 60 + Number(m[2]);
}
const sekTilPace = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
/** Garmins enhet: m/s delt på 10. Tempo i sek/km er 100 / verdien. */
const paceTilVerdi = (sekPerKm) => 100 / sekPerKm;
const verdiTilPace = (v) => (v ? sekTilPace(100 / v) : null);

const gc = await connect();

const nå = await gc.client.get(SETTINGS);
const ud = nå?.userData;
if (!ud) {
    console.error('Fikk ikke lest user-settings — avbryter uten å skrive.');
    process.exit(1);
}

const fraHr = ud.lactateThresholdHeartRate;
const fraFart = ud.lactateThresholdSpeed;
const fraAuto = ud.thresholdHeartRateAutoDetected;

console.log(`Nå i Garmin:  LTHR ${fraHr}  ·  terskelfart ${verdiTilPace(fraFart)}/km (${fraFart})  ·  autodetekt ${fraAuto}`);
if (spec.why) console.log(`\n${spec.why}\n`);

// Sikringen: treffer ikke forventningen, er rettelsen enten alt utført eller
// skrevet mot en annen tilstand enn den som faktisk står. Begge deler betyr stopp.
if (spec.expect) {
    const feil = [];
    if (spec.expect.hr != null && spec.expect.hr !== fraHr) feil.push(`LTHR: forventet ${spec.expect.hr}, fant ${fraHr}`);
    if (spec.expect.pace != null) {
        const v = verdiTilPace(fraFart);
        if (v !== spec.expect.pace) feil.push(`terskelfart: forventet ${spec.expect.pace}, fant ${v}`);
    }
    if (feil.length) {
        console.log('Forventningen i "expect" stemmer ikke:');
        for (const f of feil) console.log(`  ! ${f}`);
        console.log('\nGjør ingenting. Er verdien alt rettet, kan rettelsen slettes.');
        process.exit(0);
    }
}

const tilHr = spec.hr ?? fraHr;
const tilSek = spec.pace != null ? paceTilSek(spec.pace) : null;
const tilFart = tilSek != null ? paceTilVerdi(tilSek) : fraFart;
const tilAuto = spec.stopAutoDetect ? false : fraAuto;

const endringer = [];
if (tilHr !== fraHr) endringer.push(`  LTHR             ${fraHr} → ${tilHr}`);
if (tilFart !== fraFart) endringer.push(`  terskelfart      ${verdiTilPace(fraFart)}/km → ${sekTilPace(tilSek)}/km  (${fraFart} → ${tilFart})`);
if (tilAuto !== fraAuto) endringer.push(`  autodeteksjon    ${fraAuto} → ${tilAuto}   (hindrer at Garmin setter den tilbake)`);

if (!endringer.length) {
    console.log('Ingenting å endre — verdiene står allerede slik rettelsen ber om.');
    process.exit(0);
}
console.log('Endringer:');
console.log(endringer.join('\n'));

if (tørrkjør || !spec.apply) {
    console.log(`\nTørrkjøring${!spec.apply && !tørrkjør ? ' ("apply" er ikke true i ' + fil + ')' : ''} — ingenting er sendt.`);
    process.exit(0);
}

// Sikkerhetskopi før skriving. Endepunktet erstatter hele profilen, og selv om
// vi bare rører tre felter er det billig å kunne legge tilbake det som sto.
const backup = join(DATA, 'backup', `user-settings-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
mkdirSync(dirname(backup), { recursive: true });
writeFileSync(backup, JSON.stringify(nå, null, 2));
console.log(`\nSikkerhetskopi av user-settings: ${backup}`);

const kropp = { ...nå, userData: { ...ud, lactateThresholdHeartRate: tilHr, lactateThresholdSpeed: tilFart, thresholdHeartRateAutoDetected: tilAuto } };

try {
    await gc.client.put(SETTINGS, kropp);
    console.log('PUT user-settings: OK');
} catch (err) {
    console.error(`PUT feilet: ${err?.response?.status ?? err.message}`);
    console.error(JSON.stringify(err?.response?.data ?? {}).slice(0, 500));
    process.exit(1);
}

// Les tilbake. Garmin svarer 200 på ting den ikke lagret, så eneste ærlige
// bekreftelse er et friskt GET.
const etter = (await gc.client.get(SETTINGS))?.userData ?? {};
console.log(`\nEtter skriving: LTHR ${etter.lactateThresholdHeartRate}  ·  terskelfart ${verdiTilPace(etter.lactateThresholdSpeed)}/km  ·  autodetekt ${etter.thresholdHeartRateAutoDetected}`);

const ok = etter.lactateThresholdHeartRate === tilHr && Math.abs((etter.lactateThresholdSpeed ?? 0) - tilFart) < 1e-6;
console.log(ok ? '✓ Verdiene står som bestilt.' : '! Verdiene ble IKKE som bestilt — se over.');

// Pulssonene er avledet av LTHR, men ikke nødvendigvis oppdatert i samme kall.
try {
    const soner = await gc.client.get(ZONES);
    const løp = (soner ?? []).find((z) => z.sport === 'DEFAULT') ?? (soner ?? [])[0];
    if (løp) {
        console.log(`\nPulssoner (${løp.sport}, metode ${løp.trainingMethod}): terskel ${løp.lactateThresholdHeartRateUsed}, sone 4 fra ${løp.zone4Floor}, sone 5 fra ${løp.zone5Floor}`);
        console.log(løp.lactateThresholdHeartRateUsed === tilHr
            ? '✓ Sonene fulgte med.'
            : `! Sonene henger igjen på ${løp.lactateThresholdHeartRateUsed} — sett dem i Garmin Connect under pulssoner.`);
    }
} catch (err) {
    console.log(`\n(Fikk ikke lest pulssonene: ${err?.response?.status ?? err.message} — sjekk dem i appen.)`);
}
