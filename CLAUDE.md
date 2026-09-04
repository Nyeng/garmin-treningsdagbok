# Arbeidsregler for dette repoet

Les denne først. Den dekker det som ikke er åpenbart fra koden.

## Oppsettet er TO repoer

| Repo | Innhold | Synlighet |
|---|---|---|
| `garmin-treningsdagbok` (dette) | koden, `config.json`, `workout.json`, `plan.example.json` | **offentlig** |
| `garmin-data` | all treningsdata, `plan.json`, fix-filene, dashboardet | **privat** |

Koblet med `GARMIN_DATA_DIR` (satt i brukerens `~/.zshrc`). **Alt som er
personlig hører hjemme i data-repoet.** Testen er ikke «er dette en måling» —
`plan.json` ble flyttet dit fordi den røper pulssoner, sykdomshistorikk og
hvilke dager brukeren ikke er hjemme.

**Committ aldri noe fra `data/` til dette repoet.** Sjekk før push:

```bash
git ls-files | grep -E '^data/|dashboard\.html|dagbok/'   # skal være tom
```

## Kjør ikke lokal synk og committ dataene

`sync.js` lokalt er fint for å hente ferske tall til en analyse. Men **committ
aldri de genererte filene derfra** — sync-workflowen eier dem, og kjører to
ganger daglig. Gjør du begge deler, kolliderer `summary.json`, `status.json`,
`activities/` og `dashboard.html` hver gang, og rebasen blir et rot.

Skal du committe noe i data-repoet (f.eks. `plan.json` eller `CLAUDE.md`):

```bash
git pull --rebase                      # først, alltid
git add <bare fila du endret>          # aldri git add -A
```

Har du allerede lokale endringer i genererte filer:

```bash
git checkout HEAD -- summary.json status.json dashboard.html activities/ history.json last_sync.txt
```

## Datastien defineres ett sted

`lib/paths.js`. Importer `DATA` derfra — bygg aldri `join(ROOT, 'data')` på
nytt, ellers slutter det private oppsettet å virke i det stille.

## Verifiserte endepunkter

Garmins interne API er ikke dokumentert. Endepunkter i `lib/garmin.js` er
merket med verifiseringsdato. **Verifiser empirisk før du bygger på et nytt** —
skriv et engangsskript, kall det, les svaret tilbake, rydd opp.

Fallgruver som allerede har kostet tid:

- `calendar-service` er **0-indeksert på måned** — oktober er `month/9`. En
  1-indeksert forespørsel gir tom kalender, ikke feil.
- Sletting av en økt fjerner **også** kalenderoppføringen (kaskade). Det er dét
  som gjør `push-plan.js` idempotent uten en egen «avplanlegg»-sti.
- `exerciseSets` krever **PUT**, ikke POST. POST mot `connectapi` gir 405.
- Terskelverdier ligger i brukerprofilen, og endepunktet **erstatter hele
  objektet** — derfor sikkerhetskopi i `data/backup/` før hver skriving.

## Steg-skjemaet

Nøkkelen heter `kind` (`step` godtas for gamle filer). `repeat: n` på et drag
gir n × (draget + pausen rett etter). Oversettelsen ligger i
`lib/workout-spec.js` og deles av `push-workout.js` og `push-plan.js` — legg
den aldri i bare den ene.

## Les data/summary.json, ikke rådataene

`summary.json` er destillatet. Rådata i `data/activities/`, `data/daily/` osv.
er der når du må grave, men de er store og uleselige.

`data/history.json` er append-only. Løpsprediksjonene backfilles ett år, men
**VO2max kan ikke gjenskapes** — Garmin gir bare siste verdi. Slett aldri fila.

## Kjente feller i Garmin-dataene

Disse er egenskaper ved dataene, ikke bugs. Full liste i README under «Kjente
fallgruver». De tre som oftest ødelegger en analyse:

1. **Baneøkter:** er `avgSpeed > maxSpeed` på en lap, er lapen ugyldig. Snitt
   over maks er matematisk umulig. Én slik lap gir falsk åpningsfart og kan
   forurense terskelen via autodeteksjonen.
2. **Drag under ~30 sek:** lap-gjennomsnitt er ubrukelige. Les makstall og
   pulsresponsen i pausen etter draget.
3. **Mølle:** distansen måles fra håndleddet og bommer grovt. Bruk tidsstyrte
   steg, aldri distanse.

## Regn ordentlig før du påstår en trend

Ikke sammenlign en delvis uke med hele uker. Bruk ISO-uker, oppgi antall dager
bak et snitt, og si fra når et tall bygger på for få punkter. Brukeren fanget
en 2-dagers «ukesverdi» presentert ved siden av 7-dagers snitt — den feilen
skal ikke gjentas.

## Skriving mot Garmin

Alle skrive-verktøy har tørrkjøring som standard og en `apply`-sikring i tillegg.
Behold det mønsteret. Dette er ekte helsedata uten angreknapp.
