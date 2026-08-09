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
  writeBatch, serverTimestamp, getCountFromServer, increment,
  arrayUnion, arrayRemove,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";


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

/**
 * Sletter en spiller PERMANENT fra master-registeret (seksten_spillere),
 * inkludert historikk-subcollectionen. Dette er en hard delete -- i
 * motsetning til deaktiverSpiller() (soft, reverserbar) og fjernFraRoster()
 * (fjerner kun spilleren fra ETT events roster, rører ikke master-dokumentet).
 *
 * Sletter IKKE eventuelle referanser til spilleren i seksten_champions eller
 * i et events kamper/leaderboard/roster (de bærer denormalisert navn og
 * fortsetter å vise historiske resultater med navnet spilleren hadde --
 * dette er en bevisst avveining slik at historiske eventer ikke "hull-etes"
 * av en senere sletting). UI-et bør advare/blokkere sletting av en spiller
 * som står i det AKTIVE eventets roster, for å unngå en spillerId i
 * rosteret som ikke lenger peker på et gyldig master-dokument.
 */
export async function slettSpillerHelt(spillerId) {
  const batch = writeBatch(db);

  const historikkSnap = await getDocs(collection(db, SPILLERE, spillerId, 'historikk'));
  historikkSnap.docs.forEach(d => batch.delete(d.ref));

  batch.delete(doc(db, SPILLERE, spillerId));
  await batch.commit();
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

/**
 * Sletter et event PERMANENT, inkludert ALLE subcollections
 * (puljer, spillere/roster, kamper, leaderboard, sluttspill) -- Firestore
 * sletter aldri subcollections automatisk når foreldredokumentet slettes,
 * så det må gjøres eksplisitt her, eller de blir liggende igjen som
 * "foreldreløse" dokumenter appen aldri viser, men som fortsatt tar plass.
 *
 * Rører IKKE seksten_champions (championer beholdes i Hall of Fame selv om
 * kilde-eventet slettes) eller seksten_spillere (master-spillerne lever
 * uavhengig av eventer). Destruktivt og ugjenkallelig -- bekreft i UI før kall.
 *
 * Kjører i flere batcher (Firestore-batcher er begrenset til 500
 * operasjoner) siden et event med mye historikk kan ha ganske mange
 * kamp-dokumenter.
 */
export async function slettEvent(eventId) {
  const eventRef = doc(db, EVENTS, eventId);

  const subcollectionNavn = ['puljer', 'spillere', 'kamper', 'leaderboard', 'sluttspill'];
  const alleRefs = [];
  for (const navn of subcollectionNavn) {
    const snap = await getDocs(collection(db, EVENTS, eventId, navn));
    snap.docs.forEach(d => alleRefs.push(d.ref));
  }
  alleRefs.push(eventRef);

  const BATCH_STORRELSE = 450; // god margin under Firestores grense på 500
  for (let i = 0; i < alleRefs.length; i += BATCH_STORRELSE) {
    const batch = writeBatch(db);
    alleRefs.slice(i, i + BATCH_STORRELSE).forEach(ref => batch.delete(ref));
    await batch.commit();
  }

  // Hvis dette var det live-aktive eventet, rydd også pekeren i seksten_live
  // slik at TV Mode/Courts ikke fortsetter å lytte etter et event som er borte.
  const liveSnap = await getDoc(doc(db, LIVE, 'aktivEvent'));
  if (liveSnap.exists() && liveSnap.data().eventId === eventId) {
    await setDoc(doc(db, LIVE, 'aktivEvent'), { eventId: null, gjeldendeRunde: null, sluttspillFase: 'none', oppdatert: serverTimestamp() });
  }
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

/** Flytter en spiller fra én pulje til en annen — oppdaterer begge puljedokumentenes
 *  spillerIds-lister OG rosterets puljeId-felt i én batch. */
export async function byttSpillerPulje(eventId, spillerId, fraPuljeId, tilPuljeId) {
  const batch = writeBatch(db);
  batch.update(doc(db, EVENTS, eventId, 'puljer', fraPuljeId), { spillerIds: arrayRemove(spillerId) });
  batch.update(doc(db, EVENTS, eventId, 'puljer', tilPuljeId), { spillerIds: arrayUnion(spillerId) });
  batch.update(doc(db, EVENTS, eventId, 'spillere', spillerId), { puljeId: tilPuljeId });
  await batch.commit();
}

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

export function lyttKamperForFase(eventId, fase, cb) {
  const q = query(collection(db, EVENTS, eventId, 'kamper'), where('fase', '==', fase), limit(30));
  return onSnapshot(q, (snap) => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
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

/** Gjenopptar en PAUSET timer uten å nullstille gjenstående tid (i motsetning til startTimer). */
export async function gjenopptaTimer(eventId, kampId, gjenstaendeSekunder) {
  await updateDoc(doc(db, EVENTS, eventId, 'kamper', kampId), {
    status: 'active',
    'timer.status': 'running',
    'timer.startetAt': serverTimestamp(),
    'timer.gjenstaendeSekunder': gjenstaendeSekunder,
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

// --- Resultatregistrering (puljespill) ---

/**
 * Registrerer sluttresultatet for en puljespill-kamp OG oppdaterer puljens
 * leaderboard-dokument i SAMME skriveoperasjon (batch) — TRYGT for flere
 * samtidige admin-enheter, siden dette IKKE leser søsken-kampene i puljen
 * først. Leaderboardet lagres som rå per-spiller-tellere
 * (`spillerStats.{spillerId}.{seire,tap,poeng,poengforskjell}`), oppdatert
 * med Firestores atomiske `increment()` — to admin-enheter som lagrer
 * resultat for to ulike kamper i samme pulje SAMTIDIG kan aldri overskrive
 * hverandres tall, siden increment() ikke krever å lese gjeldende verdi
 * først (i motsetning til den forrige "les alle kamper → regn ut → skriv
 * hele rangeringen på nytt"-tilnærmingen, som hadde et reelt race-vindu —
 * relevant nå som appen deles mellom 2-3 admin-enheter samtidig).
 *
 * Selve RANGERINGEN (sortert liste) regnes IKKE ut her — det gjøres ved
 * LESING, av eventlogikk.sorterSpillerStats(), siden lesing ikke har noe
 * race condition-problem. Se admin.js/tv.js for bruk.
 */
export async function registrerPuljeResultat(eventId, kamp, { poengA, poengB, erOverstyring = false, rosterNavnMap = {} }) {
  const kampRef = doc(db, EVENTS, eventId, 'kamper', kamp.id);
  const leaderboardRef = doc(db, EVENTS, eventId, 'leaderboard', kamp.puljeId);

  const aVant = poengA > poengB;
  const vinnerId = aVant ? kamp.spillerA : kamp.spillerB;
  const poengforskjell = Math.abs(poengA - poengB);

  const batch = writeBatch(db);
  batch.update(kampRef, {
    status: 'completed', poengA, poengB, vinnerId, poengforskjell,
    overstyrtAvAdmin: erOverstyring || kamp.overstyrtAvAdmin === true,
    'timer.status': 'finished',
  });
  batch.set(leaderboardRef, {
    puljeId: kamp.puljeId,
    oppdatert: serverTimestamp(),
    spillerStats: {
      [kamp.spillerA]: {
        navn: rosterNavnMap[kamp.spillerA] ?? kamp.spillerA,
        seire: increment(aVant ? 1 : 0),
        tap: increment(aVant ? 0 : 1),
        poeng: increment(aVant ? 3 : 0),
        poengforskjell: increment(poengA - poengB),
      },
      [kamp.spillerB]: {
        navn: rosterNavnMap[kamp.spillerB] ?? kamp.spillerB,
        seire: increment(aVant ? 0 : 1),
        tap: increment(aVant ? 1 : 0),
        poeng: increment(aVant ? 0 : 3),
        poengforskjell: increment(poengB - poengA),
      },
    },
  }, { merge: true }); // merge:true gjør et DYPT merge — increment() på én spillers felter påvirker ikke den andre
  await batch.commit();
}

/**
 * OVERSTYRING av et allerede lagret resultat — IKKE bruk registrerPuljeResultat
 * for dette, siden increment() da ville dobbelttalt de opprinnelige poengene.
 * Regner ut DIFFERANSEN mellom gammelt og nytt resultat og increment()-er med
 * den, slik at sluttsummen blir riktig uansett rekkefølge andre skriv skjer i.
 * `kamp` må inneholde de FORRIGE (før overstyring) poengA/poengB-verdiene.
 */
export async function overstyrPuljeResultat(eventId, kamp, { nyPoengA, nyPoengB, rosterNavnMap = {} }) {
  if (kamp.status !== 'completed') {
    return registrerPuljeResultat(eventId, kamp, { poengA: nyPoengA, poengB: nyPoengB, erOverstyring: true, rosterNavnMap });
  }

  const kampRef = doc(db, EVENTS, eventId, 'kamper', kamp.id);
  const leaderboardRef = doc(db, EVENTS, eventId, 'leaderboard', kamp.puljeId);

  const forrigeAVant = kamp.poengA > kamp.poengB;
  const nyAVant = nyPoengA > nyPoengB;
  const vinnerId = nyAVant ? kamp.spillerA : kamp.spillerB;

  const seireADiff = (nyAVant ? 1 : 0) - (forrigeAVant ? 1 : 0);
  const tapADiff = (nyAVant ? 0 : 1) - (forrigeAVant ? 0 : 1);
  const poengADiff = (nyAVant ? 3 : 0) - (forrigeAVant ? 3 : 0);
  const poengforskjellADiff = (nyPoengA - nyPoengB) - (kamp.poengA - kamp.poengB);

  const batch = writeBatch(db);
  batch.update(kampRef, {
    poengA: nyPoengA, poengB: nyPoengB, vinnerId,
    poengforskjell: Math.abs(nyPoengA - nyPoengB),
    overstyrtAvAdmin: true,
  });
  batch.set(leaderboardRef, {
    puljeId: kamp.puljeId,
    oppdatert: serverTimestamp(),
    spillerStats: {
      [kamp.spillerA]: {
        navn: rosterNavnMap[kamp.spillerA] ?? kamp.spillerA,
        seire: increment(seireADiff), tap: increment(tapADiff),
        poeng: increment(poengADiff), poengforskjell: increment(poengforskjellADiff),
      },
      [kamp.spillerB]: {
        navn: rosterNavnMap[kamp.spillerB] ?? kamp.spillerB,
        seire: increment(-seireADiff), tap: increment(-tapADiff),
        poeng: increment(-poengADiff), poengforskjell: increment(-poengforskjellADiff),
      },
    },
  }, { merge: true });
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

export function lyttAktivtEvent(cb) {
  return onSnapshot(doc(db, LIVE, 'aktivEvent'), (snap) => {
    cb(snap.exists() ? snap.data() : null);
  });
}

/** Setter qualifiedForNext=true på event-rosterdokumentet — kalles når topp 2 fra hver pulje er avklart. */
export async function markerRosterKvalifisert(eventId, spillerId) {
  await updateDoc(doc(db, EVENTS, eventId, 'spillere', spillerId), { qualifiedForNext: true });
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
