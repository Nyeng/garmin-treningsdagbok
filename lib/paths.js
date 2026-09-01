// Hvor treningsdataene ligger.
//
// Standard er `data/` i repoet. Settes miljøvariabelen GARMIN_DATA_DIR, brukes
// den i stedet — og det er hele poenget: koden kan ligge i et OFFENTLIG repo
// mens helsedataene (søvn, HRV, vekt, GPS-spor) ligger i et separat PRIVAT
// repo med sin egen git-historikk.
//
//   export GARMIN_DATA_DIR=~/Repos/garmin-data
//
// Se «Public repo» i README for oppsettet.
//
// Alle skriptene henter datastien herfra og ingen andre steder. Legger du til
// et nytt skript som leser eller skriver data, importer DATA — ikke bygg
// stien på nytt, ellers slutter den private varianten å virke i det stille.

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

/** Repoets rot — der config.json og workout.json ligger. */
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// `~` utvides for hånd: et skall utvider den bare når variabelen settes uten
// fnutter, og en tilde som overlever inn hit blir ellers til en mappe som
// heter «~» ved siden av repoet — en feil som er stille og vond å se.
function utvidTilde(sti) {
    if (sti === '~') return homedir();
    if (sti.startsWith('~/')) return join(homedir(), sti.slice(2));
    return sti;
}

/** Mappa treningsdataene leses fra og skrives til. */
export const DATA = process.env.GARMIN_DATA_DIR
    ? resolve(utvidTilde(process.env.GARMIN_DATA_DIR))
    : join(ROOT, 'data');

/** Sant når dataene ligger utenfor repoet — brukes i logglinjer. */
export const DATA_ER_EKSTERN = Boolean(process.env.GARMIN_DATA_DIR);
