# Garmin-treningsdagbok

> Idéen kommer fra **Sondre Wittek** ([@sonwit](https://github.com/sonwit)) —
> takk for tipset. Dette repoet er min egen gjennomføring av den.

Kobler Garmin Connect til dine egne GitHub-repoer: henter treningsdata ned,
lagrer den som JSON du eier selv, og pusher strukturerte økter, styrkeprogram
og løyper den andre veien — så de dukker opp på klokka.

## ⚠️ Oppsettet krever TO repoer

Dette prosjektet er bygget rundt en deling som er verdt å forstå før du gjør
noe som helst:

| Repo | Innhold | Synlighet |
|---|---|---|
| **kode-repoet** (dette) | skriptene, `config.json`, `workout.json` | **offentlig** — koden er generell og deles fritt |
| **data-repoet** | all treningsdata, dashboardet, fix-filene | **privat** — søvn, HRV, vekt og GPS-spor |

De to kobles med miljøvariabelen **`GARMIN_DATA_DIR`**, som peker fra koden til
data-repoet:

```bash
export GARMIN_DATA_DIR=~/Repos/garmin-data   # legg den i ~/.zshrc
```

**Hvorfor delt:** `data/` inneholder hvor du sov, hvor tung du var og hvert
GPS-spor du har løpt — altså hvor du bor. Det hører ikke hjemme i et offentlig
repo. Men dataene trenger likevel versjonering og backup: **VO2max-trenden i
`history.json` kan ikke gjenskapes** — Garmin gir bare siste verdi, så den
bygges ett punkt per synk og finnes ingen andre steder. Derfor et *privat repo*,
ikke en `.gitignore` alene.

**Er ikke `GARMIN_DATA_DIR` satt**, faller alt tilbake på `data/` her — som er
gitignorert, så ingenting lekker. Da virker prosjektet på én maskin uten backup.
Fullt oppsett står i
[Public repo — og hvor dataene bor](#public-repo--og-hvor-dataene-bor).

---

Ingen offisiell Garmin-API-nøkkel trengs. Alt går gjennom det samme
private API-et som Garmin Connect-appen selv bruker, via
[`garmin-connect`](https://www.npmjs.com/package/garmin-connect)-biblioteket.

**Hva du får:**

| | |
|---|---|
| `sync.js` | henter aktiviteter, splits, søvn, HRV, hvilepuls, vekt, VO2max, prediksjoner → data-repoet |
| `stats.js` | ukesstatistikk, restitusjon, nedtelling til løp, i terminalen |
| `push-workout.js` | dagens økt fra `workout.json` → strukturert økt i Garmin Connect |
| `push-plan.js` | hele planen fra `plan.json` → daterte økter i **treningskalenderen** |
| `push-strength.js` | faste styrkeøkter → øktbiblioteket i Garmin |
| `push-loype.js` | en rute → løype (course) i Garmin |
| `finn-loype.js` / `finn-bakke.js` | finner flate teststrekk og jevne intervallbakker fra OSM + Kartverket (**Norge**) |
| `fix-threshold.js` / `fix-strength.js` | retter terskelverdier og loggede styrkesett ved kilden |
| `build-dashboard.js` | statisk `dashboard.html` med form, volum og restitusjon over tid |
| `lib/paths.js` | eneste sted datastien defineres — leser `GARMIN_DATA_DIR` |
| `.github/workflows/` | push av økter når filene endres (synken ligger i data-repoet) |
| `proxy/` | **valgfritt** — Cloud Run-proxy som gir en AI-agent lesetilgang uten å gi den Garmin-tokenet ditt |

Koden er skrevet for å leses av en AI-assistent (Claude Code, Cursor,
Copilot) like mye som av deg: dataene ligger som flate JSON-filer på disk, med
et destillat i `summary.json` som er ment å være det en analyse leser.

---

## Kom i gang

Krever **Node 22 eller nyere** (GitHub Actions-workflowene kjører Node 24).

```bash
git clone <ditt-repo> treningsdagbok && cd treningsdagbok
npm install

node login.js    # logg inn med Garmin-e-post og passord, én gang
node sync.js     # første synk henter 365 dager historikk (tar noen minutter)
node stats.js    # se at det virker
```

`login.js` lagrer to tokens i `~/.garmin-tokens`. OAuth1-tokenet varer omtrent
et år, OAuth2-tokenet er kortlevd og fornyes automatisk fra det første.
Passordet trengs ikke igjen.

**Har du to-faktor (MFA) på Garmin-kontoen**, støtter ikke biblioteket det —
skru MFA midlertidig av på garmin.com mens du kjører `login.js`, og på igjen
etterpå. Tokenene fortsetter å virke.

### Daglig bruk

```bash
node sync.js     # inkrementell — henter bare nye dager
node stats.js
```

### Første oppsett av ditt eget repo

1. Lag et **offentlig** repo for koden og et **privat** repo for dataene — se
   [Public repo — og hvor dataene bor](#public-repo--og-hvor-dataene-bor).
2. Legg koden herfra inn i det første (`git remote add origin <ditt-repo>`).
3. `export GARMIN_DATA_DIR=~/Digdir/Repos/garmin-data` (legg den i `~/.zshrc`).
4. Rediger `config.json` med løpene dine — se under.
5. Kjør `node sync.js`. Dataene havner i data-repoet og committes der, aldri her.

`config.json` er det eneste du *må* endre. Formatet:

```json
{
  "races": [
    {
      "name": "Oslo Maraton — halvmaraton",
      "date": "2027-09-18",
      "distance_km": 21.1,
      "goal": "1:35 (4:30/km)",
      "goal_seconds": 5700,
      "note": "Fritekst — bakgrunn, hvorfor målet er som det er"
    }
  ]
}
```

`goal_seconds` er måltiden i sekunder og er den `stats.js` og dashboardet
regner mot; `goal` er bare teksten som vises. Har du ingen løp planlagt, la
`races` stå som en tom liste (`"races": []`).

---

## Public repo — og hvor dataene bor

Repoet er delt i to, med vilje:

| Repo | Innhold | Synlighet |
|---|---|---|
| `garmin-treningsdagbok` (dette) | koden, `config.json`, `workout.json` | **offentlig** |
| `garmin-data` | `data/` — søvn, HRV, vekt, GPS-spor, dashboard | **privat** |

Grunnen er ikke datamengde — flate JSON-filer som skrives én gang er nettopp
det git er best på, og et år lander på 50–100 MB. Grunnen er at `data/`
inneholder hvor du sov, hvor tung du var og hvor du bor, og at det ikke hører
hjemme i et offentlig repo.

Dataene trenger likevel et sted å bo som ikke er én disk. Særlig
`history.json`. Den er append-only, og **VO2max-kurven kan ikke gjenskapes**:
Garmin gir bare siste verdi, så den bygges ett punkt per synk fra den dagen du
begynner. (Løpsprediksjonene er derimot daterte serier og backfilles ett år
bakover ved første synk — se under.) Derfor et privat repo og ikke en `.gitignore` alene.

### `GARMIN_DATA_DIR`

Alle skriptene henter datastien fra `lib/paths.js`, som leser miljøvariabelen
`GARMIN_DATA_DIR`. Er den ikke satt, brukes `data/` i dette repoet (som er
gitignorert) — så alt virker rett ut av boksen, og det private repoet er noe du
kobler på når du vil.

```bash
export GARMIN_DATA_DIR=~/Digdir/Repos/garmin-data   # legg den i ~/.zshrc
node sync.js && node build-dashboard.js
```

`~` utvides av `lib/paths.js` selv, så den virker også når variabelen settes fra
en workflow eller en `.env`.

Legger du til et nytt skript som leser eller skriver data: **importer `DATA` fra
`lib/paths.js`**, ikke bygg stien på nytt. Ellers slutter den private varianten
å virke i det stille.

### Sette opp det private data-repoet

```bash
gh repo create garmin-data --private
cd ~/Digdir/Repos/garmin-data
git remote add origin git@github.com:Nyeng/garmin-data.git
git push -u origin main
```

Legg tokenene inn som repo-secrets **i data-repoet** (`GARMIN_OAUTH1_TOKEN` og
`GARMIN_OAUTH2_TOKEN`, se under), og sett `KODE_REPO` øverst i workflow-filene
der til `<din-bruker>/garmin-treningsdagbok`. Er kode-repoet privat, trenger
checkout-steget i tillegg en PAT med `repo`-scope som secret.

### Hva ligger hvor

**Kode-repoet** har workflowene som bare *skriver til Garmin* og ikke rører
datamappa: `push-workout.yml`, `push-strength.yml`, `push-loype.yml`,
`inspect-activity.yml`, `inspect-threshold.yml`.

**Data-repoet** har `sync.yml` (henter data og committer dem), `fix-threshold.yml`
og `fix-strength.yml`. De to siste ligger der fordi de skriver til datamappa —
sikkerhetskopien av brukerprofilen og de rettede øvelsessettene — og fordi
`threshold-fix.json` og `strength-fix.json` inneholder terskelpuls, aktivitets-ID-er
og loggede vekter. Begge filene ligger derfor i data-repoet, og kjøres derfra:

```bash
cd ~/Digdir/Repos/garmin-data
node ../garmin-treningsdagbok/fix-threshold.js --dry-run
```

Workflowene i begge repoene sjekker ut de to repoene ved siden av hverandre og
kobler dem med `GARMIN_DATA_DIR`.

### Secrets

| Secret | Verdi | Hvor |
|---|---|---|
| `GARMIN_OAUTH1_TOKEN` | innholdet i `~/.garmin-tokens/oauth1_token.json`, som én linje | begge repo |
| `GARMIN_OAUTH2_TOKEN` | innholdet i `~/.garmin-tokens/oauth2_token.json`, som én linje | begge repo |

```bash
cat ~/.garmin-tokens/oauth1_token.json   # kopier ut, uten linjeskift på slutten
```

Secrets er trygge i et offentlig repo: GitHub gir dem aldri til workflows som
kjører fra en fork-PR. Merk at OAuth1-tokenet utløper etter omtrent et år — da
må `login.js` kjøres på nytt og secretene oppdateres begge steder.

Hopper du over secretene, virker alt lokalt. Workflowene er en bekvemmelighet,
ikke en forutsetning.

**Publiser aldri `dashboard.html` på GitHub Pages.** Pages er alltid offentlig på
Free- og Pro-planen, uansett hva repoet er.

---

## Dagens økt → Garmin (`workout.json`)

Økta beskrives som ren data. Endrer du `workout.json` og pusher, kjører
`.github/workflows/push-workout.yml` og laster den opp til Garmin Connect.
Lokalt:

```bash
node push-workout.js              # push økta i workout.json
node push-workout.js --dry-run    # se JSON-en uten å sende noe
node push-workout.js --list       # list dine siste økter (med id)
node push-workout.js --delete ID  # slett en økt
```

```json
{
  "date": "2027-05-14",
  "name": "Terskel 4 x 6 min",
  "type": "running",
  "steps": [
    { "kind": "warmup",   "minutes": 15, "hr": { "max": 145 } },
    { "kind": "interval", "minutes": 6,  "hr": { "max": 172 }, "repeat": 4 },
    { "kind": "recovery", "minutes": 2 },
    { "kind": "cooldown", "minutes": 10 }
  ]
}
```

Fullt skjema står øverst i `push-workout.js`. Kort:

- **Steg-typer:** `warmup`, `interval`, `recovery`, `cooldown`, `ramp`. Nøkkelen
  heter `kind` (`step` godtas også, for gamle filer).
- **Hvert steg avsluttes** enten på distanse (`"km": 1.35`) eller tid
  (`"minutes": 5` / `"seconds": 30`).
- **Fartsmål:** `"pace": { "fast": "4:55", "slow": "5:00" }`.
- **Pulsmål:** `"hr": { "min": 125, "max": 152 }`. Utelater du `min`
  (`"hr": { "max": 172 }`), settes gulvet automatisk 50 slag under taket — bruk
  den formen på terskeldrag, der poenget er et tak og ikke et gulv, så klokka
  ikke maser «for lav puls» mens du fortsatt er på vei opp.
- **`"repeat": 4`** på et drag gir 4 × (draget + pausen rett etter). Pausen
  trekkes inn i gjentakelsen fordi det er slik en økt leses: «4 x 6 min med 2
  min pause» er fire runder. Er det ingen pause etter, gjentas draget alene.
- **`"treadmill": true`** på toppnivå legger inn et 20-sekunders opptrappingssteg
  foran hvert drag, så klokka vibrerer når det er på tide å skru opp beltet.
  Sekundene tas fra det rolige steget foran når det er tidsstyrt og har nok å
  gi, så økta ikke blir lengre. Enkeltdrag kan reservere seg med `"ramp": false`.

Pushen er **idempotent**: samme øktnavn erstattes i stedet for å duplisere, og
utgåtte datoer pushes aldri. Det er trygt å justere dagens økt flere ganger.

Økta havner i Garmin Connect (nett og app). Send den videre til klokka derfra,
eller legg den i treningskalenderen på riktig dato.

**NB:** fartsmål på intervallsteg bruker et stykke av Garmins interne
workout-API som ikke er offentlig dokumentert. Sjekk økta i Connect etter push
første gang.

---

## Treningsplan (`plan.json` → kalenderen)

`push-workout.js` legger én økt i øktbiblioteket, og så planlegger du den for
hånd. For en plan over flere uker er det ~50 klikk i Connect — altså friksjonen
som gjør at planen ikke blir brukt. `push-plan.js` planlegger dem i stedet:

```bash
node push-plan.js --dry-run    # vis hva som ville skjedd
node push-plan.js              # push + legg i treningskalenderen
node push-plan.js --list       # hva ligger i kalenderen de neste 3 månedene
node push-plan.js --clear      # fjern planens økter fra kalenderen
```

```json
{
  "name": "Retur etter sykdom → 10 km",
  "workouts": [
    { "date": "2026-09-03", "name": "Terskel 4 x 6 min", "steps": [ … ] },
    { "date": "2026-09-05", "name": "Langtur 12 km",     "steps": [ … ] }
  ]
}
```

Hver økt bruker **nøyaktig samme steg-skjema som `workout.json`** — begge går
gjennom `lib/workout-spec.js`, så det finnes bare én oversettelse fra data til
Garmin-økt.

Endepunktet er `POST workout-service/schedule/<workoutId>` med
`{"date":"YYYY-MM-DD"}`, verifisert 01.09.2026. Det er ikke offentlig
dokumentert — samme risikoklasse som fartsmålene og terskelverdiene.

**Idempotent, og det kommer gratis:** sletting av en økt fjerner også
kalenderoppføringen. Skriptet sletter derfor alle økter med en dato som finnes i
planen før det pusher, så en justert plan *erstatter* den forrige i stedet for å
legge seg oppå. Faste styrkeøkter har ingen dato i navnet og røres aldri.

Alle økter bygges før noe sendes: en plan med en feil i økt 7 av 12 skal ikke
etterlate seks halvpushede økter i Garmin.

**Fallgruve:** `calendar-service` er **0-indeksert på måned** — oktober er
`month/9`. En 1-indeksert forespørsel gir en tom kalender, ikke en feil.

---

## Styrkeøkter (`push-strength.js`)

Faste styrkeøkter lastes opp som gjenbrukbare økter i øktbiblioteket — ikke
datofestet, så de kan startes rett fra klokka (Styrketrening → Økter).

```bash
node push-strength.js --dry-run
node push-strength.js
```

`push-strength.js` inneholder **et kjørbart eksempelprogram** med to økter.
Bytt ut øvelsene med dine egne. Byggeklossene ligger i
`lib/workout-builder.js`:

```js
exercise('SQUAT', 'BARBELL_BACK_SQUAT', { reps: 6, weightKg: 60, note: '…' })
perSide('ROW', 'ONE_ARM_BENT_OVER_ROW', { reps: 8 })   // ett steg per side
rest(90)
rounds(3, [ …steg… ])                                   // supersett/sirkler
```

Kategoriene og øvelsesnavnene er Garmins egne koder. Katalogen er stor og ikke
offentlig dokumentert; de vanligste står i `lib/workout-builder.js`, og en
ukjent kode gir feil ved push i stedet for å bli lastet opp i det stille. Har
en øvelse ingen underkategori, send `null`.

Legger du flere programmer i `PROGRAMMER`-objektet, rydder skriptet bort
øktene fra det inaktive programmet ved push — så biblioteket alltid speiler
nøyaktig det som er aktivt.

---

## Terskelverdier (`fix-threshold.js`)

```bash
node inspect-threshold.js          # les ut hvor terskelen ligger, skriver ingenting
node fix-threshold.js --dry-run    # vis diffen
node fix-threshold.js              # send (krever også "apply": true i fila)
```

Garmin **autodetekterer terskelen etter harde økter**, og én korrupt lap holder
til å sette den grovt feil — se «Baneøkter» under [Kjente fallgruver](#kjente-fallgruver-i-garmin-data).
Følgene treffer alt som avhenger av sonene: sone 4–5-minutter forsvinner fra
harde økter, og løpsprediksjonene hopper over natta uten at noe har skjedd med
formen.

Verdiene ligger i **brukerprofilen**, ikke på økta:

```
GET/PUT https://connectapi.garmin.com/userprofile-service/userprofile/user-settings
→ { id, userData: { lactateThresholdHeartRate, lactateThresholdSpeed,
    thresholdHeartRateAutoDetected, … }, userSleep, … }
```

`lactateThresholdSpeed` er **m/s delt på ti** — tempo i sek/km er
`100 / verdien`. Kontroll: `0.38333226` → 4:21/km.

**Hele objektet sendes tilbake**, med bare de endrede feltene rørt: endepunktet
erstatter, så en delvis kropp kan nulle ut vekt, søvnvinduer og resten av
profilen. Derfor lagres en sikkerhetskopi i `data/backup/` før hver skriving, og
verdiene leses tilbake etterpå — Garmin svarer 200 på ting den ikke lagret.

Pulssonene ligger for seg i `/biometric-service/heartRateZones` og er avledet av
LTHR (`zone5Floor` **er** terskelen). De følger som regel med av seg selv, men
skriptet sjekker det og sier fra hvis de henger igjen.

Rettelsen oppgis i `threshold-fix.json`:

```json
{
  "why": "fritekst — hvorfor rettelsen finnes",
  "apply": false,
  "expect": { "hr": 175 },
  "hr": 168,
  "pace": "4:30",
  "stopAutoDetect": false
}
```

`expect` er en sikring: treffer den ikke, gjør skriptet ingenting og sier fra —
så en rettelse som er blitt overflødig ikke råtner i det stille. **To sikringer
må stå riktig samtidig** for at noe sendes: `"apply": true` i fila *og* fravær
av `--dry-run`.

**Slår du av autodeteksjonen** (Garmin Connect-appen → Puls → Automatisk
registrering → Terskel: Av), oppdaterer ikke tallet seg selv lenger. Da må det
vedlikeholdes herfra — ellers undervurderer Garmin deg like systematisk som en
feilaktig autodeteksjon overvurderer deg. Terskelen bør revurderes etter et
**løp på 10 km til halvmaraton** (den beste målingen som finnes), eller etter
**to terskeløkter på rad** med tydelig bedre fart på samme puls — to, ikke én;
en enkeltøkt er vær, underlag og dagsform. Merk at terskel*farten* ikke er
synlig under Puls i appen; den finnes bare via API-et.

---

## Styrkesett: rette loggen (`fix-strength.js`)

Aktivitetens `summarizedExerciseSets` har bare totaler per øvelse — sett, reps,
**tyngste** vekt og volum. Enkeltsettene ligger her:

```
GET https://connectapi.garmin.com/activity-service/activity/<id>/exerciseSets
→ { activityId, exerciseSets: [ { exercises:[{category,name}], repetitionCount,
    weight /* gram */, duration, setType: ACTIVE|REST, startTime, … } ] }
```

Synken lagrer dem i `data/exercisesets/<id>.json` og **overskriver** — en
styrkeøkt rettes typisk i appen i etterkant. `summary.json` bygger
øvelsesradene fra disse filene når de finnes, og faller tilbake på aggregatet
ellers.

Å rette i Connect-GUI-et er tungvint nok til at det ikke blir gjort. Derfor:

```bash
node fix-strength.js --dry-run
node fix-strength.js
```

```json
{
  "activityId": 24105522581,
  "why": "fritekst",
  "apply": false,
  "fixes": [
    { "ex": "LATERAL_RAISE/DUMBBELL_LATERAL_RAISE", "set": 3, "kg": 4 },
    { "ex": "SHOULDER_PRESS/SEATED_DUMBBELL_SHOULDER_PRESS", "kg": 12 },
    { "ex": "PULL_UP/WEIGHTED_PULL_UP", "to": "PULL_UP/LAT_PULLDOWN" }
  ]
}
```

**PUT, ikke POST — og det er ikke det nettleseren gjør.** Webklienten sender
`POST` mot `connect.garmin.com/gc-api/…`, men den ruta er en proxy; mot backend
blir det `PUT`. `POST` rett på `connectapi` svarer **405 Method Not Allowed**.
Kroppen er GET-svaret uten `wktStepIndex` og `messageIndex`. **Hele lista må
med**, også REST-settene — settene har ingen egen id og kan bare adresseres på
plass.

Rettelser som *ikke* skal skrives til Garmin — gamle økter det ikke er verdt å
røre — legges i `data/corrections.json` i stedet. De brukes når `summary.json`
bygges, mens rådataene i `data/activities/` aldri røres (`sync.js` overskriver
hver hentede økt, så en håndredigering der forsvinner uten varsel).

---

## Stryd og andre Connect IQ-felt

Connect-API-et gir ikke *developer fields* — feltene en Connect IQ-app skriver
(Stryd-kraft, form power, beinstivhet). Synken laster derfor ned original-FIT-fila
for nye løpeturer og leser dem ut (`lib/fit.js`), lagrer sammendrag per økt og
per runde i `data/devfields/<activityId>.json`, og legger gjennomsnittene inn som
`dev` på løpeturen i `data/summary.json`.

Økter uten slike felt får også en fil (med tom `fields`), så FIT-fila aldri
lastes ned to ganger. Feiler nedlastingen eller parsingen, logges det som en
advarsel og synken går videre.

Forutsetter at datafeltet ligger på løpeprofilen på klokka — poden alene, paret
som fotpod, gir bare fart og distanse. Test parseren uten nettverk med
`node test-fit.js`, som bygger en syntetisk FIT-fil.

`node inspect-activity.js <id>` viser hva Garmin faktisk har lagret på en
aktivitet, og er måten å finne ut om et eksternt felt i det hele tatt kom fram.

---

## Løyper (courses)

`lib/garmin.js` kan liste, opprette og slette løyper — f.eks. tegne opp en
langtur som dukker opp på klokka.

```js
// POST https://connectapi.garmin.com/course-service/course
{
  courseName: 'Langtur 16 km',
  activityTypePk: 1,          // 1 = løping
  rulePK: 2,                  // 2 = privat (1 = offentlig, 4 = gruppe)
  sourceTypeId: 3,
  distanceMeter: 16000,
  elevationGainMeter: 180,
  elevationLossMeter: 180,
  startPoint: { latitude, longitude },
  geoPoints: [ { latitude, longitude, elevation, distance } ]  // distance = kumulativt
}
// DELETE https://connectapi.garmin.com/course-service/course/<courseId>
```

Fallgruver: feltnavnene avviker fra GET-svaret (`activityTypePk`/`rulePK`/
`distanceMeter`, ikke `activityType`/`privacyRule`/`distanceInMeters`), alle
fire toppfeltene er påkrevd, og en nyopprettet løype er låst for sletting i
noen sekunder (HTTP 429 «not yet ready»). Løypa sendes til klokka fra
Connect-appen (Løyper → send til enhet).

### Finn løyper og bakker (kun Norge)

```bash
node finn-loype.js --sted "Tromsø" --km 10             # flat tur-retur
node finn-loype.js --sted "Tromsø" --km 18 --rundtur   # rundløype
node finn-bakke.js --sted "Tromsø" --stigning 6-10 --sekunder 90
```

To datakilder, begge gratis og uten API-nøkkel:

- **Veinettet fra OpenStreetMap** via Overpass. Tunneler, motorvei, trapper og
  privat vei filtreres bort før søket starter.
- **Høydene fra Kartverket** (`ws.geonorge.no/hoydedata`), DTM1 med 1 meters
  oppløsning — langt bedre enn globale datasett, men **bare for Norge**. Skal
  dette virke andre steder, må høydekilden i `lib/kart.js` byttes.

`finn-loype.js` rangerer på **flathet**, laget for «jeg er på et sted jeg ikke
kjenner og trenger en flat, tunnelfri strekning å løpe en test på».
`finn-bakke.js` gjør det motsatte, men kriteriet er *ikke* bratteste bakke —
det er **jevnhet**: hvor stor del av strekningen som ligger i stigningsbåndet
du ba om, og hvor lang den verste flate biten er. En bakke som slipper i et
platå midt i draget ødelegger settet.

Begge cacher veinett og høyder i `data/kart-cache.json` (gitignorert) — Overpass
er en fellestjeneste som svarer 406 uten `User-Agent` og 429/504 når den er
travel; klienten bytter speil og prøver på nytt.

`--lagre loype.json` skriver beste forslag til fil, og
`.github/workflows/push-loype.yml` laster den opp når fila pushes. Delingen er
med vilje: søket kan kjøres hvor som helst, men da blir det **nøyaktig den ruta
som ble vurdert** som lastes opp — ikke et nytt søk som kan svare noe annet.

**Fallgruve:** korte, bratte utslag nær havnivå er som regel brurampe eller støy
i terrengmodellen, ikke en reell bakke. `finn-bakke.js` måler derfor stigningen
i et glidende 40-metersvindu, ikke per kant.

Konstanten `FLATFART_60S` i `finn-bakke.js` oversetter dragvarighet til meter
og er kalibrert på én løper i ett bratthetsbånd — **juster den til ditt eget
nivå**. Den påvirker bare hvor lang en bakke må være for å gi ønsket varighet.

---

## Vekt

Vekt kommer inn i Garmin fra en tilkoblet vekt (f.eks. Withings → Garmin
Connect) og leses herfra som alt annet. Endepunktet er **ikke verifisert** —
Garmin har flyttet det flere ganger, og de to variantene svarer med hver sin
form:

| Variant | Form på svaret |
|---|---|
| `weight-service/weight/range/<start>/<end>?includeAll=true` | `{ dailyWeightSummaries: [{ summaryDate, latestWeight: { weight } }] }` |
| `weight-service/weight/dateRange?startDate=&endDate=` | `{ dateWeightList: [{ calendarDate, weight }] }` |

`sync.js` prøver dem i rekkefølge og bruker den første som svarer. Svarer
ingen, logges en advarsel og synken går videre.

**Vekt oppgis i GRAM.** Resultatet havner på dagen i `summary.json` som
`weight_kg` og `body_fat_pct`, rett ved siden av hvilepuls, HRV og søvn — med
vilje, fordi utilsiktet vektnedgang og fallende HRV i en oppbyggingsperiode
peker på samme sak.

**To feller, begge sett i ekte data:**

1. **`latestWeight` er ikke nødvendigvis en veiing.** `USER_SETTING` er
   profilvekta, tastet inn for hånd, og er ofte den ferskeste oppføringen på
   dagen. Derfor filtreres det på ekte vektkilder (`INDEX_SCALE` m.fl.).
2. **Selv ekte veiinger kan være innbyrdes umulige.** To målinger minutter fra
   hverandre kan skille flere kilo. Én av dem er feil, og retningen er kjent: en
   ny påstigning kan bare *legge til* vekt (klær, gjenstander, feil profil på
   vekta), aldri fjerne den. Regelen er derfor **dagens første veiing**, som
   også er konvensjonen for vektlogging.

Er det mer enn 1 kg mellom veiingene samme dag, legges `weight_spread_kg` på
dagen — så en vekt som tilordner målinger til feil profil blir synlig i stedet
for stilltiende midlet bort.

---

## Dashboard

```bash
node build-dashboard.js     # → $GARMIN_DATA_DIR/dashboard.html
```

Genereres fra `data/summary.json` + `config.json`: nedtelling og mål vs.
Garmins prediksjon per løp, ukevolum, terskelfart og maratonprediksjon over
tid, HRV, hvilepuls, søvn og treningsklarhet. Kjør den etter hver synk. Åpne
fila lokalt i nettleseren. Den skrives til **datamappa**, ikke hit: den er
avledet av `summary.json` og inneholder de samme helsedataene i grafform, så den
hører hjemme i det private repoet.

**Hvilke prediksjonsgrafer som vises** styres av `PREDIKSJONER` øverst i
`build-dashboard.js`. Garmin gir alle fire distansene, og de ligger i
`history.json` uansett — lista velger bare hva som tegnes:

```js
const PREDIKSJONER = ['k5', 'k10', 'half'];   // 'marathon' finnes også
```

Målet fra `config.json` kobles til riktig graf på distanse (±15 %), så et løp
på 10 km får målstreken sin i 10 km-grafen.

De to formgrafene har **invertert y-akse** — de viser tider, så linja peker
oppover når formen blir bedre. Punktene ligger etter dato, ikke jevnt fordelt:
Garmin oppdaterer terskelen bare på økter som kvalifiserer, så serien har hull.

**Publiser den ikke på GitHub Pages.** Se [Personvern og sikkerhet](#personvern-og-sikkerhet) nederst.

---

## Datastruktur

```
data/
  activities/<år>.json   # alle aktiviteter per år (dedupet, nyeste først)
  splits/<id>.json       # km-splits per løpetur
  devfields/<id>.json    # developer fields fra FIT-fila (Stryd m.m.)
  exercisesets/<id>.json # enkeltsettene på en styrkeøkt (øvelse, reps, vekt per sett)
  daily/<dato>.json      # søvn, HRV, hvilepuls, stress, treningsklarhet (rå Garmin-svar)
  summary.json           # kompakt destillat av alt over — LES DENNE for analyse,
                         # rådata kun når du trenger å grave (regenereres av sync.js)
  corrections.json       # rettelser til Garmins rådata, brukt når summary.json bygges
  status.json            # VO2max, treningsstatus, løpsprediksjoner, terskel, rekorder,
                         # samt vekt som serie over siste år
  history.json           # formmålerne per dato. APPEND-ONLY (lib/history.js).
                         # Prediksjonene backfilles 1 år ved første synk;
                         # VO2max kan IKKE regenereres — ett punkt per synk
  backup/                # sikkerhetskopi av brukerprofilen før hver skriving
  last_sync.txt          # dato for siste synk
  dashboard.html         # statisk dashboard, bygget av build-dashboard.js
  threshold-fix.json     # rettelse av terskelverdier (se fix-threshold.js)
  strength-fix.json      # rettelse av loggede styrkesett (se fix-strength.js)
```

Alt over ligger i det **private** data-repoet, som `GARMIN_DATA_DIR` peker på.
I det offentlige kode-repoet ligger bare koden pluss:

```
config.json              # løpene dine og måltidene
workout.json             # dagens økt som data
```

`summary.json` er poenget med hele opplegget: rådataene fra Garmin er store og
uleselige, destillatet er det en analyse — din egen eller en AI-assistents —
faktisk skal lese.

`history.json` er delvis uerstattelig, og skillet er verdt å kjenne:

| Felt | Backfilles? |
|---|---|
| `pred_k5_s`, `pred_k10_s`, `pred_half_s`, `pred_marathon_s` | **ja** — Garmin serverer daterte serier, og `syncStatus` henter et helt år |
| `vo2max` | **nei** — bare siste verdi finnes. Ett punkt per synk, fra dagen du begynner |

Merk at årsvinduet i `syncStatus` er hardkodet (`sync.js`), uavhengig av
`--days`: en bredere backfill gir flere aktiviteter og daglige helsedata, men
ikke lengre formkurve. Slett aldri fila.

---

## Kjente fallgruver i Garmin-data

Dette er feil som har kostet ekte analyser ekte tid. De er ikke bugs i koden —
de er egenskaper ved dataene klokka leverer.

**Baneøkter.** I `track_running`-modus snapper klokka lap-distansene til
banegeometrien, og kan bomme katastrofalt på én enkelt lap uten at noe annet
ser feil ut. Én lap kan påstå 1 600 m på 159 sekunder — 36 km/t — mens de atten
andre stemmer innenfor ±54 m. Én slik lap gir falsk åpningsfart, ~1 km for høy
totaldistanse, falske PR-er, og kan forurense terskelen via autodeteksjonen.
**Test alltid: er `avgSpeed` > `maxSpeed` på en lap, er lapen ugyldig.** Snitt
over maks er matematisk umulig.

**Korte drag.** Klokkas lap-gjennomsnitt er ubrukelige på drag under ~30
sekunder. På seks 15-sekunders bakkesprinter falt snitteffekten 570 → 165 W og
snittkadensen 194 → 57 gjennom settet, mens makseffekt, makskadens og
pulstoppen etterpå var flate. Beviset er at normalisert effekt lå *under*
snitteffekten i alle seks — matematisk umulig, og en direkte følge av at NP
bygges på et 30-sekunders rullende vindu som ikke har noe å regne på i en
15-sekunders lap. **Les makstall og pulsresponsen i pausen etter draget** —
pulsen topper seg først når draget er over. Aldri snitt.

**Mølleøkter.** Klokka måler distanse fra håndleddet innendørs og bommer grovt:
en økt logget 8,35 km der beltebasert regnestykke ga ~7,2 km, og hele
fartsspennet ble komprimert (+18 % på terskeldrag, −9 % på sprinter). Bruk
**tidsstyrte steg** (`"minutes"`/`"seconds"`), aldri distanse, og styr etter
puls og beltefart. Møllebeltets eget display over-rapporterer gjerne også noen
prosent.

**Manglende felt fra en pod er poden, ikke profilen.** Nuller fra et
Connect IQ-datafelt betyr som regel at poden ikke svarte — feltene kan til og
med være deklarert i FIT-fila og likevel tomme. Vekk poden og verifiser at den
er paret før start.

---

## Bruk med en AI-assistent

Repoet er lagt opp for at en assistent skal kunne lese dataene og skrive
analyser rett inn i det:

- Legg analyser i en `dagbok/`-mappe som markdown, og la assistenten skrive
  der. En fil med **åpne spørsmål** som leses ved hver øktstart er verdt mye:
  chatter tar slutt og kontekst forsvinner, fila gjør det ikke.
- Skriv en `CLAUDE.md` (eller tilsvarende) med reglene dine — terskelverdier,
  fallgruvene over, hvordan du vil at økter skal utformes. Da slipper du å
  forklare det på nytt hver gang.
- Peke assistenten på `data/summary.json`, ikke rådataene. Rådataene er der når
  den trenger å grave.
- Skal en assistent kunne foreslå dagens økt, er mønsteret: den skriver
  `workout.json`, pusher, og GitHub Actions laster opp til Garmin. Da er det
  en commit som er «utløseren», ikke et direkte skriv mot Garmin-kontoen din.

---

## Valgfritt: Garmin-proxy (Cloud Run)

**Hopp over denne delen hvis du ikke bruker AI-assistenter i skya.** Alt over
virker uten den.

Problemet den løser: skal en skyøkt kunne hente ferske data selv, må den ha
Garmin-legitimasjon — og da kan assistenten, og enhver kommando den kjører,
lese et token som har **full skrivetilgang** til Garmin-kontoen din. Proxyen i
`proxy/` holder innloggingen i stedet, og slipper bare gjennom `GET`.

```
skyøkt  ──(ingen legitimasjon)──▶  agent-proxyen
                                     │ fester Authorization her
                                     ▼
                                  Cloud Run: garmin-proxy
                                     │ kun GET, OAuth i minnet
                                     ▼
                                  connectapi.garmin.com
```

Arbeidsdelingen blir: **lesing** (`sync.js`, `stats.js`, `inspect-*.js`) går
gjennom proxyen, **skriving** (`push-workout.js`, `fix-threshold.js`, …) går
gjennom GitHub Actions med det ekte tokenet. En commit er riktig friksjon for
noe som endrer klokka. Kjøres et push-skript i proxy-modus, kaster klienten med
en forklaring i stedet for en kryptisk feil langt nede.

Tjenesten er **statsløs med vilje**: OAuth1-tokenet ligger i Secret Manager,
OAuth2-tokenet lever bare i minnet, og en kaldstart minter et nytt. Ingen
database.

### Deploy

```bash
PROJECT=<din-prosjekt-id>
REGION=europe-north1
gcloud config set project $PROJECT

gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
    artifactregistry.googleapis.com secretmanager.googleapis.com

# Egen tjenestekonto — proxyen skal ikke arve compute-kontoens rettigheter
gcloud iam service-accounts create garmin-proxy --display-name="Garmin proxy"
SA="garmin-proxy@$PROJECT.iam.gserviceaccount.com"

# Hemmeligheter. Token-filene kommer fra `node login.js` — kjør «Kom i gang»
# øverst først hvis de ikke finnes. Bruk `printf`, ikke `echo`: et etterfølgende
# linjeskift blir en del av tokenet og gir 401 som er vond å feilsøke.
PROXY_TOKEN=$(openssl rand -base64 48 | tr -d '\n/+=' | head -c 44)
printf '%s' "$PROXY_TOKEN" | gcloud secrets create garmin-proxy-token --data-file=-
gcloud secrets create garmin-oauth1 --data-file="$HOME/.garmin-tokens/oauth1_token.json"
gcloud secrets create garmin-oauth2 --data-file="$HOME/.garmin-tokens/oauth2_token.json"

for hemmelighet in garmin-proxy-token garmin-oauth1 garmin-oauth2; do
    gcloud secrets add-iam-policy-binding $hemmelighet \
        --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor
done

cd proxy
gcloud run deploy garmin-proxy \
    --source . --region $REGION --service-account $SA \
    --allow-unauthenticated --min-instances 0 --max-instances 2 --memory 512Mi \
    --set-secrets "PROXY_TOKEN=garmin-proxy-token:latest,GARMIN_OAUTH1_TOKEN=garmin-oauth1:latest,GARMIN_OAUTH2_TOKEN=garmin-oauth2:latest"

echo "$PROXY_TOKEN"   # trengs under, og kan ikke leses ut igjen etterpå
```

**`--allow-unauthenticated` er ikke en glipp.** Cloud Runs egen IAM krever et
Google-ID-token som utløper hver time, og agent-proxyer fester bare *statiske*
headere. Autentiseringen ligger derfor i tjenesten selv: bearer-sjekk i konstant
tid, og den nekter å starte hvis `PROXY_TOKEN` er kortere enn 32 tegn.
`*.run.app`-URL-en er ikke en hemmelighet.

### Verifiser

```bash
URL=$(gcloud run services describe garmin-proxy --region $REGION --format='value(status.url)')

curl -s "$URL/health"                                                                     # {"ok":true}
curl -s -o /dev/null -w '%{http_code}\n' "$URL/garmin/userprofile-service/socialProfile"   # 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
     -H "Authorization: Bearer $PROXY_TOKEN" "$URL/garmin/x"                              # 405
curl -s -H "Authorization: Bearer $PROXY_TOKEN" \
     "$URL/garmin/userprofile-service/socialProfile" | head -c 120                         # profilen din
```

Får du 401 på siste linje, er tokenet i Secret Manager sannsynligvis lagret med
et linjeskift på slutten.

### Klientsiden

Tokenet heter forskjellige ting i hver ende, fordi det er to uavhengige
programmer:

| Hvor | Variabel | Rolle |
|---|---|---|
| Secret Manager → Cloud Run | `PROXY_TOKEN` | det tjenesten **krever** |
| AI-miljøet / GitHub Actions | `GARMIN_PROXY_TOKEN` | det klienten **sender** |

Samme streng begge steder. Settes `GARMIN_PROXY_URL` på miljøet, går all lesing
gjennom proxyen. Settes klienten *uten* `GARMIN_PROXY_TOKEN`, sender den ingen
`Authorization`-header og lar miljøets egen credential-mekanisme feste den —
det er den beste varianten, for da finnes ingen legitimasjon i økta i det hele
tatt.

### Kostnad

En synk gjør ~25 HTTP-kall, altså ~3 000 i måneden ved fire synker daglig.
Cloud Runs gratisnivå er 2 millioner kall — **0,15 %**. Reelt sett null, pluss
noen ører for imaget i Artifact Registry.

---

## Personvern og sikkerhet

- **Kode-repoet er offentlig, data-repoet er privat.** Dataene inneholder søvn,
  HRV, hvilepuls, vekt, kroppsfett og posisjonsdata for hver eneste tur — altså
  hvor du bor. **Fjern aldri `data/` fra `.gitignore`** her, selv om
  `GARMIN_DATA_DIR` peker et annet sted: linja er sikkerhetsnettet den dagen
  variabelen ikke er satt.
- **Sjekk før hver push til det offentlige repoet:**

  ```bash
  git ls-files | grep -E '^data/|dashboard\.html|dagbok/'   # skal være tom
  ```
- **Publiser aldri `dashboard.html` på GitHub Pages.** Pages er alltid offentlig
  på Free- og Pro-planen, uansett hva repoet er.
- **Tokenene gir full tilgang til Garmin-kontoen**, også skriving. De ligger i
  `~/.garmin-tokens` (modus 600) og som repo-secrets. `.gitignore` holder dem
  ute av git, men sjekk selv før første push.
- **Tilbakekalling:** kjør `node login.js` på nytt for å minte nye tokens, eller
  bytt Garmin-passord. Husk å oppdatere repo-secretene etterpå.
- Legger du tokenene som miljøvariabler i et AI-skymiljø, kan assistenten og
  enhver kommando den kjører lese dem. Det er nettopp det proxyen over finnes
  for å slippe.

---

## Lisens og forbehold

Ikke tilknyttet Garmin. Bruker Garmins interne API, som kan endre seg uten
varsel — endepunktene her er verifisert ved å observere Connects egen
webklient, og noen av dem (fartsmål på intervaller, terskelverdier,
øvelsessett) er ikke offentlig dokumentert i det hele tatt. Skriveoperasjonene
går mot ekte helsedata uten angreknapp; derfor har alle av dem tørrkjøring som
standard og en `apply`-sikring i tillegg. Bruk dem deretter.
