// ============================================================================
// eventlogikk.test.js — "16"
// Kjøres med: node eventlogikk.test.js
// ============================================================================

import {
  erLovligOvergang,
  sjekkForutsetninger,
  kanGaTil,
  beregnPuljeRangering,
  bestemKvalifiserte,
  genererKvartfinaleOppsett,
  genererSemifinaleOppsett,
  genererFinaleOppsett,
  nesteSluttspillFase,
  beregnSerieStatus,
  oppdaterSpillerStats,
} from './eventlogikk.js';

let bestatt = 0, feilet = 0;

function test(navn, fn) {
  try { fn(); bestatt++; console.log(`✓ ${navn}`); }
  catch (e) { feilet++; console.error(`✗ ${navn}`); console.error(`  ${e.message}`); }
}
function assert(v, m) { if (!v) throw new Error(m || 'Assertion feilet'); }

// ----------------------------------------------------------------------------
// Status-maskin
// ----------------------------------------------------------------------------

test('kan gå ett steg fram i statuskjeden', () => {
  assert(erLovligOvergang('draft', 'registration_open'));
  assert(erLovligOvergang('main_event', 'playoffs'));
});

test('kan IKKE hoppe over statuser', () => {
  assert(!erLovligOvergang('draft', 'main_event'));
  assert(!erLovligOvergang('registration_open', 'playoffs'));
});

test('kan reversere fra registration_closed til registration_open, men ikke fra main_event', () => {
  assert(erLovligOvergang('registration_closed', 'registration_open'));
  assert(!erLovligOvergang('main_event', 'registration_closed'));
});

test('registration_closed krever nøyaktig 16 registrerte spillere', () => {
  const feil15 = sjekkForutsetninger('registration_closed', { antallRegistrerteSpillere: 15 });
  assert(!feil15.tillatt);
  const ok = sjekkForutsetninger('registration_closed', { antallRegistrerteSpillere: 16 });
  assert(ok.tillatt);
});

test('main_event krever 4 gyldige puljer OG validert kampoppsett', () => {
  const manglerOppsett = sjekkForutsetninger('main_event', {
    puljer: [{ id: 'A', spillerIds: ['1', '2', '3', '4'] }, { id: 'B', spillerIds: ['5', '6', '7', '8'] },
             { id: 'C', spillerIds: ['9', '10', '11', '12'] }, { id: 'D', spillerIds: ['13', '14', '15', '16'] }],
    kampoppsettGenerertOgValidert: false,
  });
  assert(!manglerOppsett.tillatt);

  const ok = sjekkForutsetninger('main_event', {
    puljer: [{ id: 'A', spillerIds: ['1', '2', '3', '4'] }, { id: 'B', spillerIds: ['5', '6', '7', '8'] },
             { id: 'C', spillerIds: ['9', '10', '11', '12'] }, { id: 'D', spillerIds: ['13', '14', '15', '16'] }],
    kampoppsettGenerertOgValidert: true,
  });
  assert(ok.tillatt);
});

test('playoffs krever at alle 24 puljespill-kamper er fullført', () => {
  const kamper = Array.from({ length: 24 }, (_, i) => ({ fase: 'pool', status: i < 20 ? 'completed' : 'scheduled' }));
  const resultat = sjekkForutsetninger('playoffs', { puljespillKamper: kamper });
  assert(!resultat.tillatt);
  assert(resultat.arsaker[0].includes('4'));

  const alleFerdige = kamper.map(k => ({ ...k, status: 'completed' }));
  assert(sjekkForutsetninger('playoffs', { puljespillKamper: alleFerdige }).tillatt);
});

test('kanGaTil kombinerer strukturell og forretningssjekk', () => {
  const resultat = kanGaTil('registration_open', 'registration_closed', { antallRegistrerteSpillere: 10 });
  assert(!resultat.tillatt);
  const ulovligHopp = kanGaTil('draft', 'playoffs', {});
  assert(!ulovligHopp.tillatt);
});

// ----------------------------------------------------------------------------
// Puljeranking
// ----------------------------------------------------------------------------

test('beregnPuljeRangering: poeng avgjør når det ikke er likt', () => {
  const spillere = ['S1', 'S2', 'S3', 'S4'];
  const kamper = [
    { spillerA: 'S1', spillerB: 'S2', poengA: 15, poengB: 10, vinnerId: 'S1', status: 'completed' },
    { spillerA: 'S3', spillerB: 'S4', poengA: 8, poengB: 15, vinnerId: 'S4', status: 'completed' },
  ];
  const rangering = beregnPuljeRangering(spillere, kamper);
  assert(rangering[0].spillerId === 'S1' || rangering[0].spillerId === 'S4', 'Forventet en vinner øverst');
  assert(rangering.find(r => r.spillerId === 'S1').poeng === 3);
  assert(rangering.find(r => r.spillerId === 'S2').poeng === 0);
});

test('beregnPuljeRangering: poengforskjell brukes som tie-break ved lik poengsum', () => {
  const spillere = ['S1', 'S2', 'S3', 'S4'];
  const kamper = [
    { spillerA: 'S1', spillerB: 'S3', poengA: 15, poengB: 5, vinnerId: 'S1', status: 'completed' }, // S1 diff +10
    { spillerA: 'S2', spillerB: 'S4', poengA: 12, poengB: 10, vinnerId: 'S2', status: 'completed' }, // S2 diff +2
  ];
  const rangering = beregnPuljeRangering(spillere, kamper);
  const s1 = rangering.find(r => r.spillerId === 'S1');
  const s2 = rangering.find(r => r.spillerId === 'S2');
  assert(s1.poeng === s2.poeng, 'begge skal ha 3 poeng her');
  assert(s1.rank < s2.rank, 'S1 skal rangeres over S2 pga. bedre poengforskjell');
});

test('beregnPuljeRangering: innbyrdes oppgjør avgjør ved lik poeng OG poengforskjell', () => {
  const spillere = ['S1', 'S2'];
  const kamper = [
    { spillerA: 'S1', spillerB: 'S2', poengA: 15, poengB: 10, vinnerId: 'S1', status: 'completed' },
  ];
  const rangering = beregnPuljeRangering(spillere, kamper);
  assert(rangering[0].spillerId === 'S1', 'S1 vant det direkte oppgjøret og skal rangeres først');
});

test('beregnPuljeRangering: manuell overstyring vinner over automatisk beregning', () => {
  const spillere = ['S1', 'S2', 'S3', 'S4'];
  const kamper = [
    { spillerA: 'S1', spillerB: 'S2', poengA: 15, poengB: 0, vinnerId: 'S1', status: 'completed' },
  ];
  const rangering = beregnPuljeRangering(spillere, kamper, ['S4', 'S3', 'S2', 'S1']);
  assert(rangering[0].spillerId === 'S4');
  assert(rangering.every(r => r.overstyrt === true));
});

test('bestemKvalifiserte: topp 2 fra hver pulje, 8 totalt', () => {
  const rangeringPerPulje = {
    A: [{ spillerId: 'A1' }, { spillerId: 'A2' }, { spillerId: 'A3' }, { spillerId: 'A4' }],
    B: [{ spillerId: 'B1' }, { spillerId: 'B2' }, { spillerId: 'B3' }, { spillerId: 'B4' }],
    C: [{ spillerId: 'C1' }, { spillerId: 'C2' }, { spillerId: 'C3' }, { spillerId: 'C4' }],
    D: [{ spillerId: 'D1' }, { spillerId: 'D2' }, { spillerId: 'D3' }, { spillerId: 'D4' }],
  };
  const kvalifiserte = bestemKvalifiserte(rangeringPerPulje);
  assert(kvalifiserte.length === 8);
  assert(kvalifiserte.every(k => k.qualifiedForNext === true));
  assert(kvalifiserte.filter(k => k.puljePlassering === 1).length === 4);
});

// ----------------------------------------------------------------------------
// Sluttspill-seeding
// ----------------------------------------------------------------------------

test('genererKvartfinaleOppsett følger spesifikasjonens pairing', () => {
  const rangeringPerPulje = {
    A: [{ spillerId: 'A1' }, { spillerId: 'A2' }],
    B: [{ spillerId: 'B1' }, { spillerId: 'B2' }],
    C: [{ spillerId: 'C1' }, { spillerId: 'C2' }],
    D: [{ spillerId: 'D1' }, { spillerId: 'D2' }],
  };
  const kvartfinaler = genererKvartfinaleOppsett(rangeringPerPulje);
  assert(kvartfinaler.length === 4);
  const qf1 = kvartfinaler.find(k => k.id === 'QF1');
  assert(qf1.spillerA === 'A1' && qf1.spillerB === 'B2', 'QF1 skal være puljevinner A mot nr. 2 i pulje B');
  const qf3 = kvartfinaler.find(k => k.id === 'QF3');
  assert(qf3.spillerA === 'C1' && qf3.spillerB === 'D2');
});

test('genererSemifinaleOppsett bruker krysspar (QF1+QF4, QF2+QF3) for å unngå pulje-rematch', () => {
  const semis = genererSemifinaleOppsett({ QF1: 'A1', QF2: 'B2', QF3: 'C1', QF4: 'D2' });
  const sf1 = semis.find(s => s.id === 'SF1');
  const sf2 = semis.find(s => s.id === 'SF2');
  assert(sf1.spillerA === 'A1' && sf1.spillerB === 'D2', 'SF1 skal være QF1 mot QF4');
  assert(sf2.spillerA === 'B2' && sf2.spillerB === 'C1', 'SF2 skal være QF2 mot QF3');
  const finale = genererFinaleOppsett({ SF1: 'A1', SF2: 'D2' }, ['pickleball', 'skyball', 'speedminton']);
  assert(finale.spillerA === 'A1' && finale.spillerB === 'D2');
});

test('nesteSluttspillFase går riktig vei og kaster feil ved enden', () => {
  assert(nesteSluttspillFase('none') === 'quarterfinal');
  assert(nesteSluttspillFase('quarterfinal') === 'semifinal');
  assert(nesteSluttspillFase('final') === 'completed');
  let kastet = false;
  try { nesteSluttspillFase('completed'); } catch { kastet = true; }
  assert(kastet, 'Skal kaste feil når man prøver å gå videre fra "completed"');
});

// ----------------------------------------------------------------------------
// Best-av-3-serielogikk
// ----------------------------------------------------------------------------

test('beregnSerieStatus: 2-0 avgjør serien uten en tredje kamp', () => {
  const status = beregnSerieStatus('A', 'B', [
    { vinnerId: 'A', status: 'completed' },
    { vinnerId: 'A', status: 'completed' },
  ]);
  assert(status.ferdig === true);
  assert(status.vinnerId === 'A');
  assert(status.trengerNesteOppgjor === false);
});

test('beregnSerieStatus: 1-1 krever en tredje/avgjørende kamp', () => {
  const status = beregnSerieStatus('A', 'B', [
    { vinnerId: 'A', status: 'completed' },
    { vinnerId: 'B', status: 'completed' },
  ]);
  assert(status.ferdig === false);
  assert(status.trengerNesteOppgjor === true);
});

// ----------------------------------------------------------------------------
// Spillerstatistikk
// ----------------------------------------------------------------------------

test('oppdaterSpillerStats akkumulerer additivt fra eksisterende stats', () => {
  const eksisterende = { antallEventer: 2, antallSeire: 5, antallFinaler: 1, antallEventseire: 0, sisteResultat: null };
  const nye = oppdaterSpillerStats(eksisterende, {
    kampSeire: 3, naddeFinale: true, vantEvent: true, eventId: 'ev9', plassering: '1', dato: '2026-08-01',
  });
  assert(nye.antallEventer === 3);
  assert(nye.antallSeire === 8);
  assert(nye.antallFinaler === 2);
  assert(nye.antallEventseire === 1);
  assert(nye.sisteResultat.eventId === 'ev9');
});

test('oppdaterSpillerStats fungerer for en helt ny spiller (ingen tidligere stats)', () => {
  const nye = oppdaterSpillerStats(null, { kampSeire: 1, naddeFinale: false, vantEvent: false, eventId: 'ev1', plassering: '9', dato: '2026-08-01' });
  assert(nye.antallEventer === 1);
  assert(nye.antallSeire === 1);
});

console.log(`\n${bestatt} bestått, ${feilet} feilet.`);
if (feilet > 0) process.exit(1);
