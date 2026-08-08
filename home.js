// ============================================================================
// home.js — "16" — offentlig startside
// ============================================================================

import { paAuthEndring } from './auth.js'; // side-effect: sikrer anonym innlogging
import * as repo from './firestore-repo.js';
import * as logikk from './eventlogikk.js';
import { lyttAlleLeaderboards } from './public-repo.js';

const $ = (sel) => document.querySelector(sel);

function oppdaterOfflineIndikator() {
  $('#offline-indicator').hidden = navigator.onLine;
}
window.addEventListener('online', oppdaterOfflineIndikator);
window.addEventListener('offline', oppdaterOfflineIndikator);
oppdaterOfflineIndikator();

let startet = false;
paAuthEndring(({ bruker }) => {
  if (bruker && !startet) { startet = true; start(); }
});

async function start() {
  const innstillinger = await repo.hentInnstillinger();
  if (innstillinger) {
    $('#hjem-eventnavn').textContent = innstillinger.eventNavn ?? '16';
    $('#hjem-tagline').textContent = innstillinger.tagline ?? '';
    document.title = innstillinger.eventNavn ?? '16';
  }

  const siste = await repo.hentSisteEventer(1);
  if (siste.length === 0) {
    $('#hjem-status-badge').textContent = 'Ingen aktive eventer';
    return;
  }

  repo.lyttEvent(siste[0].id, (event) => {
    if (!event) return;
    renderStatus(event);
    lyttAlleLeaderboards(event.id, renderLeaderboard);
  });
}

function renderStatus(event) {
  $('#hjem-status-badge').textContent = logikk.STATUS_VISNINGSNAVN[event.status] ?? event.status;
  $('#hjem-event-navn').textContent = event.navn;
  if (event.status === 'main_event' && event.gjeldendeRunde) {
    $('#hjem-runde-info').textContent = `Runde ${event.gjeldendeRunde} av 4`;
  } else if (event.status === 'playoffs') {
    $('#hjem-runde-info').textContent = { quarterfinal: 'Kvartfinaler', semifinal: 'Semifinaler', final: 'Finale' }[event.sluttspillFase] ?? '';
  } else {
    $('#hjem-runde-info').textContent = '';
  }
}

function renderLeaderboard(perPulje) {
  const puljer = ['A', 'B', 'C', 'D'];
  const harData = puljer.some(p => perPulje[p]?.rangering?.length);
  if (!harData) {
    $('#leaderboard-rot').innerHTML = '<p class="muted">Ingen resultater registrert ennå.</p>';
    return;
  }
  $('#leaderboard-rot').innerHTML = puljer.map(p => {
    const lb = perPulje[p];
    if (!lb) return '';
    return `
      <div class="card">
        <h3>Pulje ${p}</h3>
        ${lb.rangering.map((r, i) => `
          <div class="list-row">
            <span class="mono" style="width:22px; display:inline-block;">#${i + 1}</span>
            <span style="flex:1;">${escapeHtml(r.navn)}</span>
            ${i < 2 ? '<span class="badge badge-active" style="margin-right:8px;">QUALIFIED</span>' : ''}
            <span class="mono muted2">${r.seire}-${r.tap} · ${r.poeng}p · ${r.poengforskjell > 0 ? '+' : ''}${r.poengforskjell}</span>
          </div>
        `).join('')}
      </div>
    `;
  }).join('');
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
