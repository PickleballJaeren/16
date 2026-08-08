// ============================================================================
// courts.js — "16" — Courts-visning
//
// Sanntid brukes bevisst kun her (og TV Mode/leaderboard) — ikke som
// standardmønster ellers i appen. Lytter kun på ÉN liten, målrettet
// spørring (gjeldende rundes kamper, maks 6 dokumenter), pekt ut av
// seksten_live/aktivEvent.
// ============================================================================

import { paAuthEndring } from './auth.js';
import * as repo from './firestore-repo.js';
import { beregnGjenstaendeSekunder, formaterTid } from './public-repo.js';

const $ = (sel) => document.querySelector(sel);

const ALLE_BANER = ['Pickleball 1', 'Pickleball 2', 'Skyball 1', 'Skyball 2', 'Speedminton 1', 'Speedminton 2'];
const DISIPLIN_KLASSE = { pickleball: 'court-pickleball', skyball: 'court-skyball', speedminton: 'court-speedminton' };

let gjeldendeEventId = null;
let gjeldendeRunde = null;
let avmeldKamper = null;
let nesteRundeKamperCache = [];
let sisteKamperCache = []; // brukt av den lokale nedtellingen mellom Firestore-oppdateringer

let startet = false;
paAuthEndring(({ bruker }) => {
  if (bruker && !startet) { startet = true; start(); }
});

function start() {
  // Render tomme kort umiddelbart, fylles inn når data kommer.
  $('#courts-rot').innerHTML = ALLE_BANER.map(b => tomtKortHtml(b)).join('');

  repo.lyttAktivtEvent(async (live) => {
    if (!live) {
      $('#courts-runde-info').textContent = 'Ingen aktivt event';
      return;
    }
    $('#courts-runde-info').textContent = live.sluttspillFase && live.sluttspillFase !== 'none'
      ? { quarterfinal: 'Kvartfinaler', semifinal: 'Semifinaler', final: 'Finale' }[live.sluttspillFase]
      : `Runde ${live.gjeldendeRunde} av 4`;

    if (live.eventId !== gjeldendeEventId || live.gjeldendeRunde !== gjeldendeRunde) {
      gjeldendeEventId = live.eventId;
      gjeldendeRunde = live.gjeldendeRunde;
      if (avmeldKamper) avmeldKamper();

      if (live.sluttspillFase === 'none' || !live.sluttspillFase) {
        avmeldKamper = repo.lyttKamperForRunde(live.eventId, live.gjeldendeRunde, renderKamper);
        nesteRundeKamperCache = await repo.hentKamperForRunde(live.eventId, live.gjeldendeRunde + 1).catch(() => []);
      } else {
        avmeldKamper = repo.lyttKamperForFase(live.eventId, live.sluttspillFase, renderKamper);
        nesteRundeKamperCache = [];
      }
    }
  });
}

function renderKamper(kamper) {
  sisteKamperCache = kamper;
  const perBane = Object.fromEntries(ALLE_BANER.map(b => [b, null]));
  for (const k of kamper) perBane[k.bane] = k;

  $('#courts-rot').innerHTML = ALLE_BANER.map(bane => {
    const kamp = perBane[bane];
    const neste = nesteRundeKamperCache.find(k => k.bane === bane);
    return kamp ? kampKortHtml(bane, kamp, neste) : tomtKortHtml(bane, neste);
  }).join('');
}

function tomtKortHtml(bane, neste) {
  return `
    <div class="card court-card">
      <h3>${bane}</h3>
      <p class="muted">Ingen kamp akkurat nå.</p>
      ${neste ? nesteKampHtml(neste) : ''}
    </div>
  `;
}

function kampKortHtml(bane, kamp, neste) {
  const klasse = DISIPLIN_KLASSE[kamp.disiplin] ?? '';
  const ferdig = kamp.status === 'completed';

  let timerHtml = '';
  if (!ferdig) {
    const gjenstaende = beregnGjenstaendeSekunder(kamp.timer);
    const varselKlasse = kamp.suddenDeath ? 'sudden-death' : (gjenstaende <= 60 ? 'warning' : '');
    timerHtml = `
      <p class="court-timer mono ${varselKlasse}" data-kamp-id="${kamp.id}" data-timer-status="${kamp.timer?.status}">
        ${kamp.suddenDeath ? 'SUDDEN DEATH' : formaterTid(gjenstaende)}
      </p>
    `;
  }

  return `
    <div class="card court-card ${klasse}">
      <div class="list-row" style="border:none; padding-top:0;">
        <h3 style="margin:0;">${bane}</h3>
        <span class="badge badge-accent">${kamp.disiplin}</span>
      </div>
      <div class="court-players">
        <span>${escapeHtml(kamp.spillerANavn ?? kamp.spillerA)}</span>
        <span class="mono score">${ferdig ? `${kamp.poengA} – ${kamp.poengB}` : 'vs'}</span>
        <span>${escapeHtml(kamp.spillerBNavn ?? kamp.spillerB)}</span>
      </div>
      ${timerHtml}
      ${ferdig ? '<p style="text-align:center;"><span class="badge badge-active">Ferdig</span></p>' : ''}
      ${neste ? nesteKampHtml(neste) : ''}
    </div>
  `;
}

function nesteKampHtml(neste) {
  return `
    <div class="court-next muted2">
      Neste: ${escapeHtml(neste.spillerANavn ?? neste.spillerA)} vs ${escapeHtml(neste.spillerBNavn ?? neste.spillerB)} (${neste.disiplin})
    </div>
  `;
}

// Lokal, jevn nedtelling mellom Firestore-oppdateringer: oppdaterer kun
// tekstinnholdet i timer-elementene hvert sekund, ikke en full re-render
// (unngår flimmer, og trenger ikke vente på neste onSnapshot-hendelse).
setInterval(() => {
  document.querySelectorAll('.court-timer[data-timer-status="running"]').forEach(el => {
    const kampId = el.dataset.kampId;
    const kamp = sisteKamperCache.find(k => k.id === kampId);
    if (!kamp || kamp.suddenDeath) return;
    const gjenstaende = beregnGjenstaendeSekunder(kamp.timer);
    el.textContent = formaterTid(gjenstaende);
    el.classList.toggle('warning', gjenstaende > 0 && gjenstaende <= 60);
  });
}, 1000);

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
