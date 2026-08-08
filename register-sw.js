// ============================================================================
// register-sw.js — "16"
// Plain script (ikke type="module") slik at den kan ligge helt øverst uten
// å vente på modul-graf-oppløsning — registrering skal skje så tidlig som
// mulig, uavhengig av om appens egne ES-moduler laster raskt eller ikke.
// ============================================================================
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('Service worker-registrering feilet (appen fungerer likevel, bare uten offline-støtte):', err);
    });
  });
}
