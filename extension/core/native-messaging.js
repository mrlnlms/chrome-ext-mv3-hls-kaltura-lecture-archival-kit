// Cliente Chrome Native Messaging.
// Mantém o port vivo durante o download (service worker não morre enquanto
// houver um port aberto). Drena 300ms após 'done' pra absorver mensagens
// de progresso em trânsito antes de fechar.

const NATIVE_HOST_NAME = "com.your.host";
const DRAIN_MS = 300;

export function startDownload(request, onMessage, onError) {
  return new Promise((resolve, reject) => {
    let port;
    let done = false;
    let drainTimer = null;

    try {
      port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    } catch (e) {
      if (onError) onError(e);
      reject(e);
      return;
    }

    port.onMessage.addListener((msg) => {
      try {
        if (onMessage) onMessage(msg);
      } catch {}
      if (msg && msg.type === "done") {
        done = true;
        drainTimer = setTimeout(() => {
          try { port.disconnect(); } catch {}
          resolve(msg);
        }, DRAIN_MS);
      }
      if (msg && msg.type === "error") {
        done = true;  // para aqui
        drainTimer = setTimeout(() => {
          try { port.disconnect(); } catch {}
          reject(new Error(msg.message || "Host reported error"));
        }, DRAIN_MS);
      }
    });

    port.onDisconnect.addListener(() => {
      if (drainTimer) clearTimeout(drainTimer);
      if (!done) {
        const err = chrome.runtime.lastError;
        const msg = err ? err.message : "Native host disconnected";
        if (onError) onError(new Error(msg));
        reject(new Error(msg));
      }
    });

    try {
      port.postMessage(request);
    } catch (e) {
      if (onError) onError(e);
      reject(e);
    }
  });
}
