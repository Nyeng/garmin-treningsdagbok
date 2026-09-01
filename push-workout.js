// Pusher dagens økt (definert som data i workout.json) til Garmin Connect,
// klar til å lastes ned på klokka (sync skjer via Garmin Connect-appen/kontoen).
//
// Kjør:
//   node push-workout.js              # push økta i workout.json
//   node push-workout.js --dry-run    # print Garmin-JSON-en som ville blitt sendt, ikke send
//   node push-workout.js --list       # list dine 20 siste økter i Garmin Connect (med id)
//   node push-workout.js --delete ID  # slett en økt
//
// workout.json-formatet (økta som ren data — dette er fila treningsforslag-
// rutinen redigerer, ikke denne koden):
//   {
//     "date": "2026-08-03",             // økta gjelder denne dagen; utgåtte datoer pushes aldri
//     "name": "Langtur 17 km rolig",    // Garmin-navnet blir "03-08-2026 <name>"
//                                       // (dato lagres som ISO, vises dag-måned-år)
//     "description": "...",             // vises i Garmin Connect/på klokka
//     "rationale": "...",               // hvorfor denne økta (kun for dagboka, sendes ikke)
//     "steps": [
//       { "step": "warmup",   "km": 2 },
//       { "step": "interval", "km": 13, "hr": { "min": 125, "max": 152 } },
//       { "step": "interval", "km": 5,  "pace": { "fast": "4:10", "slow": "4:20" } },
//       { "step": "recovery", "seconds": 90 },      // eller "km": 0.4
//       { "step": "cooldown", "km": 1 }
//     ]
//   }
//   Pulsmål kan angis som et rent tak — utelat "min", så settes gulvet
//   automatisk lavt nok til at klokka aldri varsler "for lav puls" mens du er
//   på vei opp i puls. Bruk dette som standard på terskeldrag; poenget der er
//   et tak, ikke et gulv:
//       { "step": "interval", "minutes": 5, "hr": { "max": 172 } }
//
//   Alle steg tar enten "km" ELLER varighet ("minutes"/"seconds"):
//       { "step": "warmup",   "minutes": 10 }
//       { "step": "interval", "minutes": 5, "hr": { "min": 155, "max": 172 } }
//       { "step": "interval", "seconds": 30 }
//   Bruk varighet på mølleøkter — klokka måler distanse fra håndleddet
//   innendørs og bommer ofte flere prosent, så distansesteg blir feil lange.
//   Valgfritt per steg: "note" (vises som steg-beskrivelse på klokka).
//
//   "treadmill": true på toppnivå legger automatisk inn et 20-sekunders
//   opptrappingssteg foran hvert drag, så du får en vibrasjon når det er på
//   tide å begynne å skru opp beltet. De 20 sekundene tas fra det rolige
//   steget foran når det er tidsstyrt og har nok å gi, slik at økta ikke blir
//   lengre. Enkeltdrag kan reservere seg med "ramp": false, og teksten på
//   steget kan overstyres med "rampNote". Steget finnes også som en vanlig
//   steg-type å sette inn for hånd: { "step": "ramp", "seconds": 20 }.
//
// Pushen er idempotent: finnes det allerede økter med samme navn i Garmin,
// slettes de først (justering av dagens økt gir aldri duplikater).
//
// USIKKERT: fartsmål (targetType 'pace.zone') på intervall-steg er rekonstruert
// fra reverse-engineering av Garmins interne API, ikke offentlig dokumentert.
// Sjekk økta i Garmin Connect etter push — si ifra i dagboken/chatten hvis
// fartssonen ikke vises riktig på klokka, så justeres skjemaet i lib/workout-builder.js.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from './lib/garmin.js';
import {
    warmup, warmupTime, interval, intervalTime, recovery, recoveryTime,
    rampTime, cooldown, cooldownTime, buildWorkout
} from './lib/workout-builder.js';

const ROOT = dirname(fileURLToPath(import.meta.url));

const RAMP_SECONDS = 20;
const RAMP_NOTE = 'Skru opp farten nå — beltet skal være i målfart når draget starter';

function durationOf(step) {
    return step.seconds ?? (step.minutes != null ? step.minutes * 60 : null);
}

/**
 * Setter inn et opptrappingssteg foran hvert drag ("treadmill": true i
 * workout.json). De 20 sekundene tas fra det rolige steget foran når det er
 * tidsstyrt og har nok å gi (så økta blir like lang), ellers legges de til.
 * Et enkelt drag kan reservere seg med "ramp": false.
 */
function insertRamps(specSteps) {
    const out = [];
    for (const s of specSteps) {
        if (s.step === 'interval' && s.ramp !== false) {
            const prev = out[out.length - 1];
            const prevSecs = prev ? durationOf(prev) : null;
            if (prev && ['recovery', 'warmup'].includes(prev.step)
                && prevSecs != null && prevSecs - RAMP_SECONDS >= 20) {
                const { minutes, ...rest } = prev;
                out[out.length - 1] = { ...rest, seconds: prevSecs - RAMP_SECONDS };
            }
            out.push({ step: 'ramp', seconds: RAMP_SECONDS, note: s.rampNote ?? RAMP_NOTE });
        }
        out.push(s);
    }
    return out;
}

function buildFromSpec(spec) {
    for (const field of ['date', 'name', 'steps']) {
        if (!spec[field]) throw new Error(`workout.json mangler feltet "${field}"`);
    }
    const specSteps = spec.treadmill ? insertRamps(spec.steps) : spec.steps;
    const steps = specSteps.map((s, i) => {
        // Et steg avsluttes enten på distanse ("km") eller varighet
        // ("minutes"/"seconds"); varighet vinner hvis begge er satt.
        const secs = durationOf(s);
        if (secs == null && s.km == null && s.step !== 'ramp') {
            throw new Error(`Steg ${i + 1} (${s.step}) mangler lengde — sett "km", "minutes" eller "seconds"`);
        }
        const target = s.pace ?? s.hr;
        let step;
        switch (s.step) {
            case 'warmup':   step = secs != null ? warmupTime(secs) : warmup(s.km); break;
            case 'cooldown': step = secs != null ? cooldownTime(secs) : cooldown(s.km); break;
            case 'interval': step = secs != null ? intervalTime(secs, target) : interval(s.km, target); break;
            case 'recovery': step = secs != null ? recoveryTime(secs) : recovery(s.km); break;
            case 'ramp':     step = rampTime(secs ?? RAMP_SECONDS); break;
            default: throw new Error(`Ukjent steg-type "${s.step}" (steg ${i + 1}) — gyldige: warmup, interval, recovery, ramp, cooldown`);
        }
        if (s.note) step.description = s.note;
        return step;
    });
    return buildWorkout({
        name: `${toDisplayDate(spec.date)} ${spec.name}`,
        description: spec.description,
        steps
    });
}

// Datoer lagres som ISO ("2026-08-08") i workout.json — det er formatet som
// sorterer og sammenlignes riktig — men vises som dag-måned-år i øktnavnet.
function toDisplayDate(isoDate) {
    const [y, m, d] = isoDate.split('-');
    return `${d}-${m}-${y}`;
}

// Henter datoen ut av et øktnavn og gir den tilbake som ISO, så den kan
// sammenlignes med andre datoer. Godtar både dagens format ("08-06-2026 ...")
// og det gamle ISO-formatet ("2026-06-08 ..."), slik at økter som ble pushet
// før formatendringen fortsatt ryddes bort i stedet for å bli liggende for
// alltid. Formatene kan ikke forveksles: ingen ISO-dato matcher dd-mm-yyyy.
function isoDateFromName(workoutName = '') {
    const dmy = /^(\d{2})-(\d{2})-(\d{4}) /.exec(workoutName);
    if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
    const iso = /^(\d{4}-\d{2}-\d{2}) /.exec(workoutName);
    return iso ? iso[1] : null;
}

const spec = JSON.parse(readFileSync(join(ROOT, 'workout.json'), 'utf8'));
const workout = buildFromSpec(spec);

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const list = args.includes('--list');
const deleteId = args.includes('--delete') ? args[args.indexOf('--delete') + 1] : null;

if (dryRun) {
    console.log(JSON.stringify(workout, null, 2));
    process.exit(0);
}

const gc = await connect();

if (list) {
    const workouts = await gc.getWorkouts(0, 20);
    for (const w of workouts) {
        console.log(`${w.workoutId}  ${w.workoutName}  (${w.estimatedDistanceInMeters ?? '?'} m)`);
    }
    process.exit(0);
}

if (deleteId) {
    await gc.deleteWorkout({ workoutId: deleteId });
    console.log(`Slettet økt ${deleteId}`);
    process.exit(0);
}

// Rydd i dagsøkter (navn som starter med en dato) så øktbiblioteket på
// klokka aldri fylles opp: utgåtte datoer slettes, og alle økter med samme
// dato som dagens (samme navn eller ikke) slettes før ny push — en justering
// erstatter dermed alltid forgjengeren i stedet for å lage en kopi.
const today = new Date().toISOString().slice(0, 10);
for (const w of await gc.getWorkouts(0, 50)) {
    const dato = isoDateFromName(w.workoutName);
    if (!dato) continue; // faste økter (styrke m.m.) røres aldri
    if (dato < today) {
        await gc.deleteWorkout({ workoutId: w.workoutId });
        console.log(`Ryddet bort utgått dagsøkt: ${w.workoutName}`);
    } else if (dato === spec.date) {
        await gc.deleteWorkout({ workoutId: w.workoutId });
        console.log(`Erstattet tidligere versjon: ${w.workoutName}`);
    }
}

// Aldri push en utgått økt (skjer f.eks. når workflowen trigges av en
// kodeendring uten at workout.json er oppdatert for i dag).
if (spec.date < today) {
    console.log(`workout.json er datert ${spec.date} (utgått) — pusher ikke.`);
    process.exit(0);
}

const created = await gc.addWorkout(workout);
console.log(`Økt opprettet i Garmin Connect: "${created.workoutName}" (id ${created.workoutId})`);
console.log('Åpne Garmin Connect (app/nett) → Treningskalender/Økter for å sende den til klokka,');
console.log('eller planlegg den på dagens dato i kalenderen slik at den synker automatisk.');
