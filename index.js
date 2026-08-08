// ============================================================================
// index.js — "16"  (Cloud Function-inngangspunkt)
//
// Dette er den ENESTE filen Firebase Functions kjører server-side. Den ligger
// flatt i repo-roten sammen med resten av appen (se firebase.json:
// "functions.source" er satt til "." — repo-roten — nettopp for å slippe en
// egen functions/-mappe). Skrevet som ES-modul (import/export) fordi
// package.json har "type":"module", som gjelder for HELE roten, inkludert
// denne filen.
//
// Eneste jobb: verifisere admin-PIN SERVER-SIDE (aldri i klienten) og sette
// `admin: true` som custom claim på den anonyme brukerens auth-token.
//
// Deploy:
//   firebase deploy --only functions:verifyAdminPin
//
// Før første deploy, sett PIN-hashen som en secret (IKKE i klartekst i kode
// eller i git):
//   firebase functions:secrets:set SEKSTEN_ADMIN_PIN_HASH
//   → lim inn SHA-256-hashen (hex) av ønsket PIN, f.eks. generert med:
//     node -e "console.log(require('crypto').createHash('sha256').update('1234').digest('hex'))"
//
// For å bytte PIN senere: kjør secrets:set på nytt med ny hash og deploy
// funksjonen igjen.
// ============================================================================

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import admin from 'firebase-admin';
import crypto from 'crypto';

admin.initializeApp();

const ADMIN_PIN_HASH = defineSecret('SEKSTEN_ADMIN_PIN_HASH');

export const verifyAdminPin = onCall({ secrets: [ADMIN_PIN_HASH] }, async (request) => {
  if (!request.auth) {
    throw new HttpsError(
      'unauthenticated',
      'Du må være logget inn (anonymt) før PIN kan verifiseres.'
    );
  }

  const pin = String(request.data?.pin ?? '');
  if (!pin) {
    return { ok: false, feil: 'Ingen PIN oppgitt.' };
  }

  const forventetHash = ADMIN_PIN_HASH.value();
  if (!forventetHash) {
    throw new HttpsError('failed-precondition', 'Admin-PIN er ikke konfigurert på serveren ennå.');
  }

  const innsendtHash = crypto.createHash('sha256').update(pin).digest('hex');

  // Tidskonstant sammenligning for å unngå timing-angrep.
  const buffere = [Buffer.from(innsendtHash, 'hex'), Buffer.from(forventetHash, 'hex')];
  const likLengde = buffere[0].length === buffere[1].length;
  const erLik = likLengde && crypto.timingSafeEqual(buffere[0], buffere[1]);

  if (!erLik) {
    return { ok: false, feil: 'Feil PIN.' };
  }

  await admin.auth().setCustomUserClaims(request.auth.uid, { admin: true });
  await admin.firestore().collection('seksten_admins').doc(request.auth.uid).set({
    tildelt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { ok: true };
});
