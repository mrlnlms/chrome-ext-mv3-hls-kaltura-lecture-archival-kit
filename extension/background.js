// Service worker MV3 — core genérico.
// Responsabilidades: captura por aba (flavors HLS + Kaltura session),
// storage de estado, ciclo de download via native messaging, mensageria
// com o popup. Tudo específico da plataforma (URLs institucionais,
// handlers custom, scrollback do chat, walker de materiais) fica no
// adapter, carregado via importScripts no final.

const CHUNK_URL_PATTERN = /\/seg-\d+-v1-a1\.ts(\?|$)/;
const FLAVOR_ID_PATTERN = /\/flavorId\/([^/]+)\//;

// Definidos pelo adapter (via apply-to-public-clone.sh) ou pelo skeleton.
// Skeleton usa valores genéricos pra o repo público funcionar out-of-the-box.
const NATIVE_HOST = "com.your.host";
const HARDCODED_DEST = "~/Downloads/kaltura-lectures";

// Ports vivas indexadas por tabId (pra evitar coletor matar service worker
// no meio de um download).
const liveDownloadPorts = new Map();

// Serializa updates concorrentes ao state (chrome.storage.session é async
// e sem transação — múltiplos updates em sequência rápida davam race).
let stateUpdateChain = Promise.resolve();
function queueStateUpdate(fn) {
  stateUpdateChain = stateUpdateChain.then(fn, fn);
  return stateUpdateChain;
}

// --- Listener 1: chunks .ts do CDN Kaltura (genérico) -----------------

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (!CHUNK_URL_PATTERN.test(details.url)) return;
    const m = details.url.match(FLAVOR_ID_PATTERN);
    if (!m) return;
    storeFlavorChunk(details.tabId, m[1], details.url);
  },
  { urls: ["https://cfvod.kaltura.com/*"] }
);

// --- Listener 2: ks em qualquer request *.kaltura.com (genérico) -------

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const ks = extractKs(details.url);
    if (!ks) return;
    storeKs(details.tabId, ks);
  },
  { urls: ["https://*.kaltura.com/*"] }
);

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

// --- Storage ----------------------------------------------------------

const tabKey = (tabId) => `tab:${tabId}`;

async function getTabState(tabId) {
  const k = tabKey(tabId);
  return (await chrome.storage.session.get(k))[k] || {
    flavors: {},
    ks: null,
    ksUpdatedAt: null,
    metadata: null,
    download: null,
  };
}

async function setTabState(tabId, state) {
  await chrome.storage.session.set({ [tabKey(tabId)]: state });
}

async function patchTabState(tabId, patch) {
  const state = await getTabState(tabId);
  Object.assign(state, patch);
  await setTabState(tabId, state);
  return state;
}

async function storeFlavorChunk(tabId, flavorId, chunkUrl) {
  const state = await getTabState(tabId);
  const isNew = !state.flavors[flavorId];
  state.flavors[flavorId] = chunkUrl;
  await setTabState(tabId, state);
  if (isNew) console.log(`[core] Tab ${tabId}: nova flavor ${flavorId}`);
}

async function storeKs(tabId, ks) {
  const state = await getTabState(tabId);
  if (state.ks === ks) return;
  state.ks = ks;
  state.ksUpdatedAt = new Date().toISOString();
  await setTabState(tabId, state);
  console.log(`[core] Tab ${tabId}: ks atualizado (len=${ks.length})`);
}

// --- Cleanup -----------------------------------------------------------

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(tabKey(tabId));
  const port = liveDownloadPorts.get(tabId);
  if (port) {
    try { port.disconnect(); } catch {}
    liveDownloadPorts.delete(tabId);
  }
});

// --- Mensagens do popup ------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "getState") {
    (async () => {
      const state = await getTabState(msg.tabId);
      sendResponse({ tabId: msg.tabId, state });
    })();
    return true;
  }
  if (msg.type === "download") {
    (async () => {
      try {
        await startDownload(msg.tabId);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }
  if (msg.type === "cancel") {
    (async () => {
      try {
        await cancelDownload(msg.tabId);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true;
  }
});

// --- Download via native messaging ------------------------------------

async function startDownload(tabId) {
  const state = await getTabState(tabId);
  const flavorUrls = Object.values(state.flavors || {});
  if (flavorUrls.length === 0) {
    throw new Error("Nenhuma flavor capturada — dê play no vídeo primeiro.");
  }
  if (state.download && state.download.status === "running") {
    throw new Error("Download já em curso pra esta aba.");
  }

  // Adapter pode disparar side effects antes do download (refresh
  // metadata, scrollback do chat, etc).
  if (self.adapter && typeof self.adapter.onBeforeDownload === "function") {
    try {
      await self.adapter.onBeforeDownload(tabId);
    } catch (e) {
      console.warn("[core] adapter.onBeforeDownload falhou:", e);
    }
  }

  const fresh = await getTabState(tabId);
  const title = buildTitle(fresh);

  const job = {
    chunks: flavorUrls,
    ks: fresh.ks,
    dest: HARDCODED_DEST,
    title,
  };

  // Adapter enriquece o job com campos específicos (chat, slides, etc).
  if (self.adapter && typeof self.adapter.buildJobExtras === "function") {
    try {
      Object.assign(job, self.adapter.buildJobExtras(fresh));
    } catch (e) {
      console.warn("[core] adapter.buildJobExtras falhou:", e);
    }
  }

  // Adapter define estado inicial de materials/multimedia; core usa
  // fallback seguro caso adapter não exponha.
  let prePopulated = { materials: [], multimedia: null };
  if (self.adapter && typeof self.adapter.prePopulateDownload === "function") {
    try {
      prePopulated = self.adapter.prePopulateDownload(fresh) || prePopulated;
    } catch (e) {
      console.warn("[core] adapter.prePopulateDownload falhou:", e);
    }
  }

  await patchTabState(tabId, {
    download: {
      status: "running",
      phase: "conectando",
      title,
      startedAt: new Date().toISOString(),
      materials: prePopulated.materials,
      multimedia: prePopulated.multimedia,
    },
  });
  notifyPopup(tabId);

  const port = chrome.runtime.connectNative(NATIVE_HOST);
  liveDownloadPorts.set(tabId, port);

  port.onMessage.addListener(async (msg) => {
    if (msg.type !== "progress") console.log(`[core] host msg:`, msg);
    if (msg.type === "phase") {
      await queueStateUpdate(async () => {
        const cur = await getTabState(tabId);
        await patchTabState(tabId, {
          download: { ...cur.download, phase: msg.msg },
        });
        notifyPopup(tabId);
      });
    } else if (msg.type === "progress") {
      await queueStateUpdate(async () => {
        const cur = await getTabState(tabId);
        await patchTabState(tabId, {
          download: {
            ...cur.download,
            progress: {
              elapsed: msg.elapsed,
              total: msg.total,
              pct: msg.pct,
              speed: msg.speed,
            },
          },
        });
        notifyPopup(tabId);
      });
    } else if (msg.type === "multimediaProgress") {
      await queueStateUpdate(async () => {
        const cur = await getTabState(tabId);
        const mm = { ...(cur.download?.multimedia || {}) };
        mm[msg.item] = msg.status;
        await patchTabState(tabId, {
          download: { ...cur.download, multimedia: mm },
        });
        notifyPopup(tabId);
      });
    } else if (msg.type === "materialsList") {
      await queueStateUpdate(async () => {
        const cur = await getTabState(tabId);
        if (!cur.download?.materials || cur.download.materials.length === 0) {
          const items = (msg.items || []).map((it) => ({
            folder: it.folder || "",
            filename: it.filename || "",
            status: "pending",
          }));
          await patchTabState(tabId, {
            download: { ...cur.download, materials: items },
          });
          notifyPopup(tabId);
        }
      });
    } else if (msg.type === "materialProgress") {
      await queueStateUpdate(async () => {
        const cur = await getTabState(tabId);
        const mats = (cur.download?.materials || []).slice();
        if (mats[msg.index]) {
          mats[msg.index] = {
            ...mats[msg.index],
            status: msg.status,
            error: msg.error || null,
          };
          await patchTabState(tabId, {
            download: { ...cur.download, materials: mats },
          });
          notifyPopup(tabId);
        }
      });
    } else if (msg.type === "done") {
      await queueStateUpdate(async () => {
        const cur = await getTabState(tabId);
        await patchTabState(tabId, {
          download: {
            ...cur.download,
            status: "done",
            phase: "concluído",
            path: msg.path,
            finishedAt: new Date().toISOString(),
          },
        });
        notifyPopup(tabId);
      });
    } else if (msg.type === "error") {
      await queueStateUpdate(async () => {
        const cur = await getTabState(tabId);
        await patchTabState(tabId, {
          download: {
            ...cur.download,
            status: "error",
            error: msg.message,
            finishedAt: new Date().toISOString(),
          },
        });
        notifyPopup(tabId);
      });
    }
  });

  port.onDisconnect.addListener(async () => {
    const lastError = chrome.runtime.lastError?.message;
    console.log(`[core] host disconnected (tab ${tabId}). lastError=${lastError}`);
    liveDownloadPorts.delete(tabId);
    const cur = await getTabState(tabId);
    if (cur.download && cur.download.status === "running") {
      await patchTabState(tabId, {
        download: {
          ...cur.download,
          status: "error",
          error: lastError || "host desconectou inesperadamente",
          finishedAt: new Date().toISOString(),
        },
      });
      notifyPopup(tabId);
    }
  });

  port.postMessage(job);
}

async function cancelDownload(tabId) {
  const state = await getTabState(tabId);
  if (!state.download || state.download.status !== "running") {
    throw new Error("Nenhum download em curso nessa aba.");
  }
  await patchTabState(tabId, {
    download: {
      ...state.download,
      status: "cancelled",
      phase: "cancelado",
      finishedAt: new Date().toISOString(),
    },
  });
  const port = liveDownloadPorts.get(tabId);
  if (port) {
    try { port.disconnect(); } catch {}
    liveDownloadPorts.delete(tabId);
  }
  notifyPopup(tabId);
}

function notifyPopup(tabId) {
  chrome.runtime.sendMessage({ type: "downloadUpdate", tabId }).catch(() => {});
}

function buildTitle(state) {
  const m = state.metadata;
  if (m && m.title) {
    const parts = [sanitizeFilename(m.title)];
    if (m.professor) parts.push(sanitizeFilename(m.professor));
    return parts.join(" - ");
  }
  return `lecture-${Date.now()}`;
}

function sanitizeFilename(s) {
  return String(s)
    .replace(/[\/\\:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// --- Carrega adapter ativo (último passo) ------------------------------
// No repo público o default é "adapters/skeleton/adapter-boot.js" (no-op).
// O apply-to-public-clone.sh patcha esta linha pra apontar pro adapter
// real copiado (ex: adapters/mbx/).

try {
  importScripts("adapters/skeleton/adapter-boot.js");
} catch (e) {
  console.warn("[core] adapter-boot não carregou:", e.message || e);
}

console.log("[core] service worker booted");
