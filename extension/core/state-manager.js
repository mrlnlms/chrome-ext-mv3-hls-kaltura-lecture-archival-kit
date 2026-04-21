// Gerencia estado por aba em chrome.storage.session.
// Serializa updates concorrentes via promise chain — o storage session é
// assíncrono e não tem transação, então múltiplos patches simultâneos sem
// serialização dão race condition (leituras velhas sobrescrevem escritas novas).

const tabKey = (tabId) => `tab:${tabId}`;

// Estado padrão de uma aba nova.
const defaultState = () => ({
  flavors: {},        // { flavorId: lastChunkUrl } — flavors HLS vistos
  ks: null,           // Kaltura Session token
  ksUpdatedAt: null,  // timestamp da última captura do KS
  adapterState: {},   // campo livre pro adapter (Phase 3) guardar dados próprios
  metadata: null,     // { title, instructor, date } — preenchido pelo adapter
  download: null,     // { phase, progress, items: [...] } — estado do download
});

// Fila global de updates — garante que operações read-modify-write não
// colidam quando múltiplos eventos chegam em rápida sucessão.
let chain = Promise.resolve();

/**
 * Lê o estado da aba. Retorna defaultState se não houver nada salvo.
 * @param {number} tabId
 * @returns {Promise<object>}
 */
async function getTabState(tabId) {
  const k = tabKey(tabId);
  return (await chrome.storage.session.get(k))[k] || defaultState();
}

/**
 * Sobrescreve o estado completo da aba no storage.
 * @param {number} tabId
 * @param {object} state
 * @returns {Promise<void>}
 */
async function setTabState(tabId, state) {
  await chrome.storage.session.set({ [tabKey(tabId)]: state });
}

/**
 * Enfileira uma função na chain de updates para execução serial.
 * A função recebe nenhum argumento — ela deve fechar sobre tabId e patch.
 * Erros não quebram a chain (fn é passada como ambos then/catch).
 * @param {() => Promise<any>} fn
 * @returns {Promise<any>}
 */
function queueUpdate(fn) {
  chain = chain.then(fn, fn);
  return chain;
}

/**
 * Aplica um patch shallow no estado da aba de forma serializada.
 * @param {number} tabId
 * @param {object} patch
 * @returns {Promise<object>} estado resultante
 */
function patchTabState(tabId, patch) {
  return queueUpdate(async () => {
    const state = await getTabState(tabId);
    Object.assign(state, patch);
    await setTabState(tabId, state);
    return state;
  });
}

/**
 * Aplica um patch shallow em state.adapterState de forma serializada.
 * Mantém o adapterState isolado do core state — o adapter não toca
 * em flavors/ks/metadata/download diretamente.
 * @param {number} tabId
 * @param {object} patch
 * @returns {Promise<object>} estado resultante
 */
function patchAdapterState(tabId, patch) {
  return queueUpdate(async () => {
    const state = await getTabState(tabId);
    state.adapterState = { ...state.adapterState, ...patch };
    await setTabState(tabId, state);
    return state;
  });
}

export const StateManager = {
  getTabState,
  setTabState,
  queueUpdate,
  patchTabState,
  patchAdapterState,
};
