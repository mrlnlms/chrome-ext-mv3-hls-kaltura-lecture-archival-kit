// Popup: stateless. Lê o state da aba ativa de chrome.storage.session
// e renderiza. Re-render a cada 500ms enquanto aberto.

async function render() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    const key = `tab:${tab.id}`;
    const stored = (await chrome.storage.session.get(key))[key] || {};
    const flavorCount = Object.keys(stored.flavors || {}).length;
    document.getElementById("flavor-count").textContent = String(flavorCount);
    document.getElementById("ks-status").textContent = stored.ks ? "✓ captured" : "✗ missing";
  } catch (e) {
    console.error("[popup] render error:", e);
  }
}

render();
const refreshInterval = setInterval(render, 500);
window.addEventListener("unload", () => clearInterval(refreshInterval));
