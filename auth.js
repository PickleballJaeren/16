// ============================================================================
// auth.js — "16"
//
// FORENKLET VERSJON: samme mønster som de tre andre appene i prosjektet --
// klient-sjekket PIN, ingen Firebase Auth eller Cloud Function bak. Dette er
// en bevisst nedgradering fra den opprinnelig anbefalte løsningen (Anonymous
// Auth + server-verifisert custom claim via Cloud Function).
//
// KONSEKVENS (gjelder likt for denne og de tre andre appene dine): enhver
// som åpner nettleserens utviklerverktøy og leser denne filen kan finne
// PIN-en og skrive/overstyre resultater direkte mot Firestore. Reglene i
// firestore.rules kan ikke skille "riktig admin" fra "hvem som helst" uten
// en ekte autentiseringsmekanisme bak PIN-en. Det er en bevisst, konsistent
// avveining med resten av oppsettet ditt -- ikke en glipp.
//
// BYTT PIN-EN under før du deployer til klubben:
// ============================================================================

const ADMIN_PIN = '1234';

let erAdmin = false;
const lyttere = [];

/**
 * Registrer en callback som får {bruker, erAdmin}. `bruker` er alltid `true`
 * her (ingen innlogging trengs for å LESE data -- kun for admin-skriving),
 * beholdt kun for å matche samme grensesnitt resten av appen forventer.
 */
export function paAuthEndring(cb) {
  lyttere.push(cb);
  cb({ bruker: true, erAdmin });
  return () => {
    const i = lyttere.indexOf(cb);
    if (i !== -1) lyttere.splice(i, 1);
  };
}

function varsleAlle() {
  for (const cb of lyttere) cb({ bruker: true, erAdmin });
}

/**
 * @returns {Promise<{ok:boolean, feil?:string}>}
 */
export async function loggInnSomAdmin(pin) {
  if (String(pin) === ADMIN_PIN) {
    erAdmin = true;
    varsleAlle();
    return { ok: true };
  }
  return { ok: false, feil: 'Feil PIN.' };
}

export function hentAuthStatus() {
  return { bruker: true, erAdmin };
}
