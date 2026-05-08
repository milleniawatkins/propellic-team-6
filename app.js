/* =============================================================
   Performance Creative Engine — Propellic
   ============================================================= */

const API = "";          // same origin — FastAPI serves this file
let SESSION_ID = null;   // set on init

// State
const state = {
  brief: null,           // { filename }
  brandDocs: [],         // [{ filename }]
  sources: { meta: false, google: false, ga4: false },
  config: {},
  generated: null,
  activePlacement: null,
};

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function init() {
  // Check for session_id in URL (e.g. after OAuth redirect)
  const params = new URLSearchParams(window.location.search);
  const urlSession = params.get("session_id");
  const metaConnected = params.get("meta_connected");

  if (urlSession) {
    SESSION_ID = urlSession;
    localStorage.setItem("pce_session", SESSION_ID);
    // Clean URL
    window.history.replaceState({}, "", "/");
  } else {
    SESSION_ID = localStorage.getItem("pce_session");
  }

  if (!SESSION_ID) {
    await createSession();
  } else {
    // Verify session still exists
    try {
      const s = await apiFetch(`/api/sessions/${SESSION_ID}`);
      if (metaConnected) {
        state.sources.meta = true;
        updateSourceStatus("meta", "connected");
        toast("Meta Ads connected ✓", "success");
      }
      // Restore state from session
      if (s.has_brief) { state.brief = { filename: "Uploaded" }; syncBriefUI(); }
      if (s.brand_doc_count > 0) { for (let i = 0; i < s.brand_doc_count; i++) state.brandDocs.push({ filename: `Doc ${i+1}` }); }
      if (s.has_meta_data) { state.sources.meta = true; updateSourceStatus("meta", "uploaded"); }
      if (s.has_google_data) { state.sources.google = true; updateSourceStatus("google", "uploaded"); }
      if (s.has_ga4_data) { state.sources.ga4 = true; updateSourceStatus("ga4", "uploaded"); }
    } catch {
      await createSession();
    }
  }

  document.getElementById("session-pill").textContent = SESSION_ID.slice(0, 8);
}

async function createSession() {
  const data = await apiFetch("/api/sessions", { method: "POST" });
  SESSION_ID = data.session_id;
  localStorage.setItem("pce_session", SESSION_ID);
  document.getElementById("session-pill").textContent = SESSION_ID.slice(0, 8);
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

let currentStep = 1;

function goStep(n) {
  // Validate before advancing
  if (n === 3 && !state.brief) {
    toast("Please upload a creative brief before continuing.", "error");
    return;
  }

  document.getElementById(`panel-${currentStep}`).classList.remove("active");
  document.getElementById(`panel-${n}`).classList.add("active");

  // Update step nav
  document.querySelectorAll(".step-item").forEach(el => {
    const s = parseInt(el.dataset.step);
    el.classList.remove("active", "done");
    if (s === n) el.classList.add("active");
    else if (s < n) el.classList.add("done");
  });

  // Update connectors
  for (let i = 1; i <= 4; i++) {
    const conn = document.getElementById(`conn-${i}-${i+1}`);
    if (conn) conn.classList.toggle("done", i < n);
  }

  // Update generate summary
  if (n === 4) updateGenerateSummary();

  currentStep = n;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ---------------------------------------------------------------------------
// File uploads
// ---------------------------------------------------------------------------

function handleDragOver(e, zoneId) {
  e.preventDefault();
  document.getElementById(zoneId).classList.add("drag-over");
}
function handleDragLeave(zoneId) {
  document.getElementById(zoneId).classList.remove("drag-over");
}
function handleDrop(e, type) {
  e.preventDefault();
  const zoneId = type === "brief" ? "brief-dropzone" : "brand-dropzone";
  document.getElementById(zoneId).classList.remove("drag-over");
  const files = Array.from(e.dataTransfer.files);
  uploadDocFiles(type, files);
}
function handleFileSelect(type, input) {
  uploadDocFiles(type, Array.from(input.files));
  input.value = "";
}

async function uploadDocFiles(type, files) {
  if (!files.length) return;
  const isBrief = type === "brief";

  for (const file of files) {
    const fd = new FormData();
    fd.append("session_id", SESSION_ID);
    if (isBrief) {
      fd.append("file", file);
      try {
        await apiFetch("/api/upload/brief", { method: "POST", body: fd, raw: true });
        state.brief = { filename: file.name };
        syncBriefUI();
        toast(`Creative brief uploaded: ${file.name}`, "success");
        break; // only one brief
      } catch (e) {
        toast(`Upload failed: ${e.message}`, "error");
      }
    } else {
      fd.append("files", file);
      try {
        await apiFetch("/api/upload/brand", { method: "POST", body: fd, raw: true });
        state.brandDocs.push({ filename: file.name });
        syncBrandUI();
        toast(`Brand doc uploaded: ${file.name}`, "success");
      } catch (e) {
        toast(`Upload failed: ${e.message}`, "error");
      }
    }
  }
}

function syncBriefUI() {
  const list = document.getElementById("brief-files");
  if (state.brief) {
    list.innerHTML = fileChip(state.brief.filename, "brief-chip");
  } else {
    list.innerHTML = "";
  }
  checkStep2Continue();
}

function syncBrandUI() {
  const list = document.getElementById("brand-files");
  list.innerHTML = state.brandDocs.map((d, i) => fileChip(d.filename, `brand-chip-${i}`, i)).join("");
  checkStep2Continue();
}

function fileChip(name, id, brandIdx) {
  const removeAttr = brandIdx !== undefined
    ? `onclick="removeBrandDoc(${brandIdx})"`
    : `onclick="removeBrief()"`;
  return `<div class="file-chip" id="${id}">
    <span>📄</span>
    <span class="file-chip-name">${name}</span>
    <span class="file-chip-remove" ${removeAttr}>×</span>
  </div>`;
}

function removeBrief() {
  state.brief = null;
  syncBriefUI();
}
function removeBrandDoc(idx) {
  state.brandDocs.splice(idx, 1);
  syncBrandUI();
}

function checkStep2Continue() {
  document.getElementById("btn-step2-continue").disabled = !state.brief;
}

// ---------------------------------------------------------------------------
// Data source uploads
// ---------------------------------------------------------------------------

async function uploadSourceFile(source, input) {
  const file = input.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append("session_id", SESSION_ID);
  fd.append("file", file);

  const endpoint = `/api/upload/${source}-data`;
  try {
    await apiFetch(endpoint, { method: "POST", body: fd, raw: true });
    state.sources[source] = true;
    updateSourceStatus(source, "uploaded");
    toast(`${sourceName(source)} data uploaded: ${file.name}`, "success");
  } catch (e) {
    toast(`Upload failed: ${e.message}`, "error");
  }
  input.value = "";
}

function updateSourceStatus(source, status) {
  const el = document.getElementById(`${source}-status`);
  if (!el) return;
  if (status === "connected") {
    el.className = "source-status connected";
    el.textContent = "● Connected";
  } else if (status === "uploaded") {
    el.className = "source-status uploaded";
    el.textContent = "✓ Data uploaded";
  }
}

function sourceName(source) {
  return { meta: "Meta Ads", google: "Google Ads", ga4: "GA4" }[source] || source;
}

// ---------------------------------------------------------------------------
// Meta OAuth
// ---------------------------------------------------------------------------

function connectMeta() {
  if (!SESSION_ID) return;
  window.location.href = `/auth/meta?session_id=${SESSION_ID}`;
}

// ---------------------------------------------------------------------------
// Checkboxes
// ---------------------------------------------------------------------------

function updateCheckbox(input) {
  input.closest(".checkbox-label").classList.toggle("checked", input.checked);
}

// ---------------------------------------------------------------------------
// Generate
// ---------------------------------------------------------------------------

function updateGenerateSummary() {
  const placements = getSelectedPlacements();
  const funnel = document.getElementById("funnel-stage")?.value || "Consideration";
  const variants = document.getElementById("num-variants")?.value || "3";
  const sources = Object.entries(state.sources).filter(([,v]) => v).map(([k]) => sourceName(k));
  const doc = state.brief ? "1 brief" : "no brief";
  const brand = state.brandDocs.length ? ` + ${state.brandDocs.length} brand doc(s)` : "";
  document.getElementById("generate-summary").textContent =
    `${placements.length} placements · ${variants} variants each · ${funnel} funnel · ` +
    `${sources.length ? sources.join(", ") : "no performance data"} · ${doc}${brand}`;
}

function getSelectedPlacements() {
  return Array.from(document.querySelectorAll("#placement-group input:checked")).map(i => i.value);
}

const loadingMessages = [
  "Analyzing historical performance data...",
  "Identifying winning hooks and themes...",
  "Mapping emotional triggers from top ads...",
  "Crafting placement-optimized copy...",
  "Finalizing ad variants...",
];

async function runGeneration() {
  const placements = getSelectedPlacements();
  if (!placements.length) { toast("Select at least one placement.", "error"); return; }

  const config = {
    campaign_name: document.getElementById("campaign-name").value || "Performance Creative Engine",
    funnel_stage: document.getElementById("funnel-stage").value,
    num_variants: parseInt(document.getElementById("num-variants").value),
    placements,
  };
  state.config = config;

  // Show loading
  document.getElementById("pre-generate").style.display = "none";
  document.getElementById("results-state").classList.add("hidden");
  const loadingEl = document.getElementById("loading-state");
  loadingEl.classList.add("visible");

  // Cycle loading messages
  let msgIdx = 0;
  const msgEl = document.getElementById("loading-msg");
  const msgInterval = setInterval(() => {
    msgIdx = (msgIdx + 1) % loadingMessages.length;
    msgEl.textContent = loadingMessages[msgIdx];
  }, 2800);

  try {
    const result = await apiFetch("/api/generate", {
      method: "POST",
      body: JSON.stringify({ session_id: SESSION_ID, config }),
      headers: { "Content-Type": "application/json" },
    });
    state.generated = result;
    clearInterval(msgInterval);
    loadingEl.classList.remove("visible");
    renderResults(result, config);
    document.getElementById("results-state").classList.remove("hidden");
  } catch (e) {
    clearInterval(msgInterval);
    loadingEl.classList.remove("visible");
    document.getElementById("pre-generate").style.display = "";
    toast(`Generation failed: ${e.message}`, "error");
  }
}

// ---------------------------------------------------------------------------
// Render results
// ---------------------------------------------------------------------------

function renderResults(data, config) {
  const { analysis, ads } = data;
  const total = ads.length;
  const placements = [...new Set(ads.map(a => a.placement))];

  document.getElementById("results-subtitle").textContent =
    `${total} ads across ${placements.length} placements — ${config.funnel_stage} funnel`;

  // Analysis
  document.getElementById("insights-text").textContent = analysis.key_insights || "";
  renderTags("tags-themes", analysis.winning_themes || [], false);
  renderTags("tags-hooks", analysis.top_hooks || [], true);
  renderTags("tags-triggers", analysis.emotional_triggers || [], false);
  renderTags("tags-ctas", analysis.top_ctas || [], true);

  // Placement tabs
  const tabsEl = document.getElementById("placement-tabs");
  tabsEl.innerHTML = placements.map((p, i) =>
    `<button class="placement-tab ${i === 0 ? "active" : ""}" onclick="switchPlacement('${p}', this)">${p}</button>`
  ).join("");

  state.activePlacement = placements[0];
  renderAdsGrid(ads, placements[0]);
}

function renderTags(elId, items, accent) {
  const el = document.getElementById(elId);
  el.innerHTML = items.map(t => `<span class="tag ${accent ? "accent-tag" : ""}">${t}</span>`).join("");
}

function switchPlacement(placement, btn) {
  document.querySelectorAll(".placement-tab").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  state.activePlacement = placement;
  renderAdsGrid(state.generated.ads, placement);
}

function renderAdsGrid(ads, placement) {
  const filtered = ads.filter(a => a.placement === placement);
  const grid = document.getElementById("ads-grid");
  grid.innerHTML = filtered.map(ad => `
    <div class="ad-card">
      <div class="ad-card-header">
        <span class="ad-placement-badge">${ad.placement}</span>
        <span class="ad-variant-badge">Variant ${ad.variant}</span>
      </div>
      <div class="ad-card-body">
        ${ad.hook ? `<div class="ad-hook">🪝 "${ad.hook}"</div>` : ""}
        ${ad.headline ? `<div class="ad-headline">${ad.headline}</div>` : ""}
        <div class="ad-primary-text">${ad.primary_text || ""}</div>
        <div class="ad-meta">
          <span class="ad-cta-chip">${ad.cta || "LEARN_MORE"}</span>
          ${ad.emotional_angle ? `<span class="ad-angle">${ad.emotional_angle}</span>` : ""}
        </div>
        ${ad.rationale ? `<div class="ad-rationale">💡 ${ad.rationale}</div>` : ""}
      </div>
    </div>
  `).join("");
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function goExport() {
  if (!state.generated) return;
  const ads = state.generated.ads || [];
  const placements = [...new Set(ads.map(a => a.placement))];
  const statsEl = document.getElementById("export-stats");
  statsEl.innerHTML = [
    { value: ads.length, label: "Total Ads" },
    { value: placements.length, label: "Placements" },
    { value: [...new Set(ads.map(a => a.variant))].length, label: "Variants" },
  ].map(s => `
    <div class="export-stat">
      <div class="export-stat-value">${s.value}</div>
      <div class="export-stat-label">${s.label}</div>
    </div>
  `).join("");
  goStep(5);
}

function downloadCSV() {
  if (!SESSION_ID) return;
  window.location.href = `/api/export/${SESSION_ID}`;
  toast("Download started — import the CSV into Meta Ads Manager.", "success");
}

function startOver() {
  localStorage.removeItem("pce_session");
  window.location.href = "/";
}

// ---------------------------------------------------------------------------
// API helper
// ---------------------------------------------------------------------------

async function apiFetch(path, opts = {}) {
  const { raw, ...fetchOpts } = opts;
  const res = await fetch(API + path, fetchOpts);
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = j.detail || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

function toast(message, type = "info") {
  const container = document.getElementById("toast-container");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${type === "success" ? "✓" : type === "error" ? "✕" : "ℹ"}</span> ${message}`;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ---------------------------------------------------------------------------
// Wire up step 5 from results
// ---------------------------------------------------------------------------

// Override goStep to populate export stats when going to step 5
const _goStep = goStep;
window.goStep = function(n) {
  if (n === 5 && state.generated) {
    const ads = state.generated.ads || [];
    const placements = [...new Set(ads.map(a => a.placement))];
    document.getElementById("export-stats").innerHTML = [
      { value: ads.length, label: "Total Ads" },
      { value: placements.length, label: "Placements" },
      { value: parseInt(state.config.num_variants || 3), label: "Variants" },
    ].map(s => `
      <div class="export-stat">
        <div class="export-stat-value">${s.value}</div>
        <div class="export-stat-label">${s.label}</div>
      </div>
    `).join("");
  }
  _goStep(n);
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

init();
