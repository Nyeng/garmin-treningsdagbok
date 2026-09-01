// Oversetter øktdata (workout.json / plan.json) til Garmins workout-format.
//
// Ligger her og ikke i push-workout.js fordi push-plan.js trenger nøyaktig det
// samme: én økt beskrevet som data → én økt i Garmin. Skulle de to hatt hver
// sin kopi, ville de glidd fra hverandre — og da ville en økt oppført seg
// forskjellig avhengig av om den kom fra en dagsfil eller en plan.
//
// Steg-skjemaet er dokumentert øverst i push-workout.js.

import {
    warmup, warmupTime, interval, intervalTime, recovery, recoveryTime,
    rampTime, cooldown, cooldownTime, buildWorkout, rounds
} from './workout-builder.js';

// Steg-typen heter "kind" i workout.json, README og plan.json. Koden leste
// tidligere bare "step", så den medfølgende eksempeløkta kastet ved push.
// Begge godtas nå — "kind" er det dokumenterte navnet, "step" beholdes så
// eksisterende filer ikke slutter å virke.
const typeOf = (s) => s.kind ?? s.step;

const RAMP_SECONDS = 20;
const RAMP_NOTE = 'Skru opp farten nå — beltet skal være i målfart når draget starter';

export function durationOf(step) {
    return step.seconds ?? (step.minutes != null ? step.minutes * 60 : null);
}

/**
 * Setter inn et opptrappingssteg foran hvert drag ("treadmill": true i
 * workout.json). De 20 sekundene tas fra det rolige steget foran når det er
 * tidsstyrt og har nok å gi (så økta blir like lang), ellers legges de til.
 * Et enkelt drag kan reservere seg med "ramp": false.
 */
export function insertRamps(specSteps) {
    const out = [];
    for (const s of specSteps) {
        if (typeOf(s) === 'interval' && s.ramp !== false) {
            const prev = out[out.length - 1];
            const prevSecs = prev ? durationOf(prev) : null;
            if (prev && ['recovery', 'warmup'].includes(typeOf(prev))
                && prevSecs != null && prevSecs - RAMP_SECONDS >= 20) {
                const { minutes, ...rest } = prev;
                out[out.length - 1] = { ...rest, seconds: prevSecs - RAMP_SECONDS };
            }
            out.push({ kind: 'ramp', seconds: RAMP_SECONDS, note: s.rampNote ?? RAMP_NOTE });
        }
        out.push(s);
    }
    return out;
}

export function buildFromSpec(spec) {
    for (const field of ['date', 'name', 'steps']) {
        if (!spec[field]) throw new Error(`økta mangler feltet "${field}"`);
    }
    const specSteps = spec.treadmill ? insertRamps(spec.steps) : spec.steps;

    // Ett spec-steg → ett Garmin-steg.
    const byggSteg = (s, i) => {
        // Et steg avsluttes enten på distanse ("km") eller varighet
        // ("minutes"/"seconds"); varighet vinner hvis begge er satt.
        const secs = durationOf(s);
        const type = typeOf(s);
        if (secs == null && s.km == null && type !== 'ramp') {
            throw new Error(`Steg ${i + 1} (${type}) mangler lengde — sett "km", "minutes" eller "seconds"`);
        }
        const target = s.pace ?? s.hr;
        let step;
        switch (type) {
            case 'warmup':   step = secs != null ? warmupTime(secs) : warmup(s.km); break;
            case 'cooldown': step = secs != null ? cooldownTime(secs) : cooldown(s.km); break;
            case 'interval': step = secs != null ? intervalTime(secs, target) : interval(s.km, target); break;
            case 'recovery': step = secs != null ? recoveryTime(secs) : recovery(s.km); break;
            case 'ramp':     step = rampTime(secs ?? RAMP_SECONDS); break;
            default: throw new Error(`Ukjent steg-type "${type}" (steg ${i + 1}) — gyldige: warmup, interval, recovery, ramp, cooldown`);
        }
        if (s.note) step.description = s.note;
        return step;
    };

    // "repeat": 4 på et drag betyr 4 × (draget + pausen etter det). Pausen
    // trekkes inn i gruppa fordi det er slik en økt skrives og leses: «4 x 6
    // min med 2 min pause» er fire runder, ikke fire drag etterfulgt av én
    // pause. Er det ingen pause etter, gjentas draget alene.
    //
    // Dette manglet helt: "repeat" var dokumentert i README, men ble aldri
    // lest — en økt med "repeat": 4 ga ETT drag, uten feilmelding.
    const steps = [];
    for (let i = 0; i < specSteps.length; i++) {
        const s = specSteps[i];
        const n = s.repeat;
        if (n == null) {
            steps.push(byggSteg(s, i));
            continue;
        }
        if (!Number.isInteger(n) || n < 2) {
            throw new Error(`"repeat" på steg ${i + 1} må være et heltall >= 2, fikk ${JSON.stringify(n)}`);
        }
        const gruppe = [byggSteg(s, i)];
        const neste = specSteps[i + 1];
        if (neste && typeOf(neste) === 'recovery' && neste.repeat == null) {
            gruppe.push(byggSteg(neste, i + 1));
            i++; // pausen er konsumert av gruppa
        }
        steps.push(rounds(n, gruppe));
    }

    return buildWorkout({
        name: `${toDisplayDate(spec.date)} ${spec.name}`,
        description: spec.description,
        steps
    });
}

// Datoer lagres som ISO ("2026-08-08") i workout.json — det er formatet som
// sorterer og sammenlignes riktig — men vises som dag-måned-år i øktnavnet.
export function toDisplayDate(isoDate) {
    const [y, m, d] = isoDate.split('-');
    return `${d}-${m}-${y}`;
}

// Henter datoen ut av et øktnavn og gir den tilbake som ISO, så den kan
// sammenlignes med andre datoer. Godtar både dagens format ("08-06-2026 ...")
// og det gamle ISO-formatet ("2026-06-08 ..."), slik at økter som ble pushet
// før formatendringen fortsatt ryddes bort i stedet for å bli liggende for
// alltid. Formatene kan ikke forveksles: ingen ISO-dato matcher dd-mm-yyyy.
export function isoDateFromName(workoutName = '') {
    const dmy = /^(\d{2})-(\d{2})-(\d{4}) /.exec(workoutName);
    if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
    const iso = /^(\d{4}-\d{2}-\d{2}) /.exec(workoutName);
    return iso ? iso[1] : null;
}
