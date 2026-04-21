// Registra listeners de webRequest para capturar chunks HLS e KS do Kaltura.
// Listeners precisam ser registrados no top-level do service worker — o MV3 SW
// pode ser morto e acordado, e o Chrome só reconecta event listeners que foram
// registrados sincronamente na inicialização.

import { StateManager } from "./state-manager.js";

// Padrão de URL dos segmentos HLS gerados pelo Kaltura (formato seg-N-v1-a1).
const CHUNK_URL_PATTERN = /\/seg-\d+-v1-a1\.ts(\?|$)/;

// Extrai o flavorId do path da URL do CDN do Kaltura.
const FLAVOR_ID_PATTERN = /\/flavorId\/([^/]+)\//;

/**
 * Tenta extrair o Kaltura Session token de uma URL.
 * Trata tanto query param (?ks=...) quanto path segment (/ks/.../).
 * Retorna null em vez de lançar em URLs malformadas.
 * @param {string} url
 * @returns {string|null}
 */
function extractKs(url) {
  try {
    const u = new URL(url);
    const fromQuery = u.searchParams.get("ks");
    if (fromQuery) return fromQuery;
    const m = u.pathname.match(/\/ks\/([^/]+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Registra os listeners de webRequest do core HLS/Kaltura.
 * Deve ser chamado uma única vez no top-level do service worker.
 */
export function registerHlsListeners() {
  // --- Listener 1: segmentos .ts do CDN -----------------------------------
  // Captura chunks HLS servidos pelo CDN do Kaltura. Extrai o flavorId do
  // path e guarda a URL do último chunk visto por flavor por aba.
  // Isso permite, depois, remontar o manifest HLS com as flavors disponíveis.

  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (details.tabId < 0) return;
      if (!CHUNK_URL_PATTERN.test(details.url)) return;

      const m = details.url.match(FLAVOR_ID_PATTERN);
      if (!m) return;

      const flavorId = m[1];
      const chunkUrl = details.url;

      // Serializa o update pra evitar race entre chunks de flavors distintos
      // chegando em paralelo pra mesma aba.
      StateManager.queueUpdate(async () => {
        const state = await StateManager.getTabState(details.tabId);
        state.flavors[flavorId] = chunkUrl;
        await StateManager.setTabState(details.tabId, state);
      });
    },
    { urls: ["https://cfvod.kaltura.com/*"] }
  );

  // --- Listener 2: KS em qualquer request *.kaltura.com -------------------
  // O KS aparece tanto em query params quanto em path segments dependendo do
  // endpoint. Capturamos o primeiro que passar e atualizamos se vier um novo.

  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (details.tabId < 0) return;

      const ks = extractKs(details.url);
      if (!ks) return;

      StateManager.patchTabState(details.tabId, {
        ks,
        ksUpdatedAt: Date.now(),
      });
    },
    { urls: ["https://*.kaltura.com/*"] }
  );
}
