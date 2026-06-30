/**
 * UpworkAI - Popup Script v2.0
 */

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = btn.dataset.tab;
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("tab-" + target).classList.add("active");
    if (target === "debug") loadLogs();
  });
});

async function init() {
  const config = await rpc({ type: "GET_CONFIG" }) ?? {};
  const stats  = await rpc({ type: "GET_STATS" }) ?? {};

  set("sDetected",  stats.detected  ?? 0);
  set("sSubmitted", stats.submitted ?? 0);
  set("sQueued",    stats.queued    ?? 0);
  set("sMessages",  stats.messages  ?? 0);
  set("sFailed",    stats.failed    ?? 0);

  chrome.storage.local.get("queue", ({ queue }) => set("sQueueLen", (queue ?? []).length));

  const modeRow = document.getElementById("modeRow");
  if (config.simulationMode) modeRow.innerHTML += '<span class="badge badge-sim">⚠️ Simulation</span>';
  if (config.debugMode)      modeRow.innerHTML += '<span class="badge badge-debug">🔍 Debug</span>';

  if (config.simulationMode) document.getElementById("simBanner").classList.add("show");

  document.getElementById("dashboardUrl").value    = config.dashboardUrl    ?? "";
  document.getElementById("monitorEnabled").checked = config.enabled        !== false;
  document.getElementById("simMode").checked        = config.simulationMode ?? false;
  document.getElementById("debugMode").checked      = config.debugMode      ?? false;

  const base = config.apiBase || (config.dashboardUrl ? config.dashboardUrl + "/api" : "");
  await checkConnection(base);
}

async function checkConnection(apiBase) {
  const dot  = document.getElementById("statusDot");
  const text = document.getElementById("statusText");
  if (!apiBase) {
    dot.className = "dot offline";
    text.textContent = "Dashboard URL not configured";
    return false;
  }
  try {
    const res = await fetch(`${apiBase}/healthz`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) { dot.className = "dot"; text.textContent = "Connected to dashboard"; return true; }
    throw new Error();
  } catch {
    dot.className = "dot offline";
    text.textContent = "Cannot reach dashboard";
    return false;
  }
}

document.getElementById("disableSimBtn")?.addEventListener("click", async () => {
  document.getElementById("simMode").checked = false;
  const url = document.getElementById("dashboardUrl").value.trim().replace(/\/$/, "");
  await rpc({
    type: "SET_CONFIG",
    config: {
      dashboardUrl:   url,
      apiBase:        url + "/api",
      enabled:        document.getElementById("monitorEnabled").checked,
      simulationMode: false,
      debugMode:      document.getElementById("debugMode").checked,
    },
  });
  document.getElementById("simBanner").classList.remove("show");
  toast("Simulation mode disabled — jobs will now be submitted!", "#22c55e");
});

document.getElementById("saveBtn").addEventListener("click", async () => {
  const url = document.getElementById("dashboardUrl").value.trim().replace(/\/$/, "");
  if (!url) { toast("Enter a dashboard URL", "#ef4444"); return; }

  await rpc({
    type: "SET_CONFIG",
    config: {
      dashboardUrl:   url,
      apiBase:        url + "/api",
      enabled:        document.getElementById("monitorEnabled").checked,
      simulationMode: document.getElementById("simMode").checked,
      debugMode:      document.getElementById("debugMode").checked,
    },
  });
  toast("Settings saved!");
  document.getElementById("simBanner").classList.toggle("show", document.getElementById("simMode").checked);
  await checkConnection(url + "/api");
});

document.getElementById("testConnection").addEventListener("click", async () => {
  const url = document.getElementById("dashboardUrl").value.trim().replace(/\/$/, "");
  if (!url) { toast("Enter dashboard URL first", "#f59e0b"); return; }
  const ok = await checkConnection(url + "/api");
  toast(ok ? "Connected!" : "Connection failed", ok ? "#22c55e" : "#ef4444");
});

document.getElementById("openDashboard").addEventListener("click", async () => {
  const cfg = await rpc({ type: "GET_CONFIG" });
  if (cfg?.dashboardUrl) chrome.tabs.create({ url: cfg.dashboardUrl });
  else toast("Configure dashboard URL in Settings", "#f59e0b");
});

async function loadLogs() {
  const logs = await rpc({ type: "GET_DEBUG_LOGS" }) ?? [];
  const list = document.getElementById("logList");
  document.getElementById("logCount").textContent = `${logs.length} entries`;

  if (!logs.length) {
    list.innerHTML = '<div class="log-empty">No logs yet. Enable Debug Mode in Settings.</div>';
    return;
  }

  list.innerHTML = [...logs].reverse().slice(0, 200).map((e) => {
    const time  = new Date(e.ts).toLocaleTimeString();
    const isSim = /SIM|SIMULATION/i.test(e.msg ?? "");
    const isErr = /error|fail/i.test(e.msg ?? "");
    const cls   = isSim ? "sim" : isErr ? "error" : "";
    return `<div class="log-entry"><span class="log-time">${time}</span><span class="log-msg ${cls}">${esc(e.msg ?? "")}</span></div>`;
  }).join("");
}

document.getElementById("refreshLogs").addEventListener("click", loadLogs);
document.getElementById("clearLogs").addEventListener("click", async () => {
  await rpc({ type: "CLEAR_LOGS" });
  await loadLogs();
  toast("Logs cleared");
});

function rpc(payload) {
  return new Promise((r) => chrome.runtime.sendMessage(payload, (res) => r(chrome.runtime.lastError ? null : res)));
}
function set(id, val) { const el = document.getElementById(id); if (el) el.textContent = String(val); }
function toast(text, color = "#22c55e") {
  const el = document.getElementById("toast");
  el.textContent = text; el.style.background = color;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2200);
}
function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

// ── DOM Diagnostic tool ────────────────────────────────────────────────────

let diagPollTimer = null;

function diagSetStatus(cls, msg, extra = "") {
  const el = document.getElementById("diagStatus");
  el.innerHTML = `<span class="${cls}">${esc(msg)}</span>${extra ? `<span style="color:#64748b">${esc(extra)}</span>` : ""}`;
}

function diagShowResult(diag) {
  const out = document.getElementById("diagOut");
  const copyBtn = document.getElementById("diagCopyBtn");
  const refreshBtn = document.getElementById("diagRefreshBtn");

  if (!diag) return;

  const lines = diag.log ?? [];
  const summary = [
    `=== DOM Diagnostic ===`,
    `URL: ${diag.url ?? ""}`,
    `Page: ${diag.pageTitle ?? ""}`,
    `Time: ${diag.ts ? new Date(diag.ts).toLocaleTimeString() : ""}`,
    `Status: ${diag.status ?? ""}`,
    `pvStatus: ${diag.pvStatus ?? "null"}`,
    `strategy: ${diag.matchedStrategy ?? "null"}`,
    `proposals: ${diag.proposalText ?? "null"}`,
    diag.error ? `ERROR: ${diag.error}` : "",
    "",
    ...lines,
  ].filter(l => l !== undefined).join("\n");

  out.textContent = summary;
  out.classList.add("show");
  copyBtn.style.display = "";
  refreshBtn.style.display = "";
  copyBtn._diagText = summary;
  copyBtn._rawDiag = diag; // used by double-click → Export JSON
}

async function diagPollResult() {
  const diag = await rpc({ type: "GET_LAST_DIAG" });
  if (!diag) return;

  if (diag.status === "running") {
    diagSetStatus("running", `Running… (${diag.log?.length ?? 0} log lines so far)`);
    return;
  }
  clearInterval(diagPollTimer);
  diagPollTimer = null;

  const btn = document.getElementById("diagRunBtn");
  btn.disabled = false;
  btn.textContent = "Run";

  if (diag.status === "error") {
    diagSetStatus("err", `Error: ${diag.error}`);
  } else {
    diagSetStatus("done", `Done — pvStatus=${diag.pvStatus ?? "null"} strategy=${diag.matchedStrategy ?? "null"}`);
  }
  diagShowResult(diag);
}

document.getElementById("diagRunBtn").addEventListener("click", async () => {
  const url = document.getElementById("diagUrl").value.trim();
  if (!url || !url.startsWith("http")) {
    toast("Enter a valid Upwork job URL", "#ef4444"); return;
  }
  const btn = document.getElementById("diagRunBtn");
  btn.disabled = true;
  btn.textContent = "…";

  document.getElementById("diagOut").classList.remove("show");
  document.getElementById("diagCopyBtn").style.display = "none";
  document.getElementById("diagRefreshBtn").style.display = "none";
  diagSetStatus("running", "Starting… opening background tab");

  await rpc({ type: "DIAGNOSE_URL", url });
  toast("Diagnostic started — ~10s", "#6366f1");

  clearInterval(diagPollTimer);
  diagPollTimer = setInterval(diagPollResult, 2000);
});

document.getElementById("diagCopyBtn").addEventListener("click", () => {
  const btn = document.getElementById("diagCopyBtn");
  const text = btn._diagText || "";
  navigator.clipboard.writeText(text).then(() => toast("Copied to clipboard!")).catch(() => toast("Copy failed", "#ef4444"));
});

document.getElementById("diagRunBtn").dataset.diagText = "";

// "Export JSON" download — works without extra permissions
function diagDownloadJson(diagData) {
  try {
    const json = JSON.stringify(diagData, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = "upwork-diag.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch (e) {
    toast("Download failed: " + e.message, "#ef4444");
  }
}

document.getElementById("diagRefreshBtn").addEventListener("click", () => diagPollResult());

// Double-click Copy button = download JSON file
document.getElementById("diagCopyBtn").addEventListener("dblclick", () => {
  const diag = document.getElementById("diagCopyBtn")._rawDiag;
  if (diag) diagDownloadJson(diag);
  else toast("No result yet", "#f59e0b");
});

init();
