// MAIN world. Roda em document_start, antes do framework da página carregar.
// Monkey-patcheia window.fetch e XMLHttpRequest.prototype.send para
// capturar responses do chat API da plataforma.
//
// INSTRUÇÕES DE ADAPTAÇÃO:
// 1. Substitua HOST pelo host do chat API da sua plataforma.
// 2. Ajuste ENDPOINT_LABEL com os paths REST que carregam contexto inicial.
// 3. Se a plataforma usa SignalR/MessagePack binário, o decoder já foi
//    carregado via messagepack-decoder.js — use window.__archivalKit.messagePack.decode
//    onde você estiver interceptando os frames WebSocket (ver seção SignalR abaixo).
(function () {
  const HOST = "your-lms-chat-api.example.com"; // TODO: substituir pelo host real

  // Mapeamento de path REST → label semântico.
  // Ajuste os paths de acordo com os endpoints da sua plataforma.
  const ENDPOINT_LABEL = {
    "/Chat/Messages/Initial": "conversations",
    "/QA/Questions/Initial":  "questions",
    "/Chat/Messages/Pinned":  "pinned",
  };

  /**
   * Retorna o label semântico para uma URL, ou null se não for de interesse.
   * @param {string|null} url
   * @returns {string|null}
   */
  function labelFor(url) {
    if (!url || url.indexOf(HOST) < 0) return null;
    for (const pattern in ENDPOINT_LABEL) {
      if (url.indexOf(pattern) >= 0) return ENDPOINT_LABEL[pattern];
    }
    return null;
  }

  /**
   * Publica dados capturados via postMessage para o ISOLATED world (chat-bridge.js).
   * @param {string} label
   * @param {*} data
   */
  function post(label, data) {
    window.postMessage(
      { __archivalKitChatCapture: true, label, data },
      "*"
    );
    console.log(
      `[chat-hook] captured ${label} (len=${JSON.stringify(data).length})`
    );
  }

  // --- fetch wrapper --------------------------------------------------------
  // A página (Angular, React ou similar) pode reescrever window.fetch depois
  // de nós. Guardamos nosso wrapper e, nos primeiros 15s, reassinamos se for
  // trocado — garante que o hook sobreviva ao boot do framework.

  const origFetch = window.fetch;
  const wrappedFetch = async function (input, init) {
    const resp = await origFetch.apply(this, arguments);
    try {
      const url = typeof input === "string" ? input : input && input.url;
      const label = labelFor(url);
      if (label && resp.ok) {
        resp
          .clone()
          .json()
          .then((d) => post(label, d))
          .catch(() => {
            // Benigno: muitos chat-APIs retornam 0 bytes no REST;
            // os dados reais chegam via SignalR WebSocket binário (MessagePack).
          });
      }
    } catch {}
    return resp;
  };
  window.fetch = wrappedFetch;

  const guard = setInterval(() => {
    if (window.fetch !== wrappedFetch) {
      console.log("[chat-hook] fetch foi substituído — reinstalando wrapper");
      window.fetch = wrappedFetch;
    }
  }, 250);
  setTimeout(() => clearInterval(guard), 15000);

  // --- XHR wrapper ----------------------------------------------------------
  // Algumas libs usam XHR com responseType="json": responseText vem vazio e o
  // JSON já vem parseado em .response.

  const XHR = XMLHttpRequest.prototype;
  const origOpen = XHR.open;
  const origSend = XHR.send;

  XHR.open = function (method, url) {
    this.__archivalKitUrl = url;
    return origOpen.apply(this, arguments);
  };

  XHR.send = function () {
    const label = labelFor(this.__archivalKitUrl);
    if (label) {
      this.addEventListener("load", function () {
        if (this.status < 200 || this.status >= 300) return;
        try {
          let data;
          if (this.response != null && typeof this.response === "object") {
            data = this.response;
          } else if (typeof this.response === "string" && this.response) {
            data = JSON.parse(this.response);
          } else if ((this.responseText || "").length > 0) {
            data = JSON.parse(this.responseText);
          } else {
            // Benigno: endpoint REST retornou 0 bytes — dados chegam via
            // SignalR WebSocket binário (MessagePack).
            return;
          }
          post(label, data);
        } catch (e) {
          console.warn(`[chat-hook] XHR parse fail for ${label}:`, e);
        }
      });
    }
    return origSend.apply(this, arguments);
  };

  // --- WebSocket / SignalR --------------------------------------------------
  // Se a plataforma usa SignalR com protocolo MessagePack binário, cada
  // mensagem WebSocket chega como ArrayBuffer com varint-length prefix + frame.
  // O decoder já foi carregado por messagepack-decoder.js (injetado antes deste
  // script no manifest via content_scripts).
  //
  // TODO: para ativar, descomente e ajuste TARGET_TO_LABEL com os targets
  // SignalR da sua plataforma:
  //
  // const TARGET_TO_LABEL = {
  //   ReceiveMessage:     "conversations",
  //   ReceiveQuestion:    "questions",
  //   ReceivePinnedMsg:   "pinned",
  // };
  //
  // const origWS = window.WebSocket;
  //
  // function readVarint(b, off) {
  //   let v = 0, s = 0;
  //   for (let i = 0; i < 5; i++) {
  //     const x = b[off + i];
  //     v |= (x & 0x7f) << s;
  //     if ((x & 0x80) === 0) return [v >>> 0, off + i + 1];
  //     s += 7;
  //   }
  //   throw new Error("[chat-hook] varint > 5 bytes");
  // }
  //
  // function decodeSignalRFrames(bytes) {
  //   const mp = window.__archivalKit && window.__archivalKit.messagePack;
  //   if (!mp) { console.warn("[chat-hook] messagePack decoder não disponível"); return []; }
  //   const out = [];
  //   let off = 0;
  //   while (off < bytes.length) {
  //     const [frameLen, dataStart] = readVarint(bytes, off);
  //     const frameBytes = bytes.subarray(dataStart, dataStart + frameLen);
  //     out.push(mp.decode(frameBytes));
  //     off = dataStart + frameLen;
  //   }
  //   return out;
  // }
  //
  // function handleBinary(bytes) {
  //   let frames;
  //   try { frames = decodeSignalRFrames(bytes); }
  //   catch (e) { console.warn("[chat-hook] SignalR decode err:", e.message); return; }
  //   for (const f of frames) {
  //     if (!Array.isArray(f)) continue;
  //     const type = f[0];
  //     if (type === 6) continue; // ping
  //     if (type === 1 && typeof f[3] === "string") {
  //       const target = f[3];
  //       const args = f[4];
  //       const label = TARGET_TO_LABEL[target];
  //       if (label) post(label, Array.isArray(args) && args.length ? args[0] : null);
  //     }
  //   }
  // }
  //
  // function WrappedWS(url, protocols) {
  //   const ws = protocols ? new origWS(url, protocols) : new origWS(url);
  //   ws.addEventListener("message", (ev) => {
  //     if (ev.data instanceof ArrayBuffer) handleBinary(new Uint8Array(ev.data));
  //     else if (ev.data instanceof Blob)
  //       ev.data.arrayBuffer().then((buf) => handleBinary(new Uint8Array(buf)));
  //   });
  //   return ws;
  // }
  // WrappedWS.prototype = origWS.prototype;
  // WrappedWS.CONNECTING = origWS.CONNECTING;
  // WrappedWS.OPEN       = origWS.OPEN;
  // WrappedWS.CLOSING    = origWS.CLOSING;
  // WrappedWS.CLOSED     = origWS.CLOSED;
  // window.WebSocket = WrappedWS;

  console.log("[chat-hook] fetch + XHR wrappers installed at", location.href);
})();
