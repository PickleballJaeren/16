// ============================================================================
// firebase-init.js — "16"
//
// FORENKLET VERSJON: kun Firestore. Firebase Auth og Cloud Functions er ikke
// lenger i bruk siden admin-innlogging er en ren klient-sjekket PIN (se
// auth.js) -- samme mønster som de tre andre appene i prosjektet.
//
// Config-verdiene under er de samme som de tre andre appene bruker (samme
// Firebase-prosjekt/Firestore-database).
// ============================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentSingleTabManager,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyB_0rxDzHpV2HB6JdHm8SEHoGc8vE2F_rE",
  authDomain: "pickle-rank-5fbe5.firebaseapp.com",
  projectId: "pickle-rank-5fbe5",
  storageBucket: "pickle-rank-5fbe5.firebasestorage.app",
  messagingSenderId: "761601873916",
  appId: "1:761601873916:web:f3c13d21e809658fd80479",
};

export const app = initializeApp(firebaseConfig);

// persistentLocalCache gir Firestores innebygde offline-kø for skrive-
// operasjoner: skriv gjort uten nett lagres lokalt og synkroniseres
// automatisk når tilkoblingen er tilbake.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentSingleTabManager() }),
});
