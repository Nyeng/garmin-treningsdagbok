// Pusher en hel treningsplan til Garmin Connect og LEGGER DEN I KALENDEREN.
//
// Forskjellen fra push-workout.js: den pusher én økt til øktbiblioteket, og du
// planlegger den for hånd. Denne pusher mange daterte økter og planlegger hver
// av dem på sin dato, så de dukker opp på klokka den dagen de skal kjøres.
//
//   node push-plan.js --dry-run     # vis hva som ville skjedd, send ingenting
//   node push-plan.js               # push + planlegg
//   node push-plan.js --list        # vis hva som ligger i kalenderen framover
//   node push-plan.js --clear       # fjern alle planlagte økter fra planen
//
// plan.json:
// plan.json leses fra $GARMIN_DATA_DIR (det private data-repoet), med fallback
// til repoet selv. Se kommentaren ved PLAN under.
//
//   {
//     "name": "Retur etter sykdom",      // fritekst, blir ikke sendt til Garmin
//     "workouts": [
//       { "date": "2026-09-03", "name": "Rolig 6 km", "steps": [ … ] },
//       { "date": "2026-09-05", "name": "Terskel 4 x 6 min", "steps": [ … ] }
//     ]
//   }
//
// Hver økt bruker NØYAKTIG samme steg-skjema som workout.json — se toppen av
// push-workout.js. Begge går gjennom lib/workout-spec.js.
//
// IDEMPOTENT: økter navngis "dd-mm-yyyy Navn", og alle økter med en dato som
// finnes i planen slettes før ny push. Sletting av en økt fjerner også
// kalenderoppføringen, så en justert plan erstatter den forrige i stedet for å
// legge seg oppå. Utgåtte datoer pushes aldri, og utgåtte dagsøkter ryddes bort.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { connect, endpoints } from './lib/garmin.js';
import { DATA, ROOT } from './lib/paths.js';
import { buildFromSpec, isoDateFromName, toDisplayDate } from './lib/workout-spec.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const list = args.includes('--list');
const clear = args.includes('--clear');

// plan.json hører hjemme i det PRIVATE data-repoet: den inneholder pulssoner
// avledet av terskelen din, hvorfor planen ser ut som den gjør, og hvilke dager
// du pendler — altså når du forutsigbart ikke er hjemme. Samme vurdering som for
// threshold-fix.json.
//
// Faller tilbake på repoet selv, så malens plan.example.json og et oppsett uten
// GARMIN_DATA_DIR fortsatt virker.
const PLAN = [join(DATA, 'plan.json'), join(ROOT, 'plan.json')].find(existsSync);
if (!PLAN) {
    console.error('Fant ingen plan.json.');
    console.error(`  lette i: ${join(DATA, 'plan.json')}`);
    console.error(`  og i:    ${join(ROOT, 'plan.json')}`);
    console.error('Kopier plan.example.json til data-mappa og rediger den.');
    process.exit(1);
}
const plan = JSON.parse(readFileSync(PLAN, 'utf8'));
const økter = plan.workouts ?? [];
if (!Array.isArray(økter) || økter.length === 0) {
    console.error('plan.json har ingen økter i "workouts".');
    process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);
const kommende = økter.filter((ø) => ø.date >= today).sort((a, b) => a.date.localeCompare(b.date));
const utgåtte = økter.length - kommende.length;

// Bygg alt FØR noe sendes: en plan som feiler på økt 7 av 12 skal ikke ha
// lagt igjen seks halvpushede økter i Garmin.
const bygget = kommende.map((ø) => {
    try {
        return { spec: ø, workout: buildFromSpec(ø) };
    } catch (e) {
        throw new Error(`Økta ${ø.date} "${ø.name ?? '?'}" er ugyldig: ${e.message}`);
    }
});

if (dryRun) {
    console.log(`Plan: ${plan.name ?? '(uten navn)'}`);
    console.log(`${bygget.length} økter å planlegge${utgåtte ? `, ${utgåtte} utgåtte hoppes over` : ''}\n`);
    for (const { spec, workout } of bygget) {
        const steg = workout.workoutSegments[0].workoutSteps;
        const beskriv = steg.map((s) => s.type === 'RepeatGroupDTO'
            ? `${s.numberOfIterations}x(${s.workoutSteps.map((c) => c.stepType?.stepTypeKey).join('+')})`
            : s.stepType?.stepTypeKey).join(' · ');
        console.log(`  ${spec.date}  ${workout.workoutName}`);
        console.log(`              ${beskriv}`);
    }
    console.log('\nTørrkjøring — ingenting er sendt.');
    process.exit(0);
}

const gc = await connect();

if (list) {
    const nå = new Date();
    for (let m = 0; m < 3; m++) {
        const d = new Date(Date.UTC(nå.getUTCFullYear(), nå.getUTCMonth() + m, 1));
        const cal = await gc.client.get(...endpoints.calendar(d.getUTCFullYear(), d.getUTCMonth()));
        for (const i of (cal?.calendarItems ?? []).filter((i) => i.itemType === 'workout' && i.date >= today)) {
            console.log(`${i.date}  ${i.title}`);
        }
    }
    process.exit(0);
}

// Datoene planen eier. Alt annet i biblioteket røres ikke — faste styrkeøkter
// har ingen dato i navnet og er usynlige for denne ryddingen.
const planDatoer = new Set(kommende.map((ø) => ø.date));

let ryddet = 0;
for (const w of await gc.getWorkouts(0, 100)) {
    const dato = isoDateFromName(w.workoutName);
    if (!dato) continue;
    if (dato < today || planDatoer.has(dato)) {
        await gc.deleteWorkout({ workoutId: w.workoutId });
        console.log(`  ryddet: ${w.workoutName}`);
        ryddet++;
    }
}
if (ryddet) console.log(`${ryddet} økt(er) ryddet bort.\n`);

if (clear) {
    console.log('--clear: planen er fjernet fra kalenderen. Ingen nye økter pushet.');
    process.exit(0);
}

let ok = 0;
for (const { spec, workout } of bygget) {
    const created = await gc.addWorkout(workout);
    await gc.client.post(...endpoints.scheduleWorkout(created.workoutId), { date: spec.date });
    console.log(`  ${spec.date}  ${created.workoutName}  → planlagt`);
    ok++;
}

console.log(`\n${ok} økt(er) pushet og lagt i treningskalenderen.`);
if (utgåtte) console.log(`${utgåtte} utgått(e) økt(er) i plan.json ble hoppet over.`);
console.log('De dukker opp på klokka på sin dato (Garmin synker kalenderen selv).');
