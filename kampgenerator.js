// ============================================================================
// kampgenerator.js — "16"
//
// Ren, frittstående funksjon (ingen Firestore, ingen DOM) som genererer et
// gyldig kampoppsett for hovedeventets puljespill: 4 puljer à 4 spillere,
// 3 disipliner (2 baner hver = 6 baner totalt), 4 runder der hver pulje har
// nøyaktig én hvilerunde.
//
// Selv konstruksjonen er deterministisk riktig (se kommentarer under), men
// funksjonen validerer ALLTID sitt eget resultat mot de 7 reglene før den
// returnerer noe — "hvis et oppsett ikke er gyldig, skal appen ikke godkjenne
// det". Hvis validering skulle feile (f.eks. pga. fremtidig endring i
// konfigurasjonen som bryter forutsetningene), forsøker den på nytt med ny
// tilfeldig rekkefølge et begrenset antall ganger, og kaster til slutt en
// beskrivende feil i stedet for å returnere noe ugyldig.
//
// Brukes fra app.js slik:
//   import { genererKampoppsett } from './kampgenerator.js';
//   const kamper = genererKampoppsett({ puljer, disipliner, baner });
// ============================================================================

const SPILLERE_PER_PULJE = 4;
const MAKS_FORSOK = 30;

/**
 * @param {Array<{id:string, navn:string, spillerIds:string[]}>} puljer
 *   Nøyaktig 4 puljer, hver med nøyaktig 4 unike spiller-ID-er.
 * @param {string[]} disipliner
 *   Nøyaktig 3 disipliner, f.eks. ['pickleball','skyball','speedminton'].
 * @param {Object<string, [string,string]>} baner
 *   Bane-navn per disiplin, nøyaktig 2 per disiplin,
 *   f.eks. { pickleball: ['Pickleball 1','Pickleball 2'], ... }.
 * @returns {Array<{runde:number, fase:'pool', bane:string, disiplin:string,
 *                   puljeId:string, spillerA:string, spillerB:string}>}
 */
export function genererKampoppsett({ puljer, disipliner, baner }) {
  sjekkInputForm(puljer, disipliner, baner);

  let sisteFeil = null;
  for (let forsok = 0; forsok < MAKS_FORSOK; forsok++) {
    const kandidat = byggKandidatOppsett(puljer, disipliner, baner);
    const resultat = validerKampoppsett(kandidat, { puljer, disipliner, baner });
    if (resultat.gyldig) {
      return kandidat;
    }
    sisteFeil = resultat.feil;
  }

  throw new Error(
    'Kampgeneratoren klarte ikke å produsere et gyldig oppsett etter ' +
    MAKS_FORSOK + ' forsøk. Siste valideringsfeil: ' + JSON.stringify(sisteFeil)
  );
}

// ----------------------------------------------------------------------------
// Input-validering (form på input, ikke resultatet)
// ----------------------------------------------------------------------------

function sjekkInputForm(puljer, disipliner, baner) {
  if (!Array.isArray(puljer) || puljer.length < 2) {
    throw new Error('Kampgenerator: trenger minst 2 puljer, fikk ' + (puljer && puljer.length));
  }
  const antallPuljer = puljer.length;
  const forventetDisipliner = antallPuljer - 1;

  if (!Array.isArray(disipliner) || disipliner.length !== forventetDisipliner) {
    throw new Error(
      `Kampgenerator: med ${antallPuljer} puljer trengs nøyaktig ${forventetDisipliner} ` +
      `disipliner (én pulje hviler per runde, og rundene = antall puljer). Fikk ${disipliner && disipliner.length}.`
    );
  }

  for (const pulje of puljer) {
    if (!pulje.id || !Array.isArray(pulje.spillerIds)) {
      throw new Error('Kampgenerator: hver pulje trenger id og spillerIds. Ugyldig pulje: ' + JSON.stringify(pulje));
    }
    if (pulje.spillerIds.length !== SPILLERE_PER_PULJE) {
      throw new Error(`Kampgenerator: pulje ${pulje.id} har ${pulje.spillerIds.length} spillere, forventet ${SPILLERE_PER_PULJE}.`);
    }
    if (new Set(pulje.spillerIds).size !== SPILLERE_PER_PULJE) {
      throw new Error(`Kampgenerator: pulje ${pulje.id} har duplikate spiller-ID-er.`);
    }
  }

  for (const d of disipliner) {
    if (!Array.isArray(baner[d]) || baner[d].length !== 2) {
      throw new Error(`Kampgenerator: disiplin "${d}" må ha nøyaktig 2 baner i 'baner'-objektet.`);
    }
  }
}

// ----------------------------------------------------------------------------
// Konstruksjon av ett kandidatoppsett
//
// Metode (se docs/kampgenerator-notat.md for utledningen):
// - Puljene rester i rekkefølge N, N-1, ..., 1 (pulje-indeks i (0-basert)
//   hviler i runde (antallPuljer - i)). Dette gir nøyaktig regel 7 og matcher
//   rotasjonen i spesifikasjonen (A hviler sist, D hviler først).
// - Hver pulje spiller sine 3 aktive runder i kronologisk rekkefølge mot en
//   fast sekvens av disipliner, forskjøvet med puljens indeks
//   (offset = puljeIndeks mod antallDisipliner). Dette garanterer at hver
//   runde har tre AKTIVE puljer med tre FORSKJELLIGE disipliner (regel 4),
//   og at hver spiller får nøyaktig én kamp per disiplin (regel 2 og 6),
//   fordi hver puljes 3 aktive runder dekker alle 3 disipliner nøyaktig én
//   gang hver.
// - Innad i en pulje brukes "sirkelmetoden" for 4-spiller-runde-robin:
//   3 lokale runder, hver et perfekt matching-par av puljens 4 spillere,
//   som til sammen dekker alle 6 mulige par nøyaktig én gang (regel 1),
//   og gir hver spiller nøyaktig én kamp per lokal runde (regel 5).
//
// Tilfeldighet (rekkefølge på puljer inn i indeks 0..N-1, rotasjon på
// disiplinlisten, og hvilken spiller som er "anker" i sirkelmetoden per
// pulje) gjør at appen ikke returnerer et hardkodet oppsett — "Regenerer"
// i admin gir et nytt, like gyldig oppsett.
// ----------------------------------------------------------------------------

function byggKandidatOppsett(puljerInput, disiplinerInput, baner) {
  const antallPuljer = puljerInput.length;
  const antallDisipliner = disiplinerInput.length;

  // Tilfeldig rekkefølge på puljene bestemmer hvilken indeks (0..N-1) — og
  // dermed hvilken hvilerunde og hvilket disiplin-startpunkt — hver pulje får.
  const puljer = shuffle(puljerInput);

  // Tilfeldig rotasjon av disiplinrekkefølgen (samme rotasjon brukes for
  // alle puljer, så strukturen over holder uendret).
  const rotasjon = Math.floor(Math.random() * antallDisipliner);
  const disipliner = roter(disiplinerInput, rotasjon);

  const kamper = [];
  // Holder styr på hvilken (disiplin, bane-slot) som allerede er brukt av en
  // annen pulje i samme runde, slik at de to banene per disiplin fordeles
  // uten kollisjon.
  const baneSlotBrukt = {}; // key: `${runde}-${disiplin}` -> antall brukt (0,1)

  puljer.forEach((pulje, puljeIndeks) => {
    const hvilerunde = antallPuljer - puljeIndeks; // 1-indeksert runde
    const aktiveRunder = [];
    for (let r = 1; r <= antallPuljer; r++) {
      if (r !== hvilerunde) aktiveRunder.push(r);
    }
    aktiveRunder.sort((a, b) => a - b); // kronologisk

    const offset = puljeIndeks % antallDisipliner;
    const puljeDisiplinSekvens = roter(disipliner, offset); // lengde == antallDisipliner == aktiveRunder.length

    const spillere = shuffle(pulje.spillerIds); // tilfeldig "anker" for sirkelmetoden
    const [p0, p1, p2, p3] = spillere;
    // Sirkelmetoden for 4 spillere: 3 lokale runder = 3 perfekte matchinger.
    const lokaleRunder = [
      [[p0, p3], [p1, p2]],
      [[p0, p2], [p3, p1]],
      [[p0, p1], [p2, p3]],
    ];

    aktiveRunder.forEach((runde, lokalIndeks) => {
      const disiplin = puljeDisiplinSekvens[lokalIndeks];
      const [matchA, matchB] = lokaleRunder[lokalIndeks];

      for (const [spillerA, spillerB] of [matchA, matchB]) {
        const key = `${runde}-${disiplin}`;
        const slot = baneSlotBrukt[key] || 0;
        const bane = baner[disiplin][slot];
        baneSlotBrukt[key] = slot + 1;

        kamper.push({
          runde,
          fase: 'pool',
          disiplin,
          bane,
          puljeId: pulje.id,
          spillerA,
          spillerB,
        });
      }
    });
  });

  return kamper;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function roter(arr, n) {
  const i = ((n % arr.length) + arr.length) % arr.length;
  return arr.slice(i).concat(arr.slice(0, i));
}

// ----------------------------------------------------------------------------
// VALIDATOR — sjekker de 7 reglene eksplisitt mot et FERDIG kampoppsett.
// Stoler ikke på at konstruksjonen over var riktig; scanner det faktiske
// resultatet. Dette er funksjonen appen skal kalle før den noensinne lagrer
// et generert oppsett til Firestore.
// ----------------------------------------------------------------------------

export function validerKampoppsett(kamper, { puljer, disipliner, baner }) {
  const feil = [];

  sjekkRegel1AlleMoterAlle(kamper, puljer, feil);
  sjekkRegel2Og6EnKampPerDisiplin(kamper, puljer, disipliner, feil);
  sjekkRegel3AlleBanerBrukt(kamper, puljer, baner, feil);
  sjekkRegel4ToKamperPerDisiplinPerRunde(kamper, puljer, baner, feil);
  sjekkRegel5IngenSpillerToKamperSammeRunde(kamper, feil);
  sjekkRegel7EnHvilerundePerPulje(kamper, puljer, feil);

  return { gyldig: feil.length === 0, feil };
}

function allePar(spillerIds) {
  const par = [];
  for (let i = 0; i < spillerIds.length; i++) {
    for (let j = i + 1; j < spillerIds.length; j++) {
      par.push(parNokkel(spillerIds[i], spillerIds[j]));
    }
  }
  return par;
}

function parNokkel(a, b) {
  return [a, b].sort().join('|');
}

// Regel 1: Alle møter alle i sin pulje nøyaktig én gang.
function sjekkRegel1AlleMoterAlle(kamper, puljer, feil) {
  for (const pulje of puljer) {
    const forventedePar = new Set(allePar(pulje.spillerIds));
    const spilteKamper = kamper.filter(k => k.puljeId === pulje.id);
    const spiltePar = spilteKamper.map(k => parNokkel(k.spillerA, k.spillerB));

    const settSpilte = new Set(spiltePar);
    if (settSpilte.size !== spiltePar.length) {
      feil.push(`Regel 1: pulje ${pulje.id} har duplikate kamper mellom samme par.`);
    }
    for (const par of forventedePar) {
      if (!settSpilte.has(par)) {
        feil.push(`Regel 1: pulje ${pulje.id} mangler kamp mellom ${par}.`);
      }
    }
    if (spilteKamper.length !== forventedePar.size) {
      feil.push(`Regel 1: pulje ${pulje.id} har ${spilteKamper.length} kamper, forventet ${forventedePar.size}.`);
    }
  }
}

// Regel 2 + 6: Alle spiller nøyaktig én kamp i hver disiplin.
function sjekkRegel2Og6EnKampPerDisiplin(kamper, puljer, disipliner, feil) {
  const disiplinSett = new Set(disipliner);
  for (const pulje of puljer) {
    for (const spillerId of pulje.spillerIds) {
      const disiplinerSpilt = kamper
        .filter(k => k.puljeId === pulje.id && (k.spillerA === spillerId || k.spillerB === spillerId))
        .map(k => k.disiplin);

      if (disiplinerSpilt.length !== disipliner.length) {
        feil.push(`Regel 2/6: spiller ${spillerId} (pulje ${pulje.id}) har ${disiplinerSpilt.length} kamper, forventet ${disipliner.length}.`);
        continue;
      }
      const unike = new Set(disiplinerSpilt);
      if (unike.size !== disipliner.length) {
        feil.push(`Regel 2/6: spiller ${spillerId} (pulje ${pulje.id}) spiller ikke alle disipliner nøyaktig én gang: ${disiplinerSpilt.join(', ')}.`);
      }
      for (const d of disiplinerSpilt) {
        if (!disiplinSett.has(d)) {
          feil.push(`Regel 2/6: spiller ${spillerId} har kamp i ukjent disiplin "${d}".`);
        }
      }
    }
  }
}

// Regel 3: Hver runde bruker alle banene.
function sjekkRegel3AlleBanerBrukt(kamper, puljer, baner, feil) {
  const alleBaner = new Set(Object.values(baner).flat());
  const antallRunder = puljer.length;
  for (let runde = 1; runde <= antallRunder; runde++) {
    const banerIRunde = new Set(kamper.filter(k => k.runde === runde).map(k => k.bane));
    for (const bane of alleBaner) {
      if (!banerIRunde.has(bane)) {
        feil.push(`Regel 3: runde ${runde} bruker ikke banen "${bane}".`);
      }
    }
  }
}

// Regel 4: Riktig antall kamper per disiplin per runde (2 hver, ut fra baner.length).
function sjekkRegel4ToKamperPerDisiplinPerRunde(kamper, puljer, baner, feil) {
  const antallRunder = puljer.length;
  for (let runde = 1; runde <= antallRunder; runde++) {
    for (const disiplin of Object.keys(baner)) {
      const forventet = baner[disiplin].length;
      const antall = kamper.filter(k => k.runde === runde && k.disiplin === disiplin).length;
      if (antall !== forventet) {
        feil.push(`Regel 4: runde ${runde} har ${antall} ${disiplin}-kamper, forventet ${forventet}.`);
      }
    }
  }
}

// Regel 5: Ingen spiller har to kamper i samme runde.
function sjekkRegel5IngenSpillerToKamperSammeRunde(kamper, feil) {
  const perRunde = {};
  for (const k of kamper) {
    perRunde[k.runde] = perRunde[k.runde] || [];
    perRunde[k.runde].push(k.spillerA, k.spillerB);
  }
  for (const [runde, spillere] of Object.entries(perRunde)) {
    const sett = new Set();
    for (const s of spillere) {
      if (sett.has(s)) {
        feil.push(`Regel 5: spiller ${s} har mer enn én kamp i runde ${runde}.`);
      }
      sett.add(s);
    }
  }
}

// Regel 7: Puljene har én hvilerunde hver.
function sjekkRegel7EnHvilerundePerPulje(kamper, puljer, feil) {
  const antallRunder = puljer.length;
  for (const pulje of puljer) {
    const rundeMedKamp = new Set(kamper.filter(k => k.puljeId === pulje.id).map(k => k.runde));
    const hvilerunder = [];
    for (let r = 1; r <= antallRunder; r++) {
      if (!rundeMedKamp.has(r)) hvilerunder.push(r);
    }
    if (hvilerunder.length !== 1) {
      feil.push(`Regel 7: pulje ${pulje.id} har ${hvilerunder.length} hvilerunder, forventet nøyaktig 1 (fant: ${hvilerunder.join(',')}).`);
    }
  }
}
