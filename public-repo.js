// ============================================================================
// public-repo.js — "16"
//
// Ekstra, LESBARE hjelpefunksjoner brukt av de offentlige sidene (spiller-
// flate, Courts, TV Mode). Bygger videre på firestore-repo.js — ingen
// duplisering av spørringslogikk, kun sammensetninger som er spesifikke for
// de offentlige visningene. Krever ingen admin-rettighet (rules tillater
// offentlig lesing av disse dokumentene).
// ============================================================================

import * as repo from './firestore-repo.js';

const PULJE_IDER = ['A', 'B', 'C', 'D'];

/**
 * Abonnerer på alle 4 puljers leaderboard samtidig (fire små, målrettede
 * onSnapshot-lyttere — ikke ett bredt spørring). Kaller cb med et samlet
 * kart { A: leaderboardDoc|null, B: ..., C: ..., D: ... } hver gang ett av
 * dem endrer seg.
 *
 * @returns {Function} unsubscribe-funksjon som stopper alle 4 lytterne
 */
export function lyttAlleLeaderboards(eventId, cb) {
  const state = { A: null, B: null, C: null, D: null };
  const avmeldinger = PULJE_IDER.map(puljeId =>
    repo.lyttLeaderboard(eventId, puljeId, (lb) => {
      state[puljeId] = lb;
      cb({ ...state });
    })
  );
  return () => avmeldinger.forEach(fn => fn());
}

/**
 * Regner ut gjenstående sekunder for en kamps timer, basert på om den er i
 * gang (running) eller stoppet (paused/not_started/finished). For "running"
 * kombineres server-satt startetAt med lokal klokke for en jevn nedtelling
 * mellom Firestore-oppdateringer.
 */
export function beregnGjenstaendeSekunder(timer) {
  if (!timer) return 0;
  if (timer.status !== 'running' || !timer.startetAt) {
    return Math.max(0, timer.gjenstaendeSekunder ?? 0);
  }
  const startetMs = timer.startetAt.toMillis ? timer.startetAt.toMillis() : new Date(timer.startetAt).getTime();
  const forlopteSek = (Date.now() - startetMs) / 1000;
  return Math.max(0, (timer.gjenstaendeSekunder ?? 0) - forlopteSek);
}

export function formaterTid(sekunder) {
  const s = Math.max(0, Math.round(sekunder));
  const min = Math.floor(s / 60);
  const sek = s % 60;
  return `${min}:${String(sek).padStart(2, '0')}`;
}

export { repo };
