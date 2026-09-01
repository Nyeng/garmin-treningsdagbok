// Bygger strukturerte løpeøkter (oppvarming / drag-innslag / rolig / nedjogg)
// som JSON i formatet Garmin Connects workout-service forventer, klar til å
// sendes med gc.addWorkout() (fra garmin-connect-biblioteket, se sync.js/lib/garmin.js).
//
// VIKTIG Å VITE: Garmin har ingen offentlig dokumentasjon på dette skjemaet.
// stepType og endCondition ('distance' / 'no.target') er verifisert direkte
// mot node_modules/garmin-connect sin egen RunningTemplate.js — de er trygge.
// targetType 'pace.zone' (fartsmål) og 'heart.rate.zone' (pulsmål) er derimot
// IKKE verifisert mot en faktisk innlogget konto, bare rekonstruert fra kjente
// reverse-engineering-kilder. Sjekk økta i Garmin Connect (nett/app) etter
// push — hvis fartssonen/pulssonen ikke vises riktig på et steg, si ifra så
// justeres id-en/nøkkelen.

const RUNNING_SPORT = { sportTypeId: 1, sportTypeKey: 'running' };

const STEP_TYPE = {
    warmup: { stepTypeId: 1, stepTypeKey: 'warmup' },
    cooldown: { stepTypeId: 2, stepTypeKey: 'cooldown' },
    interval: { stepTypeId: 3, stepTypeKey: 'interval' },
    recovery: { stepTypeId: 4, stepTypeKey: 'recovery' },
    rest: { stepTypeId: 5, stepTypeKey: 'rest' },
    other: { stepTypeId: 7, stepTypeKey: 'other' }
};

const END_CONDITION_DISTANCE = { conditionTypeId: 3, conditionTypeKey: 'distance' };
const END_CONDITION_TIME = { conditionTypeId: 2, conditionTypeKey: 'time' };

const TARGET_NO_TARGET = { workoutTargetTypeId: 1, workoutTargetTypeKey: 'no.target' };
const TARGET_HEART_RATE_ZONE = { workoutTargetTypeId: 4, workoutTargetTypeKey: 'heart.rate.zone' };
const TARGET_PACE_ZONE = { workoutTargetTypeId: 6, workoutTargetTypeKey: 'pace.zone' };

// "4:55" (min:sek per km) -> meter/sekund. Garmin lagrer fart som hastighet,
// ikke tempo, så et tempo-intervall må sendes som et min/maks hastighetsvindu.
function paceToSpeedMs(paceMinPerKm) {
    const [min, sec] = paceMinPerKm.split(':').map(Number);
    const secPerKm = min * 60 + (sec || 0);
    return 1000 / secPerKm;
}

function baseStep({ stepType, endCondition, endConditionValue, unit, target }) {
    return {
        type: 'ExecutableStepDTO',
        stepId: null,
        stepOrder: null, // settes riktig i buildWorkout()
        childStepId: null,
        description: null,
        stepType,
        endCondition,
        endConditionValue,
        preferredEndConditionUnit: unit ? { unitKey: unit } : null,
        endConditionCompare: null,
        endConditionZone: null,
        targetType: target ? target.targetType : TARGET_NO_TARGET,
        targetValueOne: target ? target.min : null,
        targetValueTwo: target ? target.max : null,
        zoneNumber: null
    };
}

// fastPace/slowPace: "mm:ss" per km, f.eks. paceTarget('4:55', '5:05')
function paceTarget(fastPace, slowPace) {
    return {
        targetType: TARGET_PACE_ZONE,
        min: paceToSpeedMs(slowPace), // tregeste fart = lavest m/s
        max: paceToSpeedMs(fastPace) // raskeste fart = høyest m/s
    };
}

// minBpm/maxBpm: puls i slag/min, f.eks. hrTarget(125, 150). Watchen varsler
// (vibrasjon + fargeskift) hvis pulsen går utenfor vinduet i begge retninger,
// så sett minBpm godt under det egentlige målet for å unngå falske "for
// rolig"-varsler når hensikten bare er et pulstak.
function hrTarget(minBpm, maxBpm) {
    return {
        targetType: TARGET_HEART_RATE_ZONE,
        min: minBpm,
        max: maxBpm
    };
}

// Hvor langt under taket det stille gulvet legges når et steg bare angir et
// pulstak. 50 slag er valgt fordi pulsen ellers ligger under gulvet i starten
// av et drag — på mølleøkta 5. august lå pulsen på 105-145 gjennom hele første
// drag mot et gulv på 155, og klokka nagget «for lavt» i flere minutter mens
// oppvarmingen gjorde nøyaktig det den skulle.
const SILENT_HR_FLOOR_MARGIN = 50;
const MIN_HR_FLOOR = 100;

// Pulstak uten reell nedre grense. Garmin krever to verdier i en pulssone, så
// gulvet settes langt nok ned til at det aldri utløses; du beholder pulsmåleren
// og taket på skjermen, men slipper masingen på vei opp i puls.
function hrCeiling(maxBpm) {
    return hrTarget(Math.max(MIN_HR_FLOOR, maxBpm - SILENT_HR_FLOOR_MARGIN), maxBpm);
}

/** Rolig oppvarming, uten fartsmål (kjør på følelse/puls). */
export function warmup(distanceKm) {
    return baseStep({
        stepType: STEP_TYPE.warmup,
        endCondition: END_CONDITION_DISTANCE,
        endConditionValue: Math.round(distanceKm * 1000),
        unit: 'kilometer'
    });
}

/** Tidsbasert oppvarming (sekunder) — bruk på mølle, der distansen er upålitelig. */
export function warmupTime(seconds) {
    return baseStep({
        stepType: STEP_TYPE.warmup,
        endCondition: END_CONDITION_TIME,
        endConditionValue: Math.round(seconds)
    });
}

/** Rolig nedjogg, uten fartsmål. */
export function cooldown(distanceKm) {
    return baseStep({
        stepType: STEP_TYPE.cooldown,
        endCondition: END_CONDITION_DISTANCE,
        endConditionValue: Math.round(distanceKm * 1000),
        unit: 'kilometer'
    });
}

/** Tidsbasert nedjogg (sekunder). */
export function cooldownTime(seconds) {
    return baseStep({
        stepType: STEP_TYPE.cooldown,
        endCondition: END_CONDITION_TIME,
        endConditionValue: Math.round(seconds)
    });
}

/**
 * Drag med et fartsvindu eller pulsvindu.
 * target er enten { fast: '4:55', slow: '5:05' } (min:sek per km) for fart,
 * eller { min: 125, max: 150 } (slag/min) for puls. Utelates min, blir målet
 * et rent pulstak med stille gulv — se hrCeiling().
 */
export function interval(distanceKm, target) {
    return baseStep({
        stepType: STEP_TYPE.interval,
        endCondition: END_CONDITION_DISTANCE,
        endConditionValue: Math.round(distanceKm * 1000),
        unit: 'kilometer',
        target: resolveTarget(target)
    });
}

/**
 * Tidsbasert drag (sekunder), samme målformat som interval(). Foretrekk denne
 * på mølle: klokka måler distanse fra håndleddet innendørs og bommer ofte
 * flere prosent, så et 5-minuttersdrag blir aldri 5 minutter hvis steget
 * avsluttes på distanse.
 */
export function intervalTime(seconds, target) {
    return baseStep({
        stepType: STEP_TYPE.interval,
        endCondition: END_CONDITION_TIME,
        endConditionValue: Math.round(seconds),
        target: resolveTarget(target)
    });
}

function resolveTarget(target) {
    if (!target) return undefined;
    if ('fast' in target) return paceTarget(target.fast, target.slow);
    if (target.max == null) throw new Error('Pulsmål mangler "max" (taket er påkrevd)');
    // Bare tak angitt -> stille gulv, se hrCeiling().
    return target.min == null ? hrCeiling(target.max) : hrTarget(target.min, target.max);
}

/** Rolig jogg mellom harde drag, uten fartsmål. */
export function recovery(distanceKm) {
    return baseStep({
        stepType: STEP_TYPE.recovery,
        endCondition: END_CONDITION_DISTANCE,
        endConditionValue: Math.round(distanceKm * 1000),
        unit: 'kilometer'
    });
}

/**
 * Opptrapping: et kort steg like før et drag, som gir deg en vibrasjon og en
 * beskjed om å begynne å skru opp farten. Finnes fordi et møllebelte bruker
 * 15-20 sekunder på å komme opp i fart — uten et eget steg starter draget
 * mens beltet fortsatt akselererer, og de første 20 sekundene av hvert drag
 * går tapt (mølleøkta 5. august: hvert 5-minuttersdrag fikk ~4:40 på riktig
 * belastning).
 *
 * USIKKERT: stepType 'other' (id 7) er ikke verifisert mot workout-service —
 * sjekk at steget vises som eget steg i Garmin Connect etter første push.
 */
export function rampTime(seconds) {
    return baseStep({
        stepType: STEP_TYPE.other,
        endCondition: END_CONDITION_TIME,
        endConditionValue: Math.round(seconds)
    });
}

/** Tidsbasert rolig jogg/hvile, f.eks. mellom stigningsdrag (sekunder). */
export function recoveryTime(seconds) {
    return baseStep({
        stepType: STEP_TYPE.recovery,
        endCondition: END_CONDITION_TIME,
        endConditionValue: Math.round(seconds)
    });
}

/**
 * Slår sammen steg til en komplett økt, klar for gc.addWorkout(workout).
 * steps: liste av warmup()/interval()/recovery()/cooldown()-steg i rekkefølge.
 */
/**
 * Nummererer et stegtre: stepOrder løper fortløpende gjennom hele treet, og
 * hver RepeatGroupDTO får en unik childStepId som barna arver. Delt av
 * buildWorkout() og buildStrengthWorkout() — begge trenger nøyaktig samme
 * regel, og Garmin avviser økta i det stille hvis nummereringen er feil.
 */
function nummererSteg(steps) {
    let order = 0;
    let groupId = 0;
    const number = (step) => {
        order += 1;
        if (step.type === 'RepeatGroupDTO') {
            groupId += 1;
            const id = groupId;
            return {
                ...step,
                stepOrder: order,
                childStepId: id,
                workoutSteps: step.workoutSteps.map((child) => ({ ...number(child), childStepId: id }))
            };
        }
        return { ...step, stepOrder: order };
    };
    return steps.flat(Infinity).map(number);
}

export function buildWorkout({ name, description, steps }) {
    // Går gjennom nummererSteg() og ikke en flat map, slik at rounds()-grupper
    // også virker på løpeøkter — «4 × 6 min» er én RepeatGroupDTO, ikke fire
    // kopier av samme steg.
    const numberedSteps = nummererSteg(steps);
    return {
        workoutName: name,
        description,
        sportType: RUNNING_SPORT,
        workoutSegments: [
            {
                segmentOrder: 1,
                sportType: RUNNING_SPORT,
                workoutSteps: numberedSteps
            }
        ]
    };
}

// --- Styrkeøkter ---------------------------------------------------------
//
// Verifisert mot workout-service 27. juli 2026: sportTypeId 5, reps-basert
// endCondition (conditionTypeId 10) og category/exerciseName aksepteres og
// lagres. Gyldige category/exerciseName-verdier kommer fra Garmins offisielle
// øvelseskatalog: https://connect.garmin.com/web-data/exercises/Exercises.json
// (samme koder som FIT-standardens exercise_category/exercise_name).

const STRENGTH_SPORT = { sportTypeId: 5, sportTypeKey: 'strength_training' };
const END_CONDITION_REPS = { conditionTypeId: 10, conditionTypeKey: 'reps' };

/**
 * Ett øvelsessteg. reps ELLER seconds (f.eks. planke) må angis.
 *   exercise('LUNGE', 'DUMBBELL_LUNGE', { reps: 10 })
 *   exercise('PLANK', 'PLANK', { seconds: 45 })
 *   exercise('SQUAT', 'BARBELL_BACK_SQUAT', { reps: 6, weightKg: 60 })
 * Merk: reps per steg gjelder totalt. For ensidige øvelser ("10 per ben"), bruk
 * perSide() i stedet — den lager ett steg per side, så klokka teller riktig og
 * varsler ved sidebytte.
 */
export function exercise(category, exerciseName, { reps, seconds, weightKg, note } = {}) {
    const timed = seconds != null;
    return {
        type: 'ExecutableStepDTO',
        stepId: null,
        stepOrder: null, // settes i buildStrengthWorkout()
        childStepId: null,
        description: note ?? null, // vises som steg-notat i app/klokke
        stepType: STEP_TYPE.interval,
        endCondition: timed ? END_CONDITION_TIME : END_CONDITION_REPS,
        endConditionValue: timed ? Math.round(seconds) : reps,
        category,
        exerciseName,
        weightValue: weightKg ?? null,
        weightUnit: weightKg != null ? { unitKey: 'kilogram' } : null,
        targetType: TARGET_NO_TARGET,
        targetValueOne: null,
        targetValueTwo: null
    };
}

/**
 * Ensidig øvelse som ett steg PER SIDE, i stedet for ett steg med totalsummen.
 * Garmins øktskjema har ingen «per side»-flagg (verifisert mot øvelseskatalogen
 * og workout-service — feltet finnes ikke), så to steg er den eneste måten å få
 * klokka til å telle reps per arm/ben og vibrere ved sidebytte:
 *
 *   perSide('ROW', 'ONE_ARM_BENT_OVER_ROW', { reps: 8, note: 'Flat rygg' })
 *   perSide('PLANK', 'SIDE_PLANK', { seconds: 30, sideLabels: ['Høyre albue ned', 'Venstre albue ned'] })
 *
 * reps/seconds er dosen PER SIDE, ikke totalt. switchRest legger en kort pause
 * mellom sidene (utelat der byttet skjer uten pause, som på sideplanke).
 * Returnerer en liste — rounds()/buildStrengthWorkout() flater den ut selv, så
 * den kan settes rett inn der exercise() sto.
 */
export function perSide(
    category,
    exerciseName,
    { reps, seconds, weightKg, note, sideLabels = ['Høyre', 'Venstre'], switchRest } = {}
) {
    return sideLabels.flatMap((label, i) => {
        const step = exercise(category, exerciseName, {
            reps,
            seconds,
            weightKg,
            note: note ? `${label} — ${note}` : label
        });
        const isLast = i === sideLabels.length - 1;
        return switchRest != null && !isLast ? [step, rest(switchRest)] : [step];
    });
}

/** Pause mellom øvelser/runder (sekunder). */
export function rest(seconds) {
    return {
        type: 'ExecutableStepDTO',
        stepId: null,
        stepOrder: null,
        childStepId: null,
        stepType: STEP_TYPE.rest,
        endCondition: END_CONDITION_TIME,
        endConditionValue: Math.round(seconds),
        targetType: TARGET_NO_TARGET,
        targetValueOne: null,
        targetValueTwo: null
    };
}

/**
 * Gjenta en gruppe steg n ganger (sett/runder/supersett):
 *   rounds(3, [exercise(...), rest(45)])
 * Nestede lister flates ut, så perSide() kan brukes rett i listen.
 */
export function rounds(n, steps) {
    return {
        type: 'RepeatGroupDTO',
        stepId: null,
        stepOrder: null,
        childStepId: null, // settes i buildStrengthWorkout()
        stepType: STEP_TYPE.repeat,
        numberOfIterations: n,
        smartRepeat: false,
        workoutSteps: steps.flat(Infinity)
    };
}

/**
 * Komplett styrkeøkt for gc.addWorkout(). steps kan blande exercise()/rest()/
 * perSide() på toppnivå og rounds()-grupper; nestede lister flates ut.
 * stepOrder nummereres fortløpende gjennom hele treet (grupper teller som eget
 * steg), childStepId er unik per gruppe.
 */
export function buildStrengthWorkout({ name, description, steps }) {
    const numberedSteps = nummererSteg(steps);
    return {
        workoutName: name,
        description,
        sportType: STRENGTH_SPORT,
        workoutSegments: [
            {
                segmentOrder: 1,
                sportType: STRENGTH_SPORT,
                workoutSteps: numberedSteps
            }
        ]
    };
}
