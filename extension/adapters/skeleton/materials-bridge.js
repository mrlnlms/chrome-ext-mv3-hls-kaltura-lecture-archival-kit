// ISOLATED world. Escuta postMessage emitido por materials-hook.js (MAIN world)
// e repassa ao service worker via chrome.runtime.sendMessage.
//
// É a única forma dos dois worlds se comunicarem — cada um tem seu próprio
// heap JS e não compartilha variáveis. O MAIN world escreve via postMessage,
// o ISOLATED world lê e encaminha para o background (service worker).
window.addEventListener("message", (e) => {
  // Ignora mensagens de outras janelas/frames.
  if (e.source !== window) return;
  if (!e.data || !e.data.__archivalKitMaterialsCapture) return;

  chrome.runtime.sendMessage({
    type: "adapterCapture",
    channel: "materials",
    data: e.data.data,
  }).catch(() => {
    // popup / service worker pode não estar escutando — silencioso, é esperado.
  });
});
