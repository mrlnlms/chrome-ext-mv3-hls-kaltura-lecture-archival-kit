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

// Convenção de status/ícone (mesma entre Multimídia e Materiais):
//   idle        ○   pré-clique (detectado mas ainda não começou a rodar)
//   pending     ⏳   job iniciado, aguardando a vez
//   downloading 📥   rodando agora
//   done        ✅   concluído
//   error       ❌   falhou
//   skipped     ⏭    pulado (MBX_SKIP_VIDEO ou dedup)
//   unavailable —   não disponível pra esta aula (ex: sem slides no player)
function iconFor(status) {
  switch (status) {
    case "done":        return "✅";
    case "downloading": return "📥";
    case "error":       return "❌";
    case "pending":     return "⏳";
    case "skipped":     return "⏭";
    case "unavailable": return "—";
    default:            return "○"; // idle
  }
}

// Ordem canônica dos items de multimídia.
const MM_ORDER = ["video", "sub_pt", "sub_en", "sub_es", "slides"];
const MM_LABELS = {
  video: "Vídeo",
  sub_pt: "Legenda PT",
  sub_en: "Legenda EN",
  sub_es: "Legenda ES",
  slides: "Slides",
};

function renderItem(list, label, status, errMsg, folder) {
  const li = document.createElement("li");
  li.className = status || "idle";
  const icon = document.createElement("span");
  icon.className = "icon";
  icon.textContent = iconFor(status);
  li.appendChild(icon);
  if (folder) {
    const f = document.createElement("span");
    f.className = "folder-hint";
    f.textContent = `[${folder}]`;
    li.appendChild(f);
  }
  const name = document.createElement("span");
  name.className = "label-name";
  name.title = errMsg || label;
  name.textContent = label;
  li.appendChild(name);
  list.appendChild(li);
}

// A lista de materiais pré-clique vem do state genérico `pendingMaterials`:
// `[{filename, folder}]`. Qualquer adapter que queira mostrar a preview pode
// popular essa chave assim que capturar a lista. O popup fica agnóstico ao
// shape específico do LMS.

function renderMultimedia(state) {
  const section = document.getElementById("multimedia-section");
  const list = document.getElementById("multimedia-list");
  const hasFlavors = Object.keys(state.flavors || {}).length > 0;
  if (!hasFlavors) {
    section.classList.remove("active");
    list.innerHTML = "";
    return;
  }

  const mm = state.download && state.download.multimedia ? state.download.multimedia : {};
  // Coleta chaves: as padrão (MM_ORDER) + qualquer extra que o adapter pré-popule.
  const keys = new Set([...MM_ORDER.slice(0, 3)]); // video + sub_pt + sub_en sempre aparecem
  for (const k of Object.keys(mm)) keys.add(k);

  const ordered = [...keys].sort((a, b) => {
    const ia = MM_ORDER.indexOf(a);
    const ib = MM_ORDER.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });

  list.innerHTML = "";
  for (const key of ordered) {
    const status = mm[key] || "idle";
    renderItem(list, MM_LABELS[key] || key, status);
  }
  section.classList.add("active");
}

function renderMaterialsUpfront(state) {
  const section = document.getElementById("materials-section");
  const list = document.getElementById("materials-list");
  const count = document.getElementById("materials-count");
  const d = state.download;

  list.innerHTML = "";
  let totalItems = 0;
  let doneItems = 0;

  // "Slides (do player)" é item especial — baseado em state.slidesUrl,
  // não vem da aba Materiais da plataforma.
  if (d && d.multimedia && d.multimedia.slides != null && d.multimedia.slides !== "unavailable") {
    renderItem(list, "Slides (do player)", d.multimedia.slides);
    totalItems++;
    if (d.multimedia.slides === "done") doneItems++;
  } else if (!d && state.slidesUrl) {
    renderItem(list, "Slides (do player)", "idle");
    totalItems++;
  }

  // Lista da aba Materiais: usa download.materials (pré-populado + atualizado
  // pelo host); pré-clique cai no walker JS com materials_raw.
  if (d && Array.isArray(d.materials) && d.materials.length) {
    for (const m of d.materials) {
      renderItem(list, m.filename || "(sem nome)", m.status || "pending", m.error, m.folder);
      totalItems++;
      if (m.status === "done") doneItems++;
    }
  } else if (!d && Array.isArray(state.pendingMaterials)) {
    // Pré-clique: lista vem do adapter via chave genérica state.pendingMaterials.
    for (const m of state.pendingMaterials) {
      renderItem(list, m.filename || "(sem nome)", "idle", null, m.folder);
      totalItems++;
    }
  }

  if (totalItems === 0) {
    section.classList.remove("active");
    count.textContent = "";
    return;
  }
  section.classList.add("active");
  count.textContent = d ? `(${doneItems}/${totalItems})` : `(${totalItems})`;
}

async function render() {
  try {
    const state = await loadState();
    if (!state) return;

    const flavorCount = Object.keys(state.flavors || {}).length;
    document.getElementById("flavor-count").textContent = String(flavorCount);
    document.getElementById("ks-status").textContent = state.ks ? "✓ captured" : "✗ missing";

    const dl = state.download;
    const btn = document.getElementById("download-btn");
    const canDownload = flavorCount > 0 && !!state.ks;
    const isRunning = dl && dl.status === "running";
    btn.disabled = !canDownload || isRunning;

    // Listas sempre renderizam (com status idle pré-clique).
    renderMultimedia(state);
    renderMaterialsUpfront(state);

    // Seção download só aparece durante/depois do download.
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
