// Popup: mostra estado de captura da aba ativa + botão Baixar/Cancelar.
// Pede state ao SW via getState e re-renderiza em cada mensagem de update
// (downloadUpdate) que o background dispara.

const els = {
  flavorsCount: document.getElementById("flavors-count"),
  flavorsList: document.getElementById("flavors-list"),
  ksStatus: document.getElementById("ks-status"),
  metadataStatus: document.getElementById("metadata-status"),
  downloadBtn: document.getElementById("download-btn"),
  cancelBtn: document.getElementById("cancel-btn"),
  downloadStatus: document.getElementById("download-status"),
  multimediaSection: document.getElementById("multimedia-section"),
  multimediaList: document.getElementById("multimedia-list"),
  materialsSection: document.getElementById("materials-section"),
  materialsList: document.getElementById("materials-list"),
};

let currentTabId = null;

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    els.flavorsCount.textContent = "(sem aba ativa)";
    return;
  }
  currentTabId = tab.id;
  await refresh();

  els.downloadBtn.addEventListener("click", onClickDownload);
  els.cancelBtn.addEventListener("click", onClickCancel);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "downloadUpdate" && msg.tabId === currentTabId) {
      refresh();
    }
  });
})();

async function refresh() {
  const resp = await chrome.runtime.sendMessage({
    type: "getState",
    tabId: currentTabId,
  });
  const state = (resp && resp.state) || {};
  renderState(state);
}

function renderState(state) {
  const flavorIds = Object.keys(state.flavors || {});
  els.flavorsCount.innerHTML = flavorIds.length
    ? `<span class="ok">${flavorIds.length}</span>`
    : `<span class="empty">0</span>`;
  els.flavorsList.textContent = flavorIds.length
    ? flavorIds.join(", ")
    : "(dê play no vídeo)";

  els.ksStatus.innerHTML = state.ks
    ? `<span class="ok">✓ capturado</span> (len ${state.ks.length})`
    : `<span class="empty">✗ ausente</span>`;

  if (state.metadata && state.metadata.title) {
    const parts = [state.metadata.title];
    if (state.metadata.professor) parts.push(state.metadata.professor);
    els.metadataStatus.innerHTML = `<span class="ok">${escapeHtml(parts.join(" — "))}</span>`;
  } else {
    els.metadataStatus.innerHTML = `<span class="empty">(aguardando)</span>`;
  }

  renderDownload(state.download);
  renderMultimedia(state);
  renderMaterialsUpfront(state);

  const isRunning = state.download && state.download.status === "running";
  const hasFlavors = flavorIds.length > 0;
  // Em running, some o Baixar e aparece o Cancelar. Nos outros estados o
  // Baixar volta (permite re-tentar depois de erro/cancel/done).
  els.downloadBtn.style.display = isRunning ? "none" : "";
  els.cancelBtn.style.display = isRunning ? "" : "none";
  els.cancelBtn.disabled = false;
  els.cancelBtn.textContent = "Cancelar";
  els.downloadBtn.disabled = !hasFlavors || !state.ks;
  els.downloadBtn.textContent = hasFlavors ? "Baixar" : "Aguardando captura…";
}

function renderDownload(d) {
  if (!d) {
    els.downloadStatus.style.display = "none";
    els.downloadStatus.className = "download-status";
    return;
  }
  els.downloadStatus.style.display = "block";

  if (d.status === "running") {
    els.downloadStatus.className = "download-status";
    els.downloadStatus.innerHTML =
      `<div class="phase">⏳ ${escapeHtml(d.phase || "…")}</div>` +
      `<div class="path">${escapeHtml(d.title || "")}</div>` +
      renderProgress(d);
  } else if (d.status === "done") {
    els.downloadStatus.className = "download-status done";
    els.downloadStatus.innerHTML =
      `<div class="phase">✓ Concluído</div>` +
      `<div class="path">${escapeHtml(d.path || "")}</div>`;
  } else if (d.status === "error") {
    els.downloadStatus.className = "download-status error";
    els.downloadStatus.innerHTML =
      `<div class="phase err">✗ Erro</div>` +
      `<div class="path">${escapeHtml(d.error || "")}</div>`;
  } else if (d.status === "cancelled") {
    els.downloadStatus.className = "download-status cancelled";
    els.downloadStatus.innerHTML =
      `<div class="phase">⊘ Cancelado</div>` +
      `<div class="path">${escapeHtml(d.title || "")}</div>`;
  }
}

async function onClickDownload() {
  els.downloadBtn.disabled = true;
  const resp = await chrome.runtime.sendMessage({
    type: "download",
    tabId: currentTabId,
  });
  if (!resp || !resp.ok) {
    els.downloadStatus.style.display = "block";
    els.downloadStatus.className = "download-status error";
    els.downloadStatus.innerHTML =
      `<div class="phase err">✗ Não disparou</div>` +
      `<div class="path">${escapeHtml((resp && resp.error) || "erro desconhecido")}</div>`;
    els.downloadBtn.disabled = false;
  }
}

async function onClickCancel() {
  els.cancelBtn.disabled = true;
  els.cancelBtn.textContent = "Cancelando…";
  let resp;
  try {
    resp = await chrome.runtime.sendMessage({
      type: "cancel",
      tabId: currentTabId,
    });
  } catch (e) {
    resp = { ok: false, error: String((e && e.message) || e) };
  }
  if (!resp || !resp.ok) {
    els.cancelBtn.disabled = false;
    els.cancelBtn.textContent = "Cancelar";
    els.downloadStatus.style.display = "block";
    els.downloadStatus.className = "download-status error";
    els.downloadStatus.innerHTML =
      `<div class="phase err">✗ Falha ao cancelar</div>` +
      `<div class="path">${escapeHtml((resp && resp.error) || "erro desconhecido")}</div>`;
  }
  // Se ok: background dispara notifyPopup, refresh() vai atualizar a UI.
}

function renderProgress(d) {
  const p = d.progress;
  // O host emite apenas elapsed/speed (sem total). Barra indeterminada em
  // qualquer fase que não seja "video", ou quando ainda não chegou progress.
  const isVideo = d.phase === "video" || d.phase === "baixando vídeo";
  if (!isVideo || !p || p.elapsed == null) {
    return (
      `<div class="progress-bar"><div class="progress-fill indeterminate"></div></div>`
    );
  }
  const speed = p.speed != null ? `${Number(p.speed).toFixed(2)}x` : "—";
  const elapsedFmt = fmtHMS(p.elapsed);
  return (
    `<div class="progress-bar"><div class="progress-fill indeterminate"></div></div>` +
    `<div class="progress-text">` +
      `<span>${escapeHtml(elapsedFmt)}</span>` +
      `<span>${escapeHtml(speed)}</span>` +
    `</div>`
  );
}

// Convenção de status/ícone (mesma entre multimídia e materiais):
//   idle        ○   pré-clique (detectado mas ainda não começou)
//   pending     ⏳   job iniciado, aguardando a vez
//   downloading 📥   rodando agora
//   done        ✅   concluído
//   error       ❌   falhou
//   skipped     ⏭    pulado (env var de skip ou dedup)
//   unavailable —   não disponível pra esta aula
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

function classFor(status) {
  switch (status) {
    case "done":        return "mat-done";
    case "downloading": return "mat-dl";
    case "error":       return "mat-err";
    case "pending":     return "mat-pending";
    case "skipped":     return "mat-skip";
    case "unavailable": return "mat-skip";
    default:            return "mat-idle";
  }
}

function renderMatItem(label, status, errMsg) {
  const title = errMsg ? ` title="${escapeHtml(errMsg)}"` : "";
  return `<div class="mat-item ${classFor(status)}"${title}>${iconFor(status)} ${escapeHtml(label)}</div>`;
}

function renderMultimedia(state) {
  const hasFlavors = Object.keys(state.flavors || {}).length > 0;
  if (!hasFlavors) {
    els.multimediaSection.style.display = "none";
    return;
  }
  const mm = (state.download && state.download.multimedia) || {};
  const status = (k) => mm[k] || "idle";
  const items = [
    renderMatItem("Vídeo", status("video")),
    renderMatItem("Legenda pt", status("sub_pt")),
    renderMatItem("Legenda en", status("sub_en")),
  ];
  els.multimediaSection.style.display = "";
  els.multimediaList.innerHTML = items.join("");
}

function renderMaterialsUpfront(state) {
  const d = state.download;
  const items = [];

  // "Slides (do player)" — item especial, não vem da aba Materiais.
  if (d && d.multimedia && d.multimedia.slides != null &&
      d.multimedia.slides !== "unavailable") {
    items.push(renderMatItem("Slides (do player)", d.multimedia.slides));
  } else if (!d && state.slidesUrl) {
    items.push(renderMatItem("Slides (do player)", "idle"));
  }

  // Lista de materiais: durante download, usa download.materials (atualizado
  // pelo host via materialProgress). Pré-clique, usa state.pendingMaterials
  // que o adapter pode popular quando captura a lista.
  if (d && Array.isArray(d.materials) && d.materials.length) {
    for (const m of d.materials) {
      items.push(renderMatItem(m.filename || "(sem nome)", m.status || "pending", m.error));
    }
  } else if (!d && Array.isArray(state.pendingMaterials)) {
    for (const m of state.pendingMaterials) {
      items.push(renderMatItem(m.filename || "(sem nome)", "idle"));
    }
  }

  if (!items.length) {
    els.materialsSection.style.display = "none";
    return;
  }
  els.materialsSection.style.display = "";
  els.materialsList.innerHTML = items.join("");
}

function fmtHMS(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}
