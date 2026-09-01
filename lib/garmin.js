// Felles Garmin-klient: token-lasting og API-endepunkter som ikke finnes
// som ferdige metoder i garmin-connect-biblioteket.

// NB: 'garmin-connect' er en CommonJS-pakke som eksporterer GarminConnect via
// en getter (Object.defineProperty). Nodes ESM-loader gjenkjenner ikke alltid
// dette statisk som en named export (avhenger av Node-versjon — derfor
// funket dette lokalt, men feilet i GitHub Actions). Default-import +
// destrukturering er trygt uansett Node-versjon.
import pkg from 'garmin-connect';
const { GarminConnect } = pkg;
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const TOKEN_DIR = join(homedir(), '.garmin-tokens');
const API = 'https://connectapi.garmin.com';

export function hasTokens() {
    return existsSync(join(TOKEN_DIR, 'oauth1_token.json'));
}

// Tokens kan komme to veier: fra fil (node login.js, lokalt) eller fra
// miljøvariabler. Miljøvariantene finnes fordi biblioteket bare kan lese fra
// fil, mens både GitHub Actions og Claude Code-skyøkter leverer hemmeligheter
// som miljøvariabler. Skrives de her, virker samme kode alle tre steder — og en
// skyøkt kan hente data direkte i stedet for å måtte pushe en commit for å
// trigge synk-workflowen.
//
// Fila vinner hvis den allerede finnes, så en lokal innlogging aldri overskrives
// av en gammel variabel.
function materializeTokensFromEnv() {
    const oauth1 = process.env.GARMIN_OAUTH1_TOKEN;
    const oauth2 = process.env.GARMIN_OAUTH2_TOKEN;
    if (!oauth1 || !oauth2) return false;
    mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(join(TOKEN_DIR, 'oauth1_token.json'), oauth1, { mode: 0o600 });
    writeFileSync(join(TOKEN_DIR, 'oauth2_token.json'), oauth2, { mode: 0o600 });
    return true;
}

// ---------------------------------------------------------------------------
// Proxy-modus
//
// Settes GARMIN_PROXY_URL, går all lesing gjennom Garmin-proxyen i stedet for
// rett på Garmin, og det finnes ikke noe Garmin-token i denne prosessen i det
// hele tatt. Se README under «Garmin-proxy (Cloud Run)».
//
// Proxyen slipper bare gjennom GET. Det er hele poenget: en skyøkt kan lese alt
// den trenger, men kan ikke laste opp økter eller flytte terskelverdien —
// skriving går fortsatt via GitHub Actions med det ekte tokenet.
// ---------------------------------------------------------------------------

const PROXY_URL = process.env.GARMIN_PROXY_URL;
const PROXY_TOKEN = process.env.GARMIN_PROXY_TOKEN;

function toProxyUrl(url) {
    if (!url.startsWith(API)) throw new Error(`proxyen dekker bare ${API}, fikk: ${url}`);
    return `${PROXY_URL.replace(/\/$/, '')}/garmin${url.slice(API.length)}`;
}

// Samme formatering som bibliotekets toDateString: lokale datodeler, YYYY-MM-DD.
function dateString(date) {
    const d = new Date(date);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

async function proxyGet(url, { params, responseType } = {}) {
    const mål = new URL(toProxyUrl(url));
    for (const [k, v] of Object.entries(params ?? {})) {
        if (v != null) mål.searchParams.set(k, String(v));
    }
    // Uten PROXY_TOKEN sendes ingen Authorization-header — da fester Anthropics
    // agent-proxy den selv, etter at forespørselen har forlatt VM-en, og tokenet
    // finnes ikke i økta. Med token setter vi den selv, slik CI må gjøre.
    const headers = PROXY_TOKEN ? { Authorization: `Bearer ${PROXY_TOKEN}` } : {};
    const res = await fetch(mål, { headers });
    if (!res.ok) throw new Error(`proxy svarte ${res.status} på ${mål.pathname}`);
    return responseType === 'arraybuffer' ? await res.arrayBuffer() : await res.json();
}

function proxyClient() {
    const base = {
        // Rå endepunktkall fra lib/garmin.js sitt `endpoints`-objekt.
        get: proxyGet,
        // lib/fit.js henter FIT-zipen som binærdata via gc.client.get().
        client: { get: proxyGet },
        // De to kallene som ellers går gjennom bibliotekets egne metoder.
        getUserProfile: () => proxyGet(`${API}/userprofile-service/socialProfile`),
        getSleepData: (date = new Date()) =>
            proxyGet(`${API}/sleep-service/sleep/dailySleepData`, { params: { date: dateString(date) } }),
        // Proxyen eier tokenet — det finnes ingenting å skrive tilbake her.
        exportTokenToFile: () => {}
    };
    // Alt annet er skriving eller innlogging, og skal feile med en forklaring
    // i stedet for en «is not a function» langt nede i et push-skript.
    return new Proxy(base, {
        get(target, prop) {
            if (prop in target) return target[prop];
            if (typeof prop !== 'string' || prop === 'then') return undefined;
            throw new Error(
                `«${prop}» er ikke tilgjengelig i proxy-modus — proxyen slipper bare gjennom GET. ` +
                'Skriving mot Garmin må kjøres i GitHub Actions med det ekte tokenet. Se README «Garmin-proxy».'
            );
        }
    });
}

export async function connect() {
    if (PROXY_URL) return proxyClient();
    if (!hasTokens() && !materializeTokensFromEnv()) {
        console.error(
            'Ingen tokens funnet. Tre muligheter:\n' +
            '  node login.js                     (lokalt — lagrer i ~/.garmin-tokens)\n' +
            '  GARMIN_OAUTH1_TOKEN/..._OAUTH2_   (CI — se README «Tokens»)\n' +
            '  GARMIN_PROXY_URL                  (skyøkt, read-only — se README «Garmin-proxy»)'
        );
        process.exit(1);
    }
    const gc = new GarminConnect({ username: '', password: '' });
    gc.loadTokenByFile(TOKEN_DIR);
    return gc;
}

// displayName trengs i flere endepunkt-URLer; hentes én gang per kjøring
let displayName;
export async function getDisplayName(gc) {
    if (!displayName) {
        const profile = await gc.getUserProfile();
        displayName = profile.displayName;
    }
    return displayName;
}

export const endpoints = {
    // Løyper (courses) — GET-endepunkter. Oppretting/sletting bruker
    // gc.client.post/delete direkte; payload-skjema og fallgruver er
    // dokumentert i README.md under «Løyper (courses)». Verifisert 27.07.2026.
    courses: (dn) => [`${API}/course-service/course/owner/${dn}`],
    courseDetail: (courseId) => [`${API}/course-service/course/${courseId}`],
    activitiesByDate: (start, end) => [
        `${API}/activitylist-service/activities/search/activities`,
        { params: { startDate: start, endDate: end, start: 0, limit: 1000 } }
    ],
    splits: (activityId) => [`${API}/activity-service/activity/${activityId}/splits`],
    // Øvelsessett per styrkeøkt — enkeltsettene, ikke sammendraget. Verifisert
    // 25.08.2026. Svaret er { activityId, exerciseSets: [...] }, der hvert sett
    // har exercises[], repetitionCount, weight (gram), setType (ACTIVE/REST) og
    // startTime. Settene har INGEN egen id, så de kan bare adresseres på plass.
    exerciseSets: (activityId) => [`${API}/activity-service/activity/${activityId}/exerciseSets`],
    hrv: (date) => [`${API}/hrv-service/hrv/${date}`],
    stress: (date) => [`${API}/wellness-service/wellness/dailyStress/${date}`],
    trainingReadiness: (date) => [`${API}/metrics-service/metrics/trainingreadiness/${date}`],
    maxMetrics: (date) => [`${API}/metrics-service/metrics/maxmet/daily/${date}/${date}`],
    trainingStatus: (date) => [`${API}/metrics-service/metrics/trainingstatus/aggregated/${date}`],
    racePredictions: (dn) => [`${API}/metrics-service/metrics/racepredictions/latest/${dn}`],
    // Historikk for prediksjonene. IKKE verifisert mot API-et — svarer den
    // ikke, logger synken en advarsel og går videre: data/history.json bygges
    // uansett opp av det daglige `latest`-punktet.
    racePredictionsRange: (dn, start, end) => [
        `${API}/metrics-service/metrics/racepredictions/daily/${dn}`,
        { params: { fromCalendarDate: start, toCalendarDate: end } }
    ],
    personalRecords: (dn) => [`${API}/personalrecord-service/personalrecord/prs/${dn}`],
    restingHeartRate: (dn, date) => [
        `${API}/userstats-service/wellness/daily/${dn}`,
        { params: { fromDate: date, untilDate: date, metricId: 60 } }
    ],
    userSummary: (dn, date) => [
        `${API}/usersummary-service/usersummary/daily/${dn}`,
        { params: { calendarDate: date } }
    ],
    enduranceScore: (date) => [
        `${API}/metrics-service/metrics/endurancescore`,
        { params: { calendarDate: date } }
    ],
    // Vekt. Withings synker inn i Garmin Connect hver tredje time, så Garmin er
    // kilden også for vekt — det finnes ingen Withings-integrasjon i repoet.
    // IKKE verifisert mot API-et: Garmin har flyttet dette endepunktet flere
    // ganger, og de to variantene under svarer med hver sin form. sync.js
    // prøver dem i rekkefølge og bruker den første som svarer; lib/summary.js
    // leser begge formene. Svarer ingen, logger synken en advarsel og går
    // videre — resten av synken er viktigere.
    //
    //   range     → { dailyWeightSummaries: [{ summaryDate, latestWeight: { weight } }] }
    //   dateRange → { dateWeightList: [{ calendarDate, weight }] }
    //
    // Vekt oppgis i GRAM begge steder.
    weightRange: (start, end) => [
        `${API}/weight-service/weight/range/${start}/${end}`,
        { params: { includeAll: true } }
    ],
    weightDateRange: (start, end) => [
        `${API}/weight-service/weight/dateRange`,
        { params: { startDate: start, endDate: end } }
    ],
    // value er m/s delt på 10 → tempo i sek/km = 100 / value
    lactateThresholdSpeed: (start, end) => [
        `${API}/biometric-service/stats/lactateThresholdSpeed/range/${start}/${end}`,
        { params: { aggregation: 'daily' } }
    ],
    lactateThresholdHeartRate: (start, end) => [
        `${API}/biometric-service/stats/lactateThresholdHeartRate/range/${start}/${end}`,
        { params: { aggregation: 'daily' } }
    ]
};
