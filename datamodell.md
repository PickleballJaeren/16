# "16" — Datamodell (Fase 1)

> **Scope-avklaring:** Appen håndterer kun **hovedeventet** (16 spillere,
> 4 puljer à 4). Kvalifiseringen (6 puljer à 4, sudden death, wildcard-tildeling
> til kvalifiseringen) skjer utenfor appen. Appen trenger likevel å vite
> *hvordan* hver av de 16 spillerne kom inn i hovedeventet — det feltet
> (`kvalifiseringsstatusKilde`: Returning Top 8 / Qualifier Winner / Wildcard /
> Admin Invite) beholdes uendret fra spesifikasjonen, siden det er en
> admin-satt tag på hovedevent-rosteret, ikke et resultat av intern
> puljespilling appen selv kjører.

Alle nye samlinger prefikses `seksten_` for å unngå kollisjon med de tre
andre appene i samme Firebase-prosjekt. Ingen Storage/`storage.rules` — appen
bruker ikke bilder.

Prinsippet gjennom hele modellen: **alt som skal listes er enten en
subcollection under et dokument man allerede har (event, spiller), eller et
ferdig-aggregert dokument** (leaderboard, live-status). Ingen sted leser vi en
hel toppnivå-samling og filtrerer i klienten.

---

## 1. `seksten_settings/app` (singleton)

Gjør eventnavn/tagline redigerbart uten å hardkode det i UI-koden.

```jsonc
{
  eventNavn: "16",
  tagline: "3 disipliner. 1 mester.",
  disipliner: ["pickleball", "skyball", "speedminton"],
  oppdatert: Timestamp
}
```

---

## 2. `seksten_spillere/{spillerId}` (toppnivå — spillere lever på tvers av eventer)

```jsonc
{
  navn: string,
  farge: string,          // hex, generert i UI for initial-badge — ikke opplastet
  aktiv: boolean,
  opprettet: Timestamp,
  stats: {                // denormalisert, oppdateres transaksjonelt når et event fullføres
    antallEventer: number,
    antallSeire: number,        // kampseire totalt, alle eventer
    antallFinaler: number,
    antallEventseire: number,   // ganger vunnet et helt event
    sisteResultat: { eventId: string, plassering: string, dato: Timestamp } | null
  }
}
```

### Subcollection: `seksten_spillere/{spillerId}/historikk/{eventId}`

Gjør at en spillerprofil kan hente *sin egen* historikk med én avgrenset
spørring, i stedet for å scanne `seksten_events`.

```jsonc
{
  eventNavn: string,
  dato: Timestamp,
  pulje: string,
  plasseringPulje: number,
  kvalifisert: boolean,
  sluttspillResultat: "quarterfinal" | "semifinal" | "final" | "winner" | null,
  poeng: number,
  seire: number,
  tap: number
}
```

---

## 3. `seksten_events/{eventId}` (toppnivå)

```jsonc
{
  navn: string,                 // f.eks. "16 – Event #7"
  eventNummer: number,          // sekvensiell, brukes i Hall of Fame
  status: "draft" | "registration_open" | "registration_closed"
        | "main_event" | "playoffs" | "completed",
  // Statusmaskinen fra spesifikasjonen droppet "Qualifier" som eget steg,
  // siden appen ikke lenger kjører selve kvalifiseringen — den skjer
  // utenfor appen, og resultatet kommer inn som kvalifiseringsstatusKilde
  // per spiller (se roster-subcollection under). Si ifra hvis du likevel
  // vil ha "Qualifier" som et rent informativt venteskritt i statusmaskinen.
  dato: Timestamp,
  opprettet: Timestamp,
  oppdatert: Timestamp,
  config: {
    antallPuljer: number,               // 4
    spillerePerPulje: number,           // 4
    kampVarighetPuljespillMin: number,  // 10
    kampVarighetSluttspillMin: number,  // 6 eller 7, admin-valgt
    disipliner: string[],               // ["pickleball","skyball","speedminton"]
    baner: string[]                     // 6 navngitte baner
  },
  gjeldendeRunde: number,
  sluttspillFase: "none" | "quarterfinal" | "semifinal" | "final" | "completed"
}
```

### Subcollection: `puljer/{puljeId}`

```jsonc
{ navn: "A", spillerIds: [string, string, string, string], ferdig: boolean }
```

### Subcollection: `spillere/{spillerId}` (event-scoped roster)

Denne (ikke toppnivå-`seksten_spillere`) er det admin jobber mot under
eventet — den bærer kvalifiseringskilde og pulje-plassering *for dette
eventet*, uten å røre master-spillerdokumentet.

```jsonc
{
  spillerId: string,          // ref til seksten_spillere
  navn: string,                // denormalisert, for rask visning
  puljeId: string,
  kvalifiseringsstatusKilde: "returning_top8" | "qualifier_winner"
                            | "wildcard" | "admin_invite",
  wildcardBegrunnelse: string | null,
  qualifiedForNext: boolean    // settes automatisk (topp 2) + kan overstyres manuelt
}
```

### Subcollection: `kamper/{kampId}`

```jsonc
{
  runde: number,
  fase: "pool" | "quarterfinal" | "semifinal" | "final",
  bane: string,
  disiplin: "pickleball" | "skyball" | "speedminton",
  puljeId: string | null,      // null i sluttspill
  spillerA: string, spillerANavn: string,
  spillerB: string, spillerBNavn: string,
  status: "scheduled" | "active" | "completed",
  poengA: number | null, poengB: number | null,
  vinnerId: string | null,
  poengforskjell: number | null,
  suddenDeath: boolean,
  overstyrtAvAdmin: boolean,
  timer: {
    status: "not_started" | "running" | "paused" | "finished",
    startetAt: Timestamp | null,
    gjenstaendeSekunder: number
  }
}
```

### Subcollection: `leaderboard/{puljeId}`

**Rå, atomisk oppdaterte tellere — IKKE en ferdig-sortert liste.** Endret fra
opprinnelig design: den sorterte rangeringen ble tidligere regnet ut og
skrevet i sin helhet ved hvert kampresultat, men det krevde å lese puljens
øvrige kamper først — et race-vindu når flere admin-enheter skriver samtidig
(appen deles nå mellom 2-3 admin-er). Løsningen: hver spillers tellere
oppdateres med Firestores atomiske `increment()` (aldri lest-og-skrevet-på-
nytt), og selve SORTERINGEN gjøres ved lesing, av
`eventlogikk.sorterSpillerStats()` — lesing har ikke noe race condition-
problem, kun skriving hadde det.

```jsonc
{
  puljeId: string,
  oppdatert: Timestamp,
  spillerStats: {   // spillerId -> rå tellere, oppdatert med increment()
    [spillerId]: {
      navn: string,
      seire: number, tap: number, poeng: number, poengforskjell: number
    }
  }
}
```

### Subcollection: `sluttspill/{fase}`  (`fase` = "quarterfinal" | "semifinal" | "final")

```jsonc
{
  kampIds: string[],         // peker inn i kamper-subcollection
  bestAvSeire: 2,             // "first to 2 wins" (best of 3)
  disiplinRekkefolge: string[] | null,  // kun for "final"
  vinnerId: string | null
}
```

---

## 4. `seksten_live/aktivEvent` (singleton, realtime-mål)

Det ENESTE dokumentet TV Mode / Courts lytter direkte på med `onSnapshot` for
å vite *hvilket* event/runde som er live — deretter en avgrenset spørring mot
det eventets `kamper`-subcollection (`where runde == gjeldende`, maks 6
treff).

```jsonc
{ eventId: string, gjeldendeRunde: number, sluttspillFase: string, oppdatert: Timestamp }
```

---

## 5. `seksten_champions/{championId}` (Hall of Fame, toppnivå — liten samling)

```jsonc
{
  spillerId: string, navn: string,
  eventNummer: number, eventId: string,
  dato: Timestamp,
  antallSeireTotalt: number   // denormalisert løpende teller
}
```

---

## 6. `seksten_admins/{uid}` — anbefalt, for ekte autentisering

Se anbefaling i eget avsnitt nedenfor. Dette dokumentet er kun en lesbar
oversikt over hvem som er admin — selve rettighetstildelingen skjer via
**custom claim** (`admin: true`) satt av en Cloud Function som verifiserer
PIN server-side, ikke av dette dokumentet alene.

```jsonc
{ navn: string, tildelt: Timestamp }
```

---

## Designvalg / avveininger jeg har tatt

- **Event-scoped roster (`events/{id}/spillere`) er separat fra
  master-spillere (`seksten_spillere`).** Dette lar en spiller ha ulik
  kvalifiseringsstatus per event uten å mutere permanente data, og betyr at
  "slett spiller fra event" aldri kan slette historikk ved et uhell.
- **Leaderboard er skrevet, ikke beregnet**, som krevd — oppdateres i samme
  batch som kampresultatet for å garantere konsistens (ingen race mellom
  "kamp lagret" og "leaderboard oppdatert").
- **`seksten_live/aktivEvent` er bevisst ett lite dokument**, slik at TV
  Mode/Courts aldri åpner en bred spørring — de følger denne pekeren og
  lytter deretter smalt.
- **Sudden death og timer ligger inne i kamp-dokumentet**, ikke i egen
  samling, siden det alltid leses/skrives sammen med kampen.

## Åpne spørsmål før jeg går videre

1. **Autentisering (viktig — se egen anbefaling):** Jeg anbefaler Firebase
   Anonymous Auth (alle brukere, spillere og admin, logges anonymt inn ved
   appstart) + en Cloud Function `verifyAdminPin(pin)` som setter
   `admin: true` som custom claim ved korrekt PIN. Alternativet — kun
   klient-sjekket PIN slik de tre andre appene gjorde det — betyr at *enhver*
   som åpner devtools kan skrive/overstyre resultater direkte mot Firestore,
   siden reglene da må være `allow write: if true`. Siden denne appen
   håndterer resultat-overstyring og hvem som går til sluttspill (ikke bare
   rating-visning), vil jeg bygge med ekte custom-claim-sjekk i reglene under.
   Cloud Function for PIN-verifisering bygges i Fase 4 (Admin-dashboard) —
   si ifra om du heller vil ha ren klient-PIN for enkelhets skyld, så justerer
   jeg reglene.
2. ~~Kvalifiseringspuljer i leaderboard~~ — avklart: kvalifiseringen er ikke
   en del av appen. Datamodellen over er oppdatert til å kun håndtere
   hovedeventet (16 spillere, 4 puljer à 4). `kvalifiseringsstatusKilde` på
   event-rosteret er beholdt uendret, siden det er en admin-satt tag som
   forteller *hvordan* spilleren kvalifiserte seg (avgjort utenfor appen),
   ikke et resultat appen selv regner ut.
