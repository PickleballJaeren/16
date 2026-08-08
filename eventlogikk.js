// ============================================================================
// eventlogikk.js — "16"
//
// Rene funksjoner (ingen Firestore, ingen DOM) for:
//   1. Status-maskinen: Draft → Registration Open → Registration Closed →
//      Main Event → Playoffs → Completed.
//   2. Puljeranking med de 4 tie-break-reglene (poeng, poengforskjell,
//      innbyrdes oppgjør, manuell admin-overstyring).
//   3. Kvalifisering til sluttspill (topp 2 fra hver pulje).
//   4. Seeding av kvartfinaler ut fra puljeplassering.
//   5. Best-av-3-serielogikk (brukes for kvartfinale, semifinale og finale).
//
// Admin-dashboardet (Fase 4) kaller disse funksjonene og gjør selve
// Firestore-skrivingen — denne filen tar bare beslutninger, den lagrer
// ingenting.
// ============================================================================

// ----------------------------------------------------------------------------
// 1. STATUS-MASKIN
// ----------------------------------------------------------------------------

export const STATUS_REKKEFOLGE = [
  'draft',
  'registration_open',
  'registration_closed',
  'main_event',
  'playoffs',
  'completed',
];

export const STATUS_VISNINGSNAVN = {
  draft: 'Draft',
  registration_open: 'Registration Open',
  registration_closed: 'Registration Closed',
  main_event: 'Main Event',
  playoffs: 'Playoffs',
  completed: 'Completed',
};

// Statuser man trygt kan reversere til (før kamper er generert/spilt).
// Fra "main_event" og utover ville tilbakegang gjøre allerede genererte
// kamper/resultater foreldreløse — bruk "regenerer oppsett" i stedet.
const REVERSERBARE_STATUSER = new Set(['draft', 'registration_open', 'registration_closed']);

function statusIndeks(status) {
  const i = STATUS_REKKEFOLGE.indexOf(status);
  if (i === -1) throw new Error(`Ukjent status: "${status}"`);
  return i;
}

/**
 * Sjekker om overgangen fra→til er strukturelt lovlig (ett steg fram, eller
 * ett steg tilbake fra en reverserbar status). Sjekker IKKE forretningsregler
 * (f.eks. "16 spillere registrert") — det gjør sjekkForutsetninger().
 */
export function erLovligOvergang(fraStatus, tilStatus) {
  const fra = statusIndeks(fraStatus);
  const til = statusIndeks(tilStatus);
  if (til === fra + 1) return true;
  if (til === fra - 1 && REVERSERBARE_STATUSER.has(fraStatus)) return true;
  return false;
}

/**
 * Sjekker forretningsregler (forutsetninger) for å gå TIL en gitt status.
 * `kontekst` inneholder det som trengs for akkurat den overgangen —
 * se de enkelte case-ene under for hva som forventes.
 *
 * Returnerer { tillatt: boolean, arsaker: string[] } — arsaker er tom hvis
 * tillatt er true.
 */
export function sjekkForutsetninger(tilStatus, kontekst = {}) {
  const arsaker = [];

  switch (tilStatus) {
    case 'registration_closed': {
      const antall = kontekst.antallRegistrerteSpillere ?? 0;
      if (antall !== 16) {
        arsaker.push(`Trenger nøyaktig 16 registrerte spillere, har ${antall}.`);
      }
      break;
    }
    case 'main_event': {
      const puljer = kontekst.puljer ?? [];
      if (puljer.length !== 4) {
        arsaker.push(`Trenger 4 puljer, har ${puljer.length}.`);
      }
      for (const p of puljer) {
        if (!p.spillerIds || p.spillerIds.length !== 4) {
          arsaker.push(`Pulje ${p.id ?? '?'} har ikke 4 spillere.`);
        }
      }
      if (!kontekst.kampoppsettGenerertOgValidert) {
        arsaker.push('Kampoppsettet for puljespillet er ikke generert og validert ennå.');
      }
      break;
    }
    case 'playoffs': {
      const kamper = (kontekst.puljespillKamper ?? []).filter(k => k.fase === 'pool');
      const uferdige = kamper.filter(k => k.status !== 'completed');
      if (kamper.length !== 24) {
        arsaker.push(`Forventet 24 puljespill-kamper, fant ${kamper.length}.`);
      }
      if (uferdige.length > 0) {
        arsaker.push(`${uferdige.length} puljespill-kamper mangler registrert resultat.`);
      }
      break;
    }
    case 'completed': {
      const finale = kontekst.finaleSerie;
      if (!finale || !finale.ferdig) {
        arsaker.push('Finalen er ikke avgjort ennå.');
      }
      break;
    }
    default:
      // draft, registration_open: ingen forretningsregler å sjekke.
      break;
  }

  return { tillatt: arsaker.length === 0, arsaker };
}

/**
 * Full sjekk: strukturelt lovlig OG forretningsreglene er oppfylt.
 */
export function kanGaTil(fraStatus, tilStatus, kontekst = {}) {
  if (!erLovligOvergang(fraStatus, tilStatus)) {
    return { tillatt: false, arsaker: [`Kan ikke gå direkte fra "${fraStatus}" til "${tilStatus}".`] };
  }
  const fremover = statusIndeks(tilStatus) > statusIndeks(fraStatus);
  if (!fremover) {
    return { tillatt: true, arsaker: [] }; // reversering har ingen forretningsregler
  }
  return sjekkForutsetninger(tilStatus, kontekst);
}

// ----------------------------------------------------------------------------
// 2. PULJERANKING
// ----------------------------------------------------------------------------

/**
 * Regner ut ranking for én pulje.
 *
 * @param {string[]} spillerIds - de 4 spillerne i puljen
 * @param {Array} fullforteKamper - kamper (fase='pool') for DENNE puljen med status='completed'
 * @param {string[]|null} manuellRekkefolge - hvis satt, overstyrer dette HELE
 *   rangeringen (administrator kan overstyre ved behov). Må inneholde alle
 *   spillerIds, i ønsket rekkefølge (best først).
 * @returns {Array<{spillerId, seire, tap, poeng, poengforskjell, rank, overstyrt}>}
 */
export function beregnPuljeRangering(spillerIds, fullforteKamper, manuellRekkefolge = null) {
  const stats = {};
  for (const id of spillerIds) {
    stats[id] = { spillerId: id, seire: 0, tap: 0, poeng: 0, poengforskjell: 0 };
  }

  for (const k of fullforteKamper) {
    if (k.status !== 'completed') continue;
    const aErVinner = k.vinnerId === k.spillerA;
    if (stats[k.spillerA]) {
      stats[k.spillerA].poengforskjell += (k.poengA - k.poengB);
      if (aErVinner) { stats[k.spillerA].seire++; stats[k.spillerA].poeng += 3; }
      else stats[k.spillerA].tap++;
    }
    if (stats[k.spillerB]) {
      stats[k.spillerB].poengforskjell += (k.poengB - k.poengA);
      if (!aErVinner) { stats[k.spillerB].seire++; stats[k.spillerB].poeng += 3; }
      else stats[k.spillerB].tap++;
    }
  }

  if (manuellRekkefolge) {
    const manglende = spillerIds.filter(id => !manuellRekkefolge.includes(id));
    if (manglende.length > 0) {
      throw new Error(`Manuell rekkefølge mangler spillere: ${manglende.join(', ')}`);
    }
    return manuellRekkefolge.map((id, i) => ({ ...stats[id], rank: i + 1, overstyrt: true }));
  }

  const innbyrdesVinner = (aId, bId) => {
    const oppgjor = fullforteKamper.find(
      k => (k.spillerA === aId && k.spillerB === bId) || (k.spillerA === bId && k.spillerB === aId)
    );
    if (!oppgjor) return 0;
    if (oppgjor.vinnerId === aId) return -1; // a foran b
    if (oppgjor.vinnerId === bId) return 1;
    return 0;
  };

  const sortert = Object.values(stats).sort((a, b) => {
    if (b.poeng !== a.poeng) return b.poeng - a.poeng;
    if (b.poengforskjell !== a.poengforskjell) return b.poengforskjell - a.poengforskjell;
    return innbyrdesVinner(a.spillerId, b.spillerId);
  });

  return sortert.map((s, i) => ({ ...s, rank: i + 1, overstyrt: false }));
}

/**
 * Topp 2 fra hver pulje kvalifiserer seg til sluttspillet (8 totalt).
 * @param {Object<string, Array>} rangeringPerPulje - puljeId -> resultat fra beregnPuljeRangering
 */
export function bestemKvalifiserte(rangeringPerPulje) {
  const kvalifiserte = [];
  for (const [puljeId, rangering] of Object.entries(rangeringPerPulje)) {
    rangering.slice(0, 2).forEach((spiller, i) => {
      kvalifiserte.push({ ...spiller, puljeId, puljePlassering: i + 1, qualifiedForNext: true });
    });
  }
  return kvalifiserte;
}

// ----------------------------------------------------------------------------
// 3. SLUTTSPILL-SEEDING
// ----------------------------------------------------------------------------

/**
 * Genererer kvartfinaleoppsettet ut fra puljevinnere/nr-2 slik spesifikasjonen
 * definerer det. Administrator kan endre oppsettet manuelt etterpå — dette er
 * kun forslaget/standardoppsettet.
 *
 * @param {Object<string,Array>} rangeringPerPulje - må ha nøklene 'A','B','C','D'
 */
export function genererKvartfinaleOppsett(rangeringPerPulje) {
  const vinner = (p) => rangeringPerPulje[p][0].spillerId;
  const nummerTo = (p) => rangeringPerPulje[p][1].spillerId;

  for (const p of ['A', 'B', 'C', 'D']) {
    if (!rangeringPerPulje[p] || rangeringPerPulje[p].length < 2) {
      throw new Error(`Mangler ranking for pulje ${p} — kan ikke seede kvartfinaler.`);
    }
  }

  return [
    { id: 'QF1', spillerA: vinner('A'), spillerB: nummerTo('B') },
    { id: 'QF2', spillerA: vinner('B'), spillerB: nummerTo('A') },
    { id: 'QF3', spillerA: vinner('C'), spillerB: nummerTo('D') },
    { id: 'QF4', spillerA: vinner('D'), spillerB: nummerTo('C') },
  ];
}

/**
 * Bracket-mapping fra kvartfinalevinnere til semifinaler: SF1 = QF1+QF4,
 * SF2 = QF2+QF3 (krysspar, ikke QF1+QF2/QF3+QF4).
 *
 * Hvorfor: QF1 (A-vinner/B-nr.2) og QF2 (B-vinner/A-nr.2) trekker begge KUN
 * fra puljene A og B — hadde de møttes i samme semifinale, kunne utfallet
 * blitt et rematch mellom to spillere fra samme pulje (f.eks. A1 mot A2).
 * Med krysspar (QF1+QF4 og QF2+QF3) trekker hver semifinale alltid fra alle
 * fire puljer, så et pulje-rematch i semifinalen er umulig uansett utfall i
 * kvartfinalene. Administrator kan fortsatt overstyre manuelt i admin-UI.
 */
export function genererSemifinaleOppsett(kvartfinaleVinnere) {
  const { QF1, QF2, QF3, QF4 } = kvartfinaleVinnere;
  if (!QF1 || !QF2 || !QF3 || !QF4) {
    throw new Error('Mangler én eller flere kvartfinalevinnere — kan ikke seede semifinaler.');
  }
  return [
    { id: 'SF1', spillerA: QF1, spillerB: QF4 },
    { id: 'SF2', spillerA: QF2, spillerB: QF3 },
  ];
}

export function genererFinaleOppsett(semifinaleVinnere, disiplinRekkefolge) {
  const { SF1, SF2 } = semifinaleVinnere;
  if (!SF1 || !SF2) {
    throw new Error('Mangler én eller begge semifinalevinnere — kan ikke seede finalen.');
  }
  return { id: 'FINAL', spillerA: SF1, spillerB: SF2, disiplinRekkefolge };
}

const SLUTTSPILL_REKKEFOLGE = ['none', 'quarterfinal', 'semifinal', 'final', 'completed'];

export function nesteSluttspillFase(gjeldendeFase) {
  const i = SLUTTSPILL_REKKEFOLGE.indexOf(gjeldendeFase);
  if (i === -1 || i === SLUTTSPILL_REKKEFOLGE.length - 1) {
    throw new Error(`Kan ikke gå videre fra sluttspillfase "${gjeldendeFase}".`);
  }
  return SLUTTSPILL_REKKEFOLGE[i + 1];
}

// ----------------------------------------------------------------------------
// 4. BEST-AV-3-SERIELOGIKK (kvartfinale, semifinale, finale)
// ----------------------------------------------------------------------------

/**
 * Regner ut status for en best-av-3-serie (kvart-/semifinale: 3 mulige
 * enkeltkamper; finale: 3 mulige disipliner). Første til 2 seire vinner
 * serien — trenger derfor ikke nødvendigvis 3 kamper spilt.
 *
 * @param {string} spillerA
 * @param {string} spillerB
 * @param {Array<{vinnerId:string, status:string}>} serieKamper - kampene/disiplinene spilt så langt i serien
 */
export function beregnSerieStatus(spillerA, spillerB, serieKamper) {
  const fullforte = serieKamper.filter(k => k.status === 'completed');
  const seireA = fullforte.filter(k => k.vinnerId === spillerA).length;
  const seireB = fullforte.filter(k => k.vinnerId === spillerB).length;

  let vinnerId = null;
  if (seireA === 2) vinnerId = spillerA;
  if (seireB === 2) vinnerId = spillerB;

  return {
    spillerA, spillerB,
    seireA, seireB,
    ferdig: vinnerId !== null,
    vinnerId,
    // Trengs en tredje/avgjørende kamp/disiplin?
    trengerNesteOppgjor: vinnerId === null && fullforte.length < 3,
  };
}

// ----------------------------------------------------------------------------
// 5. HALL OF FAME / SPILLERSTATISTIKK-OPPDATERING
// ----------------------------------------------------------------------------

/**
 * Bygger champion-recorden som skrives til seksten_champions når finalen
 * er avgjort. `tidligereAntallSeireTotalt` er champion-spillerens tidligere
 * antall event-seire (denormalisert teller), hentet fra seksten_spillere.
 */
export function byggChampionRecord({ spillerId, navn, eventNummer, eventId, dato, tidligereAntallSeireTotalt }) {
  return {
    spillerId,
    navn,
    eventNummer,
    eventId,
    dato,
    antallSeireTotalt: (tidligereAntallSeireTotalt ?? 0) + 1,
  };
}

/**
 * Regner ut nye aggregerte stats for én spiller basert på deres resultat i
 * eventet som nettopp ble fullført. Rene, additive oppdateringer — admin-
 * dashboardet skriver resultatet transaksjonelt til seksten_spillere.
 *
 * @param {Object} eksisterendeStats - spiller.stats fra før
 * @param {Object} eventResultat - { kampSeire, naddeFinale, vantEvent, plassering, eventId, dato }
 */
export function oppdaterSpillerStats(eksisterendeStats, eventResultat) {
  const s = eksisterendeStats ?? { antallEventer: 0, antallSeire: 0, antallFinaler: 0, antallEventseire: 0, sisteResultat: null };
  return {
    antallEventer: s.antallEventer + 1,
    antallSeire: s.antallSeire + (eventResultat.kampSeire ?? 0),
    antallFinaler: s.antallFinaler + (eventResultat.naddeFinale ? 1 : 0),
    antallEventseire: s.antallEventseire + (eventResultat.vantEvent ? 1 : 0),
    sisteResultat: { eventId: eventResultat.eventId, plassering: eventResultat.plassering, dato: eventResultat.dato },
  };
}
