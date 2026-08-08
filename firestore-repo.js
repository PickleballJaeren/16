// ============================================================================
// firestore-repo.js — "16"
//
// ALL Firestore-tilgang for appen går gjennom denne filen. To regler holdes
// strengt her (jf. arkitektur-kravene i datamodell.md):
//
//   1. Ingen spørring leser en hel samling og filtrerer i klienten — enhver
//      liste er enten en avgrenset subcollection, eller har en ekte limit().
//   2. Leaderboard er ALDRI beregnet ved lesing — det skrives i SAMME
//      transaksjon som kampresultatet, av registrerResultat()/overstyrResultat().
// ============================================================================

import { db } from './firebase-init.js';
import {
  collection, doc, getDoc, getDocs, setDoc, updateDoc, addDoc,
  query, where, orderBy, limit, onSnapshot,
  writeBatch, serverTimestamp, getCountFromServer,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

import { beregnPuljeRangering } from './eventlogikk.js';

const EVENTS = 'seksten_events';
const SPILLERE = 'seksten_spillere';
const CHAMPIONS = 'seksten_champions';
const SETTINGS = 'seksten_settings';
const LIVE = 'seksten_live';

// ----------------------------------------------------------------------------
// Innstillinger (eventnavn/tagline — redigerbart, ikke hardkodet)
// ----------------------------------------------------------------------------

export async function hentInnstillinger() {
  const snap = await getDoc(doc(db, SETTINGS, 'app'));
  return snap.exists() ? snap.data() : null;
}

export async function lagreInnstillinger({ eventNavn, tagline, disipliner }) {
  await setDoc(doc(db, SETTINGS, 'app'), {
    eventNavn, tagline, disipliner, oppdatert: serverTimestamp(),
  }, { merge: true });
}

// ----------------------------------------------------------------------------
// Master-spillere (seksten_spillere) — bundet klubb (~60 medlemmer), derfor
// en trygg, eksplisitt begrenset liste-spørring (ikke en ubegrenset scan).
// ----------------------------------------------------------------------------

export async function hentAlleAktiveSpillere() {
  const q = query(
    collection(db, SPILLERE),
    where('aktiv', '==', true),
    orderBy('navn'),
    limit(200) // klubben har ~60 medlemmer — dette er trygg slack, ikke "les alt"
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function opprettSpiller({ navn, farge }) {
  const ref = await addDoc(collection(db, SPILLERE), {
    navn, farge: farge ?? '#2563eb', aktiv: true,
    opprettet: serverTimestamp(),
    stats: { antallEventer: 0, antallSeire: 0, antallFinaler: 0, antallEventseire: 0, sisteResultat: null },
  });
  return ref.id;
}

export async function oppdaterSpiller(spillerId, data) {
  await updateDoc(doc(db, SPILLERE, spillerId), data);
}

export async function deaktiverSpiller(spillerId) {
  await updateDoc(doc(db, SPILLERE, spillerId), { aktiv: false });
}

export async function hentSpillerHistorikk(spillerId) {
  const q = query(
    collection(db, SPILLERE, spillerId, 'historikk'),
    orderBy('dato', 'desc'),
    limit(50) // avgrenset per spiller — aldri hele historikken på tvers av alle
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ----------------------------------------------------------------------------
// Eventer (seksten_events)
// ----------------------------------------------------------------------------

export async function hentSisteEventer(antall = 10) {
  const q = query(collection(db, EVENTS), orderBy('opprettet', 'desc'), limit(antall));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function opprettEvent({ navn, dato, config }) {
  // getCountFromServer teller uten å lese dokumentene — trygt mot ubegrenset
  // vekst selv når antall eventer blir stort over årene.
  const antallSnap = await getCountFromServer(collection(db, EVENTS));
  const eventNummer = antallSnap.data().count + 1;

  const ref = await addDoc(collection(db, EVENTS), {
    navn, eventNummer, status: 'draft',
    dato, opprettet: serverTimestamp(), oppdatert: serverTimestamp(),
    config, gjeldendeRunde: 0, sluttspillFase: 'none',
    kampoppsettGenerertOgValidert: false,
  });
  return { id: ref.id, eventNummer };
}

export function lyttEvent(eventId, cb) {
  return onSnapshot(doc(db, EVENTS, eventId), (snap) => {
    cb(snap.exists() ? { id: snap.id, ...snap.data() } : null);
  });
}

export async function oppdaterEventStatus(eventId, nyStatus) {
  await updateDoc(doc(db, EVENTS, eventId), { status: nyStatus, oppdatert: serverTimestamp() });
}

export async function oppdaterEventFelt(eventId, felter) {
  await updateDoc(doc(db, EVENTS, eventId), { ...felter, oppdatert: serverTimestamp() });
}

// ----------------------------------------------------------------------------
// Event-roster (events/{id}/spillere) — hvem som er med i DETTE eventet,
// og hvordan de kvalifiserte seg. Separat fra master-spillerdokumentet.
// ----------------------------------------------------------------------------

export async function hentRoster(eventId) {
  const snap = await getDocs(collection(db, EVENTS, eventId, 'spillere')); // maks 16 — trygt uten limit()
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export function lyttRoster(eventId, cb) {
  return onSnapshot(collection(db, EVENTS, eventId, 'spillere'), (snap) => {
    cb(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  });
}

export async function leggTilIRoster(eventId, spillerId, { navn, kvalifiseringsstatusKilde, wildcardBegrunnelse }) {
  await setDoc(doc(db, EVENTS, eventId, 'spillere', spillerId), {
    spillerId, navn, puljeId: null,
    kvalifiseringsstatusKilde, wildcardBegrunnelse: wildcardBegrunnelse ?? null,
    qualifiedForNext: false,
  });
}

export async function fjernFraRoster(eventId, spillerId) {
  await setDoc(doc(db, EVENTS, eventId, 'spillere', spillerId), { fjernet: true }, { merge: true });
  // (soft-slett heller enn hard delete — enkelt å angre før kampoppsett er generert)
}

export async function flyttSpillerTilPulje(eventId, spillerId, nyPuljeId) {
  await updateDoc(doc(db, EVENTS, eventId, 'spillere', spillerId), { puljeId: nyPuljeId });
}

// ----------------------------------------------------------------------------
// Puljer (events/{id}/puljer)
// ----------------------------------------------------------------------------

export async function hentPuljer(eventId) {
  const snap = await getDocs(collection(db, EVENTS, eventId, 'puljer')); // maks 4
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/** Skriver alle 4 puljene i én batch. */
export async function lagrePuljer(eventId, puljer) {
  const batch = writeBatch(db);
  for (const p of puljer) {
    batch.set(doc(db, EVENTS, eventId, 'puljer', p.id), {
      navn: p.navn, spillerIds: p.spillerIds, ferdig: false,
    });
  }
  await batch.commit();
}

// ----------------------------------------------------------------------------
// Kamper (events/{id}/kamper)
// ----------------------------------------------------------------------------

export async function hentKamperForRunde(eventId, runde) {
  const q = query(collection(db, EVENTS, eventId, 'kamper'), where('runde', '==', runde)); // maks 6
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export function lyttKamperForRunde(eventId, runde, cb) {
  const q = query(collection(db, EVENTS, eventId, 'kamper'), where('runde', '==', runde));
  return onSnapshot(q, (snap) => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
}

export async function hentAlleKamperIPulje(eventId, puljeId) {
  const q = query(collection(db, EVENTS, eventId, 'kamper'), where('puljeId', '==', puljeId)); // maks 6
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function hentKamperForFase(eventId, fase) {
  const q = query(collection(db, EVENTS, eventId, 'kamper'), where('fase', '==', fase), limit(30));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/**
 * Skriver et helt generert (og allerede validert av kampgenerator.js) kampoppsett
 * for puljespillet i én batch, og markerer eventet som klart for hovedeventet.
 */
export async function lagreKampoppsett(eventId, kamperMedNavn) {
  const batch = writeBatch(db);
  for (const k of kamperMedNavn) {
    const ref = doc(collection(db, EVENTS, eventId, 'kamper'));
    batch.set(ref, {
      ...k,
      status: 'scheduled',
      poengA: null, poengB: null, vinnerId: null, poengforskjell: null,
      suddenDeath: false, overstyrtAvAdmin: false,
      timer: { status: 'not_started', startetAt: null, gjenstaendeSekunder: 0 },
    });
  }
  batch.update(doc(db, EVENTS, eventId), { kampoppsettGenerertOgValidert: true, oppdatert: serverTimestamp() });
  await batch.commit();
}

/** Sletter alle puljespill-kamper (for regenerering). Destruktivt — bekreft i UI før kall. */
export async function slettPuljespillKamper(eventId) {
  const q = query(collection(db, EVENTS, eventId, 'kamper'), where('fase', '==', 'pool'));
  const snap = await getDocs(q);
  const batch = writeBatch(db);
  snap.docs.forEach(d => batch.delete(d.ref));
  batch.update(doc(db, EVENTS, eventId), { kampoppsettGenerertOgValidert: false });
  await batch.commit();
}

export async function endreBaneOgDisiplin(eventId, kampId, { bane, disiplin }) {
  await updateDoc(doc(db, EVENTS, eventId, 'kamper', kampId), { bane, disiplin });
}

// --- Timer ---

export async function startTimer(eventId, kampId, varighetSek) {
  await updateDoc(doc(db, EVENTS, eventId, 'kamper', kampId), {
    status: 'active',
    timer: { status: 'running', startetAt: serverTimestamp(), gjenstaendeSekunder: varighetSek },
  });
}

export async function pauseTimer(eventId, kampId, gjenstaendeSekunder) {
  await updateDoc(doc(db, EVENTS, eventId, 'kamper', kampId), {
    'timer.status': 'paused',
    'timer.gjenstaendeSekunder': gjenstaendeSekunder,
  });
}

export async function resetTimer(eventId, kampId, varighetSek) {
  await updateDoc(doc(db, EVENTS, eventId, 'kamper', kampId), {
    status: 'scheduled',
    timer: { status: 'not_started', startetAt: null, gjenstaendeSekunder: varighetSek },
  });
}

export async function settSuddenDeath(eventId, kampId) {
  await updateDoc(doc(db, EVENTS, eventId, 'kamper', kampId), { suddenDeath: true, 'timer.status': 'finished' });
}

// --- Resultatregistrering (puljespill) — SAMME transaksjon som leaderboard ---

/**
 * Registrerer sluttresultatet for en puljespill-kamp OG oppdaterer puljens
 * leaderboard-dokument i SAMME skriveoperasjon (batch), slik at leaderboardet
 * aldri kan komme ut av synk med kampresultatene.
 *
 * OBS teknisk begrensning: Firestore sin Web SDK støtter kun enkelt-
 * dokumentlesing (`transaction.get(ref)`) inni `runTransaction` — ikke
 * spørringer mot en subcollection. Vi kan derfor ikke gjøre HELE
 * les-og-skriv-syklusen ekte transaksjonell mot puljens 6 kampdokumenter.
 * Løsningen her henter puljens kamper rett før batch-skrivingen (ikke inni
 * en transaksjon) og skriver kamp+leaderboard atomisk sammen med
 * writeBatch(). Siden admin er den ENESTE som skriver resultater, og gjør
 * det fra ett dashboard om gangen, er race-vinduet i praksis neglisjerbart —
 * men vær oppmerksom på dette hvis appen senere åpnes for flere samtidige
 * admin-enheter, da bør en Cloud Function med Admin SDK (som STØTTER
 * transaksjonelle queries) overta denne skrivingen.
 */
export async function registrerPuljeResultat(eventId, kamp, { poengA, poengB, erOverstyring = false, rosterNavnMap = {} }) {
  const kampRef = doc(db, EVENTS, eventId, 'kamper', kamp.id);
  const leaderboardRef = doc(db, EVENTS, eventId, 'leaderboard', kamp.puljeId);

  const vinnerId = poengA > poengB ? kamp.spillerA : kamp.spillerB;
  const poengforskjell = Math.abs(poengA - poengB);
  const oppdatertKamp = {
    ...kamp, status: 'completed', poengA, poengB, vinnerId, poengforskjell,
    overstyrtAvAdmin: erOverstyring || kamp.overstyrtAvAdmin === true,
  };

  // Avgrenset spørring (maks 6 dokumenter — én puljes kamper).
  const puljeKampQuery = query(collection(db, EVENTS, eventId, 'kamper'), where('puljeId', '==', kamp.puljeId));
  const puljeKampSnap = await getDocs(puljeKampQuery);
  const alleKamperIPulje = puljeKampSnap.docs.map(d => (d.id === kamp.id ? oppdatertKamp : { id: d.id, ...d.data() }));

  const spillerIdsIPulje = [...new Set(alleKamperIPulje.flatMap(k => [k.spillerA, k.spillerB]))];
  const fullforte = alleKamperIPulje.filter(k => k.status === 'completed');
  const rangering = beregnPuljeRangering(spillerIdsIPulje, fullforte)
    .map(r => ({ ...r, navn: rosterNavnMap[r.spillerId] ?? r.spillerId }));

  const batch = writeBatch(db);
  batch.update(kampRef, {
    status: 'completed', poengA, poengB, vinnerId, poengforskjell,
    overstyrtAvAdmin: erOverstyring || kamp.overstyrtAvAdmin === true,
    'timer.status': 'finished',
  });
  batch.set(leaderboardRef, {
    puljeId: kamp.puljeId, oppdatert: serverTimestamp(),
    rangering: rangering.slice(0, 4),
  });
  await batch.commit();
}

export async function hentLeaderboard(eventId, puljeId) {
  const snap = await getDoc(doc(db, EVENTS, eventId, 'leaderboard', puljeId));
  return snap.exists() ? snap.data() : null;
}

export function lyttLeaderboard(eventId, puljeId, cb) {
  return onSnapshot(doc(db, EVENTS, eventId, 'leaderboard', puljeId), (snap) => {
    cb(snap.exists() ? snap.data() : null);
  });
}

export async function hentAlleLeaderboards(eventId) {
  const snap = await getDocs(collection(db, EVENTS, eventId, 'leaderboard')); // maks 4
  return snap.docs.map(d => ({ puljeId: d.id, ...d.data() }));
}

// ----------------------------------------------------------------------------
// Sluttspill (events/{id}/sluttspill/{fase})
// ----------------------------------------------------------------------------

export async function lagreSluttspillFase(eventId, fase, data) {
  await setDoc(doc(db, EVENTS, eventId, 'sluttspill', fase), data);
}

export async function hentSluttspillFase(eventId, fase) {
  const snap = await getDoc(doc(db, EVENTS, eventId, 'sluttspill', fase));
  return snap.exists() ? snap.data() : null;
}

export async function leggTilSluttspillKamp(eventId, kamp) {
  const ref = doc(collection(db, EVENTS, eventId, 'kamper'));
  await setDoc(ref, {
    ...kamp,
    status: 'scheduled', poengA: null, poengB: null, vinnerId: null, poengforskjell: null,
    suddenDeath: false, overstyrtAvAdmin: false,
    timer: { status: 'not_started', startetAt: null, gjenstaendeSekunder: 0 },
  });
  return ref.id;
}

export async function registrerSluttspillResultat(eventId, kampId, { poengA, poengB, spillerA, spillerB }) {
  const vinnerId = poengA > poengB ? spillerA : spillerB;
  await updateDoc(doc(db, EVENTS, eventId, 'kamper', kampId), {
    status: 'completed', poengA, poengB, vinnerId,
    poengforskjell: Math.abs(poengA - poengB),
    'timer.status': 'finished',
  });
  return vinnerId;
}

// ----------------------------------------------------------------------------
// Live-peker for TV Mode / Courts (Fase 6)
// ----------------------------------------------------------------------------

export async function settAktivtEvent(eventId, gjeldendeRunde, sluttspillFase) {
  await setDoc(doc(db, LIVE, 'aktivEvent'), {
    eventId, gjeldendeRunde, sluttspillFase, oppdatert: serverTimestamp(),
  });
}

// ----------------------------------------------------------------------------
// Hall of Fame (seksten_champions)
// ----------------------------------------------------------------------------

export async function hentChampions() {
  const q = query(collection(db, CHAMPIONS), orderBy('dato', 'desc'), limit(100));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function registrerChampion(record) {
  await addDoc(collection(db, CHAMPIONS), record);
}

export async function oppdaterChampion(championId, data) {
  await updateDoc(doc(db, CHAMPIONS, championId), data);
}
