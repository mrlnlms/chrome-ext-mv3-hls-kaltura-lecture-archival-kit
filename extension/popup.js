// Popup: stateless. Lê state da aba ativa de chrome.storage.session e renderiza.
// Cada 500ms re-renderiza pra refletir progresso do download.

let activeTabId = null;

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ? tab.id : null;
}

async function loadState() {
  if (activeTabId == null) {
    activeTabId = await getActiveTabId();
    if (activeTabId == null) return null;
  }
  const key = `tab:${activeTabId}`;
  return (await chrome.storage.session.get(key))[key] || {};
}

function formatSeconds(s) {
  if (s == null) return "—";
  const total = Math.floor(s);
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

async function render() {
  try {
    const state = await loadState();
    if (!state) return;

    const flavorCount = Object.keys(state.flavors || {}).length;
    document.getElementById("flavor-count").textContent = String(flavorCount);
    document.getElementById("ks-status").textContent = state.ks ? "✓ captured" : "✗ missing";

    const btn = document.getElementById("download-btn");
    const canDownload = flavorCount > 0 && !!state.ks;
    const isInProgress = state.download && ["starting", "selecting_flavor", "video"].includes(state.download.phase);
    btn.disabled = !canDownload || isInProgress;

    const dl = state.download;
    const section = document.getElementById("download-section");
    if (dl) {
      section.classList.add("active");
      document.getElementById("dl-phase").textContent = dl.phase;
      document.getElementById("dl-phase").className = "value phase" + (dl.phase === "error" ? " error" : dl.phase === "done" ? " done" : "");
      if (dl.phase === "video" && dl.progress) {
        document.getElementById("dl-progress").textContent = `${formatSeconds(dl.progress.elapsed_seconds)} @ ${dl.progress.speed != null ? dl.progress.speed + "x" : "—"}`;
      } else {
        document.getElementById("dl-progress").textContent = "—";
      }
      document.getElementById("dl-folder").textContent = dl.phase === "done" && dl.folder ? `Saved: ${dl.folder}` : "";
      document.getElementById("dl-error").textContent = dl.phase === "error" ? (dl.error || "Unknown error") : "";
    } else {
      section.classList.remove("active");
    }
  } catch (e) {
    console.error("[popup] render error:", e);
  }
}

document.getElementById("download-btn").addEventListener("click", async () => {
  if (activeTabId == null) activeTabId = await getActiveTabId();
  if (activeTabId == null) return;
  const btn = document.getElementById("download-btn");
  btn.disabled = true;
  try {
    const resp = await chrome.runtime.sendMessage({ type: "startDownload", tabId: activeTabId });
    if (!resp || !resp.ok) {
      // render() vai mostrar o erro vindo de state.download
      console.warn("[popup] startDownload responded:", resp);
    }
  } catch (e) {
    console.error("[popup] startDownload error:", e);
  }
});

render();
const refreshInterval = setInterval(render, 500);
window.addEventListener("unload", () => clearInterval(refreshInterval));
