// Vercel Edge Middleware — HTTP Basic Auth foran det statiske dashboardet.
//
// Kjører på Vercels edge før noen fil serveres. Brukernavn/passord kommer fra
// prosjektets miljøvariabler (DASHBOARD_USER / DASHBOARD_PASS), satt i Vercel
// selv — aldri i dette repoet. Uten riktige credentials får du en 401 og en
// nettleser-innlogging-dialog, ikke dashboardet.
//
// Se README i garmin-data-repoet for oppsett av variablene.

export const config = {
    matcher: '/:path*'
};

export default function middleware(request) {
    const expectedUser = process.env.DASHBOARD_USER;
    const expectedPass = process.env.DASHBOARD_PASS;

    const auth = request.headers.get('authorization');
    if (auth) {
        const [scheme, encoded] = auth.split(' ');
        if (scheme === 'Basic' && encoded) {
            const [user, pass] = atob(encoded).split(':');
            if (user === expectedUser && pass === expectedPass) {
                return; // riktig innlogging — slipp gjennom til dashboardet
            }
        }
    }

    return new Response('Autentisering kreves', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="Treningsdashboard"' }
    });
}
