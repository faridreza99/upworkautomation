/**
 * UpworkAI - Background Service Worker v2.0
 * Offline queue, exponential retry, debug mode, simulation mode.
 */

const DEFAULT_CONFIG = {
  dashboardUrl: "",
  apiBase: "",
  enabled: true,
  debugMode: false,
  simulationMode: false,
};

const MAX_QUEUE = 200;
const MAX_LOGS = 500;
const RETRY_DELAYS = [5000, 15000, 30000, 60000, 120000];

// ── Session-level dedup Set ───────────────────────────────────────────────
// In-memory, cleared every time the MV3 service worker restarts (~30 s idle).
// Blocks redundant payment-verification tab opens + API calls for the same
// job ID within a single SW lifetime.  Fast O(1); never persisted to storage.
const sessionSeenIds = new Set();

// ── Init ──────────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === "install") {
    // Fresh install only — do not wipe existing data on update/reload
    await chrome.storage.local.set({
      config:     DEFAULT_CONFIG,
      seenJobIds: [],
      queue:      [],
      debugLogs:  [],
      stats:      { detected: 0, submitted: 0, failed: 0, messages: 0, queued: 0 },
    });
    bgLog("Extension installed (fresh) — default config written");
  } else {
    // Update or browser restart — preserve all saved config and queued jobs
    const { config } = await chrome.storage.local.get("config");
    if (!config) {
      await chrome.storage.local.set({ config: DEFAULT_CONFIG });
      bgLog(`Extension ${reason} — no config found, wrote defaults`);
    } else {
      bgLog(`Extension ${reason} — config preserved: apiBase=${config.apiBase || "(empty)"}`);
    }
  }
});

// ── Periodic queue flush + service worker keepalive ───────────────────────
// "flushQueue" retries any queued jobs every minute.
// "keepAlive"  prevents the MV3 service worker from going idle (Chrome
//              terminates it after ~30 s; the alarm re-wakes it every 25 s).
chrome.alarms.create("flushQueue",        { periodInMinutes: 1 });
chrome.alarms.create("keepAlive",         { periodInMinutes: 0.4 }); // ~24 s
chrome.alarms.create("pollApplyTriggers", { periodInMinutes: 0.5 }); // ~30 s
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "flushQueue")        flushQueue().catch(() => {});
  if (alarm.name === "keepAlive")         bgLog("[MONITOR] Service worker keepalive — active");
  if (alarm.name === "pollApplyTriggers") pollApplyTriggers().catch(() => {});
});

// ── Message router ────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  route(message)
    .then(sendResponse)
    .catch((err) => {
      bgLog("Handler error: " + err.message);
      sendResponse({ error: err.message });
    });
  return true;
});

async function route(msg) {
  // [TRACE-BG-1] Message received by background service worker.
  // Visible in: chrome://extensions → UpworkAI → "Inspect views: service worker"
  // If content.js fires TRACE-4 but this never appears, the SW was dead when
  // the message arrived (keepalive ping may have failed).
  if (msg.type === "JOB_DETECTED") {
    bgLog(`[TRACE-BG-1] JOB_DETECTED received by SW — title="${(msg.job?.title ?? "??").slice(0,60)}" id=${msg.job?.upworkJobId ?? "??"} sim=${msg.simulationMode ?? false}`);
  }
  switch (msg.type) {
    case "JOB_DETECTED":   return handleJob(msg.job, msg.simulationMode);
    case "EVENT_DETECTED": return handleEvent(msg.event, msg.simulationMode);
    case "GET_CONFIG":     return (await chrome.storage.local.get("config")).config ?? DEFAULT_CONFIG;
    case "SET_CONFIG":     return setConfig(msg.config);
    case "GET_STATS":      return (await chrome.storage.local.get("stats")).stats ?? {};
    case "GET_DEBUG_LOGS":    return (await chrome.storage.local.get("debugLogs")).debugLogs ?? [];
    case "CLEAR_LOGS":        await chrome.storage.local.set({ debugLogs: [] }); return { success: true };
    case "DEBUG_LOG":         await addLog(msg.entry); return { ok: true };
    case "PING":              return { pong: true, ts: Date.now() };
    case "GET_LAST_DIAG":     return (await chrome.storage.local.get("lastDiagnostic")).lastDiagnostic ?? null;
    case "DIAGNOSE_URL":      diagnoseJobUrl(msg.url); return { started: true };
    default:                  return { error: "Unknown type: " + msg.type };
  }
}

async function setConfig(updates) {
  const { config } = await chrome.storage.local.get("config");
  const next = { ...DEFAULT_CONFIG, ...config, ...updates };
  await chrome.storage.local.set({ config: next });
  return { success: true };
}

// ── Payment verification via background tab ───────────────────────────────
/**
 * WHY TAB-BASED: Upwork renders the "About the client" section (including
 * the Payment Verified badge) entirely client-side via React/Apollo. A raw
 * fetch() only retrieves the SSR shell which has NO payment data in it.
 *
 * This function opens the job detail page in an invisible background tab,
 * waits for React to fully hydrate, then runs executeScript against the
 * live DOM to extract the payment status with full audit logging.
 *
 * Returns: true (verified) | false (not verified) | null (unknown)
 */
async function fetchPaymentStatusFromDetailPage(jobUrl) {
  let tab = null;
  try {
    bgLog(`[PV:1] Opening background tab → ${jobUrl}`);
    tab = await chrome.tabs.create({ url: jobUrl, active: false });
    bgLog(`[PV:1] Tab created id=${tab.id} — waiting for page load`);

    // Wait for the tab to reach "complete" status
    await waitForTabLoad(tab.id, 25000);
    bgLog(`[PV:2] Page loaded — pausing 4s for React hydration`);

    // Upwork is a React SPA — wait for client-side rendering to complete
    await new Promise(r => setTimeout(r, 4000));

    bgLog(`[PV:3] Running DOM extraction script`);

    // Scroll trigger — activates lazy-loaded React components
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => { try { window.scrollTo(0, 700); window.scrollTo(0, 0); } catch {} },
    });
    await new Promise(r => setTimeout(r, 2000));
    bgLog(`[PV:3] Running comprehensive DOM extractor`);

    // This function runs inside the Upwork tab — must be fully self-contained
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: function upworkPaymentExtract() {
        const log = [];
        let pvStatus = null;
        let matchedStrategy = null;

        // ── T0: Full text-node TreeWalker (GROUND TRUTH) ─────────────────
        // Walks EVERY text node in the DOM. Finds payment/proposal text
        // regardless of element class names, aria-labels, or selectors.
        const paymentNodes = [];
        const proposalNodes = [];
        try {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
          let node;
          while ((node = walker.nextNode())) {
            const text = (node.textContent || "").trim();
            if (!text || text.length > 400 || text.length < 2) continue;
            const tl = text.toLowerCase();
            const isP = /payment|verif/.test(tl);
            const isPr = /proposal|applicant|\bbid\b/.test(tl);
            if (!isP && !isPr) continue;
            const p = node.parentElement;
            const gp = p?.parentElement;
            const info = {
              text: text.slice(0, 150),
              pTag: p?.tagName, pClass: (p?.className?.toString()||"").slice(0,80),
              pDataTest: p?.getAttribute("data-test"), pDataCy: p?.getAttribute("data-cy"),
              pAriaLabel: p?.getAttribute("aria-label"), pRole: p?.getAttribute("role"),
              gpTag: gp?.tagName, gpClass: (gp?.className?.toString()||"").slice(0,60),
              gpDataTest: gp?.getAttribute("data-test"),
            };
            if (isP) {
              paymentNodes.push(info);
              if (pvStatus === null && tl.includes("payment") && tl.includes("verif")) {
                pvStatus = !(tl.includes("not verif") || tl.includes("unverif"));
                matchedStrategy = `T0:textNode:"${text.slice(0,70)}"`;
              }
            }
            if (isPr) proposalNodes.push(info);
          }
          log.push(`T0 walk: ${paymentNodes.length} payment nodes, ${proposalNodes.length} proposal nodes`);
          for (const n of paymentNodes.slice(0,12)) {
            log.push(`T0 💳 "${n.text}" | <${n.pTag} cls="${n.pClass}" dt="${n.pDataTest}" aria="${n.pAriaLabel}">`);
          }
          for (const n of proposalNodes.slice(0,6)) {
            log.push(`T0 📊 "${n.text}" | <${n.pTag} cls="${n.pClass}" dt="${n.pDataTest}">`);
          }
        } catch(e) { log.push(`T0 error: ${e.message}`); }

        // ── T1: SVG aria-label and <title> scan ──────────────────────────
        if (pvStatus === null) {
          try {
            for (const svg of document.querySelectorAll("svg, use")) {
              const a = svg.getAttribute("aria-label") || "";
              const t = svg.querySelector?.("title")?.textContent || "";
              const c = (a + " " + t).toLowerCase();
              if (/payment|verif/.test(c)) {
                log.push(`T1 SVG: aria="${a}" title="${t}"`);
                if (c.includes("verif") && !c.includes("not verif") && !c.includes("unverif")) {
                  pvStatus = true; matchedStrategy = `T1:SVG:aria="${a}"`; break;
                } else if (c.includes("not verif") || c.includes("unverif")) {
                  pvStatus = false; matchedStrategy = `T1:SVG:aria="${a}"`; break;
                }
              }
            }
          } catch(e) { log.push(`T1 SVG error: ${e.message}`); }
        }

        // ── S1: Window globals (Next.js / Apollo / Redux hydration data) ──
        const WIN_KEYS = [
          "__NEXT_DATA__", "__APOLLO_STATE__", "__INITIAL_STATE__",
          "__REDUX_STATE__", "__PRELOADED_STATE__", "__RELAY_STORE__",
          "initialState", "__APP_STATE__", "__DATA__",
        ];
        const PV_FIELDS = [
          "paymentVerificationStatus", "paymentVerified", "hasVerifiedPayment",
          "isPaymentVerified", "paymentMethodVerified", "hasVerifiedPaymentMethod",
          "verificationStatus", "clientPaymentStatus",
        ];
        for (const key of WIN_KEYS) {
          try {
            if (!window[key]) continue;
            const json = JSON.stringify(window[key]);
            if (!json.includes("payment") && !json.includes("Payment") &&
                !json.includes("verif") && !json.includes("Verif")) continue;

            // Check for explicit VERIFIED / NOT_VERIFIED status string
            const statusM = json.match(/"paymentVerificationStatus"\s*:\s*"([^"]+)"/);
            if (statusM) {
              log.push(`S1 window.${key}: paymentVerificationStatus="${statusM[1]}"`);
              const v = statusM[1].toUpperCase();
              if (v === "VERIFIED" || v === "PAYMENT_VERIFIED") { pvStatus = true; matchedStrategy = `S1:window.${key}:paymentVerificationStatus`; break; }
              if (v === "NOT_VERIFIED" || v === "UNVERIFIED" || v === "FAILED") { pvStatus = false; matchedStrategy = `S1:window.${key}:paymentVerificationStatus`; break; }
            }

            // Check boolean fields
            for (const field of PV_FIELDS) {
              const boolM = json.match(new RegExp(`"${field}"\\s*:\\s*(true|false)`));
              if (boolM) {
                log.push(`S1 window.${key}: ${field}=${boolM[1]}`);
                pvStatus = boolM[1] === "true";
                matchedStrategy = `S1:window.${key}:${field}`;
                break;
              }
            }
            if (pvStatus !== null) break;

            // Collect nearby context for any payment-related snippet
            const payCtx = [];
            for (const field of PV_FIELDS) {
              const re = new RegExp(`.{0,30}"${field}".{0,80}`, "g");
              let m;
              while ((m = re.exec(json)) !== null && payCtx.length < 4) {
                payCtx.push(m[0].replace(/\s+/g, " ").slice(0, 120));
              }
            }
            if (payCtx.length) log.push(`S1 window.${key} context: ${payCtx.join(" | ")}`);
          } catch {}
        }

        // ── S2: Inline <script> tags ──────────────────────────────────────
        if (pvStatus === null) {
          for (const script of document.querySelectorAll("script")) {
            const c = script.textContent || "";
            if (!c.includes("paymentVerif") && !c.includes("payment_verif")) continue;

            const m = c.match(/"paymentVerificationStatus"\s*:\s*"([^"]+)"/);
            if (m) {
              log.push(`S2 script tag: paymentVerificationStatus="${m[1]}"`);
              const v = m[1].toUpperCase();
              pvStatus = v === "VERIFIED" ? true : v === "NOT_VERIFIED" ? false : null;
              matchedStrategy = "S2:script_tag:paymentVerificationStatus";
              break;
            }
            for (const field of ["paymentVerified", "hasVerifiedPayment", "isPaymentVerified"]) {
              const b = c.match(new RegExp(`"${field}"\\s*:\\s*(true|false)`));
              if (b) {
                log.push(`S2 script tag: ${field}=${b[1]}`);
                pvStatus = b[1] === "true";
                matchedStrategy = `S2:script_tag:${field}`;
                break;
              }
            }
            if (pvStatus !== null) break;
          }
        }

        // ── S3: DOM element selectors (rendered React components) ─────────
        if (pvStatus === null) {
          const VERIFIED_SELS = [
            '[data-test="payment-verified"]',
            '[data-cy="payment-verified"]',
            '[data-qa="payment-verified"]',
            '[data-test="client-payment-verified"]',
            '.air3-badge-payment',
            '[class*="paymentVerified"]',
            '[class*="PaymentVerified"]',
            '[class*="payment-verified"]',
            '[aria-label*="payment verified" i]',
            '[aria-label*="Payment Method Verified" i]',
            '[title*="payment verified" i]',
            '.up-icon-verified-payment',
          ];
          const NOT_VERIFIED_SELS = [
            '[data-test="payment-not-verified"]',
            '[data-cy="payment-not-verified"]',
            '[aria-label*="payment not verified" i]',
            '[aria-label*="Payment Not Verified" i]',
          ];
          for (const sel of VERIFIED_SELS) {
            try {
              const el = document.querySelector(sel);
              if (el) {
                log.push(`S3 DOM selector matched: ${sel} text="${el.textContent?.trim()?.slice(0,60)}"`);
                pvStatus = true;
                matchedStrategy = `S3:DOM:${sel}`;
                break;
              } else {
                log.push(`S3 selector miss: ${sel}`);
              }
            } catch {}
          }
          if (pvStatus === null) {
            for (const sel of NOT_VERIFIED_SELS) {
              try {
                if (document.querySelector(sel)) {
                  log.push(`S3 NOT_VERIFIED selector matched: ${sel}`);
                  pvStatus = false;
                  matchedStrategy = `S3:DOM:${sel}`;
                  break;
                }
              } catch {}
            }
          }
        }

        // ── S4: Body/section text scan (catches any variant) ─────────────
        if (pvStatus === null) {
          const bodyText = document.body.innerText || "";
          const patternsYes = [/payment method verified/i, /payment verified/i, /payment method: verified/i];
          const patternsNo  = [/payment not verified/i, /payment method not verified/i, /payment unverified/i];
          for (const rx of patternsYes) {
            if (rx.test(bodyText)) {
              log.push(`S4 body: "${rx.source}" found`);
              pvStatus = true; matchedStrategy = `S4:bodyText:${rx.source}`; break;
            }
          }
          if (pvStatus === null) {
            for (const rx of patternsNo) {
              if (rx.test(bodyText)) {
                log.push(`S4 body (NOT_VERIFIED): "${rx.source}" found`);
                pvStatus = false; matchedStrategy = `S4:bodyText:${rx.source}`; break;
              }
            }
          }
          if (pvStatus === null) log.push(`S4 body text scan: no payment/verified pattern matched`);
        }

        // ── DIAG: Comprehensive DOM evidence dump ─────────────────────────
        // Always runs so the popup debug log always shows what's on the page.
        const diagData = { aboutClientHtml: null, allItems: [], dataTestMap: [], shadowHosts: 0 };
        try {
          // Find "About the client" heading and dump its parent section
          const allEls = [...document.querySelectorAll("*")];
          const aboutHead = allEls.find(el => /about.*client|client.*info/i.test(el.textContent?.trim() || "") && el.children.length === 0 && (el.textContent?.trim().length || 0) < 60);
          if (aboutHead) {
            let sec = aboutHead;
            for (let i = 0; i < 7 && sec && sec !== document.body; i++) {
              sec = sec.parentElement;
              if (sec && (sec.tagName === "SECTION" || sec.tagName === "ASIDE" || /widget|card|panel|module|sidebar/i.test(sec.className?.toString() || ""))) break;
            }
            diagData.aboutClientHtml = sec?.innerHTML?.replace(/<script[\s\S]*?<\/script>/gi, "")?.slice(0, 4000) || null;
            log.push(`DIAG aboutClient heading: "${aboutHead.textContent?.trim()?.slice(0,60)}" <${sec?.tagName} cls="${sec?.className?.toString()?.slice(0,60)}">`);
            if (diagData.aboutClientHtml) log.push(`DIAG aboutClient HTML: ${diagData.aboutClientHtml.slice(0, 2000)}`);
          } else {
            log.push("DIAG aboutClient: heading not found; searching fallback containers");
            const fallback = document.querySelector('[class*="aboutClient" i],[class*="client-info" i],[data-test*="client" i],[class*="ClientInfo" i]');
            if (fallback) {
              diagData.aboutClientHtml = fallback.innerHTML?.slice(0, 3000) || null;
              log.push(`DIAG fallback <${fallback.tagName} cls="${fallback.className?.toString()?.slice(0,80)}">`);
              if (diagData.aboutClientHtml) log.push(`DIAG fallback HTML: ${diagData.aboutClientHtml.slice(0, 2000)}`);
            } else {
              log.push("DIAG: no aboutClient container found");
            }
          }
          // All li/dt/dd/facts containing payment or proposal text
          const items = allEls.filter(el => {
            if (!["LI","DT","DD","SPAN","P","DIV"].includes(el.tagName)) return false;
            const t = (el.textContent || "").toLowerCase();
            return (t.includes("payment") || t.includes("verif") || t.includes("proposal") || t.includes("spent")) && el.children.length < 4 && t.length < 200;
          });
          for (const el of items.slice(0, 20)) {
            const entry = { tag: el.tagName, cls: (el.className?.toString()||"").slice(0,80), text: el.textContent?.trim()?.slice(0,100), dt: el.getAttribute("data-test") };
            diagData.allItems.push(entry);
            log.push(`DIAG item <${entry.tag} cls="${entry.cls}" dt="${entry.dt}">: "${entry.text}"`);
          }
          // All data-test attributes (full page map)
          const dtEls = [...document.querySelectorAll("[data-test]")].slice(0, 60);
          diagData.dataTestMap = dtEls.map(el => `[data-test="${el.getAttribute("data-test")}"]<${el.tagName}>"${el.textContent?.trim()?.slice(0,40)}"`);
          log.push(`DIAG data-test elements (${dtEls.length}): ${diagData.dataTestMap.slice(0,30).join(" | ")}`);
          // Shadow DOM scan
          const shadowHosts = allEls.filter(el => el.shadowRoot);
          diagData.shadowHosts = shadowHosts.length;
          if (shadowHosts.length) log.push(`DIAG shadow hosts: ${shadowHosts.length}`);
          for (const h of shadowHosts.slice(0, 4)) {
            const t = h.shadowRoot?.textContent || "";
            if (/payment|verif/i.test(t)) log.push(`DIAG shadow match in <${h.tagName}>: ${t.slice(0, 200)}`);
          }
        } catch(e) { log.push(`DIAG error: ${e.message}`); }

        // ── S5: Collect payment-related DOM elements ───────────────────────
        const domElements = [];
        try {
          const els = [...document.querySelectorAll("[class*='payment' i],[data-test*='payment' i],[data-cy*='payment' i],[aria-label*='payment' i],[class*='verified' i],[data-test*='verified' i]")].slice(0, 20);
          for (const el of els) {
            domElements.push({ tag: el.tagName, class: (el.className?.toString()||"").slice(0,80), text: el.textContent?.trim()?.slice(0,80), dataTest: el.getAttribute("data-test"), dataCy: el.getAttribute("data-cy"), ariaLabel: el.getAttribute("aria-label") });
          }
        } catch {}

        // ── S6: Proposal count — "Activity on this job" section ONLY ─────────
        // Upwork official values: "Less than 5" | "5 to 10" | "10 to 15" |
        //   "15 to 20" | "20 to 50" | "50+"
        // Any other source is IGNORED (no full-page scanning).
        let proposalText = null;
        let proposalSource = null;
        try {
          // Step 1: find the "Activity on this job" heading (leaf text node)
          const allEls = [...document.querySelectorAll("*")];
          const activityHead = allEls.find(el => {
            const t = (el.textContent || "").trim();
            return /^activity\s+on\s+(this\s+)?job$/i.test(t) && el.children.length === 0;
          });

          log.push(`S6 "Activity on this job" widget found: ${activityHead ? "YES" : "NO"}`);

          if (activityHead) {
            // Step 2: walk up to find the section container
            let section = activityHead;
            for (let i = 0; i < 8 && section && section !== document.body; i++) {
              section = section.parentElement;
              const tag = section?.tagName || "";
              const cls = section?.className?.toString() || "";
              if (tag === "SECTION" || tag === "ASIDE" ||
                  /widget|card|panel|module|activity/i.test(cls) ||
                  section?.querySelectorAll?.("li,dt,dd")?.length > 1) break;
            }

            const sectionText = (section?.innerText || activityHead.closest("section,aside,div")?.innerText || "").replace(/\s+/g, " ");
            log.push(`S6 Activity section text: "${sectionText.slice(0, 300)}"`);

            // Step 3: extract "Proposals: <value>" from section text only
            const propM = sectionText.match(/Proposals?\s*:\s*([^\n\r,;.]{3,30})/i);
            if (propM) {
              proposalText = propM[1].trim();
              proposalSource = "Activity on this job";
              log.push(`S6 Raw proposal text: "${proposalText}"`);
              log.push(`S6 Source: ${proposalSource}`);
            } else {
              log.push(`S6 "Proposals:" label not found in Activity section`);
            }
          } else {
            log.push(`S6 Proposal count: null (Activity widget not found — not guessing)`);
          }
        } catch(e) { log.push(`S6 proposals error: ${e.message}`); }

        return {
          pvStatus,
          matchedStrategy,
          log,
          domElements,
          proposalText,
          diagData,
          pageTitle: document.title?.slice(0, 80),
          url: location.href,
        };
      },
    });

    const r = injection?.result;
    if (!r) {
      bgLog(`[PV:4] Script injection returned no result`);
      return { pvStatus: null, proposalCount: null, proposalRange: null };
    }

    bgLog(`[PV:4] pvStatus=${r.pvStatus} strategy=${r.matchedStrategy}`);
    bgLog(`[PV:4] Detection log (${r.log?.length ?? 0} entries):`);
    for (const entry of r.log ?? []) bgLog(`        ${entry}`);

    if (r.domElements?.length > 0) {
      bgLog(`[PV:5] Payment DOM elements: ${r.domElements.length}`);
      for (const el of r.domElements.slice(0, 5)) {
        bgLog(`        <${el.tag}> class="${el.class}" text="${el.text}" data-test="${el.dataTest}" aria="${el.ariaLabel}"`);
      }
    } else {
      bgLog(`[PV:5] No payment DOM elements found`);
    }

    const proposalCount = parseProposalCountFromText(r.proposalText);
    bgLog(`[PV:6] Proposal widget found: ${r.proposalText != null ? "YES" : "NO"}`);
    bgLog(`[PV:6] Raw proposal text: "${r.proposalText ?? "null"}"`);
    bgLog(`[PV:6] Parsed proposal count: ${proposalCount ?? "null"}`);
    bgLog(`[PV:6] Source: Activity on this job`);

    return {
      pvStatus: r.pvStatus ?? null,
      proposalCount,
      proposalRange: r.proposalText ?? null,
    };

  } catch (err) {
    bgLog(`[PV] Tab-based verification error: ${err.message}`);
    return { pvStatus: null, proposalCount: null, proposalRange: null };
  } finally {
    if (tab) {
      chrome.tabs.remove(tab.id).catch(() => {});
      bgLog(`[PV] Tab ${tab.id} closed`);
    }
  }
}

// ── Parse Upwork official proposal range text ─────────────────────────────
// ONLY accepts official Upwork "Activity on this job" values.
// Maps to a representative midpoint for the >= 5 filter check.
//
// Official values → representative count:
//   "Less than 5"  → 4   (qualifies: 4 < 5  → can notify)
//   "5 to 10"      → 7   (blocked: 7 >= 5)
//   "10 to 15"     → 12  (blocked)
//   "15 to 20"     → 17  (blocked)
//   "20 to 50"     → 35  (blocked)
//   "50+"          → 50  (blocked)
//   anything else  → null (do NOT guess — return null)
function parseProposalCountFromText(text) {
  if (!text) return null;
  const t = String(text).trim().toLowerCase().replace(/\s+/g, " ");

  if (/^less than 5$/i.test(t))        return 4;
  if (/^5\s*(to|-|–)\s*10$/i.test(t))  return 7;
  if (/^10\s*(to|-|–)\s*15$/i.test(t)) return 12;
  if (/^15\s*(to|-|–)\s*20$/i.test(t)) return 17;
  if (/^20\s*(to|-|–)\s*50$/i.test(t)) return 35;
  if (/^50\+?$/.test(t))               return 50;

  return null; // Unknown — do NOT fall through to guessing
}

// ── Wait for a tab to reach "complete" status ─────────────────────────────
function waitForTabLoad(tabId, timeoutMs = 25000) {
  return new Promise((resolve) => {
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(() => {
      bgLog(`[PV] waitForTabLoad timeout after ${timeoutMs}ms`);
      finish();
    }, timeoutMs);

    function listener(id, info) {
      if (id === tabId && info.status === "complete") finish();
    }

    chrome.tabs.onUpdated.addListener(listener);

    // In case the tab already loaded before we added the listener
    chrome.tabs.get(tabId, (t) => {
      if (t?.status === "complete") finish();
    });
  });
}

// ── Manual DOM diagnostic (triggered from popup) ──────────────────────────
/**
 * Opens a background tab for `url`, waits for React hydration, then runs
 * the full diagnostic script. Results stored in chrome.storage.local as
 * "lastDiagnostic" so the popup can poll and display them.
 */
async function diagnoseJobUrl(url) {
  bgLog(`[DIAG] Starting diagnostic for: ${url}`);
  await chrome.storage.local.set({ lastDiagnostic: { url, ts: Date.now(), status: "running", log: [] } });
  let tab = null;
  try {
    tab = await chrome.tabs.create({ url, active: false });
    bgLog(`[DIAG] Tab id=${tab.id} opened — waiting for load`);
    await waitForTabLoad(tab.id, 30000);
    bgLog(`[DIAG] Loaded — waiting 5s for React hydration`);
    await new Promise(r => setTimeout(r, 5000));

    // Scroll to activate lazy content
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => { try { window.scrollTo(0, 800); window.scrollTo(0, 0); } catch {} } });
    await new Promise(r => setTimeout(r, 2000));

    bgLog(`[DIAG] Running full extraction + diagnostic script`);
    const [inj] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: function upworkDiagnosticFull() {
        const log = [];
        let pvStatus = null;
        let matchedStrategy = null;

        // ── T0: Full text-node TreeWalker ─────────────────────────────────
        const paymentNodes = [];
        const proposalNodes = [];
        try {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
          let node;
          while ((node = walker.nextNode())) {
            const text = (node.textContent || "").trim();
            if (!text || text.length > 400 || text.length < 2) continue;
            const tl = text.toLowerCase();
            const isP = /payment|verif/.test(tl);
            const isPr = /proposal|applicant|\bbid\b/.test(tl);
            if (!isP && !isPr) continue;
            const p = node.parentElement;
            const gp = p?.parentElement;
            const info = {
              text: text.slice(0, 150),
              pTag: p?.tagName, pClass: (p?.className?.toString()||"").slice(0,100),
              pDataTest: p?.getAttribute("data-test"), pDataCy: p?.getAttribute("data-cy"),
              pAriaLabel: p?.getAttribute("aria-label"), pRole: p?.getAttribute("role"),
              pId: p?.id,
              gpTag: gp?.tagName, gpClass: (gp?.className?.toString()||"").slice(0,80),
              gpDataTest: gp?.getAttribute("data-test"), gpId: gp?.id,
            };
            if (isP) {
              paymentNodes.push(info);
              if (pvStatus === null && tl.includes("payment") && tl.includes("verif")) {
                pvStatus = !(tl.includes("not verif") || tl.includes("unverif"));
                matchedStrategy = `T0:textNode:"${text.slice(0,70)}"`;
              }
            }
            if (isPr) proposalNodes.push(info);
          }
          log.push(`T0 walk: ${paymentNodes.length} payment nodes, ${proposalNodes.length} proposal nodes`);
          for (const n of paymentNodes) {
            log.push(`T0 💳 "${n.text}" | <${n.pTag} id="${n.pId}" cls="${n.pClass}" dt="${n.pDataTest}" aria="${n.pAriaLabel}">`);
          }
          for (const n of proposalNodes) {
            log.push(`T0 📊 "${n.text}" | <${n.pTag} id="${n.pId}" cls="${n.pClass}" dt="${n.pDataTest}">`);
          }
        } catch(e) { log.push(`T0 error: ${e.message}`); }

        // ── T1: SVG aria-label / title scan ───────────────────────────────
        try {
          for (const svg of document.querySelectorAll("svg, use")) {
            const a = svg.getAttribute("aria-label") || "";
            const t = svg.querySelector?.("title")?.textContent || "";
            const c = (a + " " + t).toLowerCase();
            if (/payment|verif/.test(c)) {
              log.push(`T1 SVG: aria="${a}" title="${t}"`);
              if (pvStatus === null) {
                if (c.includes("verif") && !c.includes("not verif") && !c.includes("unverif")) {
                  pvStatus = true; matchedStrategy = `T1:SVG:aria="${a}"`;
                } else if (c.includes("not verif") || c.includes("unverif")) {
                  pvStatus = false; matchedStrategy = `T1:SVG:aria="${a}"`;
                }
              }
            }
          }
        } catch(e) { log.push(`T1 SVG error: ${e.message}`); }

        // ── S1: Window globals ─────────────────────────────────────────────
        if (pvStatus === null) {
          const keys = ["__NEXT_DATA__","__APOLLO_STATE__","__INITIAL_STATE__","__REDUX_STATE__","__PRELOADED_STATE__"];
          for (const key of keys) {
            try {
              if (!window[key]) continue;
              const json = JSON.stringify(window[key]);
              if (!/payment|verif/i.test(json)) continue;
              log.push(`S1 window.${key} contains payment data (${json.length} chars)`);
              const excerpts = [];
              const rx = /.{0,60}(?:payment|verif).{0,80}/gi;
              let m;
              while ((m = rx.exec(json)) !== null && excerpts.length < 6) excerpts.push(m[0].replace(/\s+/g," ").slice(0,120));
              for (const ex of excerpts) log.push(`S1   ctx: ${ex}`);
              const vm = json.match(/"paymentVerificationStatus"\s*:\s*"([^"]+)"/);
              if (vm) { log.push(`S1 paymentVerificationStatus="${vm[1]}"`); pvStatus = /^verif/i.test(vm[1]); matchedStrategy = `S1:${key}`; break; }
            } catch {}
          }
        }

        // ── S4: Body text scan ─────────────────────────────────────────────
        const bodyText = document.body.innerText || "";
        const bodyLen = bodyText.length;
        log.push(`S4 body text length: ${bodyLen}`);
        if (/payment/i.test(bodyText)) {
          const mx = bodyText.match(/.{0,60}payment.{0,80}/gi);
          for (const x of (mx||[]).slice(0,8)) log.push(`S4 body ctx: "${x.trim().replace(/\s+/g," ")}"`);
        } else {
          log.push("S4 body: 'payment' NOT found in page text (page may not be fully hydrated)");
        }

        // ── DIAG: About the Client HTML dump ──────────────────────────────
        const diagData = { aboutClientHtml: null, allItems: [], dataTestMap: [], allDump: null };
        try {
          const allEls = [...document.querySelectorAll("*")];
          // Find heading "About the client"
          const aboutHead = allEls.find(el =>
            /about.*client|client.*info/i.test(el.textContent?.trim() || "") &&
            el.children.length === 0 && (el.textContent?.trim().length || 0) < 60
          );
          if (aboutHead) {
            let sec = aboutHead;
            for (let i = 0; i < 8 && sec && sec !== document.body; i++) {
              sec = sec.parentElement;
              if (sec && (sec.tagName === "SECTION" || sec.tagName === "ASIDE" ||
                /widget|card|panel|module|sidebar/i.test(sec.className?.toString() || ""))) break;
            }
            diagData.aboutClientHtml = sec?.innerHTML?.replace(/<script[\s\S]*?<\/script>/gi,"")?.slice(0, 6000) || null;
            log.push(`DIAG aboutClient: heading="${aboutHead.textContent?.trim()?.slice(0,60)}" parent=<${sec?.tagName} cls="${sec?.className?.toString()?.slice(0,80)}">`);
            if (diagData.aboutClientHtml) log.push(`DIAG HTML:\n${diagData.aboutClientHtml.slice(0,4000)}`);
          } else {
            log.push("DIAG: 'About the client' heading NOT found");
            // Dump all li/span/div that contain payment or verified text
            const hits = allEls.filter(el => /payment|verif/i.test(el.textContent||"") && el.children.length < 3 && (el.textContent||"").length < 200);
            for (const el of hits.slice(0,20)) {
              log.push(`DIAG hit: <${el.tagName} id="${el.id}" cls="${(el.className?.toString()||"").slice(0,80)}" dt="${el.getAttribute("data-test")}">: "${el.textContent?.trim()?.slice(0,100)}"`);
            }
          }
          // All data-test elements on page
          const dtEls = [...document.querySelectorAll("[data-test]")];
          diagData.dataTestMap = dtEls.slice(0,80).map(el => `[data-test="${el.getAttribute("data-test")}"]<${el.tagName}>"${el.textContent?.trim()?.slice(0,50)}"`);
          log.push(`DIAG data-test (${dtEls.length} total): ${diagData.dataTestMap.join(" | ")}`);
          // All list items with text
          const lis = [...document.querySelectorAll("li")].filter(li => (li.textContent||"").trim().length > 2 && (li.textContent||"").trim().length < 200);
          log.push(`DIAG all LI (${lis.length}): ${lis.slice(0,30).map(li => `"${li.textContent?.trim()?.slice(0,60)}" cls="${(li.className?.toString()||"").slice(0,40)}"`).join(" | ")}`);
        } catch(e) { log.push(`DIAG error: ${e.message}`); }

        // ── S6: Proposal count — "Activity on this job" section ONLY ─────────
        let proposalText = null;
        let proposalSource = null;
        try {
          const allEls2 = [...document.querySelectorAll("*")];
          const actHead = allEls2.find(el => {
            const t = (el.textContent || "").trim();
            return /^activity\s+on\s+(this\s+)?job$/i.test(t) && el.children.length === 0;
          });
          log.push(`S6 "Activity on this job" widget found: ${actHead ? "YES" : "NO"}`);
          if (actHead) {
            let sec = actHead;
            for (let i = 0; i < 8 && sec && sec !== document.body; i++) {
              sec = sec.parentElement;
              const tag = sec?.tagName || "";
              const cls = sec?.className?.toString() || "";
              if (tag === "SECTION" || tag === "ASIDE" || /widget|card|panel|module|activity/i.test(cls) || sec?.querySelectorAll?.("li,dt,dd")?.length > 1) break;
            }
            const secText = (sec?.innerText || actHead.closest("section,aside,div")?.innerText || "").replace(/\s+/g, " ");
            log.push(`S6 Activity section text: "${secText.slice(0, 300)}"`);
            const propM = secText.match(/Proposals?\s*:\s*([^\n\r,;.]{3,30})/i);
            if (propM) {
              proposalText = propM[1].trim();
              proposalSource = "Activity on this job";
              log.push(`S6 Raw proposal text: "${proposalText}"`);
              log.push(`S6 Source: ${proposalSource}`);
            } else {
              log.push(`S6 "Proposals:" label not found inside Activity section`);
            }
          } else {
            log.push("S6 Proposal count: null (Activity widget not found — not guessing)");
          }
        } catch(e) { log.push(`S6 proposals error: ${e.message}`); }

        return { pvStatus, matchedStrategy, log, proposalText, diagData, pageTitle: document.title?.slice(0,100), url: location.href };
      },
    });

    const result = inj?.result ?? {};
    const store = {
      url,
      pageTitle: result.pageTitle,
      ts: Date.now(),
      status: "done",
      pvStatus: result.pvStatus,
      matchedStrategy: result.matchedStrategy,
      proposalText: result.proposalText,
      log: result.log ?? [],
      diagData: result.diagData,
    };
    await chrome.storage.local.set({ lastDiagnostic: store });

    bgLog(`[DIAG] DONE pvStatus=${result.pvStatus} strategy=${result.matchedStrategy}`);
    bgLog(`[DIAG] ${result.log?.length ?? 0} log lines — see popup Debug > Diagnostic tab`);
    for (const line of (result.log ?? [])) bgLog(`[DIAG]   ${line}`);
  } catch(err) {
    bgLog(`[DIAG] Error: ${err.message}`);
    await chrome.storage.local.set({ lastDiagnostic: { url, ts: Date.now(), status: "error", error: err.message, log: [] } });
  } finally {
    if (tab) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// ── Job handling ──────────────────────────────────────────────────────────
async function handleJob(job, simMode) {
  const t0 = Date.now(); // ── end-to-end latency start

  // [TRACE-BG-2] PIPELINE ENTRY REACHED — this fires immediately when handleJob() is called.
  // If TRACE-BG-1 appears but TRACE-BG-2 never appears, route() crashed before the call.
  // If neither appears, background.js never received the message.
  bgLog(`[TRACE-BG-2] *** PIPELINE ENTRY REACHED *** id=${job?.upworkJobId ?? "??"} title="${(job?.title ?? "??").slice(0,50)}" [t=0ms]`);

  const { config } = await chrome.storage.local.get("config");

  // ── STEP 1: Job received ─────────────────────────────────────────────────
  const pvListingLabel = job.paymentVerified === null ? "UNKNOWN" : job.paymentVerified ? "VERIFIED" : "NOT_VERIFIED";
  bgLog(`[1/8] Job received: "${job.title}" (${job.upworkJobId ?? "no-id"}) [t=0ms]`);
  bgLog(`      apiBase=${config?.apiBase || "(empty)"} | enabled=${config?.enabled} | sim=${simMode || config?.simulationMode}`);
  bgLog(`      💳 Payment from listing: ${pvListingLabel}`);
  bgLog(`      📊 Proposals from listing: ${job.proposalCount ?? "UNKNOWN"}`);

  if (!config?.enabled) {
    bgLog(`      ⏭ Monitoring disabled`);
    return { skipped: true, reason: "disabled" };
  }

  // ── Single-entry pipeline lock ───────────────────────────────────────────
  // sessionSeenIds is the ONLY gate for duplicate entry within one SW lifetime.
  // It is populated synchronously — before any await — so concurrent
  // handleJob() calls from MutationObserver, heartbeat, and initial scan all
  // race-safely against the same check.
  //
  // Persistent storage is NOT checked here.  After a SW restart the session
  // Set is empty, so previously-seen jobs re-enter the pipeline and hit the
  // API.  The API returns 409 for anything already in the DB, and the 409
  // handler (below in submitJob) triggers analysis recovery if needed.
  // This guarantees: no job is silently dropped due to a stale cache entry.
  if (job.upworkJobId) {
    if (sessionSeenIds.has(job.upworkJobId)) {
      bgLog(`      ⏭ [LOCK] ${job.upworkJobId} — already in pipeline this SW session`);
      return { skipped: true, reason: "seen_this_session" };
    }
    sessionSeenIds.add(job.upworkJobId);  // atomic — no concurrent re-entry possible
  }

  // ── Simulation mode ──────────────────────────────────────────────────────
  if (simMode || config.simulationMode) {
    bgLog(`[SIM] ⚠️  SIMULATION MODE — job NOT submitted`);
    await addLog({ ts: Date.now(), msg: "[SIM] Job detected (not submitted)", data: { title: job.title, url: job.jobUrl } });
    await bump("detected");
    return { simulated: true };
  }

  if (!config?.apiBase) {
    bgLog(`[ERR] apiBase not configured`);
    return { error: "apiBase not configured", hint: "Open extension popup and save your Dashboard URL" };
  }

  // ── STEP 2: Payment verification ─────────────────────────────────────────
  // Decision rule: ONLY Payment Verified jobs proceed.
  // NOT_VERIFIED or UNKNOWN → skip without submitting to API.
  let pvSource = "listing_page";
  let freshProposalCount = job.proposalCount ?? null;   // updated if detail tab opens
  let freshProposalRange = null;

  if (job.paymentVerified === true) {
    bgLog(`[2/8] 💳 VERIFIED (listing page) ✅ [t=${Date.now()-t0}ms]`);
    // Issue 6: proposal count from listing is almost always stale/null — always
    // fetch fresh from the detail page "Activity on this job" section.
    if (freshProposalCount == null) {
      bgLog(`[2/8] 📊 Proposal count unknown from listing — opening detail tab for freshness...`);
      const detailUrl = job.jobUrl ?? `https://www.upwork.com/jobs/~${job.upworkJobId}`;
      const { proposalCount: tabProposalCount, proposalRange } =
        await fetchPaymentStatusFromDetailPage(detailUrl);
      if (tabProposalCount != null) {
        freshProposalCount = tabProposalCount;
        freshProposalRange = proposalRange;
        bgLog(`[2/8] 📊 Fresh proposal count: "${proposalRange}" → ${freshProposalCount} [t=${Date.now()-t0}ms]`);
      } else {
        bgLog(`[2/8] 📊 Proposal count still unknown after detail tab — proceeding without it`);
      }
    }

  } else if (job.paymentVerified === false) {
    // Confirmed NOT verified on listing — skip immediately
    bgLog(`[2/8] 💳 NOT_VERIFIED (listing page) ❌ — skipping, no API call`);
    await addLog({
      ts: Date.now(), msg: "SKIP: Payment not verified",
      data: { title: job.title, paymentStatus: "NOT_VERIFIED", pvSource: "listing_page",
              proposalCount: job.proposalCount, decision: "SKIP",
              reason: "Client payment not verified (listing page)" },
    });
    return { skipped: true, reason: "payment_not_verified" };

  } else {
    // paymentVerified === null — unknown from listing, open detail page tab
    bgLog(`[2/8] 💳 UNKNOWN (listing page) — opening detail tab to verify...`);
    const detailUrl = job.jobUrl ?? `https://www.upwork.com/jobs/~${job.upworkJobId}`;
    const { pvStatus, proposalCount: tabProposalCount, proposalRange } =
      await fetchPaymentStatusFromDetailPage(detailUrl);

    // Capture fresh proposal count from the rendered detail page
    if (tabProposalCount != null) {
      freshProposalCount = tabProposalCount;
      freshProposalRange = proposalRange;
      bgLog(`[2/8] 📊 Fresh proposal count from detail tab: ${freshProposalCount} ("${freshProposalRange}")`);
    }

    if (pvStatus === true) {
      pvSource = "detail_page";
      job = { ...job, paymentVerified: true };
      bgLog(`[2/8] 💳 VERIFIED (detail page) ✅`);
    } else if (pvStatus === false) {
      bgLog(`[2/8] 💳 NOT_VERIFIED (detail page) ❌ — skipping`);
      await addLog({
        ts: Date.now(), msg: "SKIP: Payment not verified",
        data: { title: job.title, paymentStatus: "NOT_VERIFIED", pvSource: "detail_page",
                proposalCount: freshProposalCount, proposalRange: freshProposalRange,
                decision: "SKIP", reason: "Client payment not verified (detail page)" },
      });
      return { skipped: true, reason: "payment_not_verified" };
    } else {
      // Detail tab loaded but payment status still unreadable — Upwork may have
      // changed their markup or the tab timed out.
      // Do NOT skip: proceed with paymentVerified=null so the AI scoring stage
      // still evaluates the job.  Skipping here would silently drop every job
      // whenever Upwork's HTML structure changes.
      pvSource = "unknown";
      bgLog(`[2/8] 💳 UNKNOWN after detail tab ⚠️ — proceeding to AI scoring (markup unreadable)`);
      await addLog({
        ts: Date.now(), msg: "WARN: Payment status unreadable — forwarding to AI scoring",
        data: { title: job.title, paymentStatus: "UNKNOWN", pvSource: "unavailable",
                proposalCount: freshProposalCount, proposalRange: freshProposalRange,
                decision: "PROCEED", reason: "Upwork markup unreadable — AI scoring will decide" },
      });
    }
  }

  // ── STEP 2.5: Proposal count check ───────────────────────────────────────
  // Notification rule: paymentVerified=true AND proposalCount < 5 → notify.
  // Source: "Activity on this job" section ONLY (official Upwork values).
  // Official mapping: "Less than 5"→4 (pass) | "5 to 10"→7 | "20 to 50"→35 | "50+"→50 (all block)
  // null → unknown → let API decide (don't block on missing data)
  const proposalLabel = freshProposalRange
    ? `"${freshProposalRange}" → ${freshProposalCount}`
    : (freshProposalCount != null ? String(freshProposalCount) : "UNKNOWN (Activity section not found)");

  bgLog(`[2.5/8] 📊 Proposal widget found: ${freshProposalRange != null ? "YES" : "NO"}`);
  bgLog(`[2.5/8] 📊 Raw proposal text: "${freshProposalRange ?? "null"}"`);
  bgLog(`[2.5/8] 📊 Parsed proposal count: ${freshProposalCount ?? "null"}`);
  bgLog(`[2.5/8] 📊 Source: Activity on this job | pvSource: ${pvSource}`);

  if (freshProposalCount != null && freshProposalCount >= 5) {
    bgLog(`[2.5/8] ⛔ Too many proposals: "${freshProposalRange}" (${freshProposalCount}) — skipping (rule: paymentVerified=true AND proposalCount<5)`);
    await addLog({
      ts: Date.now(), msg: "SKIP: Too many proposals",
      data: { title: job.title, paymentStatus: "VERIFIED", pvSource,
              proposalCount: freshProposalCount, proposalRange: freshProposalRange,
              decision: "SKIP", reason: `Too many proposals: ${freshProposalCount} (must be < 5)` },
    });
    return { skipped: true, reason: "too_many_proposals" };
  }

  bgLog(`[2.5/8] ✅ Proposal check passed: ${proposalLabel} (< 5 or unknown — proceeding)`);

  // Update job with freshest proposal count and PV source
  job = {
    ...job,
    _pvSource: pvSource,
    proposalCount: freshProposalCount ?? job.proposalCount,
  };

  bgLog(`[3/8] All pre-filters passed → POST ${config.apiBase}/jobs [t=${Date.now()-t0}ms]`);
  bgLog(`      💳 Payment: VERIFIED | 📊 Proposals: ${proposalLabel} | Source: ${pvSource}`);

  // ── STEP 3: Submit to API ────────────────────────────────────────────────
  try {
    return await submitJob(job, config);
  } catch (err) {
    bgLog(`[ERR] POST failed: ${err.message} — queuing job`);
    await enqueue({ kind: "job", payload: job });
    return { queued: true };
  }
}

// ── Event handling ────────────────────────────────────────────────────────
async function handleEvent(event, simMode) {
  const { config } = await chrome.storage.local.get("config");
  if (!config?.enabled) return { skipped: true };

  if (simMode || config.simulationMode) {
    bgLog(`SIM: event "${event.type}"`);
    await addLog({ ts: Date.now(), msg: "SIMULATION: Event detected", data: event });
    return { simulated: true };
  }

  try {
    return await submitEvent(event, config);
  } catch (err) {
    bgLog("Event submit failed, queuing: " + err.message);
    await enqueue({ kind: "event", payload: event });
    return { queued: true };
  }
}

// ── HTTP: job submission ──────────────────────────────────────────────────
async function submitJob(job, config) {
  if (!config?.apiBase) throw new Error("API base not configured");
  const t0 = Date.now();

  let res;
  try {
    res = await fetch(`${config.apiBase}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(job),
      signal: AbortSignal.timeout(12000),
    });
  } catch (fetchErr) {
    // Network-level failure (CORS, DNS, timeout, host_permissions missing)
    bgLog(`[ERR] fetch() threw: ${fetchErr.message}`);
    bgLog(`      Check: is ${config.apiBase} reachable? Is host_permissions set in manifest?`);
    throw fetchErr;
  }

  // ── STEP 3: API response received ─────────────────────────────────────
  bgLog(`[3/7] ⏱ API response: HTTP ${res.status} in ${Date.now() - t0}ms (submit latency)`);

  if (res.status === 409) {
    const body = await res.json().catch(() => ({}));
    const existing = body.job;
    const existStatus = existing?.status ?? "unknown";
    const existScore  = existing?.applyScore != null ? String(existing.applyScore) : "–";
    bgLog(`      ⏭ [SKIP:db-dup] Already in DB — id=${existing?.id ?? "?"} status=${existStatus} applyScore=${existScore}`);

    // ── Recovery: un-analyzed jobs ────────────────────────────────────────
    // If the job is already in the DB but has no AI score (e.g., a previous
    // session inserted it but crashed before analysis ran), trigger analysis
    // now so the full pipeline — scoring → Telegram notification — completes.
    // Recovery trigger: applyScore == null is the ONLY reliable indicator of
    // "never analyzed".  Do NOT use status === "new" — review jobs keep
    // status="new" after scoring and must not be re-analyzed on every detection.
    if (existing?.id && existing.applyScore == null) {
      bgLog(`      🔄 [RECOVER] Job id=${existing.id} in DB with no score — triggering analysis + notification`);
      analyzeAsync(existing.id, config.apiBase);
    }

    await markSeen(job.upworkJobId);
    return { skipped: true, reason: "duplicate_in_db" };
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    bgLog(`[ERR] API error: ${err.error ?? res.status}`);
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }

  // ── STEP 4: Job saved to database ─────────────────────────────────────
  const saved = await res.json();
  bgLog(`[4/7] Job saved to database — id=${saved.id} title="${saved.title}"`);
  await markSeen(job.upworkJobId);
  await bump("submitted");
  await bump("detected");

  notify("UpworkAI: Job Detected", `"${saved.title}" sent for AI analysis`);

  // ── STEP 5: AI analysis triggered ─────────────────────────────────────
  bgLog(`[5/7] AI analysis triggered for job id=${saved.id}`);
  analyzeAsync(saved.id, config.apiBase);

  return { success: true, job: saved };
}

// ── HTTP: event submission ────────────────────────────────────────────────
async function submitEvent(event, config) {
  if (!config?.apiBase) throw new Error("API base not configured");

  const res = await fetch(`${config.apiBase}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }

  await bump("messages");
  const labels = {
    message_received: "New Message 💬",
    interview_invite: "Interview Invite! 🎯",
    contract_offer: "Contract Offer! 🤝",
    proposal_reply: "Proposal Reply 📩",
  };
  notify(`UpworkAI: ${labels[event.type] ?? "New Event"}`, event.body || event.title, 2);
  bgLog(`Event submitted: ${event.type}`);
  return { success: true };
}

// ── Background AI analysis ────────────────────────────────────────────────
async function analyzeAsync(jobId, apiBase) {
  const tAI = Date.now();
  try {
    bgLog(`[5/7] POST ${apiBase}/jobs/${jobId}/analyze (AI scoring)`);
    const r = await fetch(`${apiBase}/jobs/${jobId}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(35000),
    });
    if (!r.ok) {
      bgLog(`[ERR] AI analysis failed: HTTP ${r.status} in ${Date.now()-tAI}ms`);
      return;
    }
    const analysis = await r.json();

    // ── STEP 6: AI result received ───────────────────────────────────────
    bgLog(`[6/7] ⏱ AI analysis complete in ${Date.now()-tAI}ms — applyScore=${analysis.applyScore} risk=${analysis.riskScore} win=${analysis.winProbability} rec=${analysis.recommendation}`);

    // ── STEP 7: Notification (WhatsApp + Telegram via server) ────────────
    const threshold = 70;
    if ((analysis.applyScore ?? 0) >= threshold) {
      bgLog(`[7/7] Score ${analysis.applyScore} ≥ ${threshold} — browser notification sent; WhatsApp/Telegram dispatched by server`);
      notify(
        `UpworkAI: High Score! ${analysis.applyScore}/100 ⭐`,
        `${(analysis.recommendation ?? "review").toUpperCase()} — check dashboard.`,
        2
      );
    } else {
      bgLog(`[7/7] Score ${analysis.applyScore} < ${threshold} — no notification (below threshold)`);
    }
  } catch (err) {
    bgLog(`[ERR] analyzeAsync failed: ${err.message}`);
  }
}

// ── Telegram → Auto-Apply pipeline ───────────────────────────────────────
/**
 * pollApplyTriggers — runs every ~30 s via chrome alarm.
 *
 * 1. GET /api/apply-trigger/pending  — check for a Telegram-triggered apply
 * 2. POST /api/apply-trigger/:id/claim — atomically claim it
 * 3. Open Upwork proposal page in a background tab
 * 4. Inject auto-fill script (fills cover letter, submits)
 * 5. POST /api/apply-trigger/:id/complete — report result back to server
 */
async function pollApplyTriggers() {
  const { config } = await chrome.storage.local.get("config");
  if (!config?.apiBase) return;

  let data;
  try {
    const res = await fetch(`${config.apiBase}/apply-trigger/pending`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return;
    data = await res.json();
  } catch {
    return;
  }

  const { trigger, job } = data ?? {};
  if (!trigger || !job) return;

  bgLog(`[AUTO-APPLY:1] Trigger found id=${trigger.id} jobId=${job.id} "${job.title?.slice(0,50)}"`);

  // ── Claim immediately to prevent double-execution ────────────────────────
  try {
    await fetch(`${config.apiBase}/apply-trigger/${trigger.id}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    bgLog(`[AUTO-APPLY:ERR] Claim failed: ${err.message}`);
    return;
  }

  // ── Build Upwork proposal page URL ───────────────────────────────────────
  // Format: https://www.upwork.com/ab/proposals/job/~{upworkJobId}/apply/
  const upworkJobId = job.upworkJobId ?? "";
  const applyUrl = upworkJobId
    ? `https://www.upwork.com/ab/proposals/job/~${upworkJobId}/apply/`
    : job.jobUrl ?? "";

  if (!applyUrl) {
    bgLog(`[AUTO-APPLY:ERR] No URL for job ${job.id}`);
    await reportApplyResult(config.apiBase, trigger.id, false, "No Upwork URL available");
    return;
  }

  bgLog(`[AUTO-APPLY:2] Opening apply page: ${applyUrl}`);
  notify("UpworkAI: Auto-Apply Started", `Opening: ${job.title?.slice(0, 60)}`);

  let tab = null;
  try {
    tab = await chrome.tabs.create({ url: applyUrl, active: false });
    bgLog(`[AUTO-APPLY:3] Tab created id=${tab.id} — waiting for page load`);

    await waitForTabLoad(tab.id, 30000);
    bgLog(`[AUTO-APPLY:4] Page loaded — pausing 5s for React hydration`);
    await new Promise((r) => setTimeout(r, 5000));

    // ── Inject proposal-filling script ─────────────────────────────────────
    const proposalText = trigger.proposalText;
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: upworkAutoFillProposal,
      args: [proposalText],
    });

    const fillResult = result?.result ?? { success: false, error: "No result" };
    bgLog(`[AUTO-APPLY:5] Fill result: success=${fillResult.success} msg=${fillResult.message}`);

    if (fillResult.success) {
      bgLog(`[AUTO-APPLY:6] Proposal filled — waiting 2s then submitting`);
      await new Promise((r) => setTimeout(r, 2000));

      // Submit the form
      const [submitResult] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: upworkSubmitProposal,
        args: [],
      });

      const submitted = submitResult?.result ?? { success: false };
      bgLog(`[AUTO-APPLY:7] Submit result: success=${submitted.success}`);

      if (submitted.success) {
        notify("UpworkAI: Proposal Submitted! ✅", `"${job.title?.slice(0, 60)}" — applied!`, 2);
        await reportApplyResult(config.apiBase, trigger.id, true, null);
      } else {
        notify("UpworkAI: Submit Failed ⚠️", submitted.error ?? "Unknown error");
        await reportApplyResult(config.apiBase, trigger.id, false, submitted.error ?? "Submit failed");
      }
    } else {
      notify("UpworkAI: Form Fill Failed ⚠️", fillResult.error ?? fillResult.message ?? "Could not fill form");
      await reportApplyResult(config.apiBase, trigger.id, false, fillResult.error ?? fillResult.message);
    }
  } catch (err) {
    bgLog(`[AUTO-APPLY:ERR] Fatal: ${err.message}`);
    await reportApplyResult(config.apiBase, trigger.id, false, err.message);
  } finally {
    // Close the tab whether we succeeded or failed
    if (tab?.id) {
      try { await chrome.tabs.remove(tab.id); } catch {}
    }
  }
}

async function reportApplyResult(apiBase, triggerId, success, error) {
  try {
    await fetch(`${apiBase}/apply-trigger/${triggerId}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ success, error }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    bgLog(`[AUTO-APPLY:ERR] Could not report result: ${err.message}`);
  }
}

/**
 * upworkAutoFillProposal — injected into the Upwork proposal tab.
 * Finds the cover letter textarea and fills it with the generated proposal.
 * Must be fully self-contained (no closure references).
 */
function upworkAutoFillProposal(proposalText) {
  const log = [];

  // ── Strategy 1: data-test selectors ────────────────────────────────────
  const TEXTAREA_SELECTORS = [
    '[data-test="cover-letter-text"] textarea',
    '[data-test="cover-letter"] textarea',
    'textarea[name="cover_letter"]',
    'textarea[placeholder*="cover letter" i]',
    'textarea[placeholder*="introduce yourself" i]',
    'textarea[aria-label*="cover letter" i]',
    'textarea[aria-label*="Cover Letter" i]',
    '[data-cy="cover-letter"] textarea',
    '.cover-letter textarea',
    '.js-cover-letter',
    'textarea[id*="coverLetter" i]',
    'textarea[id*="cover-letter" i]',
    // Generic large textarea fallback (Upwork only has one main one)
    'textarea[rows]',
    'textarea',
  ];

  let textarea = null;
  let usedSelector = null;
  for (const sel of TEXTAREA_SELECTORS) {
    try {
      const el = document.querySelector(sel);
      if (el && el.tagName === 'TEXTAREA') {
        textarea = el;
        usedSelector = sel;
        log.push(`Found textarea via: ${sel}`);
        break;
      }
    } catch(e) {
      log.push(`Selector error ${sel}: ${e.message}`);
    }
  }

  if (!textarea) {
    log.push('No cover-letter textarea found');
    return { success: false, error: 'Cover letter textarea not found', log };
  }

  // ── Fill using React synthetic event system ─────────────────────────────
  try {
    // Focus the element
    textarea.focus();
    textarea.click();

    // Clear current value
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    )?.set;

    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(textarea, proposalText);
    } else {
      textarea.value = proposalText;
    }

    // Fire events React listens to
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, data: proposalText }));

    log.push(`Filled textarea (${proposalText.length} chars) via selector: ${usedSelector}`);

    // Verify
    const verified = textarea.value.length > 10;
    return { success: verified, message: verified ? 'Filled successfully' : 'Value did not stick', log };
  } catch(e) {
    return { success: false, error: e.message, log };
  }
}

/**
 * upworkSubmitProposal — injected after fill to click the submit button.
 * Must be fully self-contained.
 */
function upworkSubmitProposal() {
  const SUBMIT_SELECTORS = [
    'button[data-test="submit-proposal"]',
    'button[data-cy="submit-proposal"]',
    'button[type="submit"]',
    'button[data-qa="submit-proposal"]',
    'button.submit-proposal',
    'input[type="submit"]',
  ];

  for (const sel of SUBMIT_SELECTORS) {
    try {
      const btn = document.querySelector(sel);
      if (btn && !btn.disabled) {
        btn.click();
        return { success: true, selector: sel };
      }
    } catch(e) {}
  }

  // Last resort: find a button with submit-like text
  const buttons = [...document.querySelectorAll('button')];
  const submitBtn = buttons.find((b) => {
    const t = (b.textContent || '').toLowerCase().trim();
    return (t.includes('submit') || t.includes('apply') || t.includes('send proposal')) && !b.disabled;
  });

  if (submitBtn) {
    submitBtn.click();
    return { success: true, selector: `text:"${submitBtn.textContent?.trim()?.slice(0,30)}"` };
  }

  return { success: false, error: 'Submit button not found or disabled' };
}

// ── Offline queue ─────────────────────────────────────────────────────────
async function enqueue(item) {
  const { queue } = await chrome.storage.local.get("queue");
  const q = queue ?? [];
  if (q.length >= MAX_QUEUE) q.shift();
  q.push({ ...item, retries: 0, queuedAt: Date.now() });
  await chrome.storage.local.set({ queue: q });
  await bump("queued");
  bgLog(`Queued. Total: ${q.length}`);
}

async function flushQueue() {
  const { queue, config } = await chrome.storage.local.get(["queue", "config"]);
  const q = queue ?? [];
  if (!q.length || !config?.apiBase) return;

  bgLog(`Flushing ${q.length} queued items`);
  const remaining = [];

  for (const item of q) {
    try {
      if (item.kind === "job") await submitJob(item.payload, config);
      else if (item.kind === "event") await submitEvent(item.payload, config);
    } catch {
      const retries = (item.retries ?? 0) + 1;
      if (retries < RETRY_DELAYS.length) remaining.push({ ...item, retries });
      else bgLog(`Dropped after max retries: ${item.kind}`);
    }
  }

  await chrome.storage.local.set({ queue: remaining });
  bgLog(`Queue done — ${remaining.length} remaining`);
}

// ── Helpers ───────────────────────────────────────────────────────────────
async function markSeen(upworkJobId) {
  if (!upworkJobId) return;
  const { seenJobIds } = await chrome.storage.local.get("seenJobIds");
  const seen = seenJobIds ?? [];
  // Cap at 200 — enough to cover a day's worth of seen jobs on an active feed
  // without accumulating stale IDs that pre-block genuinely re-listed jobs.
  await chrome.storage.local.set({ seenJobIds: [...seen.slice(-200), upworkJobId] });
}

async function bump(key) {
  const { stats } = await chrome.storage.local.get("stats");
  const s = stats ?? {};
  s[key] = (s[key] ?? 0) + 1;
  await chrome.storage.local.set({ stats: s });
}

async function addLog(entry) {
  const { debugLogs } = await chrome.storage.local.get("debugLogs");
  const logs = debugLogs ?? [];
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
  await chrome.storage.local.set({ debugLogs: logs });
}

function bgLog(text) {
  console.log(`[UpworkAI BG] ${text}`);
  addLog({ ts: Date.now(), msg: "[BG] " + text, data: {} });
}

function notify(title, message, priority = 1) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon48.png",
    title,
    message: message.slice(0, 200),
    priority,
  });
}

// ── Notification click → open dashboard ──────────────────────────────────
chrome.notifications.onClicked.addListener(async () => {
  const { config } = await chrome.storage.local.get("config");
  if (config?.dashboardUrl) chrome.tabs.create({ url: config.dashboardUrl });
});
