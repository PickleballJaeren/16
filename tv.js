// ============================================================================
// tv.js — "16" — TV Mode
//
// Fasebasert visning:
//   - main_event (puljespill): roterer mellom Courts og Leaderboard.
//   - playoffs/quarterfinal: roterer mellom "TOP 8 QUALIFIED" og kvartfinale-
//     braketten (spilles jo fortsatt ute på banene, men vises samlet her).
//   - playoffs/semifinal: viser semifinale-braketten (statisk, ingen rotasjon).
//   - playoffs/final: viser en dedikert finale-skjerm — "eventets
//     hovedøyeblikk" — ingen rotasjon, hele skjermen til de to finalistene.
//   - completed: viser siste champion fra Hall of Fame.
//
// All sanntid her er MÅLRETTET (gjeldende rundes ≤6 kamper, 4 leaderboard-
// dokumenter, rosteret for kvalifiserte) — ikke brede spørringer.
// ============================================================================

import { paAuthEndring } from './auth.js';
import * as repo from './firestore-repo.js';
import * as logikk from './eventlogikk.js';
import { lyttAlleLeaderboards, beregnGjenstaendeSekunder, formaterTid } from './public-repo.js';

const $ = (sel) => document.querySelector(sel);

function oppdaterOfflineIndikator() {
  const el = $('#offline-indicator');
  if (el) el.hidden = navigator.onLine;
}
window.addEventListener('online', oppdaterOfflineIndikator);
window.addEventListener('offline', oppdaterOfflineIndikator);
oppdaterOfflineIndikator();

const ALLE_BANER = ['Pickleball 1', 'Pickleball 2', 'Skyball 1', 'Skyball 2', 'Speedminton 1', 'Speedminton 2'];
const DISIPLIN_KLASSE = { pickleball: 'disiplin-pickleball', skyball: 'disiplin-skyball', speedminton: 'disiplin-speedminton' };
const ROTASJON_INTERVALL_MS = 12000;

const state = {
  event: null, live: null,
  kamperGjeldende: [], leaderboards: {}, roster: [], champions: [],
};

let rotasjonTimer = null;
let rotasjonSlideIndex = 0;
let avmeldKamper = null;

// ----------------------------------------------------------------------------
// Oppstart
// ----------------------------------------------------------------------------

let startet = false;
paAuthEndring(({ bruker }) => {
  if (bruker && !startet) { startet = true; start(); }
});

async function start() {
  const innstillinger = await repo.hentInnstillinger();
  if (innstillinger) $('#tv-eventnavn').textContent = innstillinger.eventNavn ?? '16';

  const siste = await repo.hentSisteEventer(1);
  if (siste.length === 0) { $('#tv-status').textContent = 'Ingen aktive eventer'; return; }
  const eventId = siste[0].id;

  repo.lyttEvent(eventId, (event) => {
    state.event = event;
    if (!event) return;
    $('#tv-status').textContent = logikk.STATUS_VISNINGSNAVN[event.status] ?? event.status;
    if (event.status === 'completed') visSluttskjerm();
    else oppdaterVisning();
  });

  repo.lyttRoster(eventId, (roster) => {
    state.roster = roster.filter(r => !r.fjernet);
    oppdaterVisning();
  });

  lyttAlleLeaderboards(eventId, (lb) => {
    state.leaderboards = lb;
    oppdaterVisning();
  });

  repo.lyttAktivtEvent((live) => {
    state.live = live;
    if (!live) return;
    byttKampLytter(live);
    oppdaterVisning();
  });
}

function byttKampLytter(live) {
  if (avmeldKamper) avmeldKamper();
  if (!live.sluttspillFase || live.sluttspillFase === 'none') {
    avmeldKamper = repo.lyttKamperForRunde(live.eventId, live.gjeldendeRunde, (kamper) => {
      state.kamperGjeldende = kamper;
      oppdaterVisning();
    });
  } else {
    avmeldKamper = repo.lyttKamperForFase(live.eventId, live.sluttspillFase, (kamper) => {
      state.kamperGjeldende = kamper;
      oppdaterVisning();
    });
  }
}

// ----------------------------------------------------------------------------
// Overordnet visningsvalg
// ----------------------------------------------------------------------------

function oppdaterVisning() {
  if (!state.event) return;

  if (state.event.status === 'playoffs' && state.live?.sluttspillFase === 'final') {
    stoppRotasjon();
    visFinaleSlide();
    return;
  }
  if (state.event.status === 'playoffs' && state.live?.sluttspillFase === 'semifinal') {
    stoppRotasjon();
    visBracketSlide('semifinal', 'Semifinaler');
    return;
  }
  if (state.event.status === 'playoffs' && state.live?.sluttspillFase === 'quarterfinal') {
    startRotasjon(['top8', 'bracket-quarterfinal']);
    return;
  }
  if (state.event.status === 'main_event') {
    startRotasjon(['courts', 'leaderboard']);
    return;
  }
  stoppRotasjon();
  visSlide(null);
}

function startRotasjon(slides) {
  renderSlideEtterNavn(slides[rotasjonSlideIndex % slides.length]);
  if (rotasjonTimer) return;
  rotasjonTimer = setInterval(() => {
    rotasjonSlideIndex = (rotasjonSlideIndex + 1) % slides.length;
    renderSlideEtterNavn(slides[rotasjonSlideIndex % slides.length]);
  }, ROTASJON_INTERVALL_MS);
}

function stoppRotasjon() {
  if (rotasjonTimer) { clearInterval(rotasjonTimer); rotasjonTimer = null; }
  rotasjonSlideIndex = 0;
}

function renderSlideEtterNavn(navn) {
  if (navn === 'courts') { renderCourtsSlide(); visSlide('slide-courts'); }
  else if (navn === 'leaderboard') { renderLeaderboardSlide(); visSlide('slide-leaderboard'); }
  else if (navn === 'top8') { renderTop8Slide(); visSlide('slide-top8'); }
  else if (navn === 'bracket-quarterfinal') { renderBracketSlide('quarterfinal'); visSlide('slide-bracket'); }
}

function visBracketSlide(fase, tittel) {
  $('#tv-bracket-tittel').textContent = tittel;
  renderBracketSlide(fase);
  visSlide('slide-bracket');
}

function visSlide(id) {
  document.querySelectorAll('.tv-slide').forEach(el => el.classList.toggle('active', el.id === id));
}

// ----------------------------------------------------------------------------
// Courts-slide
// ----------------------------------------------------------------------------

function renderCourtsSlide() {
  const perBane = Object.fromEntries(ALLE_BANER.map(b => [b, null]));
  for (const k of state.kamperGjeldende) perBane[k.bane] = k;

  $('#tv-courts-grid').innerHTML = ALLE_BANER.map(bane => {
    const kamp = perBane[bane];
    if (!kamp) {
      return `<div class="tv-court"><p class="tv-court-navn">${bane}</p><p class="muted" style="margin:auto;">Pause</p></div>`;
    }
    const klasse = DISIPLIN_KLASSE[kamp.disiplin] ?? '';
    const ferdig = kamp.status === 'completed';
    const gjenstaende = ferdig ? null : beregnGjenstaendeSekunder(kamp.timer);
    const timerKlasse = kamp.suddenDeath ? 'sudden-death' : (gjenstaende !== null && gjenstaende <= 60 ? 'warning' : '');

    return `
      <div class="tv-court ${klasse}" data-kamp-id="${kamp.id}" data-timer-status="${kamp.timer?.status ?? ''}">
        <p class="tv-court-navn">${kamp.status === 'active' ? '<span class="live-dot"></span>' : ''}${bane}</p>
        <div class="tv-court-spillere">
          <span>${escapeHtml(kamp.spillerANavn ?? kamp.spillerA)}</span>
          <span>${escapeHtml(kamp.spillerBNavn ?? kamp.spillerB)}</span>
        </div>
        <p class="tv-court-score">${ferdig ? `${kamp.poengA} – ${kamp.poengB}` : '– – –'}</p>
        ${!ferdig ? `<p class="tv-court-timer ${timerKlasse}">${kamp.suddenDeath ? 'SUDDEN DEATH' : formaterTid(gjenstaende)}</p>` : '<p class="badge badge-active" style="align-self:center;">Ferdig</p>'}
      </div>
    `;
  }).join('');
}

// Lokal nedtelling mellom Firestore-oppdateringer — kun tekstoppdatering, ingen full re-render.
setInterval(() => {
  document.querySelectorAll('.tv-court[data-timer-status="running"]').forEach(el => {
    const kampId = el.dataset.kampId;
    const kamp = state.kamperGjeldende.find(k => k.id === kampId);
    if (!kamp || kamp.suddenDeath) return;
    const gjenstaende = beregnGjenstaendeSekunder(kamp.timer);
    const timerEl = el.querySelector('.tv-court-timer');
    if (timerEl) {
      timerEl.textContent = formaterTid(gjenstaende);
      timerEl.classList.toggle('warning', gjenstaende > 0 && gjenstaende <= 60);
    }
  });
}, 1000);

// ----------------------------------------------------------------------------
// Leaderboard-slide
// ----------------------------------------------------------------------------

function renderLeaderboardSlide() {
  const puljer = ['A', 'B', 'C', 'D'];
  $('#tv-leaderboard-grid').innerHTML = puljer.map(p => {
    const lb = state.leaderboards[p];
    if (!lb) return `<div class="tv-pulje-kort"><h2>Pulje ${p}</h2><p class="muted">Ingen resultater ennå.</p></div>`;
    return `
      <div class="tv-pulje-kort">
        <h2>Pulje ${p}</h2>
        ${lb.rangering.map((r, i) => `
          <div class="tv-rad">
            <span class="rank">#${i + 1}</span>
            <span class="navn">${escapeHtml(r.navn)} ${i < 2 ? '<span class="badge badge-active">Q</span>' : ''}</span>
            <span class="tall">${r.seire}-${r.tap} · ${r.poeng}p · ${r.poengforskjell > 0 ? '+' : ''}${r.poengforskjell}</span>
          </div>
        `).join('')}
      </div>
    `;
  }).join('');
}

// ----------------------------------------------------------------------------
// TOP 8 QUALIFIED-slide
// ----------------------------------------------------------------------------

function renderTop8Slide() {
  const kvalifiserte = state.roster.filter(r => r.qualifiedForNext === true);
  $('#tv-top8-liste').innerHTML = kvalifiserte.length
    ? kvalifiserte.map(r => `<div class="tv-top8-navn">${escapeHtml(r.navn)}</div>`).join('')
    : '<p class="muted">Venter på at puljespillet skal fullføres …</p>';
}

// ----------------------------------------------------------------------------
// Kvartfinale/semifinale-brakett-slide
// ----------------------------------------------------------------------------

function renderBracketSlide(fase) {
  const serier = {};
  for (const k of state.kamperGjeldende.filter(k => k.fase === fase)) {
    serier[k.serieId] = serier[k.serieId] || [];
    serier[k.serieId].push(k);
  }
  const html = Object.entries(serier).map(([serieId, kampListe]) => {
    const forste = kampListe[0];
    const status = logikk.beregnSerieStatus(forste.spillerA, forste.spillerB, kampListe);
    return `
      <div class="tv-top8-navn" style="display:flex; justify-content:space-between; align-items:center;">
        <span>${escapeHtml(forste.spillerANavn)} <span class="muted2">vs</span> ${escapeHtml(forste.spillerBNavn)}</span>
        <span class="mono">${status.seireA} – ${status.seireB}</span>
      </div>
    `;
  }).join('');
  $('#tv-bracket-liste').innerHTML = html || '<p class="muted">Venter på kamper …</p>';
}

// ----------------------------------------------------------------------------
// Finale-slide — "eventets hovedøyeblikk"
// ----------------------------------------------------------------------------

function visFinaleSlide() {
  const finaleKamp = state.kamperGjeldende.find(k => k.fase === 'final');
  if (!finaleKamp) { visSlide(null); return; }
  const serieKamper = state.kamperGjeldende.filter(k => k.fase === 'final' && k.serieId === 'FINAL');
  const status = logikk.beregnSerieStatus(finaleKamp.spillerA, finaleKamp.spillerB, serieKamper);

  $('#tv-final-a').textContent = finaleKamp.spillerANavn ?? finaleKamp.spillerA;
  $('#tv-final-b').textContent = finaleKamp.spillerBNavn ?? finaleKamp.spillerB;
  $('#tv-final-score').textContent = `${status.seireA} – ${status.seireB}`;
  const uspilt = serieKamper.find(k => k.status !== 'completed');
  $('#tv-final-disiplin').textContent = uspilt ? `Nå spilles: ${uspilt.disiplin}` : (status.ferdig ? 'Finalen er avgjort!' : '');

  visSlide('slide-final');
}

// ----------------------------------------------------------------------------
// Sluttskjerm — champion
// ----------------------------------------------------------------------------

async function visSluttskjerm() {
  stoppRotasjon();
  const champions = await repo.hentChampions();
  const siste = champions[0];
  if (siste) {
    $('#tv-champion-navn').textContent = siste.navn;
    $('#tv-champion-info').textContent = `Event #${siste.eventNummer} · ${siste.antallSeireTotalt}× vinner`;
  }
  visSlide('slide-champion');
}

// ----------------------------------------------------------------------------
// Fullskjerm
// ----------------------------------------------------------------------------

$('#fullscreen-btn').addEventListener('click', () => {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen?.().catch(() => {});
  } else {
    document.exitFullscreen?.();
  }
});

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
