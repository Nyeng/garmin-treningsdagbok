// Finner løpeløyper i veinettet fra OpenStreetMap og rangerer dem etter
// høydeprofil fra Kartverket. Laget for ett konkret problem: å finne en flat,
// tunnelfri strekning å løpe en 10 km-test på, på et sted du ikke kjenner.
//
// Kjør:
//   node finn-loype.js --sted "Tromsø" --km 10
//   node finn-loype.js --lat 69.6496 --lon 18.9560 --km 10
//   node finn-loype.js --sted "Tromsø" --km 20 --rundtur --lagre loype.json
//
// Flagg:
//   --km <n>       ønsket total distanse, standard 10
//   --rundtur      rundløype i stedet for tur-retur
//   --kandidater   antall forslag som høydesjekkes, standard 6
//   --grus         tillat grus/sti (standard: bare fast dekke)
//   --tunneler     ikke filtrer bort tunneler
//   --lagre <fil>  skriv beste forslag til fil (loype.json → GitHub Actions
//                  laster den opp til Garmin, se push-loype.js)
//   --push         last beste forslag opp til Garmin Connect herfra (krever
//                  tokens lokalt)
//   --navn <navn>  løypenavn i Garmin
//
// Tur-retur mot rundtur: en ut-og-tilbake nullstiller høydeprofilen (alt du
// løper opp, løper du ned igjen), den kan ikke gå seg vill, og den trenger
// bare én flat vei i stedet for en hel flat rundløype — bruk den til
// testøkter. Rundtur er for langturer, der variasjon betyr mer enn profil.

import {
    hentVeinett, byggGraf, naermesteNode, avstand, kurs, kursdiff,
    fortett, hoyder, profil, geokode, HARDT_DEKKE,
} from './lib/kart.js';

const args = process.argv.slice(2);
const flagg = (navn, standard = null) => {
    const i = args.indexOf(`--${navn}`);
    return i >= 0 ? args[i + 1] : standard;
};
const harFlagg = (navn) => args.includes(`--${navn}`);

const totalKm = Number(flagg('km', '10'));
const antallKandidater = Number(flagg('kandidater', '6'));
const taGrus = harFlagg('grus');
const taTunneler = harFlagg('tunneler');
const skalPushe = harFlagg('push');
const rundtur = harFlagg('rundtur');
const lagreTil = flagg('lagre');

/**
 * Strålesøk etter strekninger på ønsket lengde ut fra startpunktet.
 * Høyder er ikke med her — de koster API-kall, så de spares til finalen.
 * Her rangeres det på det som er gratis: få svinger, samme vei hele veien,
 * og fast dekke.
 */
function sokStrekninger(graf, noder, startId, malMeter, { bredde = 400, rundtur = false } = {}) {
    // Bare kryss (noder med mer enn to kanter) huskes som besøkt. De øvrige er
    // formpunkter i veigeometrien, og å bære dem med i et sett per sti gjør
    // søket tregt uten å hindre en eneste reell løkke.
    const erKryss = (id) => (graf.get(id)?.length ?? 0) > 2;
    const start = noder.get(startId);

    let stier = [{
        node: startId, meter: 0, straff: 0, sti: [startId], kryss: new Set(),
        forrigeKurs: null, veinavn: null, grusMeter: 0, veier: new Set(),
    }];
    const ferdige = [];

    for (let steg = 0; steg < 12_000 && stier.length; steg++) {
        const neste = [];
        for (const s of stier) {
            for (const kant of graf.get(s.node) ?? []) {
                if (kant.til === s.sti[s.sti.length - 2]) continue;   // ikke rett tilbake

                // Ikke samme kryss to ganger — ellers blir runden et åttetall.
                // Unntak på slutten av en rundtur: veien hjem går nesten alltid
                // gjennom et kryss man allerede har vært i, og uten dette
                // unntaket lukkes løkka aldri i et tynt veinett.
                const naerMaal = rundtur && s.meter > malMeter * 0.7;
                if (s.kryss.has(kant.til) && !naerMaal) continue;

                const k = kurs(noder.get(s.node), noder.get(kant.til));
                const sving = s.forrigeKurs == null ? 0 : kursdiff(s.forrigeKurs, k);
                const grus = HARDT_DEKKE.has(kant.vei.dekke) ? 0
                    : kant.vei.dekke ? kant.meter
                    : kant.vei.type === 'path' || kant.vei.type === 'track' ? kant.meter : 0;
                const navnebytte = kant.vei.navn && s.veinavn && kant.vei.navn !== s.veinavn ? 60 : 0;

                const meter = s.meter + kant.meter;
                const hjem = avstand(noder.get(kant.til), start);

                // På rundtur må det være plass igjen til å komme hjem. Uten
                // denne beskjæringen vandrer søket bare utover og finner aldri
                // tilbake — luftlinja hjem er en gyldig nedre grense.
                if (rundtur && meter + hjem > malMeter * 1.12) continue;

                const kryss = erKryss(kant.til) ? new Set(s.kryss).add(kant.til) : s.kryss;
                const ny = {
                    node: kant.til,
                    meter,
                    straff: s.straff + Math.max(0, sving - 25) + navnebytte + grus * 0.08,
                    sti: [...s.sti, kant.til],
                    kryss,
                    forrigeKurs: k,
                    veinavn: kant.vei.navn ?? s.veinavn,
                    grusMeter: s.grusMeter + grus,
                    veier: new Set([...s.veier, kant.vei.navn ?? kant.vei.type]),
                };

                if (rundtur) {
                    if (hjem < 60 && meter >= malMeter * 0.85) ferdige.push(ny);
                    else neste.push(ny);
                } else if (meter >= malMeter) ferdige.push(ny);
                else neste.push(ny);
            }
        }
        // På rundtur teller det å nærme seg hjem igjen mot slutten, ellers
        // ville de mest «utreisende» stiene alltid vunnet beam-plassene.
        neste.sort((a, b) => {
            const kost = (s) => s.straff / Math.max(s.meter, 1)
                + (rundtur ? avstand(noder.get(s.node), start) / Math.max(malMeter - s.meter, 200) : 0);
            return kost(a) - kost(b);
        });
        stier = neste.slice(0, bredde);
    }

    // Rundturen godtas fra 85 % av måldistansen for at løkka skal lukke seg i
    // det hele tatt, men be man om 20 km vil man ikke ha 17. Er det treff nær
    // målet, forkastes de korte.
    const naerNok = ferdige.filter((f) => f.meter >= malMeter * 0.92);
    const aktuelle = rundtur && naerNok.length ? naerNok : ferdige;

    // Én kandidat per endepunkt — ellers fylles lista med nesten like stier.
    // På rundtur ender alle samme sted, så de skilles på lengde i stedet.
    const beste = new Map();
    for (const f of aktuelle) {
        const id = rundtur ? `${Math.round(f.meter / 250)}` : f.node;
        const b = beste.get(id);
        if (!b || f.straff < b.straff) beste.set(id, f);
    }
    return [...beste.values()].sort((a, b) => a.straff - b.straff);
}

/** Filtrerer bort kandidater som deler mesteparten av traseen med en bedre. */
function ulike(kandidater, antall) {
    const valgt = [];
    for (const k of kandidater) {
        const overlapp = valgt.some((v) => {
            const felles = k.sti.filter((n) => v.sti.includes(n)).length;
            return felles / Math.min(k.sti.length, v.sti.length) > 0.6;
        });
        if (!overlapp) valgt.push(k);
        if (valgt.length >= antall) break;
    }
    return valgt;
}

// --- kjøring ----------------------------------------------------------------

let start;
const sted = flagg('sted');
if (sted) {
    start = await geokode(sted);
    console.log(`Sted: ${start.navn}`);
} else if (flagg('lat') && flagg('lon')) {
    start = { lat: Number(flagg('lat')), lon: Number(flagg('lon')) };
} else {
    console.error('Oppgi enten --sted "Navn" eller --lat <n> --lon <n>');
    process.exit(1);
}

// Tur-retur søker halve distansen én vei; rundtur søker hele veien rundt.
// Søkeradius: halve løypa på tur-retur, en firedel på rundtur (en sirkel med
// omkrets L har radius L/6,3 — en tredel gir god margin for avlange runder).
const malMeter = rundtur ? totalKm * 1000 : (totalKm * 1000) / 2;
const radiusM = rundtur ? (totalKm * 1000) / 3 : malMeter * 1.3;

console.log(rundtur
    ? `Søker rundtur på ${totalKm} km fra ${start.lat.toFixed(5)}, ${start.lon.toFixed(5)}`
    : `Søker tur-retur på ${totalKm} km (${(malMeter / 1000).toFixed(1)} km hver vei) fra ${start.lat.toFixed(5)}, ${start.lon.toFixed(5)}`);
console.log(`Filter: ${taTunneler ? 'tunneler tillatt' : 'ingen tunneler'}, ${taGrus ? 'grus tillatt' : 'fast dekke foretrekkes'}\n`);

const nett = await hentVeinett({ ...start, radiusM, taTunneler });
console.log(`OpenStreetMap: ${nett.veier.length} veier, ${nett.noder.size} punkter`);

const graf = byggGraf(nett);
const { id: startId, meter: tilStart } = naermesteNode(nett.noder, graf, start);
if (startId == null) { console.error('Fant ingen vei i nærheten.'); process.exit(1); }
console.log(`Nærmeste vei: ${Math.round(tilStart)} m fra startpunktet\n`);

const raa = sokStrekninger(graf, nett.noder, startId, malMeter, { rundtur });
if (!raa.length) {
    console.error(rundtur
        ? 'Fant ingen rundtur på ønsket lengde. Prøv en annen distanse, --grus, eller --tunneler.'
        : 'Fant ingen strekning på ønsket lengde.');
    process.exit(1);
}
const kandidater = ulike(raa, antallKandidater);
console.log(`Fant ${raa.length} ${rundtur ? 'runder' : 'strekninger'}, høydesjekker de ${kandidater.length} mest ulike …\n`);

const resultater = [];
for (const k of kandidater) {
    const punkter = fortett(k.sti.map((id) => nett.noder.get(id)), 120);
    const z = await hoyder(punkter);
    const p = profil(punkter, z);
    resultater.push({ ...k, punkter, z, ...p });
    process.stdout.write('.');
}
console.log('\n');

// Tur-retur: stigning og fall bytter plass på vei tilbake, så total stigning
// for hele økta er opp + ned uansett retning. På rundtur er den samme summen
// allerede hele runden. Flathet måles per kilometer av hele løypa.
resultater.sort((a, b) => (a.opp + a.ned) - (b.opp + b.ned));

console.log(`Forslag, flateste først (tall for hele ${rundtur ? 'runden' : 'tur-retur-løypa'}):\n`);
resultater.forEach((r, i) => {
    const totalM = rundtur ? r.lengde : r.lengde * 2;
    const stigning = r.opp + r.ned;
    const ende = r.punkter[r.punkter.length - 1];
    console.log(`${i + 1}. ${(totalM / 1000).toFixed(2)} km  ·  ${Math.round(stigning)} hm totalt  ·  ${(stigning / (totalM / 1000)).toFixed(1)} hm/km`);
    console.log(`   bratteste parti ${r.maksStigning.toFixed(1)} %  ·  ${Math.round(r.grusMeter)} m uten fast dekke`);
    console.log(`   veier: ${[...r.veier].filter(Boolean).slice(0, 5).join(' → ')}`);
    if (rundtur) {
        const midt = r.punkter[Math.floor(r.punkter.length / 2)];
        console.log(`   snur rundt: ${midt.lat.toFixed(5)}, ${midt.lon.toFixed(5)} (fjernest fra start)`);
    } else {
        console.log(`   vendepunkt: ${ende.lat.toFixed(5)}, ${ende.lon.toFixed(5)}`);
        console.log(`   kart: https://www.openstreetmap.org/directions?engine=fossgis_osrm_foot&route=${start.lat.toFixed(5)}%2C${start.lon.toFixed(5)}%3B${ende.lat.toFixed(5)}%2C${ende.lon.toFixed(5)}`);
    }
    console.log();
});

// Høydeprofil per kilometer for det beste forslaget — det er den som avgjør
// om en løype faktisk egner seg, ikke totalsummen.
{
    const b = resultater[0];
    console.log(`Høydeprofil for forslag 1${rundtur ? ', hele runden' : ', én vei (tilbake er speilvendt)'}:\n`);
    let d = 0, km = 1, startZ = b.z[0], min = b.z[0], maks = b.z[0], verst = 0;
    for (let i = 1; i < b.punkter.length; i++) {
        const l = avstand(b.punkter[i - 1], b.punkter[i]);
        d += l;
        if (b.z[i] != null) { min = Math.min(min, b.z[i]); maks = Math.max(maks, b.z[i]); }
        if (b.z[i] != null && b.z[i - 1] != null && l > 5) {
            verst = Math.max(verst, Math.abs(((b.z[i] - b.z[i - 1]) / l) * 100));
        }
        if (d >= km * 1000 || i === b.punkter.length - 1) {
            const dz = (b.z[i] ?? startZ) - startZ;
            const strek = '█'.repeat(Math.max(1, Math.round(Math.abs(dz) / 2)));
            console.log(`  km ${km}: ${dz >= 0 ? '+' : ''}${dz.toFixed(0)} m  (${min.toFixed(0)}–${maks.toFixed(0)} moh, bratteste ${verst.toFixed(1)} %)  ${strek}`);
            startZ = b.z[i] ?? startZ; min = maks = startZ; verst = 0; km++;
        }
    }
    console.log();
}

if (!skalPushe && !lagreTil) {
    console.log('Legg til --lagre for å skrive beste forslag til loype.json (pushes til Garmin av GitHub Actions),');
    console.log('eller --push for å sende den til Garmin Connect direkte herfra.');
    process.exit(0);
}

// --- beste forslag som løypedata --------------------------------------------

const b = resultater[0];
// Rundturen er allerede hel; tur-retur speilvendes så løypa på klokka
// inneholder både utturen og returen.
const rute = rundtur ? b.punkter : [...b.punkter, ...[...b.punkter].reverse().slice(1)];
const ruteZ = rundtur ? b.z : [...b.z, ...[...b.z].reverse().slice(1)];

let kumulativ = 0;
const geoPoints = rute.map((p, i) => {
    if (i > 0) kumulativ += avstand(rute[i - 1], p);
    return {
        latitude: Number(p.lat.toFixed(6)),
        longitude: Number(p.lon.toFixed(6)),
        elevation: Number((ruteZ[i] ?? 0).toFixed(1)),
        distance: Math.round(kumulativ),
    };
});

const loype = {
    navn: flagg('navn', `${totalKm} km ${rundtur ? 'rundtur' : 'tur-retur'} ${sted ?? 'løype'}`),
    beskrivelse: `Fra ${sted ?? `${start.lat.toFixed(5)}, ${start.lon.toFixed(5)}`}. `
        + `${(kumulativ / 1000).toFixed(2)} km, ${Math.round(b.opp + b.ned)} høydemeter. `
        + `Veier: ${[...b.veier].filter(Boolean).slice(0, 5).join(' → ')}.`,
    meter: Math.round(kumulativ),
    stigningMeter: Math.round(b.opp + b.ned),
    fallMeter: Math.round(b.opp + b.ned),
    geoPoints,
};

if (lagreTil) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(lagreTil, `${JSON.stringify(loype, null, 1)}\n`);
    console.log(`Skrev ${lagreTil}: «${loype.navn}», ${geoPoints.length} punkter.`);
    console.log('Commit og push fila, så laster GitHub Actions den opp til Garmin Connect.');
}

if (skalPushe) {
    const { pushLoype } = await import('./push-loype.js');
    await pushLoype(loype);
}
