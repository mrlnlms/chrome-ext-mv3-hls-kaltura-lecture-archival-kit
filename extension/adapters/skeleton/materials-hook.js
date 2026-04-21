// MAIN world. Roda em document_start, antes do framework da página carregar.
// Monkey-patcheia window.fetch e XMLHttpRequest.prototype.send para
// capturar responses do endpoint de materiais da plataforma.
//
// INSTRUÇÕES DE ADAPTAÇÃO:
// 1. Substitua HOST pelo host do API de materiais da sua plataforma.
// 2. Ajuste PATH_MATCH para o padrão de path do endpoint de materiais.
//
// NOTA: se chat-hook.js TAMBÉM patcha XMLHttpRequest.prototype.send,
// a ordem de content_scripts no manifest.json determina qual wrapper
// fica por último. Ambos, porém, capturam origOpen/origSend antes de
// modificá-los, então a cadeia preserva o comportamento nativo — o
// efeito final é apenas que alguns XHRs são rastreados por ambos os
// hooks (inofensivo) ou só pelo último registrado (benigno).
(function () {
  const HOST = "your-lms-api.example.com"; // TODO: substituir pelo host real
  const PATH_MATCH = /\/api\/v1\/Classes\/[^/]+/; // TODO: ajustar para o endpoint de materiais da sua plataforma

  /**
   * Verifica se a URL é do endpoint de materiais de interesse.
   * @param {string|null} url
   * @returns {boolean}
   */
  function matches(url) {
    return typeof url === "string" && url.indexOf(HOST) >= 0 && PATH_MATCH.test(url);
  }

  /**
   * Publica dados capturados via postMessage para o ISOLATED world (materials-bridge.js).
   * @param {*} data
   */
  function post(data) {
    window.postMessage(
      { __archivalKitMaterialsCapture: true, data },
      "*"
    );
    console.log(`[materials-hook] captured (len=${JSON.stringify(data).length})`);
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
      if (matches(url) && resp.ok) {
        resp
          .clone()
          .json()
          .then((d) => post(d))
          .catch(() => {});
      }
    } catch {}
    return resp;
  };
  window.fetch = wrappedFetch;

  const guard = setInterval(() => {
    if (window.fetch !== wrappedFetch) {
      console.log("[materials-hook] fetch foi substituído — reinstalando wrapper");
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
    this.__archivalKitMaterialsUrl = url;
    return origOpen.apply(this, arguments);
  };

  XHR.send = function () {
    if (matches(this.__archivalKitMaterialsUrl)) {
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
            return;
          }
          post(data);
        } catch (e) {
          console.warn("[materials-hook] XHR parse fail:", e);
        }
      });
    }
    return origSend.apply(this, arguments);
  };

  console.log("[materials-hook] fetch + XHR wrappers installed at", location.href);
})();
