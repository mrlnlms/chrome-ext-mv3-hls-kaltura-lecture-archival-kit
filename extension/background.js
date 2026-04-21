// Service worker do MV3. Ponto de entrada do core.
// Registra listeners de webRequest sincronamente — o MV3 SW pode ser morto
// a qualquer momento e precisa acordar nos eventos certos.

import { registerHlsListeners } from "./core/webrequest-hls.js";
import { StateManager } from "./core/state-manager.js";
import { startDownload } from "./core/native-messaging.js";

const DEFAULT_DEST = "~/Downloads/kaltura-lectures";

registerHlsListeners();

// Listener de mensagens do popup + adapter content scripts.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return;

  // Popup → "startDownload"
  if (message.type === "startDownload") {
    handleStartDownload(message.tabId)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // mantém o canal aberto para sendResponse assíncrono
  }

  // Adapter content scripts → "adapterCapture"
  if (message.type === "adapterCapture") {
    const tabId = sender && sender.tab && sender.tab.id;
    if (typeof tabId !== "number") return;
    if (message.channel === "metadata") {
      StateManager.patchTabState(tabId, { metadata: message.data });
    } else if (message.channel === "chat" || message.channel === "materials") {
      // chave composta: "chat_raw", "materials_pagina-1", etc.
      const key = `${message.channel}_${message.label || "raw"}`;
      StateManager.patchAdapterState(tabId, { [key]: message.data });
    }
    return;
  }
});

async function handleStartDownload(tabId) {
  const state = await StateManager.getTabState(tabId);

  // Valida pré-condições antes de acionar o host
  const chunks = Object.values(state.flavors || {});
  if (chunks.length === 0) {
    throw new Error("No HLS flavors captured — play the video for ~30s first");
  }
  if (!state.ks) {
    throw new Error("No Kaltura Session captured — reload the page and try again");
  }

  const title =
    (state.metadata && state.metadata.title) || `lecture-${tabId}-${Date.now()}`;

  const request = {
    chunks,
    ks: state.ks,
    dest: DEFAULT_DEST,
    title,
    metadata: state.metadata || null,
  };

  // Inicializa estado de download antes de acionar o host
  await StateManager.patchTabState(tabId, {
    download: { phase: "starting", progress: null, items: [] },
  });

  return await startDownload(
    request,
    async (msg) => {
      // Atualiza download state conforme mensagens do host chegam.
      // patchTabState usa queueUpdate internamente — burst de progress não corrompe.
      const current = await StateManager.getTabState(tabId);
      const download = current.download || { phase: "starting", progress: null, items: [] };

      if (msg.type === "progress") {
        download.phase = msg.phase || download.phase;
        if (msg.phase === "video") {
          download.progress = {
            elapsed_seconds: msg.elapsed_seconds,
            speed: msg.speed,
          };
        }
      } else if (msg.type === "done") {
        download.phase = "done";
        download.folder = msg.folder;
      } else if (msg.type === "error") {
        download.phase = "error";
        download.error = msg.message;
      }

      await StateManager.patchTabState(tabId, { download });
    },
    (err) => {
      // Erro de transporte (port desconectado, host não encontrado, etc.)
      StateManager.patchTabState(tabId, {
        download: { phase: "error", error: String(err) },
      });
    }
  );
}

console.log("[core] service worker booted");
