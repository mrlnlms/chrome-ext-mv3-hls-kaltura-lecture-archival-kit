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

// Mapeia status → ícone. Cobre os estados que o host emite
// (multimedia_progress / material_progress / done / error) + os estados
// pré-populados pelo adapter ("pending", "unavailable").
const STATUS_ICON = {
  pending: "○",
  downloading: "⏳",
  done: "✅",
  error: "❌",
  skipped: "↷",
  unavailable: "—",
};

// Ordem canônica dos items de multimídia (video primeiro, depois subs por idioma,
// depois slides). Items não listados caem no fim preservando ordem de inserção.
const MM_ORDER = ["video", "sub_pt", "sub_en", "sub_es", "slides"];

const MM_LABELS = {
  video: "Vídeo",
  sub_pt: "Legenda PT",
  sub_en: "Legenda EN",
  sub_es: "Legenda ES",
  slides: "Slides",
};

function renderMultimedia(mm) {
  const section = document.getElementById("multimedia-section");
  const list = document.getElementById("multimedia-list");
  if (!mm || Object.keys(mm).length === 0) {
    section.classList.remove("active");
    list.innerHTML = "";
    return;
  }
  section.classList.add("active");

  const keys = Object.keys(mm).sort((a, b) => {
    const ia = MM_ORDER.indexOf(a);
    const ib = MM_ORDER.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });

  list.innerHTML = "";
  for (const key of keys) {
    const status = mm[key];
    const li = document.createElement("li");
    li.className = status;
    const icon = document.createElement("span");
    icon.className = "icon";
    icon.textContent = STATUS_ICON[status] || "?";
    const label = document.createElement("span");
    label.className = "label-name";
    label.textContent = MM_LABELS[key] || key;
    li.appendChild(icon);
    li.appendChild(label);
    list.appendChild(li);
  }
}

function renderMaterials(materials) {
  const section = document.getElementById("materials-section");
  const list = document.getElementById("materials-list");
  const count = document.getElementById("materials-count");
  if (!materials || materials.length === 0) {
    section.classList.remove("active");
    list.innerHTML = "";
    count.textContent = "";
    return;
  }
  section.classList.add("active");
  const done = materials.filter((m) => m.status === "done").length;
  count.textContent = `(${done}/${materials.length})`;

  list.innerHTML = "";
  for (const m of materials) {
    const li = document.createElement("li");
    li.className = m.status || "pending";
    const icon = document.createElement("span");
    icon.className = "icon";
    icon.textContent = STATUS_ICON[m.status] || STATUS_ICON.pending;
    li.appendChild(icon);

    if (m.folder) {
      const folder = document.createElement("span");
      folder.className = "folder-hint";
      folder.textContent = `[${m.folder}]`;
      li.appendChild(folder);
    }

    const name = document.createElement("span");
    name.className = "label-name";
    name.title = m.filename || "";
    name.textContent = m.filename || "(sem nome)";
    li.appendChild(name);
    list.appendChild(li);
  }
}

async function render() {
  try {
    const state = await loadState();
    if (!state) return;

    const flavorCount = Object.keys(state.flavors || {}).length;
    document.getElementById("flavor-count").textContent = String(flavorCount);
    document.getElementById("ks-status").textContent = state.ks ? "✓ captured" : "✗ missing";

    const btn = document.getElementById("download-btn");
    const dl = state.download;
    const canDownload = flavorCount > 0 && !!state.ks;
    const isInProgress = dl && dl.status === "running";
    btn.disabled = !canDownload || isInProgress;

    const section = document.getElementById("download-section");
    if (dl) {
      section.classList.add("active");
      document.getElementById("dl-phase").textContent = dl.phase || "—";
      document.getElementById("dl-phase").className =
        "value phase" +
        (dl.status === "error" ? " error" : dl.status === "done" ? " done" : "");

      if (dl.progress) {
        const elapsed = dl.progress.elapsed;
        const speed = dl.progress.speed;
        const speedText = speed != null ? speed + "x" : "—";
        document.getElementById("dl-progress").textContent = `${formatSeconds(elapsed)} @ ${speedText}`;
      } else {
        document.getElementById("dl-progress").textContent = "—";
      }

      renderMultimedia(dl.multimedia);
      renderMaterials(dl.materials);

      document.getElementById("dl-folder").textContent =
        dl.status === "done" && dl.path ? `Saved: ${dl.path}` : "";
      document.getElementById("dl-error").textContent =
        dl.status === "error" ? (dl.error || "Unknown error") : "";
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
      console.warn("[popup] startDownload responded:", resp);
    }
  } catch (e) {
    console.error("[popup] startDownload error:", e);
  }
});

render();
const refreshInterval = setInterval(render, 500);
window.addEventListener("unload", () => clearInterval(refreshInterval));
