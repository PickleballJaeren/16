// ============================================================================
// auth.js — "16"
//
// ALLE brukere (spillere, TV Mode, admin) logges anonymt inn automatisk ved
// appstart — det er det som gjør at firestore.rules kan kreve
// `request.auth != null` for lesing uten å vise en innloggingsskjerm for
// vanlige besøkende.
//
// Admin-RETTIGHETEN er noe helt annet: den kommer fra et `admin: true`
// custom claim på auth-tokenet, satt av Cloud Function-en `verifyAdminPin`
// (se functions/index.js) etter at PIN er verifisert SERVER-SIDE. Ingenting
// her stoler på en klient-sjekket PIN alene — det er nettopp mønsteret vi
// IKKE skal gjenta fra de tre andre appene.
// ============================================================================

import { auth, funcs } from './firebase-init.js';
import {
  signInAnonymously,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";

let gjeldendeBruker = null;
let erAdmin = false;
const lyttere = [];

/**
 * Registrer en callback som får {bruker, erAdmin} hver gang auth-status
 * endrer seg (innlogget, eller admin-status endret via PIN).
 */
export function paAuthEndring(cb) {
  lyttere.push(cb);
  if (gjeldendeBruker) cb({ bruker: gjeldendeBruker, erAdmin });
  return () => {
    const i = lyttere.indexOf(cb);
    if (i !== -1) lyttere.splice(i, 1);
  };
}

function varsleAlle() {
  for (const cb of lyttere) cb({ bruker: gjeldendeBruker, erAdmin });
}

onAuthStateChanged(auth, async (bruker) => {
  if (!bruker) {
    try {
      await signInAnonymously(auth);
    } catch (e) {
      console.error('Kunne ikke logge inn anonymt:', e);
    }
    return; // onAuthStateChanged trigges på nytt når den anonyme brukeren er klar
  }
  gjeldendeBruker = bruker;
  const tokenResultat = await bruker.getIdTokenResult();
  erAdmin = tokenResultat.claims.admin === true;
  varsleAlle();
});

/**
 * Forsøker å logge inn som admin med en PIN. PIN-en sendes ALDRI direkte inn
 * i Firestore-regler — den verifiseres i en Cloud Function, som deretter
 * setter custom claim'et på den allerede anonymt innloggede brukeren.
 *
 * @returns {Promise<{ok:boolean, feil?:string}>}
 */
export async function loggInnSomAdmin(pin) {
  if (!gjeldendeBruker) {
    return { ok: false, feil: 'Ikke innlogget ennå — prøv igjen om et øyeblikk.' };
  }
  try {
    const verifiser = httpsCallable(funcs, 'verifyAdminPin');
    const respons = await verifiser({ pin: String(pin) });
    if (!respons.data?.ok) {
      return { ok: false, feil: respons.data?.feil ?? 'Feil PIN.' };
    }
    // Tving refresh av ID-tokenet slik at det nye custom claim'et faktisk
    // følger med i påfølgende Firestore-kall.
    await gjeldendeBruker.getIdToken(true);
    const tokenResultat = await gjeldendeBruker.getIdTokenResult();
    erAdmin = tokenResultat.claims.admin === true;
    varsleAlle();
    return { ok: erAdmin, feil: erAdmin ? undefined : 'Fikk ikke admin-rettighet — prøv igjen.' };
  } catch (e) {
    console.error('Admin-innlogging feilet:', e);
    return { ok: false, feil: 'Noe gikk galt under innlogging. Sjekk internettforbindelsen.' };
  }
}

export function hentAuthStatus() {
  return { bruker: gjeldendeBruker, erAdmin };
}
