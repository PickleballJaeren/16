// ============================================================================
// hall-of-fame.js — "16" — offentlig Hall of Fame
// ============================================================================

import { paAuthEndring } from './auth.js';
import * as repo from './firestore-repo.js';

const $ = (sel) => document.querySelector(sel);

let startet = false;
paAuthEndring(({ bruker }) => {
  if (bruker && !startet) { startet = true; start(); }
});

async function start() {
  const champions = await repo.hentChampions();
  if (champions.length === 0) {
    $('#champions-rot').innerHTML = '<p class="muted" style="text-align:center;">Ingen championer registrert ennå — historien starter med Event #1.</p>';
    return;
  }
  $('#champions-rot').innerHTML = champions.map(c => `
    <div class="card">
      <div class="list-row" style="border:none; padding:0;">
        <div>
          <h2 style="margin:0;">${escapeHtml(c.navn)}</h2>
          <p class="muted2 mono" style="margin:2px 0 0;">Event #${c.eventNummer} · ${formaterDato(c.dato)}</p>
        </div>
        <span class="badge badge-accent">${c.antallSeireTotalt}× vinner</span>
      </div>
    </div>
  `).join('');
}

function formaterDato(dato) {
  if (!dato) return '';
  try {
    const d = dato.toDate ? dato.toDate() : new Date(dato);
    return d.toLocaleDateString('no-NO', { year: 'numeric', month: 'long', day: 'numeric' });
  } catch {
    return String(dato);
  }
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
