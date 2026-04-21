// ISOLATED world. Extrai metadata da aula do DOM e envia ao service worker.
//
// INSTRUÇÕES DE ADAPTAÇÃO:
// Cada LMS renderiza metadata em DOM de forma diferente. Adapte os seletores
// abaixo à estrutura da sua plataforma. Use DevTools → Elements → right-click
// → Copy selector pra gerar o seletor CSS de cada campo.
(function () {
  function scrapeMetadata() {
    // TODO: ajuste os seletores pra plataforma
    const titleEl = document.querySelector(".lecture-title");
    const instructorEl = document.querySelector(".instructor-name");
    const dateEl = document.querySelector(".lecture-date");
    return {
      title: titleEl?.textContent?.trim() || null,
      instructor: instructorEl?.textContent?.trim() || null,
      date: dateEl?.textContent?.trim() || null,
    };
  }

  function sendIfReady() {
    const m = scrapeMetadata();
    if (m.title) {
      chrome.runtime.sendMessage({
        type: "adapterCapture",
        channel: "metadata",
        data: m,
      }).catch(() => {
        // popup / service worker pode não estar escutando — silencioso, é esperado.
      });
      return true;
    }
    return false;
  }

  if (!sendIfReady()) {
    const obs = new MutationObserver(() => {
      if (sendIfReady()) obs.disconnect();
    });
    obs.observe(document.body, { childList: true, subtree: true });
    // Hard timeout: 15s — se o DOM não carregar o título até lá, desiste.
    setTimeout(() => obs.disconnect(), 15000);
  }
})();
