// ============================================================================
// sw.js — "16"
//
// Ansvar: gjøre APP-SKALLET (HTML/CSS/JS/ikoner) tilgjengelig offline, slik
// at appen i det minste laster og viser noe fornuftig selv med dårlig nett
// i klubblokalet. Live event-data (Firestore) håndteres IKKE her — det har
// sin egen offline-kø via persistentLocalCache i firebase-init.js.
//
// VIKTIG: Denne service workeren ruter ALDRI trafikk til Firestore, Auth
// eller Cloud Functions — de slipper helt forbi fetch-handleren. Å legge en
// cache-strategi i veien for sanntidslytterne eller admin-PIN-verifiseringen
// ville gitt subtile, vonde feil (gamle data vist som "live", eller
// mislykkede skriveoperasjoner appen tror gikk bra).
//
// Bump CACHE_VERSION ved hver deploy som endrer app-skallet, slik at gamle
// cacher ryddes bort automatisk i activate-steget.
// ============================================================================

const CACHE_VERSION = 'v5';
const APP_CACHE = `seksten-app-shell-${CACHE_VERSION}`;
const RUNTIME_CACHE = `seksten-runtime-${CACHE_VERSION}`;

const APP_SHELL = [
  './',
  './index.html',
  './courts.html',
  './tv.html',
  './hall-of-fame.html',
  './styles.css',
  './admin.js',
  './courts.js',
  './tv.js',
  './hall-of-fame.js',
  './register-sw.js',
  './auth.js',
  './firebase-init.js',
  './firestore-repo.js',
  './public-repo.js',
  './eventlogikk.js',
  './kampgenerator.js',
  './testdata.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png',
  './favicon-32.png',
  './apple-touch-icon.png',
];

// Faste, versjonerte CDN-URL-er appens JS-moduler faktisk importerer fra.
// Uten disse i cachen vil ikke appen engang klare å parse firebase-init.js
// offline (import-setningene ville feile).
const FIREBASE_SDK_URLS = [
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js',
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js',
];

const GOOGLE_FONTS_STYLESHEET =
  'https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap';

// Verter vi ALDRI skal legge oss i veien for — Firestore-kall (WebChannel/
// long-polling-endepunktene Firestore SDK-en bruker).
const BYPASS_HOSTNAMES = [
  'firestore.googleapis.com',
];

// ----------------------------------------------------------------------------
// Install: precache app-skallet. Bruker individuelle cache.add()-kall (ikke
// addAll) slik at ÉN mislykket ressurs (f.eks. midlertidig nettbrudd på ett
// ikon) ikke blokkerer HELE installasjonen.
// ----------------------------------------------------------------------------

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(APP_CACHE);
      const alle = [...APP_SHELL, ...FIREBASE_SDK_URLS, GOOGLE_FONTS_STYLESHEET];
      const resultater = await Promise.allSettled(alle.map(url => cache.add(url)));
      const feilet = resultater
        .map((r, i) => ({ r, url: alle[i] }))
        .filter(x => x.r.status === 'rejected');
      if (feilet.length > 0) {
        console.warn('[sw] Kunne ikke precache:', feilet.map(f => f.url));
      }
    })()
  );
  self.skipWaiting();
});

// ----------------------------------------------------------------------------
// Activate: rydd bort gamle cache-versjoner.
// ----------------------------------------------------------------------------

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const nokler = await caches.keys();
      await Promise.all(
        nokler
          .filter(k => k !== APP_CACHE && k !== RUNTIME_CACHE)
          .map(k => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

// ----------------------------------------------------------------------------
// Fetch
// ----------------------------------------------------------------------------

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // POST (bl.a. Cloud Function-kall) rører vi aldri

  const url = new URL(request.url);

  if (BYPASS_HOSTNAMES.some(h => url.hostname.endsWith(h))) {
    return; // ikke kall respondWith — la nettleseren håndtere dette helt normalt
  }

  if (url.origin === self.location.origin) {
    event.respondWith(cacheForstMedBakgrunnsoppdatering(request, APP_CACHE));
    return;
  }

  if (url.hostname === 'www.gstatic.com' || url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(cacheForstMedBakgrunnsoppdatering(request, RUNTIME_CACHE));
    return;
  }

  // Alt annet (skulle i praksis ikke forekomme): la nettleseren håndtere det.
});

/**
 * Cache-først, med en bakgrunnsoppdatering av cachen fra nettverket (stale-
 * while-revalidate). For navigasjonsforespørsler som verken finnes i cache
 * eller nettverk (offline + ikke besøkt før), faller vi tilbake til
 * index.html slik at appen i det minste åpner seg og kan vise en fornuftig
 * "ingen tilkobling"-tilstand i stedet for en blank feilside.
 */
async function cacheForstMedBakgrunnsoppdatering(request, cacheNavn) {
  const cache = await caches.open(cacheNavn);
  const cachet = await cache.match(request);

  const nettverkOppdatering = fetch(request)
    .then((respons) => {
      if (respons && respons.ok) cache.put(request, respons.clone());
      return respons;
    })
    .catch(() => null);

  if (cachet) {
    nettverkOppdatering; // oppdater i bakgrunnen — ikke vent på den
    return cachet;
  }

  const fraNettverk = await nettverkOppdatering;
  if (fraNettverk) return fraNettverk;

  if (request.mode === 'navigate') {
    const fallback = await caches.match('./index.html');
    if (fallback) return fallback;
  }

  return new Response('Offline og ikke tilgjengelig i cache.', {
    status: 503, statusText: 'Offline',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
