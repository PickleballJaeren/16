// ============================================================================
// testdata.js — "16"
//
// Realistiske testdata: 16 spillere med et "ferdighetsnivå" (kun brukt til å
// simulere plausible kampresultater i full-gjennomkjoring.test.js — feltet
// finnes ikke i den ekte datamodellen og skrives ALDRI til Firestore),
// fordelt i 4 puljer à 4, med variert kvalifiseringsstatusKilde slik at
// testen faktisk dekker alle fire admin-settbare statusene inkludert en
// wildcard med begrunnelse.
// ============================================================================

export const TESTSPILLERE = [
  { id: 'p1', navn: 'Kari Nordmann', skill: 82, kvalifiseringsstatusKilde: 'returning_top8', wildcardBegrunnelse: null },
  { id: 'p2', navn: 'Ola Hansen', skill: 74, kvalifiseringsstatusKilde: 'returning_top8', wildcardBegrunnelse: null },
  { id: 'p3', navn: 'Ingrid Solberg', skill: 68, kvalifiseringsstatusKilde: 'returning_top8', wildcardBegrunnelse: null },
  { id: 'p4', navn: 'Erik Johansen', skill: 61, kvalifiseringsstatusKilde: 'returning_top8', wildcardBegrunnelse: null },
  { id: 'p5', navn: 'Silje Andersen', skill: 77, kvalifiseringsstatusKilde: 'returning_top8', wildcardBegrunnelse: null },
  { id: 'p6', navn: 'Magnus Larsen', skill: 70, kvalifiseringsstatusKilde: 'returning_top8', wildcardBegrunnelse: null },
  { id: 'p7', navn: 'Emma Kristiansen', skill: 65, kvalifiseringsstatusKilde: 'returning_top8', wildcardBegrunnelse: null },
  { id: 'p8', navn: 'Jonas Pettersen', skill: 59, kvalifiseringsstatusKilde: 'returning_top8', wildcardBegrunnelse: null },
  { id: 'p9', navn: 'Nora Eriksen', skill: 71, kvalifiseringsstatusKilde: 'qualifier_winner', wildcardBegrunnelse: null },
  { id: 'p10', navn: 'Henrik Berg', skill: 66, kvalifiseringsstatusKilde: 'qualifier_winner', wildcardBegrunnelse: null },
  { id: 'p11', navn: 'Thea Haugen', skill: 63, kvalifiseringsstatusKilde: 'qualifier_winner', wildcardBegrunnelse: null },
  { id: 'p12', navn: 'Anders Moen', skill: 58, kvalifiseringsstatusKilde: 'qualifier_winner', wildcardBegrunnelse: null },
  { id: 'p13', navn: 'Maja Olsen', skill: 55, kvalifiseringsstatusKilde: 'qualifier_winner', wildcardBegrunnelse: null },
  { id: 'p14', navn: 'Fredrik Dahl', skill: 52, kvalifiseringsstatusKilde: 'qualifier_winner', wildcardBegrunnelse: null },
  { id: 'p15', navn: 'Sofie Jensen', skill: 48, kvalifiseringsstatusKilde: 'wildcard', wildcardBegrunnelse: 'Sterk lokal form siste halvår, fortjener en sjanse.' },
  { id: 'p16', navn: 'Lars Strand', skill: 45, kvalifiseringsstatusKilde: 'admin_invite', wildcardBegrunnelse: null },
];

export const TESTPULJER = [
  { id: 'A', navn: 'Pulje A', spillerIds: ['p1', 'p6', 'p11', 'p16'] },
  { id: 'B', navn: 'Pulje B', spillerIds: ['p2', 'p5', 'p12', 'p15'] },
  { id: 'C', navn: 'Pulje C', spillerIds: ['p3', 'p8', 'p9', 'p14'] },
  { id: 'D', navn: 'Pulje D', spillerIds: ['p4', 'p7', 'p10', 'p13'] },
];

export const TESTDISIPLINER = ['pickleball', 'skyball', 'speedminton'];
export const TESTBANER = {
  pickleball: ['Pickleball 1', 'Pickleball 2'],
  skyball: ['Skyball 1', 'Skyball 2'],
  speedminton: ['Speedminton 1', 'Speedminton 2'],
};

export function navnFraId(id) {
  return TESTSPILLERE.find(s => s.id === id)?.navn ?? id;
}

export function skillFraId(id) {
  return TESTSPILLERE.find(s => s.id === id)?.skill ?? 50;
}

export function puljeIdForSpiller(spillerId) {
  return TESTPULJER.find(p => p.spillerIds.includes(spillerId))?.id ?? null;
}

/** Enkel, seedet pseudo-tilfeldig generator (mulberry32) — deterministisk mellom kjøringer. */
export function seedetRng(seed) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
