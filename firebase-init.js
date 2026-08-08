// ============================================================================
// firebase-init.js — "16"
//
// VIKTIG: Lim inn SAMME firebaseConfig som de tre andre appene i prosjektet
// bruker (1 vs 1, stafettliga, klubb-appen) — det er meningen at "16" skal
// dele Firebase-prosjekt (og dermed Firestore-database) med dem, se
// datamodell.md. Ikke opprett et nytt Firebase-prosjekt for denne appen.
// ============================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentSingleTabManager,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getFunctions } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";

const firebaseConfig = {
  apiKey: "AIzaSyB_0rxDzHpV2HB6JdHm8SEHoGc8vE2F_rE",
  authDomain: "pickle-rank-5fbe5.firebaseapp.com",
  projectId: "pickle-rank-5fbe5",
  storageBucket: "pickle-rank-5fbe5.firebasestorage.app",
  messagingSenderId: "761601873916",
  appId: "1:761601873916:web:f3c13d21e809658fd80479",
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
// persistentLocalCache gir Firestores innebygde offline-kø for skrive-
// operasjoner: skriv gjort uten nett lagres lokalt og synkroniseres
// automatisk når tilkoblingen er tilbake. admin.js viser en tydelig
// UI-indikator (basert på navigator.onLine + Firestores nettverksstatus)
// slik at administrator aldri er i tvil om et resultat faktisk er lagret
// sentralt eller bare ligger lokalt på enheten (se arkitektur-krav).
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentSingleTabManager() }),
});
export const funcs = getFunctions(app);
