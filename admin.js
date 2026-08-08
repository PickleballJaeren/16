// ============================================================================
// admin.js — "16"
// ============================================================================

import { paAuthEndring, loggInnSomAdmin } from './auth.js';
import * as repo from './firestore-repo.js';
import * as logikk from './eventlogikk.js';
import { genererKampoppsett } from './kampgenerator.js';

const DISIPLINER = ['pickleball', 'skyball', 'speedminton'];
const BANER = {
  pickleball: ['Pickleball 1', 'Pickleball 2'],
  skyball: ['Skyball 1', 'Skyball 2'],
  speedminton: ['Speedminton 1', 'Speedminton 2'],
};
const KAMPVARIGHET_PULJESPILL_MIN = 10;

const state = {
  erAdmin: false,
  event: null,
  roster: [],
  masterSpillere: [],
  puljer: [],
  gjeldendeRundeVisning: 1,
  kamperIRunde: [],
  leaderboards: [],
  champions: [],
};

// ----------------------------------------------------------------------------
// Småhjelpere: DOM, toast, bekreftelse
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
  // Alle kritiske/destruktive handlinger skal ha bekreftelse (jf. spesifikasjonen).
  return window.confirm(melding);
}

function initialFarge(navn) {
  const paletter = ['#2563eb', '#16a34a', '#eab308', '#ea580c', '#dc2626', '#3b82f6'];
  let sum = 0;
  for (const c of navn) sum += c.charCodeAt(0);
  return paletter[sum % paletter.length];
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
// Tabs
// ----------------------------------------------------------------------------

$$('.tab-pill').forEach(btn => {
  btn.addEventListener('click', () => visTab(btn.dataset.tab));
});

function visTab(navn) {
  $$('.tab-pill').forEach(b => b.classList.toggle('active', b.dataset.tab === navn));
  $$('.panel').forEach(p => p.hidden = p.id !== `panel-${navn}`);
  if (navn === 'spillere') lastSpillereTab();
  if (navn === 'kamper') lastKamperTab();
  if (navn === 'sluttspill') lastSluttspillTab();
  if (navn === 'leaderboard') lastLeaderboardTab();
  if (navn === 'halloffame') lastHallOfFameTab();
}

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

  const innstillinger = await repo.hentInnstillinger();
  if (innstillinger) {
    $('#dashboard-tittel').textContent = `${innstillinger.eventNavn} — Admin`;
    $('#pin-event-navn').textContent = innstillinger.eventNavn;
  }

  await lastEventTab();
}

// ----------------------------------------------------------------------------
// EVENT-fanen
// ----------------------------------------------------------------------------

async function lastEventTab() {
  const siste = await repo.hentSisteEventer(1);
  if (siste.length === 0) {
    $('#ingen-event-kort').hidden = false;
    $('#event-status-kort').hidden = true;
    return;
  }
  $('#ingen-event-kort').hidden = true;
  $('#event-status-kort').hidden = false;
  repo.lyttEvent(siste[0].id, async (event) => {
    state.event = event;
    if (!event) return;
    renderEventStatus(event);
    await lastRosterOgPuljer();
  });
}

$('#opprett-event-btn').addEventListener('click', async () => {
  const navn = $('#nytt-event-navn').value.trim() || '16';
  const dato = $('#nytt-event-dato').value || null;
  const { id } = await repo.opprettEvent({
    navn, dato,
    config: {
      antallPuljer: 4, spillerePerPulje: 4,
      kampVarighetPuljespillMin: KAMPVARIGHET_PULJESPILL_MIN,
      kampVarighetSluttspillMin: 6,
      disipliner: DISIPLINER, baner: Object.values(BANER).flat(),
    },
  });
  toast('Event opprettet.');
  await lastEventTab();
});

function renderEventStatus(event) {
  $('#event-navn-visning').textContent = event.navn;
  $('#event-nummer-visning').textContent = `Event #${event.eventNummer}`;
  $('#dashboard-status-linje').textContent = `${event.navn} · ${logikk.STATUS_VISNINGSNAVN[event.status]}`;
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
  if (forrige && logikk.erLovligOvergang(event.status, forrige)) {
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
  if (tilStatus === 'registration_closed') {
    return { antallRegistrerteSpillere: state.roster.length };
  }
  if (tilStatus === 'main_event') {
    return { puljer: state.puljer, kampoppsettGenerertOgValidert: state.event?.kampoppsettGenerertOgValidert === true };
  }
  if (tilStatus === 'playoffs') {
    return { puljespillKamper: state.alleKamperCache ?? [] };
  }
  if (tilStatus === 'completed') {
    return { finaleSerie: state.finaleSerieCache ?? null };
  }
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
    const serie = finaleDoc
      ? logikk.beregnSerieStatus(finaleDoc.spillerA, finaleDoc.spillerB, finaleKamper)
      : null;
    state.finaleSerieCache = serie;
    kontekst = { finaleSerie: serie };
  }
  const sjekk = logikk.sjekkForutsetninger(tilStatus, kontekst);
  if (!sjekk.tillatt) {
    toast(sjekk.arsaker.join(' '), 'error');
    return;
  }
  if (!bekreft(`Gå videre til "${logikk.STATUS_VISNINGSNAVN[tilStatus]}"?`)) return;
  await repo.oppdaterEventStatus(state.event.id, tilStatus);
  toast('Status oppdatert.');

  if (tilStatus === 'playoffs') {
    await settOppKvartfinaler();
  }
}

// ----------------------------------------------------------------------------
// SPILLERE-fanen
// ----------------------------------------------------------------------------

async function lastRosterOgPuljer() {
  if (!state.event) return;
  repo.lyttRoster(state.event.id, (roster) => {
    state.roster = roster.filter(r => !r.fjernet);
    renderRosterListe();
    renderEventStatus(state.event);
  });
  state.puljer = await repo.hentPuljer(state.event.id);
  renderPuljerVisning();
}

async function lastSpillereTab() {
  state.masterSpillere = await repo.hentAlleAktiveSpillere();
  const select = $('#legg-til-roster-select');
  select.innerHTML = '<option value="">Velg spiller …</option>' +
    state.masterSpillere
      .filter(s => !state.roster.some(r => r.id === s.id))
      .map(s => `<option value="${s.id}">${escapeHtml(s.navn)}</option>`).join('');
  renderRosterListe();
}

$('#opprett-spiller-btn').addEventListener('click', async () => {
  const navn = $('#ny-spiller-navn').value.trim();
  if (!navn) return;
  await repo.opprettSpiller({ navn, farge: initialFarge(navn) });
  $('#ny-spiller-navn').value = '';
  toast(`${navn} lagt til i master-registeret.`);
  await lastSpillereTab();
});

$('#kvalifiseringsstatus-select').addEventListener('change', (e) => {
  $('#wildcard-begrunnelse-felt').hidden = e.target.value !== 'wildcard';
});

$('#legg-til-roster-btn').addEventListener('click', async () => {
  if (!state.event) { toast('Opprett et event først.', 'error'); return; }
  if (!['draft', 'registration_open'].includes(state.event.status)) {
    toast('Rosteret kan kun endres mens eventet er i Draft eller Registration Open.', 'error');
    return;
  }
  const spillerId = $('#legg-til-roster-select').value;
  if (!spillerId) return;
  if (state.roster.length >= 16) { toast('Rosteret har allerede 16 spillere.', 'error'); return; }

  const spiller = state.masterSpillere.find(s => s.id === spillerId);
  const kilde = $('#kvalifiseringsstatus-select').value;
  const begrunnelse = $('#wildcard-begrunnelse-input').value.trim() || null;

  await repo.leggTilIRoster(state.event.id, spillerId, {
    navn: spiller.navn, kvalifiseringsstatusKilde: kilde, wildcardBegrunnelse: begrunnelse,
  });
  toast(`${spiller.navn} lagt til i rosteret.`);
  await lastSpillereTab();
});

const STATUS_KILDE_LABEL = {
  returning_top8: 'Returning Top 8', qualifier_winner: 'Qualifier Winner',
  wildcard: 'Wildcard', admin_invite: 'Admin Invite',
};

function renderRosterListe() {
  $('#roster-teller').textContent = `(${state.roster.length}/16)`;
  $('#roster-liste').innerHTML = state.roster.map(r => `
    <div class="list-row">
      <div class="player-chip">
        <span class="initial-badge" style="background:${initialFarge(r.navn)}">${r.navn[0]}</span>
        <span>${escapeHtml(r.navn)}</span>
        ${r.puljeId ? `<span class="badge badge-muted">Pulje ${r.puljeId}</span>` : ''}
        ${r.qualifiedForNext ? '<span class="badge badge-active">QUALIFIED FOR NEXT EVENT</span>' : ''}
      </div>
      <span class="badge badge-accent">${STATUS_KILDE_LABEL[r.kvalifiseringsstatusKilde] ?? r.kvalifiseringsstatusKilde}</span>
    </div>
  `).join('') || '<p class="muted">Ingen spillere i rosteret ennå.</p>';
}

$('#trekk-puljer-btn').addEventListener('click', async () => {
  if (state.roster.length !== 16) { toast('Trenger nøyaktig 16 spillere i rosteret før puljetrekning.', 'error'); return; }
  if (!bekreft('Trekke nye puljer? Dette overskriver eventuell eksisterende puljeinndeling.')) return;

  const blandet = shuffle(state.roster.map(r => r.id));
  const puljeNavn = ['A', 'B', 'C', 'D'];
  const puljer = puljeNavn.map((navn, i) => ({
    id: navn, navn: `Pulje ${navn}`, spillerIds: blandet.slice(i * 4, i * 4 + 4),
  }));
  await repo.lagrePuljer(state.event.id, puljer);
  for (const p of puljer) {
    for (const spillerId of p.spillerIds) {
      await repo.flyttSpillerTilPulje(state.event.id, spillerId, p.id);
    }
  }
  state.puljer = puljer;
  toast('Puljer trukket.');
  renderPuljerVisning();
  await lastSpillereTab();
});

function renderPuljerVisning() {
  $('#puljer-visning').innerHTML = state.puljer.map(p => `
    <div class="card-inner" style="margin-bottom:8px;">
      <h3>Pulje ${p.id}</h3>
      ${p.spillerIds.map(id => {
        const spiller = state.roster.find(r => r.id === id);
        return `<span class="badge badge-muted" style="margin:2px;">${spiller ? escapeHtml(spiller.navn) : id}</span>`;
      }).join('')}
    </div>
  `).join('') || '<p class="muted">Ingen puljer trukket ennå.</p>';
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ----------------------------------------------------------------------------
// KAMPER-fanen (puljespill)
// ----------------------------------------------------------------------------

async function lastKamperTab() {
  if (!state.event) return;
  const generert = state.event.kampoppsettGenerertOgValidert === true;
  $('#generer-kampoppsett-btn').hidden = generert;
  $('#regenerer-kampoppsett-btn').hidden = !generert;
  $('#kampoppsett-status').textContent = generert
    ? 'Kampoppsett er generert og validert.'
    : 'Kampoppsett er ikke generert ennå.';

  $('#runde-tabs').innerHTML = [1, 2, 3, 4].map(r =>
    `<button class="tab-pill ${r === state.gjeldendeRundeVisning ? 'active' : ''}" data-runde="${r}">Runde ${r}</button>`
  ).join('');
  $$('#runde-tabs .tab-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      state.gjeldendeRundeVisning = Number(btn.dataset.runde);
      lastKamperTab();
    });
  });

  if (generert) {
    state.kamperIRunde = await repo.hentKamperForRunde(state.event.id, state.gjeldendeRundeVisning);
    renderKamperListe();
  } else {
    $('#kamper-liste').innerHTML = '';
  }
}

$('#generer-kampoppsett-btn').addEventListener('click', () => genererOgLagreKampoppsett());
$('#regenerer-kampoppsett-btn').addEventListener('click', async () => {
  if (!bekreft('Regenerere kampoppsettet? Alle registrerte puljespill-resultater slettes.')) return;
  await repo.slettPuljespillKamper(state.event.id);
  await genererOgLagreKampoppsett();
});

async function genererOgLagreKampoppsett() {
  if (state.puljer.length !== 4) { toast('Trekk puljer først.', 'error'); return; }
  const navnMap = Object.fromEntries(state.roster.map(r => [r.id, r.navn]));
  try {
    const kamper = genererKampoppsett({ puljer: state.puljer, disipliner: DISIPLINER, baner: BANER });
    const medNavn = kamper.map(k => ({
      ...k, spillerANavn: navnMap[k.spillerA] ?? k.spillerA, spillerBNavn: navnMap[k.spillerB] ?? k.spillerB,
    }));
    await repo.lagreKampoppsett(state.event.id, medNavn);
    toast('Kampoppsett generert og lagret.');
    await lastKamperTab();
  } catch (e) {
    console.error(e);
    toast('Kunne ikke generere et gyldig kampoppsett: ' + e.message, 'error');
  }
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
        <div class="btn-row" style="margin-bottom:8px;">
          <button class="btn btn-outline btn-small timer-start">Start timer</button>
          <button class="btn btn-outline btn-small timer-pause">Pause</button>
          <button class="btn btn-outline btn-small timer-reset">Reset</button>
          <button class="btn btn-outline btn-small sudden-death-btn">Sudden Death</button>
        </div>
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

  kort.querySelector('.timer-start')?.addEventListener('click', () =>
    repo.startTimer(state.event.id, k.id, KAMPVARIGHET_PULJESPILL_MIN * 60).then(() => toast('Timer startet.')));
  kort.querySelector('.timer-pause')?.addEventListener('click', () =>
    repo.pauseTimer(state.event.id, k.id, k.timer?.gjenstaendeSekunder ?? 0).then(() => toast('Timer pauset.')));
  kort.querySelector('.timer-reset')?.addEventListener('click', () =>
    repo.resetTimer(state.event.id, k.id, KAMPVARIGHET_PULJESPILL_MIN * 60).then(() => toast('Timer nullstilt.')));
  kort.querySelector('.sudden-death-btn')?.addEventListener('click', () => {
    if (!bekreft('Marker denne kampen som Sudden Death?')) return;
    repo.settSuddenDeath(state.event.id, k.id).then(() => toast('Sudden Death markert.'));
  });

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
    await repo.registrerPuljeResultat(state.event.id, k, { poengA: nyA, poengB: nyB, erOverstyring: true, rosterNavnMap: navnMap });
    toast('Resultat overstyrt.');
    await lastKamperTab();
  });
}

// ----------------------------------------------------------------------------
// SLUTTSPILL-fanen
// ----------------------------------------------------------------------------

async function lastSluttspillTab() {
  if (!state.event) return;
  const leaderboards = await repo.hentAlleLeaderboards(state.event.id);
  const rangeringPerPulje = Object.fromEntries(leaderboards.map(lb => [lb.puljeId, lb.rangering]));
  const alleFireKlare = ['A', 'B', 'C', 'D'].every(p => (rangeringPerPulje[p]?.length ?? 0) >= 2);

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
  if (fase === 'quarterfinal' || fase === 'semifinal' || fase === 'final') {
    lastOgVisSerier(fase);
  }
}

async function settOppKvartfinaler() {
  const leaderboards = await repo.hentAlleLeaderboards(state.event.id);
  const rangeringPerPulje = Object.fromEntries(leaderboards.map(lb => [lb.puljeId, lb.rangering]));
  const kvartfinaler = logikk.genererKvartfinaleOppsett(rangeringPerPulje);
  await repo.oppdaterEventFelt(state.event.id, { sluttspillFase: 'quarterfinal' });
  for (const qf of kvartfinaler) {
    await repo.leggTilSluttspillKamp(state.event.id, {
      runde: 5, fase: 'quarterfinal', serieId: qf.id, kampNrISerie: 1,
      bane: BANER.pickleball[0], disiplin: DISIPLINER[0],
      puljeId: null, spillerA: qf.spillerA, spillerB: qf.spillerB,
      spillerANavn: navnFraId(qf.spillerA), spillerBNavn: navnFraId(qf.spillerB),
    });
  }
  toast('Kvartfinaler satt opp.');
}

function navnFraId(id) {
  return state.roster.find(r => r.id === id)?.navn ?? id;
}

async function lastOgVisSerier(fase) {
  const kamper = await repo.hentKamperForFase(state.event.id, fase);
  const serier = {};
  for (const k of kamper) {
    serier[k.serieId] = serier[k.serieId] || [];
    serier[k.serieId].push(k);
  }

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
      if (Number.isNaN(poengA) || Number.isNaN(poengB) || poengA === poengB) {
        toast('Fyll inn to ulike poengsummer.', 'error'); return;
      }
      const uspilt = kampListe.find(k => k.status !== 'completed');
      if (!uspilt) { toast('Alle kamper i serien er allerede spilt.', 'error'); return; }
      await repo.registrerSluttspillResultat(state.event.id, uspilt.id, {
        poengA, poengB, spillerA: forste.spillerA, spillerB: forste.spillerB,
      });

      const oppdatertListe = [
        ...kampListe.filter(k => k.id !== uspilt.id),
        { ...uspilt, status: 'completed', poengA, poengB, vinnerId: poengA > poengB ? forste.spillerA : forste.spillerB },
      ];
      const nyStatus = logikk.beregnSerieStatus(forste.spillerA, forste.spillerB, oppdatertListe);
      if (!nyStatus.ferdig && nyStatus.trengerNesteOppgjor) {
        await repo.leggTilSluttspillKamp(state.event.id, {
          runde: uspilt.runde, fase: uspilt.fase, serieId,
          kampNrISerie: (uspilt.kampNrISerie ?? 1) + 1,
          bane: uspilt.bane, disiplin: uspilt.disiplin, puljeId: null,
          spillerA: forste.spillerA, spillerB: forste.spillerB,
          spillerANavn: forste.spillerANavn, spillerBNavn: forste.spillerBNavn,
        });
      }
      toast('Resultat lagret.');
      await lastOgVisSerier(fase);
    });
  });

  if (alleFerdige && Object.keys(serier).length > 0) {
    visGaVidereKnapp(fase, serier);
  }
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
      const status = logikk.beregnSerieStatus(forste.spillerA, forste.spillerB, kampListe);
      vinnere[serieId] = status.vinnerId;
    }
    const nesteFase = logikk.nesteSluttspillFase(fase);
    await repo.oppdaterEventFelt(state.event.id, { sluttspillFase: nesteFase });

    if (nesteFase === 'semifinal') {
      const semis = logikk.genererSemifinaleOppsett(vinnere);
      for (const s of semis) {
        await repo.leggTilSluttspillKamp(state.event.id, {
          runde: 6, fase: 'semifinal', serieId: s.id, kampNrISerie: 1,
          bane: BANER.pickleball[0], disiplin: DISIPLINER[0], puljeId: null,
          spillerA: s.spillerA, spillerB: s.spillerB,
          spillerANavn: navnFraId(s.spillerA), spillerBNavn: navnFraId(s.spillerB),
        });
      }
    } else if (nesteFase === 'final') {
      const finale = logikk.genererFinaleOppsett(vinnere, DISIPLINER);
      await repo.lagreSluttspillFase(state.event.id, 'final', finale);
      await repo.leggTilSluttspillKamp(state.event.id, {
        runde: 7, fase: 'final', serieId: 'FINAL', kampNrISerie: 1,
        bane: BANER[DISIPLINER[0]][0], disiplin: DISIPLINER[0], puljeId: null,
        spillerA: finale.spillerA, spillerB: finale.spillerB,
        spillerANavn: navnFraId(finale.spillerA), spillerBNavn: navnFraId(finale.spillerB),
      });
    }
    toast(`Videre til ${nesteFase}.`);
    await lastSluttspillTab();
  });
  $('#sluttspill-bracket').appendChild(knapp);
}

// ----------------------------------------------------------------------------
// LEADERBOARD-fanen
// ----------------------------------------------------------------------------

async function lastLeaderboardTab() {
  if (!state.event) return;
  const leaderboards = await repo.hentAlleLeaderboards(state.event.id);
  $('#leaderboard-visning').innerHTML = leaderboards.map(lb => `
    <div class="card">
      <h2>Pulje ${lb.puljeId}</h2>
      ${lb.rangering.map((r, i) => `
        <div class="list-row">
          <span>#${i + 1} ${escapeHtml(r.navn)} ${r.qualifisert ? '<span class="badge badge-active">QUALIFIED</span>' : ''}</span>
          <span class="mono muted2">${r.seire}S ${r.tap}T · ${r.poeng}p · ${r.poengforskjell > 0 ? '+' : ''}${r.poengforskjell}</span>
        </div>
      `).join('')}
    </div>
  `).join('') || '<p class="muted">Ingen leaderboard-data ennå — registrer et kampresultat først.</p>';
}

// ----------------------------------------------------------------------------
// HALL OF FAME-fanen
// ----------------------------------------------------------------------------

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
    kampSeire: 0, naddeFinale: true, vantEvent: true,
    eventId: state.event.id, plassering: '1', dato: state.event.dato ?? new Date().toISOString(),
  });
  await repo.oppdaterSpiller(spillerId, { stats: nyeStats });

  toast('Champion registrert i Hall of Fame.');
  await lastHallOfFameTab();
});

// ----------------------------------------------------------------------------

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
