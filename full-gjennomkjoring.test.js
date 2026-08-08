// ============================================================================
// full-gjennomkjoring.test.js — "16"
//
// Dette er IKKE en enhetstest av én funksjon — det er en fullstendig
// simulering av et helt "16"-event fra puljetrekning til champion, med de
// 16 realistiske testspillerne fra testdata.js. Den kjører gjennom EKSAKT
// samme rekkefølge som admin.js gjør i en ekte gjennomkjøring:
//
//   puljer (gitt) → kampoppsett (kampgenerator.js) → simulerte resultater →
//   puljeranking (eventlogikk.js) → kvalifiserte topp 8 → kvartfinaler →
//   semifinaler (krysspar) → finale → champion → oppdaterte spillerstats
//
// Formålet er å fange integrasjonsfeil mellom modulene som isolerte
// enhetstester i kampgenerator.test.js/eventlogikk.test.js ikke kan se.
//
// VIKTIG DESIGNVALG: kampgenerator.js randomiserer BEVISST både hvilken
// pulje som får hvilken hvilerunde/disiplinsekvens OG hvem som etiketteres
// spillerA/spillerB (se fase 2 — "ikke hardkodet oppsett"). Det betyr at
// selve kampoppsettets STRUKTUR er forskjellig hver gang genererKampoppsett
// kalles — et fast RNG-frø for poengsimuleringen alene kan derfor ALDRI gi
// samme champion hver gang. Riktig test er derfor: kjør HELE pipelinen
// flere ganger, og verifiser at strukturelle invarianter holder på HVER
// kjøring (samme filosofi som "50 uavhengige genereringer"-testen i
// kampgenerator.test.js), i stedet for å forvente ett bestemt utfall.
//
// Kjøres med: node full-gjennomkjoring.test.js
// ============================================================================

import { genererKampoppsett, validerKampoppsett } from './kampgenerator.js';
import {
  beregnPuljeRangering, bestemKvalifiserte, genererKvartfinaleOppsett,
  genererSemifinaleOppsett, genererFinaleOppsett, beregnSerieStatus,
  nesteSluttspillFase, byggChampionRecord, oppdaterSpillerStats,
  sjekkForutsetninger, kanGaTil,
} from './eventlogikk.js';
import { TESTSPILLERE, TESTPULJER, TESTDISIPLINER, TESTBANER, navnFraId, skillFraId, puljeIdForSpiller, seedetRng } from './testdata.js';

let bestatt = 0, feilet = 0;
function sjekk(vilkar, melding) {
  if (vilkar) { bestatt++; }
  else { feilet++; console.error(`✗ ${melding}`); }
}
function seksjon(tittel) {
  console.log(`\n${'='.repeat(70)}\n${tittel}\n${'='.repeat(70)}`);
}

function simulerKamp(rng, spillerA, spillerB) {
  const [forste, andre] = [spillerA, spillerB].sort();
  const skillForste = skillFraId(forste);
  const skillAndre = skillFraId(andre);
  const forsteVinner = rng() < skillForste / (skillForste + skillAndre);
  const vinnerScore = 15 + Math.floor(rng() * 7);
  const taperScore = Math.floor(rng() * (vinnerScore - 3));
  const vinnerId = forsteVinner ? forste : andre;
  return vinnerId === spillerA
    ? { poengA: vinnerScore, poengB: taperScore }
    : { poengA: taperScore, poengB: vinnerScore };
}

function simulerSerie(rng, spillerA, spillerB, fase, serieId, forsteRunde, forsteBane, forsteDisiplin) {
  const kamper = [];
  let seireA = 0, seireB = 0, i = 0;
  while (seireA < 2 && seireB < 2) {
    const { poengA, poengB } = simulerKamp(rng, spillerA, spillerB);
    const vinnerId = poengA > poengB ? spillerA : spillerB;
    if (vinnerId === spillerA) seireA++; else seireB++;
    kamper.push({
      id: `${serieId}-k${i + 1}`, runde: forsteRunde, fase, serieId, kampNrISerie: i + 1,
      bane: forsteBane, disiplin: forsteDisiplin, puljeId: null,
      spillerA, spillerB, status: 'completed', poengA, poengB, vinnerId,
    });
    i++;
  }
  const status = beregnSerieStatus(spillerA, spillerB, kamper);
  return { kamper, vinnerId: status.vinnerId, seireA, seireB };
}

function kjorFullGjennomkjoring(rngFroe, visRapport) {
  const rng = seedetRng(rngFroe);
  const rapport = (...args) => { if (visRapport) console.log(...args); };

  sjekk(kanGaTil('draft', 'registration_open', {}).tillatt, 'draft → registration_open skal være lovlig uten forutsetninger');
  sjekk(!sjekkForutsetninger('registration_closed', { antallRegistrerteSpillere: 12 }).tillatt, 'registration_closed skal AVVISES med færre enn 16 spillere');
  sjekk(sjekkForutsetninger('registration_closed', { antallRegistrerteSpillere: TESTSPILLERE.length }).tillatt, 'registration_closed skal TILLATES med nøyaktig 16 spillere');

  sjekk(!sjekkForutsetninger('main_event', { puljer: TESTPULJER, kampoppsettGenerertOgValidert: false }).tillatt, 'main_event skal AVVISES før kampoppsettet er generert');

  let kampoppsett;
  try {
    kampoppsett = genererKampoppsett({ puljer: TESTPULJER, disipliner: TESTDISIPLINER, baner: TESTBANER });
  } catch (e) {
    feilet++; console.error('✗ Kampgenerering feilet:', e.message);
    return null;
  }
  sjekk(kampoppsett.length === 24, `Forventet 24 puljespill-kamper, fikk ${kampoppsett.length}`);

  const valideringsresultat = validerKampoppsett(kampoppsett, { puljer: TESTPULJER, disipliner: TESTDISIPLINER, baner: TESTBANER });
  sjekk(valideringsresultat.gyldig, 'Det genererte kampoppsettet skal validere som gyldig mot alle 7 reglene: ' + JSON.stringify(valideringsresultat.feil));
  sjekk(sjekkForutsetninger('main_event', { puljer: TESTPULJER, kampoppsettGenerertOgValidert: true }).tillatt, 'main_event skal TILLATES etter validert kampoppsett');

  kampoppsett = kampoppsett
    .map((k, i) => ({ ...k, id: `pk${i + 1}` }))
    .sort((a, b) => {
      const parA = [a.spillerA, a.spillerB].sort().join('|');
      const parB = [b.spillerA, b.spillerB].sort().join('|');
      return a.runde - b.runde || a.puljeId.localeCompare(b.puljeId) || parA.localeCompare(parB);
    });
  const spilteKamper = kampoppsett.map(k => {
    const { poengA, poengB } = simulerKamp(rng, k.spillerA, k.spillerB);
    const vinnerId = poengA > poengB ? k.spillerA : k.spillerB;
    return { ...k, status: 'completed', poengA, poengB, vinnerId, poengforskjell: Math.abs(poengA - poengB) };
  });

  sjekk(
    !sjekkForutsetninger('playoffs', {
      puljespillKamper: spilteKamper.slice(0, 20).concat(spilteKamper.slice(20).map(k => ({ ...k, status: 'scheduled' }))),
    }).tillatt,
    'playoffs skal AVVISES hvis ikke alle 24 puljekamper er fullført'
  );
  sjekk(sjekkForutsetninger('playoffs', { puljespillKamper: spilteKamper }).tillatt, 'playoffs skal TILLATES når alle 24 puljekamper er fullført');

  const rangeringPerPulje = {};
  for (const pulje of TESTPULJER) {
    const kamperIPulje = spilteKamper.filter(k => k.puljeId === pulje.id);
    const rangering = beregnPuljeRangering(pulje.spillerIds, kamperIPulje);
    rangeringPerPulje[pulje.id] = rangering;

    sjekk(rangering.length === 4, `Pulje ${pulje.id}: rangering skal ha 4 spillere, har ${rangering.length}`);
    sjekk(kamperIPulje.length === 6, `Pulje ${pulje.id}: skal ha 6 kamper, har ${kamperIPulje.length}`);
    sjekk(rangering.reduce((s, r) => s + r.poeng, 0) === 18, `Pulje ${pulje.id}: total poengsum skal være 18`);

    if (visRapport) {
      rapport(`\nPulje ${pulje.id}:`);
      rangering.forEach((r, i) => rapport(`  #${i + 1} ${navnFraId(r.spillerId).padEnd(20)} ${r.seire}S-${r.tap}T  ${r.poeng}p  diff ${r.poengforskjell >= 0 ? '+' : ''}${r.poengforskjell}`));
    }
  }

  const kvalifiserte = bestemKvalifiserte(rangeringPerPulje);
  sjekk(kvalifiserte.length === 8, `Forventet 8 kvalifiserte, fikk ${kvalifiserte.length}`);
  sjekk(kvalifiserte.every(k => k.qualifiedForNext === true), 'Alle kvalifiserte skal ha qualifiedForNext=true');
  rapport('\nTOP 8 QUALIFIED:', kvalifiserte.map(k => navnFraId(k.spillerId)).join(', '));

  const kvartfinaler = genererKvartfinaleOppsett(rangeringPerPulje);
  sjekk(kvartfinaler.length === 4, `Forventet 4 kvartfinaler, fikk ${kvartfinaler.length}`);
  const qfVinnere = {};
  for (const qf of kvartfinaler) {
    const { kamper, vinnerId, seireA, seireB } = simulerSerie(rng, qf.spillerA, qf.spillerB, 'quarterfinal', qf.id, 5, TESTBANER.pickleball[0], TESTDISIPLINER[0]);
    qfVinnere[qf.id] = vinnerId;
    sjekk(kamper.length >= 2 && kamper.length <= 3, `${qf.id}: best-av-3-serie skal ha 2 eller 3 kamper`);
    sjekk(vinnerId === qf.spillerA || vinnerId === qf.spillerB, `${qf.id}: vinneren må være én av de to spillerne`);
    rapport(`${qf.id}: ${navnFraId(qf.spillerA)} vs ${navnFraId(qf.spillerB)} → ${navnFraId(vinnerId)} vant (${seireA}-${seireB})`);
  }
  sjekk(nesteSluttspillFase('quarterfinal') === 'semifinal', 'nesteSluttspillFase(quarterfinal) skal være semifinal');

  const semifinaler = genererSemifinaleOppsett(qfVinnere);
  sjekk(semifinaler.length === 2, `Forventet 2 semifinaler, fikk ${semifinaler.length}`);
  for (const sf of semifinaler) {
    const puljeA = puljeIdForSpiller(sf.spillerA);
    const puljeB = puljeIdForSpiller(sf.spillerB);
    sjekk(puljeA !== puljeB, `${sf.id}: ${navnFraId(sf.spillerA)} (pulje ${puljeA}) og ${navnFraId(sf.spillerB)} (pulje ${puljeB}) skal IKKE være fra samme pulje`);
  }
  const sfVinnere = {};
  for (const sf of semifinaler) {
    const { vinnerId, seireA, seireB } = simulerSerie(rng, sf.spillerA, sf.spillerB, 'semifinal', sf.id, 6, TESTBANER.pickleball[0], TESTDISIPLINER[0]);
    sfVinnere[sf.id] = vinnerId;
    rapport(`${sf.id}: ${navnFraId(sf.spillerA)} vs ${navnFraId(sf.spillerB)} → ${navnFraId(vinnerId)} vant (${seireA}-${seireB})`);
  }

  const finale = genererFinaleOppsett(sfVinnere, TESTDISIPLINER);
  sjekk(!!finale.spillerA && !!finale.spillerB, 'Finalen skal ha to spillere satt');
  const { kamper: finaleKamper, vinnerId: championId, seireA, seireB } = simulerSerie(rng, finale.spillerA, finale.spillerB, 'final', 'FINAL', 7, TESTBANER[TESTDISIPLINER[0]][0], TESTDISIPLINER[0]);
  sjekk(!!championId, 'Finalen skal ha en avgjort vinner');
  rapport(`Finale: ${navnFraId(finale.spillerA)} vs ${navnFraId(finale.spillerB)} → ${navnFraId(championId)} vant ${seireA}-${seireB}!`);

  const finaleSerieStatus = beregnSerieStatus(finale.spillerA, finale.spillerB, finaleKamper);
  sjekk(!sjekkForutsetninger('completed', { finaleSerie: { ferdig: false, vinnerId: null } }).tillatt, 'completed skal AVVISES før finalen er avgjort');
  sjekk(sjekkForutsetninger('completed', { finaleSerie: finaleSerieStatus }).tillatt, 'completed skal TILLATES etter avgjort finale');
  sjekk(nesteSluttspillFase('final') === 'completed', 'nesteSluttspillFase(final) skal være completed');

  const championRecord = byggChampionRecord({
    spillerId: championId, navn: navnFraId(championId),
    eventNummer: 1, eventId: 'test-event-1', dato: '2026-08-08', tidligereAntallSeireTotalt: 0,
  });
  sjekk(championRecord.antallSeireTotalt === 1, 'Ny champion skal ha antallSeireTotalt=1');
  const nyeStats = oppdaterSpillerStats(null, { kampSeire: 0, naddeFinale: true, vantEvent: true, eventId: 'test-event-1', plassering: '1', dato: '2026-08-08' });
  sjekk(nyeStats.antallEventseire === 1, 'Champion skal ha antallEventseire=1');
  sjekk(nyeStats.antallFinaler === 1, 'Champion skal ha antallFinaler=1');

  return { champion: navnFraId(championId) };
}

seksjon('FULL GJENNOMKJØRING #1 (detaljert rapport)');
sjekk(TESTSPILLERE.length === 16, `Testdata skal ha nøyaktig 16 spillere, har ${TESTSPILLERE.length}`);
const forsteResultat = kjorFullGjennomkjoring(20260101, true);
console.log(`\n🏆 CHAMPION: ${forsteResultat?.champion}`);

seksjon('YTTERLIGERE 9 UAVHENGIGE GJENNOMKJØRINGER (kun invariant-sjekk)');
const alleChampioner = [forsteResultat?.champion];
for (let i = 2; i <= 10; i++) {
  const resultat = kjorFullGjennomkjoring(20260100 + i, false);
  alleChampioner.push(resultat?.champion);
  console.log(`Kjøring #${i}: champion = ${resultat?.champion}`);
}
console.log(`\n(${new Set(alleChampioner).size} forskjellige championer på tvers av 10 kjøringer — forventet variasjon, siden kampoppsettet trekkes på nytt hver gang, jf. designvalget øverst i denne filen.)`);

seksjon('SAMMENDRAG');
console.log(`${bestatt} sjekker bestått, ${feilet} feilet, over 10 fulle gjennomkjøringer.`);
console.log(feilet === 0
  ? '\n✅ Full gjennomkjøring fullført uten feil på alle 10 kjøringer — kampgenerator.js og eventlogikk.js fungerer korrekt sammen for et realistisk 16-spiller-event, uansett hvilket gyldig kampoppsett generatoren trekker.'
  : '\n❌ Full gjennomkjøring fant feil — se ✗-linjene over.');

if (feilet > 0) process.exit(1);
