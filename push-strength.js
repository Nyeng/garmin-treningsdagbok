// Pusher faste styrkeøkter til Garmin Connect som gjenbrukbare økter i
// øktbiblioteket. De er ikke datofestet — start dem fra klokka (Styrketrening →
// Økter) eller planlegg dem i kalenderen.
//
// Kjør:
//   node push-strength.js            # push øktene i det aktive programmet
//   node push-strength.js --dry-run  # print JSON uten å sende
//
// SKRIV DITT EGET PROGRAM HER. Fila under er et kjørbart eksempel med to økter
// i ett program — bytt ut øvelsene med dine egne. Byggeklossene ligger i
// lib/workout-builder.js:
//
//   exercise(kategori, øvelse, { reps | seconds, weightKg, note })
//   perSide(kategori, øvelse, { reps, ... })   ett steg per side, klokka
//                                              vibrerer ved sidebytte
//   rest(sekunder)
//   rounds(n, [ ...steg ])                     supersett/sirkler som runder
//
// Kategori- og øvelseskodene er Garmins egne (f.eks. 'SQUAT' /
// 'BARBELL_BACK_SQUAT'). Katalogen er stor og ikke offentlig dokumentert; de
// vanligste står i lib/workout-builder.js, og en ukjent kode gir feil ved push
// i stedet for å bli lastet opp i det stille. Har en øvelse ingen underkategori,
// send null (f.eks. exercise('PLYO', null, …)).
//
// Skriptet er idempotent: økter det eier (samme navn) slettes før de lastes opp
// på nytt, slik at en justering erstatter forgjengeren i stedet for å legge en
// kopi ved siden av. Legger du inn flere programmer i PROGRAMMER, ryddes de
// inaktive bort ved push, så biblioteket alltid speiler det aktive.

import { connect } from './lib/garmin.js';
import { exercise, perSide, rest, rounds, buildStrengthWorkout } from './lib/workout-builder.js';

// Hvilket program som skal ligge i Garmin-øktbiblioteket. Har du flere
// programmer (oppbygging, vinterstyrke, vedlikehold), bytt denne ene linja —
// endringen trigger .github/workflows/push-strength.yml, som rydder bort
// forrige programs økter og laster opp det nye.
const PROGRAM = 'eksempel';

export const UNDERKROPP = buildStrengthWorkout({
    name: 'Styrke A — underkropp',
    description:
        'Løpetilpasset underkropp. Spenstblokk først, mens beina er ferske. ' +
        'Ensidige øvelser ligger som ett steg per side, så klokka teller reps ' +
        'per ben. 45–55 min.',
    steps: [
        rounds(3, [
            exercise('PLYO', 'JUMP_SQUAT', { reps: 5, note: 'Maks intensjon opp, myk landing' }),
            rest(75)
        ]),
        rounds(3, [
            exercise('SQUAT', 'BARBELL_BACK_SQUAT', { reps: 6, weightKg: 60, note: '1–2 reps igjen. Aldri grinding' }),
            rest(90)
        ]),
        rounds(3, [
            exercise('DEADLIFT', 'ROMANIAN_DEADLIFT', { reps: 8, note: 'Strak rygg, hoftehengsel' }),
            rest(120)
        ]),
        rounds(3, [
            perSide('SQUAT', 'DUMBBELL_STEP_UP', { reps: 8, note: 'Kasse i knehøyde. Driv fra framre fot' }),
            rest(60)
        ]),
        rounds(3, [
            perSide('CALF_RAISE', 'SINGLE_LEG_STANDING_CALF_RAISE', { reps: 12, note: 'Opp på to ben, 3 sek ned på ett' }),
            rest(45)
        ])
    ]
});

export const OVERKROPP = buildStrengthWorkout({
    name: 'Styrke B — overkropp og core',
    description:
        'Overkropp og core. Supersett kun der øvelsene deler utstyr, ellers rene ' +
        'sett så ingen apparater okkuperes samtidig. 40–50 min.',
    steps: [
        rounds(4, [
            exercise('BENCH_PRESS', 'BARBELL_BENCH_PRESS', { reps: 8, note: 'Kontrollert ned til bryst' }),
            rest(90)
        ]),
        rounds(3, [
            perSide('ROW', 'ONE_ARM_BENT_OVER_ROW', { reps: 8, note: 'På benk, flat rygg, albue mot hofta' }),
            rest(60)
        ]),
        rounds(3, [
            exercise('PULL_UP', 'PULL_UP', { reps: 6, note: 'Strikk-assistert hvis under 5 gode reps' }),
            rest(90)
        ]),
        // Supersett: samme benk og manualer, så de deler utstyr uansett.
        rounds(3, [
            exercise('SHOULDER_PRESS', 'SEATED_DUMBBELL_SHOULDER_PRESS', { reps: 10 }),
            exercise('LATERAL_RAISE', 'DUMBBELL_LATERAL_RAISE', { reps: 12, note: 'Lett vekt, rolig opp til skulderhøyde' }),
            rest(75)
        ]),
        rounds(4, [
            perSide('CORE', 'CABLE_CORE_PRESS', { reps: 10, note: 'Pallof: press ut, motstå rotasjon' }),
            rest(45)
        ])
    ]
});

const PROGRAMMER = {
    eksempel: [UNDERKROPP, OVERKROPP]
};

if (!PROGRAMMER[PROGRAM]) {
    console.error(`Ukjent program "${PROGRAM}" — gyldige verdier: ${Object.keys(PROGRAMMER).join(', ')}`);
    process.exit(1);
}

const WORKOUTS = PROGRAMMER[PROGRAM];

// Alle økter dette skriptet eier — også de fra programmer som ikke er aktive.
// Uten dette ville et programbytte etterlatt forrige programs økter liggende i
// biblioteket ved siden av de nye.
const EIDE_NAVN = new Set(Object.values(PROGRAMMER).flat().map((w) => w.workoutName));

const dryRun = process.argv.includes('--dry-run');

if (dryRun) {
    console.log(JSON.stringify(Object.fromEntries(WORKOUTS.map((w) => [w.workoutName, w])), null, 2));
    process.exit(0);
}

const gc = await connect();

for (const w of await gc.getWorkouts(0, 50)) {
    if (!EIDE_NAVN.has(w.workoutName)) continue;
    await gc.deleteWorkout({ workoutId: w.workoutId });
    console.log(`Fjernet tidligere versjon: ${w.workoutName}`);
}

for (const workout of WORKOUTS) {
    const created = await gc.addWorkout(workout);
    console.log(`Økt opprettet: "${created.workoutName}" (id ${created.workoutId})`);
}
console.log(`Ferdig — program "${PROGRAM}" ligger i Garmin Connect under Trening → Økter,`);
console.log('og kan startes fra klokka: Styrketrening → Økter.');
