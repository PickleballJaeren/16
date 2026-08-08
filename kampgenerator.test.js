// ============================================================================
// kampgenerator.test.js — "16"
//
// Enkel, avhengighetsfri testrunner (ingen Jest/Mocha — konsistent med
// "ingen bundler, flat filstruktur"-prinsippet). Kjøres med:
//
//   node kampgenerator.test.js
//
// Avslutter med exit code 1 hvis noe feiler, slik at den kan brukes i CI.
// ============================================================================

import { genererKampoppsett, validerKampoppsett } from './kampgenerator.js';

let bestatt = 0;
let feilet = 0;

function test(navn, fn) {
  try {
    fn();
    bestatt++;
    console.log(`✓ ${navn}`);
  } catch (e) {
    feilet++;
    console.error(`✗ ${navn}`);
    console.error(`  ${e.message}`);
  }
}

function assert(vilkar, melding) {
  if (!vilkar) throw new Error(melding || 'Assertion feilet');
}

function assertKaster(fn, meldingInneholder) {
  try {
    fn();
  } catch (e) {
    if (meldingInneholder && !e.message.includes(meldingInneholder)) {
      throw new Error(`Kastet feil, men uventet melding: "${e.message}" (forventet å inneholde "${meldingInneholder}")`);
    }
    return;
  }
  throw new Error('Forventet at funksjonen skulle kaste en feil, men den gjorde ikke det.');
}

// ----------------------------------------------------------------------------
// Testdata: hovedeventets faktiske konfigurasjon (16 spillere, 4 puljer à 4)
// ----------------------------------------------------------------------------

function lagHovedeventPuljer() {
  return [
    { id: 'A', navn: 'Pulje A', spillerIds: ['A1', 'A2', 'A3', 'A4'] },
    { id: 'B', navn: 'Pulje B', spillerIds: ['B1', 'B2', 'B3', 'B4'] },
    { id: 'C', navn: 'Pulje C', spillerIds: ['C1', 'C2', 'C3', 'C4'] },
    { id: 'D', navn: 'Pulje D', spillerIds: ['D1', 'D2', 'D3', 'D4'] },
  ];
}

const disipliner = ['pickleball', 'skyball', 'speedminton'];
const baner = {
  pickleball: ['Pickleball 1', 'Pickleball 2'],
  skyball: ['Skyball 1', 'Skyball 2'],
  speedminton: ['Speedminton 1', 'Speedminton 2'],
};

// ----------------------------------------------------------------------------
// 1. Smoke test: genererer et gyldig oppsett for hovedeventets 16/4-oppsett
// ----------------------------------------------------------------------------

test('genererer et gyldig kampoppsett for hovedeventet (4 puljer à 4)', () => {
  const puljer = lagHovedeventPuljer();
  const kamper = genererKampoppsett({ puljer, disipliner, baner });

  assert(kamper.length === 24, `Forventet 24 kamper totalt (4 puljer × 6 kamper), fikk ${kamper.length}`);

  const resultat = validerKampoppsett(kamper, { puljer, disipliner, baner });
  assert(resultat.gyldig, 'Generert oppsett besto ikke egen validering: ' + JSON.stringify(resultat.feil));
});

// ----------------------------------------------------------------------------
// 2. Stress-test: siden generatoren bruker tilfeldighet, kjør mange ganger
// ----------------------------------------------------------------------------

test('50 uavhengige genereringer er ALLE gyldige (robusthet mot tilfeldighet)', () => {
  const puljer = lagHovedeventPuljer();
  for (let i = 0; i < 50; i++) {
    const kamper = genererKampoppsett({ puljer, disipliner, baner });
    const resultat = validerKampoppsett(kamper, { puljer, disipliner, baner });
    assert(resultat.gyldig, `Forsøk #${i} feilet: ${JSON.stringify(resultat.feil)}`);
  }
});

// ----------------------------------------------------------------------------
// 3. Sjekk hver av de 7 reglene eksplisitt mot ett generert oppsett
// ----------------------------------------------------------------------------

test('Regel 1: alle møter alle i sin pulje nøyaktig én gang', () => {
  const puljer = lagHovedeventPuljer();
  const kamper = genererKampoppsett({ puljer, disipliner, baner });
  for (const pulje of puljer) {
    const kamperIPulje = kamper.filter(k => k.puljeId === pulje.id);
    assert(kamperIPulje.length === 6, `Pulje ${pulje.id}: forventet 6 kamper, fikk ${kamperIPulje.length}`);
    const par = new Set(kamperIPulje.map(k => [k.spillerA, k.spillerB].sort().join('|')));
    assert(par.size === 6, `Pulje ${pulje.id}: forventet 6 unike par, fikk ${par.size}`);
  }
});

test('Regel 2/6: hver spiller får nøyaktig én kamp i hver disiplin', () => {
  const puljer = lagHovedeventPuljer();
  const kamper = genererKampoppsett({ puljer, disipliner, baner });
  for (const pulje of puljer) {
    for (const spillerId of pulje.spillerIds) {
      const spilt = kamper
        .filter(k => k.spillerA === spillerId || k.spillerB === spillerId)
        .map(k => k.disiplin);
      assert(spilt.length === 3, `Spiller ${spillerId}: forventet 3 kamper, fikk ${spilt.length}`);
      assert(new Set(spilt).size === 3, `Spiller ${spillerId}: disipliner ikke unike: ${spilt.join(',')}`);
    }
  }
});

test('Regel 3: hver runde bruker alle 6 banene', () => {
  const puljer = lagHovedeventPuljer();
  const kamper = genererKampoppsett({ puljer, disipliner, baner });
  const alleBaner = new Set(Object.values(baner).flat());
  for (let runde = 1; runde <= 4; runde++) {
    const banerBrukt = new Set(kamper.filter(k => k.runde === runde).map(k => k.bane));
    assert(banerBrukt.size === 6, `Runde ${runde}: ${banerBrukt.size} unike baner brukt, forventet 6`);
    for (const b of alleBaner) assert(banerBrukt.has(b), `Runde ${runde}: mangler bane ${b}`);
  }
});

test('Regel 4: 2 kamper per disiplin per runde', () => {
  const puljer = lagHovedeventPuljer();
  const kamper = genererKampoppsett({ puljer, disipliner, baner });
  for (let runde = 1; runde <= 4; runde++) {
    for (const d of disipliner) {
      const antall = kamper.filter(k => k.runde === runde && k.disiplin === d).length;
      assert(antall === 2, `Runde ${runde}, ${d}: ${antall} kamper, forventet 2`);
    }
  }
});

test('Regel 5: ingen spiller har to kamper i samme runde', () => {
  const puljer = lagHovedeventPuljer();
  const kamper = genererKampoppsett({ puljer, disipliner, baner });
  for (let runde = 1; runde <= 4; runde++) {
    const spillereIRunde = kamper.filter(k => k.runde === runde).flatMap(k => [k.spillerA, k.spillerB]);
    assert(new Set(spillereIRunde).size === spillereIRunde.length, `Runde ${runde}: en spiller har flere kamper`);
    assert(spillereIRunde.length === 12, `Runde ${runde}: forventet 12 spiller-opptredener (3 aktive puljer × 4), fikk ${spillereIRunde.length}`);
  }
});

test('Regel 7: hver pulje har nøyaktig én hvilerunde, og rotasjonen matcher spesifikasjonen', () => {
  const puljer = lagHovedeventPuljer();
  const kamper = genererKampoppsett({ puljer, disipliner, baner });
  for (const pulje of puljer) {
    const rundeMedKamp = new Set(kamper.filter(k => k.puljeId === pulje.id).map(k => k.runde));
    assert(rundeMedKamp.size === 3, `Pulje ${pulje.id}: spiller i ${rundeMedKamp.size} runder, forventet 3`);
  }
  // Nøyaktig én pulje hviler per runde, og ingen runde har 0 eller 2+ hvilende puljer.
  for (let runde = 1; runde <= 4; runde++) {
    const hvilende = puljer.filter(p => !kamper.some(k => k.puljeId === p.id && k.runde === runde));
    assert(hvilende.length === 1, `Runde ${runde}: ${hvilende.length} puljer hviler, forventet nøyaktig 1`);
  }
});

// ----------------------------------------------------------------------------
// 4. Ikke hardkodet: to genereringer skal (nesten alltid) gi ulikt resultat
// ----------------------------------------------------------------------------

test('genererer ikke identisk oppsett hver gang (ikke hardkodet)', () => {
  const puljer = lagHovedeventPuljer();
  const forste = genererKampoppsett({ puljer, disipliner, baner });
  let fantForskjell = false;
  for (let i = 0; i < 10 && !fantForskjell; i++) {
    const neste = genererKampoppsett({ puljer, disipliner, baner });
    const likt = JSON.stringify(forste) === JSON.stringify(neste);
    if (!likt) fantForskjell = true;
  }
  assert(fantForskjell, 'Fikk identisk oppsett i 10 forsøk på rad — mistenkelig, sjekk at shuffle faktisk kjører.');
});

// ----------------------------------------------------------------------------
// 5. Ugyldig input skal kaste en beskrivende feil, ikke returnere noe
// ----------------------------------------------------------------------------

test('kaster feil hvis en pulje har feil antall spillere', () => {
  const puljer = lagHovedeventPuljer();
  puljer[0].spillerIds = ['A1', 'A2', 'A3']; // kun 3
  assertKaster(() => genererKampoppsett({ puljer, disipliner, baner }), 'spillere');
});

test('kaster feil hvis antall disipliner ikke matcher antall puljer - 1', () => {
  const puljer = lagHovedeventPuljer();
  const feilDisipliner = ['pickleball', 'skyball']; // mangler speedminton
  assertKaster(() => genererKampoppsett({ puljer, disipliner: feilDisipliner, baner }), 'disipliner');
});

test('kaster feil hvis en pulje har duplikate spiller-ID-er', () => {
  const puljer = lagHovedeventPuljer();
  puljer[1].spillerIds = ['B1', 'B1', 'B3', 'B4'];
  assertKaster(() => genererKampoppsett({ puljer, disipliner, baner }), 'duplikate');
});

// ----------------------------------------------------------------------------
// 6. Validatoren skal faktisk fange feil i et bevisst korrupt oppsett
//    (tester at valideringen ikke bare alltid sier "gyldig")
// ----------------------------------------------------------------------------

test('validerKampoppsett fanger en manglende kamp (brudd på regel 1)', () => {
  const puljer = lagHovedeventPuljer();
  const kamper = genererKampoppsett({ puljer, disipliner, baner });
  const korrupt = kamper.slice(1); // fjern én kamp
  const resultat = validerKampoppsett(korrupt, { puljer, disipliner, baner });
  assert(!resultat.gyldig, 'Validering skulle ha feilet på et korrupt oppsett, men sa gyldig');
  assert(resultat.feil.some(f => f.includes('Regel 1')), 'Forventet minst én Regel 1-feilmelding');
});

test('validerKampoppsett fanger at en spiller har to kamper i samme runde (regel 5)', () => {
  const puljer = lagHovedeventPuljer();
  const kamper = genererKampoppsett({ puljer, disipliner, baner });
  const korrupt = kamper.map(k => ({ ...k }));
  // Tving en kollisjon: sett runde=1 på en kamp som opprinnelig var i runde 2,
  // slik at spillerne i den kampen nå har to kamper i runde 1.
  const kampFraRunde2 = korrupt.find(k => k.runde === 2);
  if (kampFraRunde2) kampFraRunde2.runde = 1;

  const resultat = validerKampoppsett(korrupt, { puljer, disipliner, baner });
  assert(!resultat.gyldig, 'Validering skulle ha feilet på dobbel-booket spiller');
});

test('validerKampoppsett fanger manglende bane-dekning i en runde (regel 3)', () => {
  const puljer = lagHovedeventPuljer();
  const kamper = genererKampoppsett({ puljer, disipliner, baner });
  const korrupt = kamper.map(k => ({ ...k }));
  const enKamp = korrupt.find(k => k.runde === 1);
  enKamp.bane = 'Pickleball 1'; // dupliser en bane i samme runde -> en annen bane blir ubrukt

  const resultat = validerKampoppsett(korrupt, { puljer, disipliner, baner });
  assert(!resultat.gyldig, 'Validering skulle ha feilet på ubrukt bane i en runde');
});

// ----------------------------------------------------------------------------

console.log(`\n${bestatt} bestått, ${feilet} feilet.`);
if (feilet > 0) process.exit(1);
