// Garmin-proxy — én oppgave: holde Garmin-innloggingen, og slippe gjennom
// LESING mot connectapi.garmin.com på vegne av den som har proxy-tokenet.
//
// Hvorfor den finnes: uten den må Garmin-tokenet ligge som miljøvariabel i
// Claude Code-skyøkta, der Claude og enhver kommando Claude kjører kan lese
// det — og det tokenet kan skrive til Garmin-kontoen. Med proxyen forlater
// Garmin-tokenet aldri denne tjenesten, og skyøkta får bare det proxy-tokenet
// gir: GET, og ingenting annet.
//
// Deploy og oppsett er dokumentert i README under «Garmin-proxy (Cloud Run)».
//
// Miljøvariabler (alle påkrevd, monteres fra Secret Manager):
//   GARMIN_OAUTH1_TOKEN   JSON, langlevd (~1 år) — kilden til alt
//   GARMIN_OAUTH2_TOKEN   JSON, kortlevd (~1 t) — fornyes fra OAuth1
//   PROXY_TOKEN           lang tilfeldig streng; det eneste kalleren trenger
//
// Statsløs med vilje. OAuth2-tokenet lever bare i minnet, så en instans som
// skaleres til null tar det med seg — neste kaldstart minter et nytt fra
// OAuth1. Det er derfor tjenesten ikke trenger database.

import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import pkg from 'garmin-connect';
const { GarminConnect } = pkg;

const UPSTREAM = 'https://connectapi.garmin.com';
const PORT = Number(process.env.PORT ?? 8080);
const PROXY_TOKEN = process.env.PROXY_TOKEN ?? '';
// Forny litt før utløp, så et kall ikke rekker å bli avvist mens det er i lufta.
const REFRESH_MARGIN_S = 120;

function fatal(msg) {
    console.error(`FEIL: ${msg}`);
    process.exit(1);
}

// Nekt å starte uten legitimasjon. Et tomt PROXY_TOKEN ville gjort tjenesten
// åpen for alle som gjetter URL-en, og Cloud Run-URL-er er ikke hemmeligheter.
if (PROXY_TOKEN.length < 32) fatal('PROXY_TOKEN mangler eller er kortere enn 32 tegn');

function parseToken(navn) {
    const raw = process.env[navn];
    if (!raw) fatal(`${navn} mangler`);
    try {
        return JSON.parse(raw);
    } catch (e) {
        fatal(`${navn} er ikke gyldig JSON: ${e.message}`);
    }
}

const gc = new GarminConnect({ username: '', password: '' });
gc.loadToken(parseToken('GARMIN_OAUTH1_TOKEN'), parseToken('GARMIN_OAUTH2_TOKEN'));

// Én fornyelse om gangen. En synk fyrer av ~25 kall tett, og uten denne ville
// alle sett et utløpt token samtidig og startet hver sin fornyelse.
let fornyelse = null;

async function accessToken({ force = false } = {}) {
    const t = gc.client.oauth2Token;
    const nå = Math.floor(Date.now() / 1000);
    if (!force && t?.access_token && t.expires_at > nå + REFRESH_MARGIN_S) return t.access_token;
    fornyelse ??= gc.client
        .refreshOauth2Token()
        .finally(() => {
            fornyelse = null;
        });
    await fornyelse;
    return gc.client.oauth2Token.access_token;
}

// Konstant tid, så en angriper ikke kan gjette tokenet tegn for tegn.
function autorisert(req) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    if (!m) return false;
    const gitt = Buffer.from(m[1]);
    const rett = Buffer.from(PROXY_TOKEN);
    return gitt.length === rett.length && timingSafeEqual(gitt, rett);
}

function svar(res, status, body, type = 'application/json') {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    res.writeHead(status, { 'content-type': type, 'content-length': buf.length });
    res.end(buf);
}

async function videresend(mål, res) {
    let upstream = await hent(mål, await accessToken());
    // Garmin kan invalidere et token før utløpstida vi regnet oss fram til.
    // Én tvungen fornyelse og ett nytt forsøk, så gir vi opp.
    if (upstream.status === 401) upstream = await hent(mål, await accessToken({ force: true }));
    const body = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
        'content-length': body.length
    });
    res.end(body);
    return upstream.status;
}

function hent(mål, token) {
    // Ingen headere fra kalleren slipper videre — kun det Garmin trenger.
    return fetch(mål, {
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: '*/*',
            'User-Agent': 'garmin-proxy'
        }
    });
}

const server = http.createServer(async (req, res) => {
    const start = Date.now();
    const url = new URL(req.url, 'http://localhost');
    let status = 0;

    try {
        // Uautentisert, og lekker ingenting: Cloud Run trenger et levendetegn.
        if (url.pathname === '/health') return svar(res, (status = 200), { ok: true });

        if (!url.pathname.startsWith('/garmin/')) return svar(res, (status = 404), { error: 'ukjent sti' });
        if (!autorisert(req)) return svar(res, (status = 401), { error: 'ugyldig token' });

        // HELE sikkerhetsmodellen: uten skrivemetoder kan et lekket proxy-token
        // ikke laste opp økter, slette dem eller flytte terskelverdien.
        if (req.method !== 'GET') {
            res.setHeader('allow', 'GET');
            return svar(res, (status = 405), { error: 'kun GET er tillatt' });
        }

        const mål = new URL(UPSTREAM + url.pathname.slice('/garmin'.length));
        mål.search = url.search;
        // URL-en normaliserer bort «..», men vi sjekker verten uansett — den er
        // det som avgjør at ingen kan bruke proxyen mot noe annet enn Garmin.
        if (mål.origin !== UPSTREAM) return svar(res, (status = 400), { error: 'ugyldig mål' });

        status = await videresend(mål, res);
    } catch (e) {
        console.error(`unntak: ${e.message}`);
        if (!res.headersSent) svar(res, (status = 502), { error: 'oppstrømsfeil' });
    } finally {
        // Sti og status, aldri tokens og aldri query — datoene der er
        // uinteressante, og loggen skal ikke fristes til å bli et datalager.
        console.log(`${status} ${req.method} ${url.pathname} ${Date.now() - start}ms`);
    }
});

server.listen(PORT, () => console.log(`garmin-proxy lytter på ${PORT}`));
