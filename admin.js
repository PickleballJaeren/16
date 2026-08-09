// ============================================================================
// admin.js — "Racketslaget"
//
// Forsiden ER admin-appen (PIN-beskyttet fra start). Tilskuere/spillere
// dekkes utelukkende av courts.html/tv.html/hall-of-fame.html — ikke denne
// siden. To modus, styrt av event.status:
//   - WIZARD (draft/registration_open/registration_closed): stegvis oppsett,
//     fritt navigerbart mellom steg 1-5.
//   - LIVE DASHBOARD (main_event/playoffs/completed): det løpende arbeidet
//     under selve eventet (kamper, sluttspill, leaderboard, Hall of Fame).
// ============================================================================

import { paAuthEndring, loggInnSomAdmin } from './auth.js';
import * as repo from './firestore-repo.js';
import * as logikk from './eventlogikk.js';
import { genererKampoppsett } from './kampgenerator.js';
import { TESTSPILLERE, TESTPULJER } from './testdata.js';

const DISIPLINER = ['pickleball', 'skyball', 'speedminton'];
const BANER = {
  pickleball: ['Pickleball 1', 'Pickleball 2'],
  skyball: ['Skyball 1', 'Skyball 2'],
  speedminton: ['Speedminton 1', 'Speedminton 2'],
};
const KAMPVARIGHET_PULJESPILL_MIN = 10;
const PULJE_IDER = ['A', 'B', 'C', 'D'];
const STATUS_KILDE_LABEL = {
  returning_top8: 'Returning Top 8', qualifier_winner: 'Qualifier Winner',
  wildcard: 'Wildcard', admin_invite: 'Admin Invite',
};

const state = {
  erAdmin: false,
  event: null,
  roster: [],
  masterSpillere: [],
  puljer: [],
  gjeldendeRundeVisning: 1,
  kamperIRunde: [],
  champions: [],
  wizardSteg: 1,
  apenFlyttMeny: null, // spillerId hvis en "flytt til pulje"-meny er åpen
};

// ----------------------------------------------------------------------------
// Småhjelpere
// ----------------------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function toast(melding, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = melding;
  $('#toast-rot').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function bekreft(melding) {
  return window.confirm(melding);
}

function initialFarge(navn) {
  const paletter = ['#2563eb', '#16a34a', '#eab308', '#ea580c', '#dc2626', '#3b82f6'];
  let sum = 0;
  for (const c of navn) sum += c.charCodeAt(0);
  return paletter[sum % paletter.length];
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function navnFraId(id) {
  return state.roster.find(r => r.id === id)?.navn ?? state.masterSpillere.find(s => s.id === id)?.navn ?? id;
}

// ----------------------------------------------------------------------------
// Offline-indikator
// ----------------------------------------------------------------------------

function oppdaterOfflineIndikator() {
  $('#offline-indicator').hidden = navigator.onLine;
}
window.addEventListener('online', oppdaterOfflineIndikator);
window.addEventListener('offline', oppdaterOfflineIndikator);
oppdaterOfflineIndikator();

// ----------------------------------------------------------------------------
// Del appen
// ----------------------------------------------------------------------------

$('#del-app-btn').addEventListener('click', async () => {
  const delData = { title: 'Racketslaget — Admin', text: 'Bli med og administrer Racketslaget', url: location.href };
  if (navigator.share) {
    try { await navigator.share(delData); } catch { /* avbrutt av bruker, ikke en feil */ }
  } else if (navigator.clipboard) {
    await navigator.clipboard.writeText(location.href);
    toast('Lenke kopiert — send den til de som skal hjelpe til.');
  } else {
    toast(location.href);
  }
});

// ----------------------------------------------------------------------------
// Auth / PIN-gate
// ----------------------------------------------------------------------------

paAuthEndring(({ erAdmin }) => {
  state.erAdmin = erAdmin;
  $('#pin-gate').hidden = erAdmin;
  $('#dashboard').hidden = !erAdmin;
  if (erAdmin) startDashboard();
});

$('#pin-submit').addEventListener('click', async () => {
  const pin = $('#pin-input').value.trim();
  if (!pin) return;
  $('#pin-submit').disabled = true;
  const res = await loggInnSomAdmin(pin);
  $('#pin-submit').disabled = false;
  if (!res.ok) {
    $('#pin-feilmelding').hidden = false;
    $('#pin-feilmelding').textContent = res.feil ?? 'Feil PIN.';
  }
});
$('#pin-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#pin-submit').click(); });

let dashboardStartet = false;
async function startDashboard() {
  if (dashboardStartet) return;
  dashboardStartet = true;
  await lastEvent();
}

// ----------------------------------------------------------------------------
// Event-lasting og modusvalg (wizard vs. live dashboard)
// ----------------------------------------------------------------------------

async function lastEvent() {
  const siste = await repo.hentSisteEventer(1);
  if (siste.length === 0) {
    state.event = null;
    visModus();
    return;
  }
  repo.lyttEvent(siste[0].id, async (event) => {
    state.event = event;
    if (!event) return;
    if (!state.roster.length && !state._rosterLastet) {
      state._rosterLastet = true;
      repo.lyttRoster(event.id, (roster) => {
        state.roster = roster.filter(r => !r.fjernet);
        if (erWizardModus()) renderWizardSteg();
      });
      state.puljer = await repo.hentPuljer(event.id);
    }
    visModus();
  });
}

function erWizardModus() {
  return !state.event || ['draft', 'registration_open', 'registration_closed'].includes(state.event.status);
}

function visModus() {
  const status = state.event?.status;
  $('#dashboard-status-linje').textContent = state.event
    ? `${state.event.navn} · ${logikk.STATUS_VISNINGSNAVN[status] ?? status}`
    : 'Ingen event opprettet ennå';

  const wizard = erWizardModus();
  $('#wizard-rot').hidden = !wizard;
  $('#live-dashboard-rot').hidden = wizard;

  if (wizard) {
    renderStepNav();
    renderWizardSteg();
  } else {
    visTab($('.tab-pill.active')?.dataset.tab ?? 'kamper');
  }
}

// ============================================================================
// OPPSETTVEIVISER
// ============================================================================

const STEG_NAVN = { 1: 'Event', 2: 'Spillere', 3: 'Puljer', 4: 'Kamper', 5: 'Start' };

function renderStepNav() {
  $('#step-nav').innerHTML = [1, 2, 3, 4, 5].map(n => `
    <button class="step-pill ${n === state.wizardSteg ? 'active' : ''}" data-steg="${n}">
      <span class="num">${n}</span>${STEG_NAVN[n]}
    </button>
  `).join('');
  $$('.step-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      state.wizardSteg = Number(btn.dataset.steg);
      renderStepNav();
      renderWizardSteg();
    });
  });
}

function renderWizardSteg() {
  [1, 2, 3, 4, 5].forEach(n => { $(`#steg-${n}`).hidden = n !== state.wizardSteg; });

  if (state.wizardSteg === 1) renderSteg1();
  if (state.wizardSteg === 2) { lastMasterSpillereOgRenderSteg2(); }
  if (state.wizardSteg === 3) renderSteg3();
  if (state.wizardSteg === 4) renderSteg4();
  if (state.wizardSteg === 5) renderSteg5();
}

// --- Steg 1: Event ---

function renderSteg1() {
  $('#event-status-kort').hidden = !state.event;
  if (state.event) {
    $('#event-navn-visning').textContent = state.event.navn;
    $('#event-nummer-visning').textContent = `Event #${state.event.eventNummer}`;
    $('#nytt-event-navn').value = state.event.navn;
  }
}

/**
 * Delt av både wizard- og live-dashboard-visningen. Krever at admin skriver
 * inn eventnavnet nøyaktig (ikke bare OK/Avbryt) siden dette er en
 * ugjenkallelig kaskade-sletting av eventets kamper, resultater og roster.
 */
async function handterSlettEvent() {
  const event = state.event;
  if (!event) return;

  const innskrevet = window.prompt(
    `Dette sletter "${event.navn}" PERMANENT -- alle kamper, resultater, ` +
    `puljer og roster for eventet forsvinner og kan IKKE gjenopprettes.\n\n` +
    `Skriv inn eventnavnet nøyaktig for å bekrefte:`
  );
  if (innskrevet === null) return; // avbrutt
  if (innskrevet.trim() !== event.navn) {
    toast('Feil eventnavn skrevet inn -- sletting avbrutt.', 'error');
    return;
  }

  try {
    await repo.slettEvent(event.id);
    toast(`"${event.navn}" er slettet.`);
    state.event = null;
    state.wizardSteg = 1;
    await lastEvent();
  } catch (e) {
    console.error(e);
    toast('Kunne ikke slette eventet: ' + e.message, 'error');
  }
}

$('#slett-event-btn')?.addEventListener('click', handterSlettEvent);
$('#slett-event-btn-2')?.addEventListener('click', handterSlettEvent);

$('#opprett-event-btn').addEventListener('click', async () => {
  const navn = $('#nytt-event-navn').value.trim() || 'Racketslaget';
  const dato = $('#nytt-event-dato').value || null;
  await repo.opprettEvent({
    navn, dato,
    config: {
      antallPuljer: 4, spillerePerPulje: 4,
      kampVarighetPuljespillMin: KAMPVARIGHET_PULJESPILL_MIN, kampVarighetSluttspillMin: 6,
      disipliner: DISIPLINER, baner: Object.values(BANER).flat(),
    },
  });
  toast('Event opprettet.');
  state.wizardSteg = 2;
  await lastEvent();
});

$('#last-testdata-btn').addEventListener('click', async () => {
  if (!bekreft('Opprette et testevent med 16 testspillere, ferdig fordelt i 4 puljer? Dette oppretter ekte dokumenter i Firestore (tydelig merket som testdata).')) return;
  $('#last-testdata-btn').disabled = true;
  try {
    toast('Oppretter testspillere …');
    const idKart = {};
    for (const s of TESTSPILLERE) {
      const spillerId = await repo.opprettSpiller({ navn: `${s.navn} (test)`, farge: initialFarge(s.navn) });
      idKart[s.id] = spillerId;
    }
    toast('Oppretter testevent …');
    const { id: eventId } = await repo.opprettEvent({
      navn: 'Racketslaget — Testevent', dato: new Date().toISOString().slice(0, 10),
      config: {
        antallPuljer: 4, spillerePerPulje: 4,
        kampVarighetPuljespillMin: KAMPVARIGHET_PULJESPILL_MIN, kampVarighetSluttspillMin: 6,
        disipliner: DISIPLINER, baner: Object.values(BANER).flat(),
      },
    });
    toast('Legger spillere i roster …');
    for (const s of TESTSPILLERE) {
      await repo.leggTilIRoster(eventId, idKart[s.id], {
        navn: `${s.navn} (test)`, kvalifiseringsstatusKilde: s.kvalifiseringsstatusKilde, wildcardBegrunnelse: s.wildcardBegrunnelse,
      });
    }
    toast('Trekker puljer …');
    const puljer = TESTPULJER.map(p => ({ id: p.id, navn: p.navn, spillerIds: p.spillerIds.map(sid => idKart[sid]) }));
    await repo.lagrePuljer(eventId, puljer);
    for (const p of puljer) {
      for (const spillerId of p.spillerIds) await repo.flyttSpillerTilPulje(eventId, spillerId, p.id);
    }
    toast('Testdata lastet inn!');
    state.wizardSteg = 4;
    await lastEvent();
  } catch (e) {
    console.error(e);
    toast('Kunne ikke laste inn testdata: ' + e.message, 'error');
  } finally {
    $('#last-testdata-btn').disabled = false;
  }
});

// --- Steg 2: Spillere ---

async function lastMasterSpillereOgRenderSteg2() {
  if (!state.event) { renderIkkeKlarSteg('steg-2', 'Opprett et event i Steg 1 først.'); return; }
  state.masterSpillere = await repo.hentAlleAktiveSpillere();
  renderSteg2();
}

function renderIkkeKlarSteg(stegId, melding) {
  $(`#${stegId}`).innerHTML = `<div class="card"><p class="muted">${escapeHtml(melding)}</p></div>`;
}

// --- Steg 2: kollapsbar kvalifiseringsstatus-velger + kollapsbar
// multi-select spillerliste + én "Legg til spillere"-knapp som committer
// alt på én gang. (Se vevleger-CSS-klassene i index.html.)

const rosterUtvalg = {
  status: 'returning_top8',
  spillerIder: new Set(),
  statusApen: false,
  spillereApen: false,
};

function renderSteg2() {
  renderStatusVelger();
  renderSpillereVelger();

  $('#roster-teller').textContent = `(${state.roster.length}/16)`;

  const kategorier = ['returning_top8', 'qualifier_winner', 'wildcard', 'admin_invite'];
  $('#roster-kategorier').innerHTML = kategorier.map(kat => {
    const spillereIKat = state.roster.filter(r => r.kvalifiseringsstatusKilde === kat);
    return `
      <div class="card kategori-kort">
        <div class="kategori-header">
          <h2 style="margin:0;">${STATUS_KILDE_LABEL[kat]}</h2>
          <span class="teller-badge">${spillereIKat.length}</span>
        </div>
        ${spillereIKat.map(r => `
          <span class="spiller-chip">${escapeHtml(r.navn)}<button data-fjern="${r.id}" aria-label="Fjern">✕</button></span>
        `).join('') || '<p class="muted" style="font-size:13px;">Ingen ennå.</p>'}
      </div>
    `;
  }).join('');

  $$('#roster-kategorier [data-fjern]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!bekreft(`Fjerne ${navnFraId(btn.dataset.fjern)} fra rosteret?`)) return;
      btn.disabled = true;
      try {
        await repo.fjernFraRoster(state.event.id, btn.dataset.fjern);
        toast('Fjernet fra roster.');
      } catch (e) {
        console.error('Feil ved fjernFraRoster:', e);
        toast('Kunne ikke fjerne spilleren: ' + e.message, 'error');
        btn.disabled = false;
      }
    });
  });

  renderMasterSpillerListe();
}

function renderStatusVelger() {
  $('#status-navn').textContent = STATUS_KILDE_LABEL[rosterUtvalg.status];
  $('#wildcard-begrunnelse-felt').hidden = rosterUtvalg.status !== 'wildcard';
  $('#status-chevron').classList.toggle('apen', rosterUtvalg.statusApen);
  $('#status-liste').hidden = !rosterUtvalg.statusApen;

  if (!rosterUtvalg.statusApen) return;
  const kategorier = ['returning_top8', 'qualifier_winner', 'wildcard', 'admin_invite'];
  $('#status-liste').innerHTML = kategorier.map(kat => {
    const valgt = kat === rosterUtvalg.status;
    return `<div class="velger-rad ${valgt ? 'valgt' : ''}" data-status="${kat}">${STATUS_KILDE_LABEL[kat]}${valgt ? '<span class="velger-rad-ikon">✓</span>' : ''}</div>`;
  }).join('');

  $$('#status-liste [data-status]').forEach(el => {
    el.addEventListener('click', () => {
      rosterUtvalg.status = el.dataset.status;
      rosterUtvalg.statusApen = false;
      renderStatusVelger();
    });
  });
}

function renderSpillereVelger() {
  $('#spillere-teller').textContent = `${rosterUtvalg.spillerIder.size} valgt`;
  $('#spillere-chevron').classList.toggle('apen', rosterUtvalg.spillereApen);
  $('#tilgjengelige-spillere-liste').hidden = !rosterUtvalg.spillereApen;

  if (!rosterUtvalg.spillereApen) return;

  const tilgjengelige = state.masterSpillere.filter(s => !state.roster.some(r => r.id === s.id));
  if (tilgjengelige.length === 0) {
    $('#tilgjengelige-spillere-liste').innerHTML = '<p class="muted" style="font-size:13px; padding:10px 2px;">Alle spillere i klubbregisteret er allerede i rosteret.</p>';
    return;
  }

  $('#tilgjengelige-spillere-liste').innerHTML = tilgjengelige.map(s => {
    const valgt = rosterUtvalg.spillerIder.has(s.id);
    return `<div class="velger-rad ${valgt ? 'valgt' : ''}" data-spiller="${s.id}">${escapeHtml(s.navn)}<span class="velger-rad-ikon">${valgt ? '✓' : '+'}</span></div>`;
  }).join('');

  $$('#tilgjengelige-spillere-liste [data-spiller]').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.spiller;
      if (rosterUtvalg.spillerIder.has(id)) rosterUtvalg.spillerIder.delete(id);
      else rosterUtvalg.spillerIder.add(id);
      renderSpillereVelger();
    });
  });
}

$('#status-toggle').addEventListener('click', () => {
  rosterUtvalg.statusApen = !rosterUtvalg.statusApen;
  rosterUtvalg.spillereApen = false;
  renderStatusVelger();
  renderSpillereVelger();
});

$('#spillere-toggle').addEventListener('click', () => {
  rosterUtvalg.spillereApen = !rosterUtvalg.spillereApen;
  rosterUtvalg.statusApen = false;
  renderStatusVelger();
  renderSpillereVelger();
});

$('#legg-til-valgte-btn').addEventListener('click', async () => {
  if (!state.event) { toast('Opprett et event først.', 'error'); return; }
  const valgteIder = [...rosterUtvalg.spillerIder];
  if (valgteIder.length === 0) { toast('Velg minst én spiller først.', 'error'); return; }
  if (state.roster.length + valgteIder.length > 16) {
    toast(`Kan ikke legge til ${valgteIder.length} -- rosteret har bare plass til ${16 - state.roster.length} til.`, 'error');
    return;
  }

  const kilde = rosterUtvalg.status;
  const begrunnelse = $('#wildcard-begrunnelse-input').value.trim() || null;
  const btn = $('#legg-til-valgte-btn');
  btn.disabled = true;

  const feilede = [];
  for (const spillerId of valgteIder) {
    const spiller = state.masterSpillere.find(s => s.id === spillerId);
    if (!spiller) continue;
    try {
      await repo.leggTilIRoster(state.event.id, spillerId, { navn: spiller.navn, kvalifiseringsstatusKilde: kilde, wildcardBegrunnelse: begrunnelse });
    } catch (e) {
      console.error('Feil ved leggTilIRoster:', e);
      feilede.push(spiller.navn);
    }
  }

  btn.disabled = false;
  const antallOk = valgteIder.length - feilede.length;
  if (antallOk > 0) toast(`${antallOk} spiller${antallOk === 1 ? '' : 'e'} lagt til.`);
  if (feilede.length > 0) toast('Kunne ikke legge til: ' + feilede.join(', '), 'error');

  rosterUtvalg.spillerIder.clear();
  renderSpillereVelger();
});

$('#opprett-spiller-btn').addEventListener('click', async () => {
  const navn = $('#ny-spiller-navn').value.trim();
  if (!navn) return;
  await repo.opprettSpiller({ navn, farge: initialFarge(navn) });
  $('#ny-spiller-navn').value = '';
  toast(`${navn} lagt til i klubbregisteret.`);
  await lastMasterSpillereOgRenderSteg2();
});

// --- Klubbregister: full oversikt + PERMANENT sletting av en master-spiller ---
// (ikke å forveksle med "fjern fra roster" over, som kun rører DETTE eventets
// roster og lar master-spilleren leve videre i klubbregisteret.)

function renderMasterSpillerListe() {
  const container = $('#master-spillere-liste');
  if (!container) return; // element finnes ikke ennå i denne HTML-versjonen

  if (state.masterSpillere.length === 0) {
    container.innerHTML = '<p class="muted" style="font-size:13px;">Ingen spillere i klubbregisteret ennå.</p>';
    return;
  }

  container.innerHTML = state.masterSpillere.map(s => {
    const erIAktivtRoster = state.roster.some(r => r.spillerId === s.id || r.id === s.id);
    return `
      <div class="list-row">
        <span>${escapeHtml(s.navn)}${erIAktivtRoster ? ' <span class="badge badge-warn">I aktivt roster</span>' : ''}</span>
        <button class="btn btn-danger btn-small" data-slett-spiller="${s.id}">Slett</button>
      </div>
    `;
  }).join('');

  $$('#master-spillere-liste [data-slett-spiller]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const spillerId = btn.dataset.slettSpiller;
      const spiller = state.masterSpillere.find(s => s.id === spillerId);
      if (!spiller) return;

      const erIAktivtRoster = state.roster.some(r => r.spillerId === spillerId || r.id === spillerId);
      if (erIAktivtRoster) {
        toast('Kan ikke slette -- spilleren står i det aktive eventets roster. Fjern fra roster først.', 'error');
        return;
      }

      if (!bekreft(
        `Slette ${spiller.navn} PERMANENT fra klubbregisteret?\n\n` +
        `Dette kan ikke angres. Historiske eventer/champions som nevner ` +
        `spilleren beholder navnet, men vil ikke lenger peke på et gyldig spillerdokument.`
      )) return;

      try {
        await repo.slettSpillerHelt(spillerId);
        toast(`${spiller.navn} slettet permanent.`);
        await lastMasterSpillereOgRenderSteg2();
      } catch (e) {
        console.error(e);
        toast('Kunne ikke slette spilleren: ' + e.message, 'error');
      }
    });
  });
}

// --- Steg 3: Puljer (med manuell flytting) ---

function renderSteg3() {
  if (!state.event) { renderIkkeKlarSteg('steg-3', 'Opprett et event og legg til spillere først.'); return; }
  renderPuljerFlytVisning();
}

$('#trekk-puljer-btn').addEventListener('click', async () => {
  if (state.roster.length !== 16) { toast('Trenger nøyaktig 16 spillere i rosteret først.', 'error'); return; }
  if (!bekreft('Trekke nye puljer? Dette overskriver eventuell eksisterende puljeinndeling.')) return;
  const blandet = shuffle(state.roster.map(r => r.id));
  const puljer = PULJE_IDER.map((navn, i) => ({ id: navn, navn: `Pulje ${navn}`, spillerIds: blandet.slice(i * 4, i * 4 + 4) }));
  await repo.lagrePuljer(state.event.id, puljer);
  for (const p of puljer) {
    for (const spillerId of p.spillerIds) await repo.flyttSpillerTilPulje(state.event.id, spillerId, p.id);
  }
  state.puljer = puljer;
  toast('Puljer trukket.');
  renderPuljerFlytVisning();
});

function renderPuljerFlytVisning() {
  if (state.puljer.length !== 4) {
    $('#puljer-flyt-visning').innerHTML = '<p class="muted">Ingen puljer trukket ennå.</p>';
    return;
  }
  $('#puljer-flyt-visning').innerHTML = state.puljer.map(p => `
    <div class="card pulje-flyt-kort">
      <h3>Pulje ${p.id}</h3>
      ${p.spillerIds.map(id => {
        const spiller = state.roster.find(r => r.id === id);
        const navn = spiller ? spiller.navn : id;
        const menyApen = state.apenFlyttMeny === id;
        return `
          <div class="pulje-spiller-rad">
            <span>${escapeHtml(navn)}</span>
            <button class="btn btn-outline btn-small" data-flytt-spiller="${id}" data-fra-pulje="${p.id}">Flytt</button>
          </div>
          ${menyApen ? `
            <div class="flytt-meny">
              ${PULJE_IDER.filter(pid => pid !== p.id).map(pid => `<button data-mal-pulje="${pid}" data-mal-spiller="${id}" data-mal-fra="${p.id}">→ ${pid}</button>`).join('')}
            </div>
          ` : ''}
        `;
      }).join('')}
    </div>
  `).join('');

  $$('[data-flytt-spiller]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.flyttSpiller;
      state.apenFlyttMeny = state.apenFlyttMeny === id ? null : id;
      renderPuljerFlytVisning();
    });
  });
  $$('[data-mal-pulje]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const spillerId = btn.dataset.malSpiller;
      const fraPuljeId = btn.dataset.malFra;
      const tilPuljeId = btn.dataset.malPulje;
      await repo.byttSpillerPulje(state.event.id, spillerId, fraPuljeId, tilPuljeId);
      const fra = state.puljer.find(p => p.id === fraPuljeId);
      const til = state.puljer.find(p => p.id === tilPuljeId);
      fra.spillerIds = fra.spillerIds.filter(id => id !== spillerId);
      til.spillerIds.push(spillerId);
      state.apenFlyttMeny = null;
      toast(`${navnFraId(spillerId)} flyttet til Pulje ${tilPuljeId}.`);
      renderPuljerFlytVisning();
    });
  });
}

// --- Steg 4: Kampoppsett ---

function renderSteg4() {
  if (!state.event) { renderIkkeKlarSteg('steg-4', 'Opprett et event og trekk puljer først.'); return; }
  const generert = state.event.kampoppsettGenerertOgValidert === true;
  $('#generer-kampoppsett-btn').hidden = generert;
  $('#regenerer-kampoppsett-btn').hidden = !generert;
  $('#kampoppsett-status').textContent = generert ? 'Kampoppsett er generert og validert. ✓' : 'Kampoppsett er ikke generert ennå.';
}

$('#generer-kampoppsett-btn').addEventListener('click', () => genererOgLagreKampoppsett());
$('#regenerer-kampoppsett-btn').addEventListener('click', async () => {
  if (!bekreft('Regenerere kampoppsettet? Alle registrerte puljespill-resultater slettes.')) return;
  await repo.slettPuljespillKamper(state.event.id);
  await genererOgLagreKampoppsett();
});

async function genererOgLagreKampoppsett() {
  if (state.puljer.length !== 4) { toast('Trekk puljer først (Steg 3).', 'error'); return; }
  const navnMap = Object.fromEntries(state.roster.map(r => [r.id, r.navn]));
  try {
    const kamper = genererKampoppsett({ puljer: state.puljer, disipliner: DISIPLINER, baner: BANER });
    const medNavn = kamper.map(k => ({ ...k, spillerANavn: navnMap[k.spillerA] ?? k.spillerA, spillerBNavn: navnMap[k.spillerB] ?? k.spillerB }));
    await repo.lagreKampoppsett(state.event.id, medNavn);
    toast('Kampoppsett generert og lagret.');
    await lastEvent();
  } catch (e) {
    console.error(e);
    toast('Kunne ikke generere et gyldig kampoppsett: ' + e.message, 'error');
  }
}

// --- Steg 5: Start ---

function renderSteg5() {
  if (!state.event) { renderIkkeKlarSteg('steg-5', 'Fullfør Steg 1-4 først.'); return; }

  const rosterOk = state.roster.length === 16;
  const puljerOk = state.puljer.length === 4;
  const kampoppsettOk = state.event.kampoppsettGenerertOgValidert === true;

  $('#start-sjekkliste').innerHTML = `
    <div class="sjekkliste-rad"><span class="${rosterOk ? 'ok' : 'mangler'}">${rosterOk ? '✓' : '○'}</span> 16 spillere lagt til (${state.roster.length}/16)</div>
    <div class="sjekkliste-rad"><span class="${puljerOk ? 'ok' : 'mangler'}">${puljerOk ? '✓' : '○'}</span> Puljer trukket</div>
    <div class="sjekkliste-rad"><span class="${kampoppsettOk ? 'ok' : 'mangler'}">${kampoppsettOk ? '✓' : '○'}</span> Kampoppsett generert og validert</div>
  `;

  const sjekk = logikk.sjekkForutsetninger('main_event', { puljer: state.puljer, kampoppsettGenerertOgValidert: kampoppsettOk });
  $('#start-hovedevent-btn').disabled = !sjekk.tillatt || !rosterOk;
  $('#start-arsaker').textContent = (!rosterOk ? 'Mangler spillere i rosteret. ' : '') + sjekk.arsaker.join(' ');
}

$('#start-hovedevent-btn').addEventListener('click', async () => {
  if (!bekreft('Starte hovedeventet? Kampoppsettet blir låst og eventet går live.')) return;
  await repo.oppdaterEventStatus(state.event.id, 'main_event');
  await repo.settAktivtEvent(state.event.id, 1, 'none');
  toast('Hovedeventet er startet!');
  await lastEvent();
});

// ============================================================================
// LØPENDE DASHBOARD (event er main_event / playoffs / completed)
// ============================================================================

$$('.tab-pill').forEach(btn => {
  btn.addEventListener('click', () => visTab(btn.dataset.tab));
});

function visTab(navn) {
  $$('.tab-pill').forEach(b => b.classList.toggle('active', b.dataset.tab === navn));
  $$('.panel').forEach(p => p.hidden = p.id !== `panel-${navn}`);
  if (navn === 'event') renderEventTab();
  if (navn === 'kamper') lastKamperTab();
  if (navn === 'sluttspill') lastSluttspillTab();
  if (navn === 'leaderboard') lastLeaderboardTab();
  if (navn === 'halloffame') lastHallOfFameTab();
}

// --- Event-fanen (i det løpende dashbordet) ---

function renderEventTab() {
  const event = state.event;
  $('#event-navn-visning-2').textContent = event.navn;
  $('#event-nummer-visning-2').textContent = `Event #${event.eventNummer}`;
  const badge = $('#event-status-badge');
  badge.textContent = logikk.STATUS_VISNINGSNAVN[event.status];

  const knapper = $('#event-status-knapper');
  knapper.innerHTML = '';
  const arsakEl = $('#event-status-arsaker');
  arsakEl.textContent = '';

  const idx = logikk.STATUS_REKKEFOLGE.indexOf(event.status);
  const neste = logikk.STATUS_REKKEFOLGE[idx + 1];
  const forrige = logikk.STATUS_REKKEFOLGE[idx - 1];

  if (neste) {
    const kontekst = byggStatusKontekst(neste);
    const sjekk = logikk.sjekkForutsetninger(neste, kontekst);
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary btn-small';
    btn.textContent = `→ ${logikk.STATUS_VISNINGSNAVN[neste]}`;
    btn.disabled = !sjekk.tillatt;
    btn.addEventListener('click', () => gaTilStatus(neste));
    knapper.appendChild(btn);
    if (!sjekk.tillatt) arsakEl.textContent = sjekk.arsaker.join(' ');
  }
  if (forrige && logikk.erLovligOvergang(event.status, forrige) && event.status !== 'main_event') {
    const btn = document.createElement('button');
    btn.className = 'btn btn-outline btn-small';
    btn.textContent = `← ${logikk.STATUS_VISNINGSNAVN[forrige]}`;
    btn.addEventListener('click', async () => {
      if (!bekreft(`Gå tilbake til "${logikk.STATUS_VISNINGSNAVN[forrige]}"?`)) return;
      await repo.oppdaterEventStatus(state.event.id, forrige);
      toast('Status endret.');
    });
    knapper.appendChild(btn);
  }
}

function byggStatusKontekst(tilStatus) {
  if (tilStatus === 'playoffs') return { puljespillKamper: state.alleKamperCache ?? [] };
  if (tilStatus === 'completed') return { finaleSerie: state.finaleSerieCache ?? null };
  return {};
}

async function gaTilStatus(tilStatus) {
  let kontekst = byggStatusKontekst(tilStatus);
  if (tilStatus === 'playoffs') {
    const alle = await repo.hentKamperForFase(state.event.id, 'pool');
    state.alleKamperCache = alle;
    kontekst = { puljespillKamper: alle };
  }
  if (tilStatus === 'completed') {
    const finaleKamper = await repo.hentKamperForFase(state.event.id, 'final');
    const finaleDoc = await repo.hentSluttspillFase(state.event.id, 'final');
    const serie = finaleDoc ? logikk.beregnSerieStatus(finaleDoc.spillerA, finaleDoc.spillerB, finaleKamper) : null;
    state.finaleSerieCache = serie;
    kontekst = { finaleSerie: serie };
  }
  const sjekk = logikk.sjekkForutsetninger(tilStatus, kontekst);
  if (!sjekk.tillatt) { toast(sjekk.arsaker.join(' '), 'error'); return; }
  if (!bekreft(`Gå videre til "${logikk.STATUS_VISNINGSNAVN[tilStatus]}"?`)) return;
  try {
    await repo.oppdaterEventStatus(state.event.id, tilStatus);
    toast('Status oppdatert.');
    if (tilStatus === 'playoffs') await settOppKvartfinaler();
  } catch (e) {
    console.error('Feil ved overgang til ' + tilStatus + ':', e);
    toast(
      'Noe feilet under overgangen: ' + e.message +
      (tilStatus === 'playoffs' ? ' -- statusen kan ha blitt endret selv om kvartfinalene ikke ble satt opp. Bruk "Sett opp kvartfinaler på nytt"-knappen i Sluttspill-fanen.' : ''),
      'error'
    );
  }
}

// --- Kamper-fanen ---

async function lastKamperTab() {
  if (!state.event) return;
  $('#runde-tabs').innerHTML = [1, 2, 3, 4].map(r =>
    `<button class="tab-pill ${r === state.gjeldendeRundeVisning ? 'active' : ''}" data-runde="${r}">Runde ${r}</button>`
  ).join('');
  $$('#runde-tabs .tab-pill').forEach(btn => {
    btn.addEventListener('click', async () => {
      state.gjeldendeRundeVisning = Number(btn.dataset.runde);
      if (state.event.status === 'main_event') {
        await repo.oppdaterEventFelt(state.event.id, { gjeldendeRunde: state.gjeldendeRundeVisning });
        await repo.settAktivtEvent(state.event.id, state.gjeldendeRundeVisning, 'none');
      }
      lastKamperTab();
    });
  });
  state.kamperIRunde = await repo.hentKamperForRunde(state.event.id, state.gjeldendeRundeVisning);
  renderKamperListe();
}

function renderKamperListe() {
  const navnMap = Object.fromEntries(state.roster.map(r => [r.id, r.navn]));
  $('#kamper-liste').innerHTML = state.kamperIRunde.map(k => kampKortHtml(k, navnMap)).join('');
  state.kamperIRunde.forEach(k => bindKampKort(k));
}

function kampKortHtml(k, navnMap) {
  const ferdig = k.status === 'completed';
  return `
    <div class="card-inner" style="margin-bottom:10px;" data-kamp-id="${k.id}">
      <div class="list-row" style="border:none; padding-top:0;">
        <span class="badge badge-accent">${k.disiplin}</span>
        <span class="mono muted2">${k.bane}</span>
      </div>
      <p style="font-size:17px; margin:8px 0;">
        ${escapeHtml(navnMap[k.spillerA] ?? k.spillerA)} <span class="muted2">vs</span> ${escapeHtml(navnMap[k.spillerB] ?? k.spillerB)}
      </p>
      ${ferdig ? `
        <p class="score mono">${k.poengA} – ${k.poengB} ${k.suddenDeath ? '<span class="badge badge-warn">SUDDEN DEATH</span>' : ''}</p>
        <span class="badge badge-active">Ferdig${k.overstyrtAvAdmin ? ' (overstyrt)' : ''}</span>
        <button class="btn btn-outline btn-small overstyr-btn" style="margin-top:8px;">Overstyr resultat</button>
      ` : `
        <div class="grid-2">
          <input type="number" class="poeng-a" placeholder="Poeng ${navnMap[k.spillerA] ?? ''}">
          <input type="number" class="poeng-b" placeholder="Poeng ${navnMap[k.spillerB] ?? ''}">
        </div>
        <div class="grid-2">
          <select class="endre-bane">${Object.values(BANER).flat().map(b => `<option ${b === k.bane ? 'selected' : ''}>${b}</option>`).join('')}</select>
          <select class="endre-disiplin">${DISIPLINER.map(d => `<option ${d === k.disiplin ? 'selected' : ''}>${d}</option>`).join('')}</select>
        </div>
        <button class="btn btn-primary btn-small lagre-resultat-btn">Lagre resultat</button>
      `}
    </div>
  `;
}

function bindKampKort(k) {
  const kort = document.querySelector(`[data-kamp-id="${k.id}"]`);
  if (!kort) return;
  const navnMap = Object.fromEntries(state.roster.map(r => [r.id, r.navn]));

  kort.querySelector('.endre-bane')?.addEventListener('change', (e) => {
    if (!bekreft('Endre bane for denne kampen? Dette overstyrer det genererte oppsettet.')) { lastKamperTab(); return; }
    repo.endreBaneOgDisiplin(state.event.id, k.id, { bane: e.target.value, disiplin: k.disiplin }).then(() => toast('Bane endret.'));
  });
  kort.querySelector('.endre-disiplin')?.addEventListener('change', (e) => {
    if (!bekreft('Endre disiplin for denne kampen? Dette overstyrer det genererte oppsettet.')) { lastKamperTab(); return; }
    repo.endreBaneOgDisiplin(state.event.id, k.id, { bane: k.bane, disiplin: e.target.value }).then(() => toast('Disiplin endret.'));
  });

  kort.querySelector('.lagre-resultat-btn')?.addEventListener('click', async () => {
    const poengA = Number(kort.querySelector('.poeng-a').value);
    const poengB = Number(kort.querySelector('.poeng-b').value);
    if (Number.isNaN(poengA) || Number.isNaN(poengB) || poengA === poengB) {
      toast('Fyll inn to ulike poengsummer (ingen uavgjort).', 'error'); return;
    }
    await repo.registrerPuljeResultat(state.event.id, k, { poengA, poengB, rosterNavnMap: navnMap });
    toast('Resultat lagret — leaderboard oppdatert.');
    await lastKamperTab();
  });

  kort.querySelector('.overstyr-btn')?.addEventListener('click', async () => {
    if (!bekreft(`Overstyre resultatet for ${navnMap[k.spillerA]} vs ${navnMap[k.spillerB]}?`)) return;
    const nyA = Number(window.prompt(`Nytt poengtall for ${navnMap[k.spillerA]}:`, k.poengA));
    const nyB = Number(window.prompt(`Nytt poengtall for ${navnMap[k.spillerB]}:`, k.poengB));
    if (Number.isNaN(nyA) || Number.isNaN(nyB) || nyA === nyB) { toast('Ugyldige poengsummer.', 'error'); return; }
    await repo.overstyrPuljeResultat(state.event.id, k, { nyPoengA: nyA, nyPoengB: nyB, rosterNavnMap: navnMap });
    toast('Resultat overstyrt.');
    await lastKamperTab();
  });
}

// --- Sluttspill-fanen ---

async function hentRangeringPerPulje(eventId) {
  const leaderboards = await repo.hentAlleLeaderboards(eventId);
  const rangeringPerPulje = {};
  for (const lb of leaderboards) {
    const kamperIPulje = await repo.hentAlleKamperIPulje(eventId, lb.puljeId);
    rangeringPerPulje[lb.puljeId] = logikk.sorterSpillerStats(lb.spillerStats, kamperIPulje.filter(k => k.status === 'completed'));
  }
  return rangeringPerPulje;
}

async function lastSluttspillTab() {
  if (!state.event) return;
  const rangeringPerPulje = await hentRangeringPerPulje(state.event.id);
  const alleFireKlare = PULJE_IDER.every(p => (rangeringPerPulje[p]?.length ?? 0) >= 2);

  if (alleFireKlare) {
    const kvalifiserte = logikk.bestemKvalifiserte(rangeringPerPulje);
    $('#kvalifiserte-liste').innerHTML = kvalifiserte.map(s => `
      <div class="list-row">
        <span>${escapeHtml(s.navn)} <span class="muted2 mono">Pulje ${s.puljeId} · #${s.puljePlassering}</span></span>
        <span class="badge badge-active">QUALIFIED</span>
      </div>
    `).join('');
  } else {
    $('#kvalifiserte-liste').innerHTML = '<p class="muted">Puljespillet må fullføres først.</p>';
  }
  renderSluttspillKontroll();
}

function renderSluttspillKontroll() {
  const fase = state.event.sluttspillFase;
  $('#sluttspill-kontroll').innerHTML = `<p class="muted2 mono">Fase: ${fase}</p>`;
  $('#sluttspill-bracket').innerHTML = '';
  if (state.event.status !== 'playoffs') return;

  if (fase === 'none' || !fase) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary btn-small';
    btn.textContent = 'Sett opp kvartfinaler på nytt';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await settOppKvartfinaler();
      } finally {
        btn.disabled = false;
      }
    });
    $('#sluttspill-kontroll').appendChild(btn);
    return;
  }

  if (fase === 'quarterfinal' || fase === 'semifinal' || fase === 'final') lastOgVisSerier(fase);
}

async function settOppKvartfinaler() {
  try {
    const rangeringPerPulje = await hentRangeringPerPulje(state.event.id);
    const kvartfinaler = logikk.genererKvartfinaleOppsett(rangeringPerPulje);

    const kvalifiserte = logikk.bestemKvalifiserte(rangeringPerPulje);
    for (const s of kvalifiserte) await repo.markerRosterKvalifisert(state.event.id, s.spillerId);

    await repo.oppdaterEventFelt(state.event.id, { sluttspillFase: 'quarterfinal' });
    await repo.settAktivtEvent(state.event.id, state.event.gjeldendeRunde, 'quarterfinal');
    for (const qf of kvartfinaler) {
      await repo.leggTilSluttspillKamp(state.event.id, {
        runde: 5, fase: 'quarterfinal', serieId: qf.id, kampNrISerie: 1,
        bane: BANER.pickleball[0], disiplin: DISIPLINER[0], puljeId: null,
        spillerA: qf.spillerA, spillerB: qf.spillerB,
        spillerANavn: navnFraId(qf.spillerA), spillerBNavn: navnFraId(qf.spillerB),
      });
    }
    toast('Kvartfinaler satt opp.');
    await lastSluttspillTab();
  } catch (e) {
    console.error('Feil ved oppsett av kvartfinaler:', e);
    toast('Kunne ikke sette opp kvartfinaler: ' + e.message, 'error');
  }
}

async function lastOgVisSerier(fase) {
  const kamper = await repo.hentKamperForFase(state.event.id, fase);
  const serier = {};
  for (const k of kamper) { serier[k.serieId] = serier[k.serieId] || []; serier[k.serieId].push(k); }

  let html = '';
  let alleFerdige = true;
  for (const [serieId, kampListe] of Object.entries(serier)) {
    const forste = kampListe[0];
    const status = logikk.beregnSerieStatus(forste.spillerA, forste.spillerB, kampListe);
    if (!status.ferdig) alleFerdige = false;
    html += `
      <div class="card-inner" style="margin-bottom:10px;">
        <h3>${serieId}: ${escapeHtml(forste.spillerANavn)} vs ${escapeHtml(forste.spillerBNavn)}</h3>
        <p class="mono">${status.seireA} – ${status.seireB}</p>
        ${status.ferdig
          ? `<span class="badge badge-active">Vinner: ${escapeHtml(status.vinnerId === forste.spillerA ? forste.spillerANavn : forste.spillerBNavn)}</span>`
          : `<div class="grid-2">
               <input type="number" class="serie-poeng-a" placeholder="Poeng ${escapeHtml(forste.spillerANavn)}">
               <input type="number" class="serie-poeng-b" placeholder="Poeng ${escapeHtml(forste.spillerBNavn)}">
             </div>
             <button class="btn btn-primary btn-small serie-lagre-btn" data-serie="${serieId}">Lagre kampresultat i serien</button>`
        }
      </div>
    `;
  }
  $('#sluttspill-bracket').innerHTML = html || '<p class="muted">Ingen kamper i denne fasen ennå.</p>';

  $$('.serie-lagre-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const serieId = btn.dataset.serie;
      const kampListe = serier[serieId];
      const forste = kampListe[0];
      const kort = btn.closest('.card-inner');
      const poengA = Number(kort.querySelector('.serie-poeng-a').value);
      const poengB = Number(kort.querySelector('.serie-poeng-b').value);
      if (Number.isNaN(poengA) || Number.isNaN(poengB) || poengA === poengB) { toast('Fyll inn to ulike poengsummer.', 'error'); return; }
      const uspilt = kampListe.find(k => k.status !== 'completed');
      if (!uspilt) { toast('Alle kamper i serien er allerede spilt.', 'error'); return; }
      await repo.registrerSluttspillResultat(state.event.id, uspilt.id, { poengA, poengB, spillerA: forste.spillerA, spillerB: forste.spillerB });

      const oppdatertListe = [...kampListe.filter(k => k.id !== uspilt.id), { ...uspilt, status: 'completed', poengA, poengB, vinnerId: poengA > poengB ? forste.spillerA : forste.spillerB }];
      const nyStatus = logikk.beregnSerieStatus(forste.spillerA, forste.spillerB, oppdatertListe);
      if (!nyStatus.ferdig && nyStatus.trengerNesteOppgjor) {
        await repo.leggTilSluttspillKamp(state.event.id, {
          runde: uspilt.runde, fase: uspilt.fase, serieId, kampNrISerie: (uspilt.kampNrISerie ?? 1) + 1,
          bane: uspilt.bane, disiplin: uspilt.disiplin, puljeId: null,
          spillerA: forste.spillerA, spillerB: forste.spillerB, spillerANavn: forste.spillerANavn, spillerBNavn: forste.spillerBNavn,
        });
      }
      toast('Resultat lagret.');
      await lastOgVisSerier(fase);
    });
  });

  if (alleFerdige && Object.keys(serier).length > 0) visGaVidereKnapp(fase, serier);
}

function visGaVidereKnapp(fase, serier) {
  const knapp = document.createElement('button');
  knapp.className = 'btn btn-primary';
  knapp.style.marginTop = '10px';
  knapp.textContent = `Gå videre til ${logikk.nesteSluttspillFase(fase)}`;
  knapp.addEventListener('click', async () => {
    if (!bekreft('Alle kamper i denne fasen er ferdige. Gå videre?')) return;
    const vinnere = {};
    for (const [serieId, kampListe] of Object.entries(serier)) {
      const forste = kampListe[0];
      vinnere[serieId] = logikk.beregnSerieStatus(forste.spillerA, forste.spillerB, kampListe).vinnerId;
    }
    const nesteFase = logikk.nesteSluttspillFase(fase);
    await repo.oppdaterEventFelt(state.event.id, { sluttspillFase: nesteFase });
    await repo.settAktivtEvent(state.event.id, state.event.gjeldendeRunde, nesteFase);

    if (nesteFase === 'semifinal') {
      const semis = logikk.genererSemifinaleOppsett(vinnere);
      for (const s of semis) {
        await repo.leggTilSluttspillKamp(state.event.id, {
          runde: 6, fase: 'semifinal', serieId: s.id, kampNrISerie: 1,
          bane: BANER.pickleball[0], disiplin: DISIPLINER[0], puljeId: null,
          spillerA: s.spillerA, spillerB: s.spillerB, spillerANavn: navnFraId(s.spillerA), spillerBNavn: navnFraId(s.spillerB),
        });
      }
    } else if (nesteFase === 'final') {
      const finale = logikk.genererFinaleOppsett(vinnere, DISIPLINER);
      await repo.lagreSluttspillFase(state.event.id, 'final', finale);
      await repo.leggTilSluttspillKamp(state.event.id, {
        runde: 7, fase: 'final', serieId: 'FINAL', kampNrISerie: 1,
        bane: BANER[DISIPLINER[0]][0], disiplin: DISIPLINER[0], puljeId: null,
        spillerA: finale.spillerA, spillerB: finale.spillerB, spillerANavn: navnFraId(finale.spillerA), spillerBNavn: navnFraId(finale.spillerB),
      });
    }
    toast(`Videre til ${nesteFase}.`);
    await lastSluttspillTab();
  });
  $('#sluttspill-bracket').appendChild(knapp);
}

// --- Leaderboard-fanen ---

async function lastLeaderboardTab() {
  if (!state.event) return;
  const rangeringPerPulje = await hentRangeringPerPulje(state.event.id);
  $('#leaderboard-visning').innerHTML = Object.entries(rangeringPerPulje).map(([puljeId, rangering]) => `
    <div class="card">
      <h2>Pulje ${puljeId}</h2>
      ${rangering.map(r => `
        <div class="list-row">
          <span>#${r.rank} ${escapeHtml(r.navn)} ${r.rank <= 2 ? '<span class="badge badge-active">QUALIFIED</span>' : ''}</span>
          <span class="mono muted2">${r.seire}S ${r.tap}T · ${r.poeng}p · ${r.poengforskjell > 0 ? '+' : ''}${r.poengforskjell}</span>
        </div>
      `).join('')}
    </div>
  `).join('') || '<p class="muted">Ingen leaderboard-data ennå — registrer et kampresultat først.</p>';
}

// --- Hall of Fame-fanen ---

async function lastHallOfFameTab() {
  state.champions = await repo.hentChampions();
  const select = $('#champion-spiller-select');
  select.innerHTML = state.roster.map(r => `<option value="${r.id}">${escapeHtml(r.navn)}</option>`).join('');
  $('#champions-liste').innerHTML = state.champions.map(c => `
    <div class="list-row">
      <span>${escapeHtml(c.navn)} <span class="muted2 mono">Event #${c.eventNummer}</span></span>
      <span class="badge badge-accent">${c.antallSeireTotalt}× vinner</span>
    </div>
  `).join('') || '<p class="muted">Ingen championer registrert ennå.</p>';
}

$('#registrer-champion-btn').addEventListener('click', async () => {
  if (!state.event) return;
  const spillerId = $('#champion-spiller-select').value;
  if (!spillerId) return;
  if (!bekreft(`Registrere ${navnFraId(spillerId)} som champion for ${state.event.navn}?`)) return;

  const spiller = state.masterSpillere.find(s => s.id === spillerId) ?? { stats: null };
  const record = logikk.byggChampionRecord({
    spillerId, navn: navnFraId(spillerId), eventNummer: state.event.eventNummer,
    eventId: state.event.id, dato: state.event.dato ?? new Date().toISOString(),
    tidligereAntallSeireTotalt: spiller.stats?.antallEventseire ?? 0,
  });
  await repo.registrerChampion(record);

  const nyeStats = logikk.oppdaterSpillerStats(spiller.stats, {
    kampSeire: 0, naddeFinale: true, vantEvent: true, eventId: state.event.id, plassering: '1', dato: state.event.dato ?? new Date().toISOString(),
  });
  await repo.oppdaterSpiller(spillerId, { stats: nyeStats });
  toast('Champion registrert i Hall of Fame.');
  await lastHallOfFameTab();
});
