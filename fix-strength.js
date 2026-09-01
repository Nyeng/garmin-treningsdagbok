// Retter øvelsessett på en styrkeøkt i Garmin Connect — vekter, reps og
// øvelseskategori — så loggen blir riktig ved kilden i stedet for å måtte
// lappes i data/corrections.json for alltid.
//
// Finnes fordi rettinga i Connect-GUI-et er tungvint nok til at den ikke blir
// gjort: velger klokka feil vekt på et par sett, oppdages det gjerne først når
// volumet ikke stemmer. Én linje i en fil er lettere å få riktig enn tolv felt
// i en app.
//
// Kjør:
//   node fix-strength.js               # bruker strength-fix.json
//   node fix-strength.js --dry-run     # vis diffen, send ingenting
//   node fix-strength.js <fil>         # annen rettelsesfil
//
// Skjemaet i strength-fix.json:
//
//   {
//     "activityId": 24105522581,
//     "why": "fritekst — hvorfor denne rettelsen finnes",
//     "apply": false,          // false = tørrkjøring uansett. Sikringen.
//     "fixes": [
//       { "ex": "LATERAL_RAISE/DUMBBELL_LATERAL_RAISE", "set": 3, "kg": 4 },
//       { "ex": "SHOULDER_PRESS/SEATED_DUMBBELL_SHOULDER_PRESS", "kg": 12 },
//       { "ex": "PULL_UP/WEIGHTED_PULL_UP", "to": "PULL_UP/LAT_PULLDOWN" }
//     ]
//   }
//
// "ex" er "KATEGORI/UNDERKATEGORI" (utelat skråstrek hvis øvelsen ikke har
// underkategori, f.eks. "HYPEREXTENSION"). "set" er nummeret blant de AKTIVE
// settene av nettopp den øvelsen, 1-basert — utelates det, treffer rettelsen
// alle settene av øvelsen. Feltene som kan settes: "kg", "reps", "to".
//
// API-et (kroppen fra Connects webklient, metoden ved
// å prøve seg fram etter at POST svarte 405):
//
//   PUT https://connectapi.garmin.com/activity-service/activity/<id>/exerciseSets
//   { activityId, exerciseSets: [ ...HELE lista, også REST-settene... ] }
//
// Hele lista sendes, ikke bare det endrede settet — settene har ingen egen id
// og kan bare adresseres på plass. Kroppen bygges derfor fra et ferskt GET, med
// bare de feltene webklienten selv sender: wktStepIndex og messageIndex tas ut.
// Vekter er i GRAM. REST-sett har weight -1 og repetitionCount null.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { connect, endpoints } from './lib/garmin.js';
import { DATA } from './lib/paths.js';

const API = 'https://connectapi.garmin.com';

const args = process.argv.slice(2);
const dryRunFlagg = args.includes('--dry-run');
const fil = args.find((a) => !a.startsWith('--')) ?? 'strength-fix.json';

if (!existsSync(fil)) {
    console.error(`Fant ikke ${fil}. Se skjemaet øverst i fix-strength.js.`);
    process.exit(1);
}

const spec = JSON.parse(readFileSync(fil, 'utf8'));
const { activityId, fixes = [], why } = spec;
if (!activityId || !fixes.length) {
    console.error(`${fil} mangler activityId eller fixes.`);
    process.exit(1);
}

// Tørrkjøring med mindre BÅDE fila sier apply:true OG --dry-run ikke er gitt.
// To brytere som må stå riktig samtidig, fordi dette skriver til ekte helsedata
// uten angreknapp.
const skriv = spec.apply === true && !dryRunFlagg;

const nøkkel = (s) => {
    const e = s.exercises?.[0];
    if (!e?.category) return null;
    return e.name ? `${e.category}/${e.name}` : e.category;
};

const gc = await connect();
const svar = await gc.get(...endpoints.exerciseSets(activityId));
const sett = svar?.exerciseSets ?? [];
if (!sett.length) {
    console.error(`Ingen øvelsessett på aktivitet ${activityId}.`);
    process.exit(1);
}

console.log(`Aktivitet ${activityId} — ${sett.length} sett (${sett.filter((s) => s.setType === 'ACTIVE').length} aktive)`);
if (why) console.log(`Begrunnelse: ${why}`);
console.log();

// Nummerer de aktive settene per øvelse, så "set: 3" betyr tredje settet av
// nettopp den øvelsen — ikke det tredje settet i økta.
const teller = new Map();
for (const s of sett) {
    if (s.setType !== 'ACTIVE') continue;
    const k = nøkkel(s);
    const n = (teller.get(k) ?? 0) + 1;
    teller.set(k, n);
    s.__nr = n;
}

let endringer = 0;
for (const fix of fixes) {
    const treff = sett.filter(
        (s) => s.setType === 'ACTIVE' && nøkkel(s) === fix.ex && (fix.set == null || s.__nr === fix.set)
    );
    if (!treff.length) {
        // Rødt bare når vi faktisk skulle skrevet. En tørrkjøring som ikke
        // treffer betyr som regel at rettelsen allerede er utført og bare ligger
        // igjen i fila — det er en beskjed, ikke en feil.
        console[skriv ? 'error' : 'log'](
            `  ${skriv ? 'FEIL: ' : ''}ingen sett matcher "${fix.ex}"${fix.set ? ` sett ${fix.set}` : ''}` +
            (skriv ? '' : ' — rettelsen er trolig allerede utført og kan fjernes fra fila')
        );
        if (skriv) process.exitCode = 1;
        continue;
    }
    for (const s of treff) {
        const før = `${nøkkel(s)} sett ${s.__nr}: ${s.repetitionCount} reps × ${s.weight / 1000} kg`;
        if (fix.kg != null) s.weight = Math.round(fix.kg * 1000);
        if (fix.reps != null) s.repetitionCount = fix.reps;
        if (fix.to) {
            const [kategori, navn] = fix.to.split('/');
            s.exercises = [{ probability: 100, category: kategori, name: navn ?? null }];
        }
        console.log(`  ${før}\n    → ${nøkkel(s)} sett ${s.__nr}: ${s.repetitionCount} reps × ${s.weight / 1000} kg`);
        endringer++;
    }
}

if (!endringer) {
    console.log('\nIngen sett ble endret — sender ingenting.');
    process.exit(skriv ? 1 : 0);
}

// Kroppen speiler nøyaktig det Connects webklient sender. __nr er vårt eget
// hjelpefelt og må ut sammen med de to Garmin ikke tar imot.
const kropp = {
    activityId,
    exerciseSets: sett.map(({ __nr, wktStepIndex, messageIndex, ...s }) => s)
};

console.log(`\n${endringer} sett endret.`);
if (!skriv) {
    console.log(
        spec.apply === true
            ? 'TØRRKJØRING (--dry-run) — ingenting sendt.'
            : 'TØRRKJØRING — sett "apply": true i fila for å sende på ekte.'
    );
    process.exit(0);
}

// PUT mot connectapi er varianten som virker.
//
// Nettleseren sender POST mot connect.garmin.com/gc-api/…, men den ruta er en
// proxy: mot backend blir det PUT. POST rett på connectapi svarer 405, som er
// et rutingsvar og ikke et autorisasjonssvar — stien finnes, men ikke for den
// metoden. Fallbackene står igjen i tilfelle Garmin flytter på det; hvert
// forsøk sender nøyaktig samme korrigerte kropp, så verste utfall er at riktig
// data skrives to ganger.
const forsøk = [
    ['PUT  connectapi', 'put', `${API}/activity-service/activity/${activityId}/exerciseSets`],
    ['POST gc-api', 'post', `https://connect.garmin.com/gc-api/activity-service/activity/${activityId}/exerciseSets`],
    ['POST connectapi', 'post', `${API}/activity-service/activity/${activityId}/exerciseSets`]
];

let sendt = false;
for (const [navn, metode, url] of forsøk) {
    try {
        const res = await gc.client[metode](url, kropp);
        console.log(`\n${navn}: OK`, res == null ? '' : JSON.stringify(res).slice(0, 200));
        console.log(`Bruk denne varianten heretter: ${metode.toUpperCase()} ${url.replace(String(activityId), '<id>')}`);
        sendt = true;
        break;
    } catch (e) {
        console.log(`${navn}: ${e?.message?.slice(0, 120) ?? e}`);
    }
}

if (!sendt) {
    console.error('\nIngen av variantene ble godtatt. Ingenting er skrevet til Garmin.');
    console.error('Neste steg: hent forespørselens HEADERE fra DevTools — det er');
    console.error('sannsynligvis en av dem (f.eks. x-http-method-override) som mangler.');
    process.exit(1);
}

// Hent settene på nytt og legg dem i repoet med en gang. Uten dette blir en
// rettet gammel økt liggende feil i data/: synkevinduet er «siste synk minus én
// dag», så 4. august kommer aldri innom igjen, og backfillen i sync.js hopper
// over økter som allerede HAR fil. Verktøyet vet nøyaktig hvilken aktivitet det
// endret, så det er her ansvaret hører hjemme.
const ferske = await gc.get(...endpoints.exerciseSets(activityId));
const filsti = join(DATA, 'exercisesets', `${activityId}.json`);
mkdirSync(dirname(filsti), { recursive: true });
writeFileSync(filsti, `${JSON.stringify(ferske, null, 2)}\n`);
console.log(`Ferske øvelsessett skrevet til ${filsti}.`);
