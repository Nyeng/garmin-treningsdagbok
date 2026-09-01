// Engangs-innlogging mot Garmin Connect.
//
// Kjør:  node login.js
// Spør om e-post og passord, og lagrer tokens i ~/.garmin-tokens.
// Etterpå kan sync.js kjøres uten passord (tokens varer ~1 år).
//
// NB: Kontoer med to-faktor (MFA) støttes ikke av garmin-connect-biblioteket —
// skru i så fall av MFA midlertidig på garmin.com mens du logger inn her.

// Se lib/garmin.js for hvorfor default-import brukes her (CJS/ESM-interop).
import pkg from 'garmin-connect';
const { GarminConnect } = pkg;
import { mkdirSync } from 'node:fs';
import readline from 'node:readline';
import { TOKEN_DIR } from './lib/garmin.js';

function ask(question, { hidden = false } = {}) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (hidden) {
        // skjul passordet mens det skrives
        rl._writeToOutput = (s) => {
            if (s.includes(question)) rl.output.write(question);
            else rl.output.write('*');
        };
    }
    return new Promise((resolve) =>
        rl.question(question, (answer) => {
            rl.close();
            if (hidden) process.stdout.write('\n');
            resolve(answer.trim());
        })
    );
}

const email = await ask('Garmin e-post: ');
const password = await ask('Garmin passord: ', { hidden: true });

console.log('Logger inn …');
const gc = new GarminConnect({ username: email, password });
await gc.login();

mkdirSync(TOKEN_DIR, { recursive: true });
gc.exportTokenToFile(TOKEN_DIR);

const profile = await gc.getUserProfile();
console.log(`Innlogget som: ${profile.fullName ?? profile.displayName}`);
console.log(`Tokens lagret i ${TOKEN_DIR} — sync.js trenger ikke passord.`);
