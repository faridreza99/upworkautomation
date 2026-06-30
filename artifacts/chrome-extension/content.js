/**
 * UpworkAI - Content Script v3.0
 *
 * Multi-strategy job detection (priority order):
 *
 *  S1 — JSON extraction from page state (window globals, <script> tags,
 *       React/Apollo/Next hydration data). Preferred: survives HTML changes.
 *  S2 — Anchor-tag scan: a[href*="~"] → filter job URLs → walk DOM for data.
 *  S3 — MutationObserver: re-runs S1+S2 whenever new content is added.
 *  S4 — Polling: retry every 3 s for 90 s until at least one job is found.
 *  S5 — DOM diagnostic report: auto-logged if no jobs found after all retries.
 *
 * Each successful detection logs which strategy found the jobs.
 */
(function () {
  "use strict";

  const TAG = "[UpworkAI]";
  const POLL_INTERVAL_INITIAL_MS = 3000; // 3 s between initial-phase scans
  const POLL_INITIAL_MAX = 30;           // 90 s max for initial phase
  // Heartbeat: random jitter in [25 s, 45 s] — avoids robotic fixed-interval pattern
  const MONITOR_INTERVAL_BASE_MS = 35000;
  const MONITOR_INTERVAL_JITTER_MS = 10000;

  let lastUrl = location.href;
  let cfg = {};
  const seenJobIds = new Set();
  const seenMsgIds = new Set();
  let pollTimer = null;
  let pollCount = 0;
  let monitorHeartbeat = null; // setTimeout handle for continuous monitoring (jittered)
  let jobObserver = null;
  let _moGeneration = 0; // incremented on every startJobObserver() call; prevents orphan MO accumulation
  let totalSubmitted = 0;

  // ── Boot ──────────────────────────────────────────────────────────────────
  console.log(TAG, "▶ v3.0 loaded", { url: location.href, readyState: document.readyState });
  init();

  async function init() {
    cfg = (await rpc({ type: "GET_CONFIG" })) ?? {};
    logConfig("init");

    if (cfg.enabled === false) {
      console.log(TAG, "❌ Monitoring disabled. Toggle in extension popup → Settings.");
      return;
    }

    if (!cfg.apiBase) {
      console.warn(TAG, "⚠️  apiBase is empty — scanner will NOT start.");
      console.warn(TAG, "   Fix: open the extension popup, enter your Dashboard URL, click Save Settings.");
      // Wake up automatically once the user saves settings
      chrome.storage.onChanged.addListener(onConfigChanged);
      return;
    }

    injectNetworkInterceptor(); // S3: wrap window.fetch in page world before any Upwork calls run
    startNetworkListener();     // S3: receive relayed job data via postMessage
    observeSpa();
    startPage("init");
    startSwKeepalive();
    // Also respond to live config changes (e.g. user updates settings while on page)
    chrome.storage.onChanged.addListener(onConfigChanged);
  }

  function logConfig(phase) {
    console.log(TAG, `Configuration loaded [${phase}]:`, {
      dashboardUrl:      cfg.dashboardUrl      || "(not set)",
      apiBase:           cfg.apiBase           || "(not set — save Dashboard URL in popup)",
      monitoringEnabled: cfg.enabled !== false,
      simulationMode:    cfg.simulationMode    ?? false,
    });
  }

  function onConfigChanged(changes, area) {
    if (area !== "local" || !changes.config) return;
    const prev = cfg;
    cfg = changes.config.newValue ?? {};
    logConfig("storage-change");

    const justGotApiBase = !prev.apiBase && !!cfg.apiBase;
    const justEnabled    = (prev.enabled === false) && cfg.enabled !== false;

    if ((justGotApiBase || justEnabled) && cfg.enabled !== false && isJobFeed(location.href)) {
      console.log(TAG, "✅ Config updated — starting scanner now");
      stopMonitor(); seenJobIds.clear();
      startPage("config-updated");
    }
  }

  // ── SPA nav ───────────────────────────────────────────────────────────────
  function observeSpa() {
    new MutationObserver(() => {
      if (location.href !== lastUrl) {
        console.log(TAG, "SPA nav →", location.href);
        lastUrl = location.href;
        stopMonitor(); seenJobIds.clear();
        startPage("spa");
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  // ── Page router ───────────────────────────────────────────────────────────
  function startPage(reason) {
    const u = location.href;
    // [TRACE-1] URL classification — visible in browser console on the Upwork tab.
    // If feed=false here and you are on the Upwork job feed, isJobFeed() needs updating.
    console.log(TAG, `[TRACE-1] startPage(${reason})`, {
      url:       u.slice(0, 120),
      feed:      isJobFeed(u),
      detail:    isJobDetail(u),
      messages:  isMessages(u),
      proposals: isProposals(u),
    });
    if (isJobFeed(u)) {
      console.log(TAG, `[TRACE-1] ✅ URL matched JOB FEED — starting monitor`);
      startMonitor();
    } else if (isJobDetail(u)) {
      console.log(TAG, `[TRACE-1] ℹ️  URL matched JOB DETAIL`);
      scanJobDetail();
    } else if (isMessages(u)) {
      console.log(TAG, `[TRACE-1] ℹ️  URL matched MESSAGES`);
      scanMessages();
    } else if (isProposals(u)) {
      console.log(TAG, `[TRACE-1] ℹ️  URL matched PROPOSALS`);
      scanProposals();
    } else {
      console.warn(TAG, `[TRACE-1] ⚠️  URL did NOT match any known page type — scanner will NOT start.`);
      console.warn(TAG, `[TRACE-1]    URL was: ${u}`);
      console.warn(TAG, `[TRACE-1]    If this is a job feed, the isJobFeed() patterns need updating.`);
    }
  }

  // ── Proposal count parser — official Upwork "Activity on this job" values ──
  // Maps Upwork's exact range labels to representative midpoints.
  // Returns null for any unrecognised text — no guessing.
  //
  //   "Less than 5"  → 4   (qualifies: 4 < 5 → can notify)
  //   "5 to 10"      → 7   (blocked)
  //   "10 to 15"     → 12  (blocked)
  //   "15 to 20"     → 17  (blocked)
  //   "20 to 50"     → 35  (blocked)
  //   "50+"          → 50  (blocked)
  //   anything else  → null
  function parseProposalUpperBound(text) {
    if (!text) return null;
    const t = String(text).trim().toLowerCase().replace(/\s+/g, " ");
    if (/^less than 5$/.test(t))        return 4;
    if (/^5\s*(to|-|–)\s*10$/.test(t))  return 7;
    if (/^10\s*(to|-|–)\s*15$/.test(t)) return 12;
    if (/^15\s*(to|-|–)\s*20$/.test(t)) return 17;
    if (/^20\s*(to|-|–)\s*50$/.test(t)) return 35;
    if (/^50\+?$/.test(t))              return 50;
    return null;
  }

  function isJobFeed(u) {
    // Fix 1: comprehensive Upwork feed URL matching.
    // Covers all known route variants including the newer /nx/find-work/feed,
    // /nx/find-work/home, /nx/jobs, and /nx/jobs/feed paths Upwork uses.
    // The /jobs check is intentionally broad and guarded by !u.includes("~")
    // so it doesn't collide with individual job detail pages.
    if (u.includes("/find-work"))      return true;  // /find-work, /nx/find-work, /nx/find-work/feed, /nx/find-work/home
    if (u.includes("/jobs/search"))    return true;  // /nx/jobs/search, /ab/jobs/search
    if (u.includes("/search/jobs"))    return true;  // /nx/search/jobs, /search/jobs
    if (u.includes("/jobs/feed"))      return true;  // /nx/jobs/feed
    if (u.includes("/nx/jobs") && !u.includes("~")) return true;  // /nx/jobs (not a detail page)
    if (u === "https://www.upwork.com/" || u === "https://www.upwork.com/nx/") return true;
    return false;
  }
  function isJobDetail(u) {
    return (u.includes("/jobs/") || u.includes("/nx/jobs/") || u.includes("/ab/proposals/job/")) && u.includes("~");
  }
  function isMessages(u) {
    return u.includes("/messages") || u.includes("/ab/messages") || u.includes("/e2e") || u.includes("/inbox");
  }
  function isProposals(u) {
    return u.includes("/proposals") || u.includes("/my-jobs") || u.includes("/nx/proposals") || u.includes("/nx/my-jobs");
  }

  // ── Monitor lifecycle ─────────────────────────────────────────────────────
  //
  //  Phase 1 — Initial scan: poll every 3 s for up to 90 s until jobs appear.
  //  Phase 2 — Continuous: jittered setTimeout heartbeat (25–45 s) runs indefinitely.
  //  MutationObserver runs throughout both phases for real-time detection.
  //
  function startMonitor() {
    stopMonitor();
    pollCount = 0;
    console.log(TAG, "[MONITOR] Scanner started");
    startJobObserver();
    doInitialScan();
  }

  function doInitialScan() {
    pollCount++;
    if (pollCount === 1 || pollCount % 5 === 0) {
      console.log(TAG, `[MONITOR] Waiting for new jobs... (initial scan ${pollCount}/${POLL_INITIAL_MAX})`);
    }
    const found = runFeedStrategies(pollCount);

    if (found > 0) {
      console.log(TAG, `[MONITOR] Initial scan #${pollCount}: detected ${found} new job(s) — switching to continuous monitor`);
      startContinuousMonitor();
      return;
    }

    if (pollCount >= POLL_INITIAL_MAX) {
      console.log(TAG, `[MONITOR] Initial scan exhausted after ${POLL_INITIAL_MAX} attempts (90 s) — switching to continuous monitor`);
      domDiagnostic();
      startContinuousMonitor();
      return;
    }

    pollTimer = setTimeout(doInitialScan, POLL_INTERVAL_INITIAL_MS);
  }

  function startContinuousMonitor() {
    clearTimeout(pollTimer);
    pollTimer = null;
    if (monitorHeartbeat) return; // already running — do not double-start

    // Use recursive jittered setTimeout instead of setInterval.
    // Each beat fires at BASE ± JITTER/2 ms (25–45 s range) so the pattern
    // is irregular and reads as natural browsing behaviour, not a bot loop.
    console.log(TAG, "[MONITOR] Continuous monitoring active — jittered heartbeat (25–45 s)");

    function scheduleNextBeat() {
      const jitter = Math.floor(Math.random() * MONITOR_INTERVAL_JITTER_MS) - MONITOR_INTERVAL_JITTER_MS / 2;
      const delay = MONITOR_INTERVAL_BASE_MS + jitter; // 25 000–45 000 ms
      monitorHeartbeat = setTimeout(() => {
        monitorHeartbeat = null;
        if (!isJobFeed(location.href)) { scheduleNextBeat(); return; }
        // S3: nudge Apollo Client into re-fetching the Best Matches query BEFORE
        // scanning the DOM.  The fetch interceptor will capture the response and
        // submit any new jobs via the message listener — independently of S1/S2.
        triggerFeedRefresh();
        const found = runFeedStrategies("heartbeat");
        if (found > 0) {
          console.log(TAG, `[MONITOR] Heartbeat: detected ${found} new job(s)`);
        }
        scheduleNextBeat(); // re-arm with fresh jitter
      }, delay);
    }

    scheduleNextBeat();
  }

  function stopMonitor() {
    clearTimeout(pollTimer);
    pollTimer = null;
    clearTimeout(monitorHeartbeat);
    monitorHeartbeat = null;
    stopJobObserver();
  }

  // ── MutationObserver (real-time detection) ────────────────────────────────
  //
  // Generation counter (_moGeneration) is the key safety mechanism:
  //   - incremented on every startJobObserver() call
  //   - each attachObserver closure captures its own generation value at creation
  //   - when the closure fires (after the 1 s delay), it bails immediately if the
  //     generation has advanced — meaning stopJobObserver() + a new startJobObserver()
  //     was called in the interim, so this is a stale (orphan) callback
  //
  // Without this guard, rapid calls to startMonitor() accumulate dozens of MOs
  // all observing document.body simultaneously → exponential CPU usage → browser freeze.
  //
  function startJobObserver() {
    stopJobObserver();
    const myGen = ++_moGeneration; // this closure owns this generation

    const attachObserver = () => {
      // Bail if superseded — a newer startJobObserver() call has already run
      if (myGen !== _moGeneration) {
        console.log(TAG, `[MONITOR] MO gen ${myGen} superseded by gen ${_moGeneration} — discarding stale attach`);
        return;
      }
      if (!document.body) {
        setTimeout(attachObserver, 200);
        return;
      }
      let debounce = null;
      jobObserver = new MutationObserver(() => {
        clearTimeout(debounce);
        debounce = setTimeout(() => {
          // Guard again inside the callback: if the MO was replaced, ignore this fire
          if (myGen !== _moGeneration) return;
          const hasNew = Array.from(document.querySelectorAll('a[href*="~"]')).some(a => {
            const id = extractJobId(a.getAttribute("href") ?? "");
            const href = a.getAttribute("href") ?? "";
            return id && !seenJobIds.has(id) && isJobHref(href);
          });
          if (hasNew) {
            console.log(TAG, "[MONITOR] New job detected (MutationObserver) — processing...");
            const found = runFeedStrategies("MO");
            if (found > 0) console.log(TAG, `[MONITOR] MutationObserver: submitted ${found} new job(s)`);
          }
        }, 600);
      });
      jobObserver.observe(document.body, { childList: true, subtree: true });
      console.log(TAG, `[MONITOR] MutationObserver gen=${myGen} attached to document.body`);
    };

    setTimeout(attachObserver, 1000);
  }
  function stopJobObserver() { if (jobObserver) { jobObserver.disconnect(); jobObserver = null; } }

  // ── S3: Network interception ──────────────────────────────────────────────
  //
  // WHY THIS IS NEEDED
  // Upwork's Best Matches page renders jobs once via SSR; the DOM never receives
  // new job nodes while the tab stays open.  S1 (window globals / script tags)
  // and S2 (anchor scan) therefore always see the same snapshot — no new jobs.
  //
  // HOW IT WORKS
  // 1. injectNetworkInterceptor() injects a tiny self-removing <script> tag
  //    into the PAGE's JS world (content scripts run in an isolated world and
  //    cannot override window.fetch directly).  The injected script wraps
  //    window.fetch and XMLHttpRequest; when a response body looks like Upwork
  //    job data it relays the parsed JSON to the content script via postMessage.
  //
  // 2. startNetworkListener() adds a window.message handler that receives the
  //    relayed data, runs walkJsonForJobs() on it (same extractor as S1), and
  //    submits any new jobs through the normal pipeline.
  //
  // 3. triggerFeedRefresh() is called by the heartbeat to prompt Upwork's
  //    Apollo Client into re-fetching the Best Matches query.  Apollo uses a
  //    refetchOnWindowFocus policy: it re-runs active queries whenever the
  //    document transitions from hidden → visible.  Simulating that transition
  //    causes a fresh GraphQL call whose response the interceptor captures.
  //
  function injectNetworkInterceptor() {
    if (document.getElementById('_uai_net')) return; // guard: already injected

    const script = document.createElement('script');
    script.id = '_uai_net';
    // Minified to keep injection overhead minimal; must be fully self-contained.
    script.textContent = `(function(){
      if(window.__UAI_NET__)return;window.__UAI_NET__=true;
      function relay(text,url){
        try{
          if(!text||text.length<30)return;
          // Quick pre-filter: only parse responses that look like job data
          if(!text.includes('"ciphertext"')&&!text.includes('"~0')&&
             !text.includes('bestMatch')&&!text.includes('jobTile')&&
             !text.includes('"JobTile"'))return;
          window.postMessage({_uai:1,url:url,data:JSON.parse(text)},'*');
        }catch(e){}
      }
      // Wrap fetch
      var _f=window.fetch.bind(window);
      window.fetch=async function(input,init){
        var resp=await _f(input,init);
        var url=typeof input==='string'?input:(input&&input.url?input.url:'');
        try{var c=resp.clone();c.text().then(function(t){relay(t,url);}).catch(function(){});}catch(e){}
        return resp;
      };
      // Wrap XHR
      var _op=XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open=function(m,u){this.__uai_url=u;return _op.apply(this,arguments);};
      var _se=XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send=function(){
        var self=this;
        this.addEventListener('load',function(){relay(self.responseText,self.__uai_url||'');});
        return _se.apply(this,arguments);
      };
    })();`;

    (document.head || document.documentElement).prepend(script);
    script.remove(); // remove from DOM — already executed
    console.log(TAG, '[S3] Network interceptor injected — Upwork API responses will be captured');
  }

  function startNetworkListener() {
    window.addEventListener('message', (evt) => {
      if (evt.source !== window || !evt.data?._uai) return;
      const { data, url } = evt.data;
      if (!data || typeof data !== 'object') return;

      const found = walkJsonForJobs(data, 'S3:net');
      if (!found.length) return;

      let submitted = 0;
      for (const job of found) {
        if (seenJobIds.has(job.upworkJobId)) continue;
        seenJobIds.add(job.upworkJobId);
        console.log(TAG, `[S3:network] Live job from API: "${job.title.slice(0, 60)}" (${job.upworkJobId})`);
        submitJob(job);
        totalSubmitted++;
        submitted++;
      }
      if (submitted > 0) {
        console.log(TAG, `[S3:network] ✅ Submitted ${submitted} new job(s) from live API intercept`);
      } else {
        console.log(TAG, `[S3:network] API response intercepted — ${found.length} job(s) already seen`);
      }
    });
    console.log(TAG, '[S3] Network job listener active');
  }

  // Nudge Upwork's Apollo Client into re-fetching the Best Matches query.
  // Apollo's refetchOnWindowFocus policy triggers a fresh GraphQL call on
  // document hidden → visible transition, whose response our interceptor captures.
  function triggerFeedRefresh() {
    // 1. First check if Upwork shows an explicit "new jobs available" / refresh button
    const refreshSelectors = [
      '[data-test="feed-refresh"]', '[data-test="new-jobs-available"]',
      '[data-cy="feed-refresh"]',   '[data-qa="feed-refresh"]',
      'button[class*="refresh"][class*="feed"]',
      'button[class*="feed"][class*="refresh"]',
    ];
    for (const sel of refreshSelectors) {
      try {
        const btn = document.querySelector(sel);
        if (btn) {
          btn.click();
          console.log(TAG, `[S3] Clicked feed refresh button: ${sel}`);
          return;
        }
      } catch {}
    }

    // 2. Simulate visibilitychange: hidden → visible.
    // Apollo checks document.visibilityState (not just the event) before refetching,
    // so we must temporarily override the property value.
    try {
      const proto = Document.prototype;
      const origDesc = Object.getOwnPropertyDescriptor(proto, 'visibilityState')
        ?? Object.getOwnPropertyDescriptor(document, 'visibilityState');

      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));

      setTimeout(() => {
        try {
          // Restore the original descriptor so the page behaves normally again
          if (origDesc) Object.defineProperty(document, 'visibilityState', origDesc);
          else Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
          document.dispatchEvent(new Event('visibilitychange'));
          console.log(TAG, '[S3] visibilitychange hidden→visible dispatched — Apollo should refetch');
        } catch(e) {}
      }, 150);
    } catch(e) {
      console.log(TAG, '[S3] visibilitychange trigger skipped:', e.message);
    }
  }

  // ── Service worker keepalive ──────────────────────────────────────────────
  // MV3 service workers terminate after ~30 s idle. Pinging every 20 s from
  // the content script keeps the SW alive so it can receive JOB_DETECTED msgs.
  function startSwKeepalive() {
    setInterval(() => {
      chrome.runtime.sendMessage({ type: "PING" }).catch(() => {});
    }, 20000);
    console.log(TAG, "[MONITOR] Service worker keepalive started (ping every 20 s)");
  }

  function isJobHref(href) {
    return href.includes("/jobs/") || href.includes("/ab/proposals/job/") || href.includes("/nx/jobs/");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STRATEGY ORCHESTRATOR
  // ═══════════════════════════════════════════════════════════════════════════
  function runFeedStrategies(attempt) {
    let jobs = [];
    let strategy = "";

    // ── S1: JSON/hydration data extraction ────────────────────────────────
    const jsonJobs = extractJobsFromPageJson();
    if (jsonJobs.length > 0) {
      jobs = jsonJobs;
      strategy = "S1:JSON";
    }

    // ── S2: Anchor-tag scan (always runs to catch any missed by S1) ───────
    const anchorJobs = extractJobsFromAnchors();
    if (anchorJobs.length > 0) {
      if (!strategy) strategy = "S2:anchors";
      // Merge: add anchor jobs not already found via JSON (by jobId)
      const s1Ids = new Set(jobs.map(j => j.upworkJobId));
      for (const j of anchorJobs) {
        if (!s1Ids.has(j.upworkJobId)) jobs.push(j);
      }
    }

    // [TRACE-2] Detection counts — visible in browser console.
    // If S1=0 and S2=0 consistently, job extraction is failing (page structure changed).
    // If S1>0 or S2>0 but nothing is submitted, seenJobIds is deduping them.
    console.log(TAG, `[TRACE-2] runFeedStrategies(${attempt}) detection:`, {
      S1_json:   jsonJobs.length,
      S2_anchor: anchorJobs.length,
      merged:    jobs.length,
      strategy:  strategy || "none",
      seenInSession: seenJobIds.size,
      tildeAnchors: document.querySelectorAll('a[href*="~"]').length,
    });

    if (jobs.length === 0) {
      if (attempt === 1 || attempt % 5 === 0) {
        const tildeCount = document.querySelectorAll('a[href*="~"]').length;
        const anchorCount = document.querySelectorAll("a").length;
        console.log(TAG, `Poll #${attempt}: 0 jobs — a[href*="~"]=${tildeCount}, total <a>=${anchorCount}`);
        if (tildeCount === 0 && attempt === 1) console.log(TAG, "  → React still rendering. Will keep polling every 3s.");
      }

      return 0;
    }

    // Submit new jobs
    let submitted = 0;
    let skippedDup = 0;
    for (const job of jobs) {
      if (seenJobIds.has(job.upworkJobId)) {
        skippedDup++;
        continue;
      }
      seenJobIds.add(job.upworkJobId);
      submitted++;
      totalSubmitted++;
      // [TRACE-3] Each job being sent to background — confirms detection → submission path
      console.log(TAG, `[TRACE-3] Sending to BG: "${job.title?.slice(0, 60)}"`, {
        id:              job.upworkJobId,
        paymentVerified: job.paymentVerified,
        proposalCount:   job.proposalCount,
        strategy:        job._detectionStrategy,
        apiBase:         cfg.apiBase || "(EMPTY — fix this in popup!)",
      });
      submitJob(job);
    }

    if (submitted > 0 || skippedDup > 0) {
      console.log(TAG, `[MONITOR] Processing job — [${strategy}] submitted=${submitted} skipped-dup=${skippedDup} (session total: ${totalSubmitted})`);
    }
    return submitted;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // S1 — JSON / PAGE STATE EXTRACTION
  // ═══════════════════════════════════════════════════════════════════════════
  function extractJobsFromPageJson() {
    const jobs = [];
    const seen = new Set();

    // 1a. Check well-known window globals
    const windowKeys = [
      "__INITIAL_STATE__", "__APOLLO_STATE__", "__PRELOADED_STATE__",
      "__REDUX_STATE__", "__NEXT_DATA__", "__NUXT__", "initialState",
      "__STATE__", "__APP_STATE__", "__DATA__",
    ];
    for (const key of windowKeys) {
      if (window[key]) {
        const found = walkJsonForJobs(window[key], `window.${key}`);
        for (const j of found) { if (!seen.has(j.upworkJobId)) { seen.add(j.upworkJobId); jobs.push(j); } }
      }
    }

    // 1b. Scan all <script> tags for embedded JSON
    for (const script of document.querySelectorAll("script")) {
      const type = script.type ?? "";
      const id = script.id ?? "";
      const content = script.textContent ?? "";
      if (!content || content.length < 50) continue;

      // Explicit JSON script tags
      if (type === "application/json" || type === "application/ld+json") {
        try {
          const data = JSON.parse(content);
          const found = walkJsonForJobs(data, `script[type="${type}"]${id ? "#" + id : ""}`);
          for (const j of found) { if (!seen.has(j.upworkJobId)) { seen.add(j.upworkJobId); jobs.push(j); } }
        } catch {}
        continue;
      }

      // Look for inline scripts that embed job data
      // Common patterns: window.__X__={...} or var state={...}
      if (!content.includes("ciphertext") && !content.includes('"title"') && !content.includes("~01")) continue;

      // Extract the first large JSON-like object from the script
      const jsonCandidates = extractJsonBlobs(content);
      for (const blob of jsonCandidates) {
        try {
          const data = JSON.parse(blob);
          const found = walkJsonForJobs(data, `script#${id || "anon"}`);
          for (const j of found) { if (!seen.has(j.upworkJobId)) { seen.add(j.upworkJobId); jobs.push(j); } }
        } catch {}
      }
    }

    if (jobs.length > 0) console.log(TAG, `S1:JSON found ${jobs.length} jobs from page state`);
    return jobs;
  }

  // Pull out JSON-looking blobs from a script's text content
  function extractJsonBlobs(text) {
    const blobs = [];
    // Pattern: assignment of a JSON object  window.__X__ = {...}  or  = {...};
    const assignMatch = text.match(/=\s*(\{[\s\S]{100,})/);
    if (assignMatch) blobs.push(assignMatch[1].replace(/;\s*$/, ""));

    // Pattern: standalone large JSON object at start of script
    if (text.trimStart().startsWith("{")) blobs.push(text.trim());

    return blobs;
  }

  // Recursively walk parsed JSON looking for objects that look like Upwork jobs
  function walkJsonForJobs(obj, source, depth = 0, out = []) {
    if (depth > 10 || !obj || typeof obj !== "object") return out;

    // Check if this node looks like a job
    if (looksLikeJob(obj)) {
      const job = buildJobFromJson(obj, source);
      if (job) out.push(job);
      // Don't recurse into a matched job object — avoid duplicates
      return out;
    }

    // Recurse
    const vals = Array.isArray(obj) ? obj : Object.values(obj);
    for (const val of vals) {
      if (val && typeof val === "object") walkJsonForJobs(val, source, depth + 1, out);
    }
    return out;
  }

  function looksLikeJob(obj) {
    // Must have a cipher/jobId that includes ~ and a title field
    const hasCipher = (typeof obj.ciphertext === "string" && obj.ciphertext.includes("~")) ||
      (typeof obj.id === "string" && obj.id.startsWith("~")) ||
      (typeof obj.jobId === "string" && obj.jobId.includes("~")) ||
      (typeof obj.uid === "string" && obj.uid.startsWith("~"));
    const hasTitle = typeof obj.title === "string" && obj.title.length > 3;
    return hasCipher && hasTitle;
  }

  function buildJobFromJson(obj, source) {
    // Extract the cipher/job ID
    const cipherRaw = obj.ciphertext ?? obj.id ?? obj.jobId ?? obj.uid ?? "";
    const jobId = extractJobId(cipherRaw) ?? extractJobId(obj.jobUrl ?? "");
    if (!jobId) return null;

    const title = obj.title ?? obj.jobTitle ?? "";
    if (!title) return null;

    // Budget
    const budget = obj.budget ?? obj.hourlyBudget ?? obj.fixedBudget ?? {};
    let budgetType = "fixed", budgetMin = null, budgetMax = null;
    if (budget.type === "hourly" || obj.type === "hourly") budgetType = "hourly";
    if (budget.min != null) budgetMin = Number(budget.min);
    if (budget.max != null) budgetMax = Number(budget.max);
    if (budget.amount != null) { budgetMin = Number(budget.amount); budgetMax = Number(budget.amount); }

    // Client info
    const client = obj.client ?? obj.buyer ?? {};
    const country = obj.location?.country ?? client.location?.country ?? client.country ?? obj.clientCountry ?? null;
    const totalSpent = client.totalSpent ?? client.totalPosted ?? null;
    // Check all known Upwork JSON field variants for payment verification.
    // Three possible outcomes: true (confirmed verified), false (confirmed NOT verified),
    // null (field absent — background will fetch the detail page to resolve).
    const pvStatus = (
      client.paymentVerificationStatus ?? client.verificationStatus ??
      client.paymentMethodStatus ?? obj.paymentVerificationStatus ?? ""
    ).toUpperCase();
    const pvExplicitlyVerified =
      pvStatus === "VERIFIED" || pvStatus === "PAYMENT_VERIFIED" ||
      client.paymentVerified === true ||
      client.hasVerifiedPayment === true ||
      client.isPaymentVerified === true ||
      client.paymentVerifiedAt != null ||
      obj.paymentVerified === true ||
      obj.isPaymentVerified === true ||
      obj.clientPaymentVerified === true;
    const pvExplicitlyNotVerified =
      pvStatus === "NOT_VERIFIED" || pvStatus === "UNVERIFIED" ||
      pvStatus === "FAILED" || pvStatus === "PENDING" ||
      client.paymentVerified === false || obj.paymentVerified === false;
    // null → unknown; background.js will fetch the job detail page to confirm
    const paymentVerified = pvExplicitlyVerified ? true : pvExplicitlyNotVerified ? false : null;

    // Skills
    const skills = [];
    for (const s of obj.skills ?? obj.requiredSkills ?? []) {
      const name = typeof s === "string" ? s : s.name ?? s.label ?? s.skillName ?? "";
      if (name) skills.push(name);
    }

    const description = obj.description ?? obj.content ?? obj.snippet ?? "";
    const jobUrl = obj.jobUrl ?? obj.url ?? `https://www.upwork.com/jobs/~${jobId}`;

    return {
      upworkJobId: jobId,
      title: String(title).trim(),
      description: String(description).trim().slice(0, 5000) || String(title).trim(),
      budgetType,
      budgetMin,
      budgetMax,
      clientCountry: country ? String(country).trim() : null,
      clientTotalSpent: totalSpent != null ? Number(totalSpent) : null,
      paymentVerified,
      proposalCount: obj.proposalsTier?.count ?? obj.proposalCount ?? null,
      skills,
      jobUrl: String(jobUrl),
      _detectionStrategy: `S1:JSON:${source}`,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // S2 — ANCHOR-TAG SCAN
  // ═══════════════════════════════════════════════════════════════════════════
  function extractJobsFromAnchors() {
    const allTilde = document.querySelectorAll('a[href*="~"]');
    const jobs = [];
    const seenThis = new Set();

    for (const a of allTilde) {
      const href = a.getAttribute("href") ?? "";
      if (!isJobHref(href)) continue;
      const fullUrl = href.startsWith("http") ? href : `https://www.upwork.com${href}`;
      const jobId = extractJobId(href);
      if (!jobId || seenJobIds.has(jobId) || seenThis.has(jobId)) continue;
      seenThis.add(jobId);

      const job = extractJobFromAnchor(a, fullUrl, jobId);
      if (job) jobs.push(job);
    }
    return jobs;
  }

  function extractJobFromAnchor(linkEl, jobUrl, jobId) {
    try {
      // Title must come from the link text (not "Apply", "Save", etc.)
      const rawTitle = (linkEl.textContent?.trim() ?? "").replace(/\s+/g, " ");
      if (!rawTitle || rawTitle.length < 5 || /^(apply|save|view|details?|more|see)$/i.test(rawTitle)) return null;

      const card = findCard(linkEl);

      return {
        upworkJobId: jobId,
        title: rawTitle,
        description: extractDescription(card) || rawTitle,
        ...parseBudget(extractText(card, [
          '[data-test="budget"]', '[data-cy="budget"]', '[data-test="job-type-label"]',
          ".budget", '[class*="budget" i]', '[class*="Budget"]', '[class*="rate" i]',
        ])),
        clientCountry: extractText(card, [
          '[data-test="client-location"]', '[data-test="client-country"]', ".client-country",
          '[class*="country" i]', '[class*="Country"]', '[class*="location" i]',
        ])?.trim()?.replace(/^[^a-zA-Z]+/, "") || null,
        paymentVerified: (() => {
          // Selectors for a "payment verified" badge (client has verified payment)
          const VERIFIED_SELS = [
            '[data-test="payment-verified"]', '[data-cy="payment-verified"]',
            '[data-qa="payment-verified"]', '.payment-verified',
            '[aria-label*="payment verified" i]', '[aria-label*="Payment Method Verified" i]',
            '[class*="PaymentVerified"]', '[class*="payment-verified" i]',
            'svg[aria-label*="verified" i]',
          ].join(', ');
          // Selectors for an explicit "payment NOT verified" badge
          const NOT_VERIFIED_SELS = [
            '[data-test="payment-not-verified"]', '[data-cy="payment-not-verified"]',
            '[aria-label*="payment not verified" i]', '[aria-label*="Payment Method Not Verified" i]',
            '[class*="PaymentNotVerified"]',
          ].join(', ');
          if (card?.querySelector(VERIFIED_SELS)) return true;
          if (card?.querySelector(NOT_VERIFIED_SELS)) return false;
          return null; // unknown — background.js will fetch the detail page
        })(),
        proposalCount: parseProposalUpperBound(extractText(card, ['[data-test="proposals-count"]', ".proposals-count", '[class*="proposals" i]'])),
        skills: extractSkills(card),
        jobUrl,
        _detectionStrategy: "S2:anchors",
      };
    } catch { return null; }
  }

  // ── DOM helpers for S2 ────────────────────────────────────────────────────
  function findCard(el) {
    let node = el.parentElement;
    for (let i = 0; i < 14; i++) {
      if (!node || node === document.body) break;
      const tag = node.tagName?.toLowerCase();
      const cls = (node.className ?? "").toString();
      if (
        tag === "article" || tag === "section" || tag === "li" ||
        /tile|card|job[-_]?item|job[-_]?post/i.test(cls) ||
        (node.childElementCount >= 3 && node.querySelectorAll('a[href*="~"]').length === 1)
      ) return node;
      node = node.parentElement;
    }
    return el.closest("li, article, section") ?? el.parentElement?.parentElement ?? el.parentElement ?? el;
  }

  function extractDescription(card) {
    if (!card) return null;
    const specific = extractText(card, [
      '[data-test="job-description"]', '[data-test="description"]',
      ".description-text", ".o-trusted-html-content", '[class*="description" i]',
    ]);
    if (specific?.length > 20) return specific;
    let best = "";
    for (const el of card.querySelectorAll("p, [class*='text' i]")) {
      const t = el.textContent?.trim() ?? "";
      if (t.length > best.length && t.length < 3000) best = t;
    }
    return best || null;
  }

  function extractSkills(card) {
    if (!card) return [];
    for (const sel of ['[data-test="token"]', '[data-test="skill"]', ".skill-tag", ".o-tag", '[class*="skill" i]']) {
      const els = card?.querySelectorAll(sel);
      if (els?.length) return Array.from(els).map(e => e.textContent?.trim()).filter(Boolean).slice(0, 15);
    }
    return [];
  }

  function extractText(root, selectors) {
    if (!root) return null;
    for (const sel of selectors) {
      const text = root.querySelector(sel)?.textContent?.trim();
      if (text) return text;
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // S5 — DOM DIAGNOSTIC REPORT
  // ═══════════════════════════════════════════════════════════════════════════
  function domDiagnostic() {
    console.group(TAG + " ══ DOM Diagnostic Report ══");
    console.log("URL:", location.href);
    console.log("Timestamp:", new Date().toISOString());

    // Anchors
    const allAnchors = document.querySelectorAll("a[href]");
    const tildeAnchors = document.querySelectorAll('a[href*="~"]');
    const jobAnchors = Array.from(tildeAnchors).filter(a => isJobHref(a.getAttribute("href") ?? ""));
    console.log(`Anchor tags: total=${allAnchors.length}  with~=${tildeAnchors.length}  job-like=${jobAnchors.length}`);

    // Sample hrefs
    const hrefs = Array.from(allAnchors).map(a => a.getAttribute("href")).filter(Boolean).slice(0, 30);
    console.log("Sample hrefs (30):", hrefs);

    // Scripts with potential JSON
    const scripts = Array.from(document.querySelectorAll("script"));
    const jsonScripts = scripts.filter(s => {
      const t = s.type ?? "";
      const c = s.textContent ?? "";
      return t.includes("json") || c.includes("ciphertext") || c.includes("~01") || c.includes('"title"');
    });
    console.log(`Script tags: total=${scripts.length}  potential-json=${jsonScripts.length}`);
    jsonScripts.slice(0, 5).forEach(s => {
      console.log(`  script[type="${s.type}"][id="${s.id}"] len=${s.textContent?.length} preview="${s.textContent?.slice(0, 120)}"`);
    });

    // Window globals
    const windowGlobals = ["__INITIAL_STATE__", "__APOLLO_STATE__", "__PRELOADED_STATE__", "__NEXT_DATA__", "__NUXT__"];
    const foundGlobals = windowGlobals.filter(k => window[k]);
    console.log("Window globals found:", foundGlobals.length ? foundGlobals : "none");

    // data-* elements
    const dataEls = Array.from(document.querySelectorAll("[data-test], [data-ev-job-uid], [data-job], [data-cy]"))
      .map(el => ({ tag: el.tagName, data: JSON.stringify(el.dataset).slice(0, 100), cls: el.className?.slice(0, 80) }))
      .slice(0, 10);
    console.log("data-* elements (10):", dataEls);

    // Body text
    console.log("Body text sample:", document.body.innerText.slice(0, 500));

    console.groupEnd();
    console.log(TAG, "▲ Share the above with the developer to fix selectors.");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // JOB DETAIL PAGE
  // ═══════════════════════════════════════════════════════════════════════════
  function scanJobDetail() {
    if (document.querySelector("[data-uai-detail]")) return;
    const jobId = extractJobId(location.href);
    if (!jobId || seenJobIds.has(jobId)) return;

    const marker = document.createElement("span");
    marker.dataset.uaiDetail = "1";
    marker.style.display = "none";
    document.body.appendChild(marker);

    // Try S1 first on detail page
    const jsonJobs = extractJobsFromPageJson();
    const jsonMatch = jsonJobs.find(j => j.upworkJobId === jobId);
    if (jsonMatch) {
      console.log(TAG, "Job detail found via S1:JSON:", jsonMatch.title);
      seenJobIds.add(jobId);
      submitJob(jsonMatch);
      return;
    }

    // Fallback: DOM extraction with retry
    const tryDom = (attempt) => {
      const titleEl = document.querySelector('h1, [data-test="job-title"]');
      const title = titleEl?.textContent?.trim();
      if (!title && attempt < 5) { setTimeout(() => tryDom(attempt + 1), 2000); return; }
      if (!title) { console.log(TAG, "Job detail: title not found"); return; }

      const descEl = document.querySelector('[data-test="description"], .description-text, .o-trusted-html-content, [class*="description" i]');
      const budgetEl = document.querySelector('[data-test="budget"], [class*="budget" i]');
      const skillEls = document.querySelectorAll('[data-test="token"], [data-test="skill"], .skill-tag, .o-tag, [class*="skill" i]');
      const countryEl = document.querySelector('[data-test="client-location"], .client-country, [class*="location" i]');
      const totalSpentEl = document.querySelector('[data-test="total-spent"], [class*="totalSpent" i]');
      const paymentEl = document.querySelector([
        '[data-test="payment-verified"]',
        '[data-cy="payment-verified"]',
        '[data-qa="payment-verified"]',
        '.payment-verified',
        '[aria-label*="payment verified" i]',
        '[aria-label*="Payment Method Verified" i]',
        '[class*="PaymentVerified"]',
        '[class*="payment-verified" i]',
        'svg[aria-label*="verified" i]',
      ].join(', '));
      const proposalEl = document.querySelector('[data-test="proposals-count"], [class*="proposals" i]');

      const job = {
        upworkJobId: jobId, title,
        description: descEl?.textContent?.trim() ?? title,
        ...parseBudget(budgetEl?.textContent?.trim()),
        clientCountry: countryEl?.textContent?.trim()?.replace(/^[^a-zA-Z]+/, "") ?? null,
        clientTotalSpent: parseAmount(totalSpentEl?.textContent?.trim() ?? ""),
        paymentVerified: paymentEl ? true : null, // null = unknown; background.js will verify via tab
        proposalCount: parseProposalUpperBound(proposalEl?.textContent),
        skills: Array.from(skillEls).map(e => e.textContent?.trim()).filter(Boolean).slice(0, 15),
        jobUrl: location.href,
        _detectionStrategy: "S2:detail-DOM",
      };
      console.log(TAG, "Job detail via S2:DOM:", title);
      seenJobIds.add(jobId);
      submitJob(job);
    };
    setTimeout(() => tryDom(1), 2000);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MESSAGES / PROPOSALS
  // ═══════════════════════════════════════════════════════════════════════════
  function scanMessages() {
    const threads = document.querySelectorAll('[data-test="message-thread"], .message-thread, [class*="MessageThread"], [class*="thread-item" i], [data-cy="thread"]');
    console.log(TAG, `Message threads: ${threads.length}`);
    threads.forEach(t => {
      if (t.dataset.uaiScanned) return;
      t.dataset.uaiScanned = "1";
      const ev = extractThreadEvent(t);
      if (ev) submitEvent(ev);
    });
    detectKeywords();
  }

  function detectKeywords() {
    const text = document.body.innerText.toLowerCase();
    const key = `__uai_${location.pathname}`;
    if (!window[key]) window[key] = {};
    [
      { flag: "interview", patterns: ["interview invitation", "would like to interview", "schedule a call", "invite you for an interview"], ev: { type: "interview_invite", title: "Interview Invitation", body: `Interview invitation at ${location.href}`, url: location.href } },
      { flag: "contract",  patterns: ["contract offer", "offered you a contract", "contract started", "hire you"], ev: { type: "contract_offer", title: "Contract Offer", body: `Contract offer at ${location.href}`, url: location.href } },
    ].forEach(({ flag, patterns, ev }) => {
      if (!window[key][flag] && patterns.some(p => text.includes(p))) { window[key][flag] = true; submitEvent(ev); }
    });
  }

  function extractThreadEvent(thread) {
    try {
      const name = thread.querySelector('[data-test="thread-name"], .thread-name, h4, h3, strong')?.textContent?.trim() ?? "Someone";
      const preview = thread.querySelector('[data-test="thread-preview"], .thread-preview, p')?.textContent?.trim() ?? "";
      const unread = thread.querySelector('[data-test="unread-badge"], .unread-badge, [class*="unread" i], [aria-label*="unread" i]') || (thread.textContent?.includes("•") ? thread : null);
      if (!unread) return null;
      const id = `${name}::${preview.slice(0, 30)}`;
      if (seenMsgIds.has(id)) return null;
      seenMsgIds.add(id);
      return { type: "message_received", title: `New message from ${name}`, body: preview || `${name} sent you a message`, senderName: name, url: location.href, timestamp: new Date().toISOString() };
    } catch { return null; }
  }

  function scanProposals() {
    document.querySelectorAll('[data-test="proposal-item"], .proposal-item, [class*="ProposalItem"]').forEach(p => {
      if (p.dataset.uaiScanned) return;
      p.dataset.uaiScanned = "1";
      const status = p.querySelector('[data-test="status"], .status, [class*="status" i]')?.textContent?.trim().toLowerCase() ?? "";
      if (status.includes("interview") || status.includes("invited")) {
        const name = p.querySelector('[class*="ClientName" i], .client-name, h4, h3')?.textContent?.trim() ?? "A client";
        submitEvent({ type: "interview_invite", title: "Interview Invitation", body: `${name} invited you for an interview`, url: location.href });
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════════════════
  function extractJobId(url) {
    return url?.match(/~([a-zA-Z0-9]{10,})/)?.[1] ?? null;
  }

  function parseBudget(text) {
    if (!text) return { budgetType: "fixed", budgetMin: null, budgetMax: null };
    const lower = text.toLowerCase();
    const isHourly = lower.includes("/hr") || lower.includes("hourly") || lower.includes("per hour") || lower.includes("/hour");
    const nums = text.match(/[\d,]+(?:\.\d+)?/g)?.map(n => parseFloat(n.replace(/,/g, ""))) ?? [];
    return { budgetType: isHourly ? "hourly" : "fixed", budgetMin: nums[0] ?? null, budgetMax: nums[1] ?? nums[0] ?? null };
  }

  function parseAmount(text) {
    if (!text) return null;
    const m = text.match(/([\d.]+)\s*([KkMm]?)/);
    if (!m) return null;
    const v = parseFloat(m[1]);
    return m[2].toLowerCase() === "k" ? v * 1000 : m[2].toLowerCase() === "m" ? v * 1000000 : v || null;
  }

  function submitJob(job) {
    const sim = cfg.simulationMode ?? false;
    // [TRACE-4] CONTENT→BG bridge — if you see TRACE-3 but never TRACE-4, Chrome
    // is dropping sendMessage before it fires (extension context invalidated).
    console.log(TAG, `[TRACE-4] chrome.runtime.sendMessage JOB_DETECTED`, {
      id:    job.upworkJobId,
      title: job.title?.slice(0, 60),
      sim,
    });
    chrome.runtime.sendMessage({ type: "JOB_DETECTED", job, simulationMode: sim }, resp => {
      // [TRACE-5] BG response — every possible outcome is logged.
      // If you see TRACE-4 but never TRACE-5, the message never reached background.js
      // (service worker may have died; check chrome://extensions → Inspect service worker).
      if (chrome.runtime.lastError) {
        console.error(TAG, `[TRACE-5] ❌ chrome.runtime.lastError:`, chrome.runtime.lastError.message);
        console.error(TAG, `[TRACE-5]    → Open chrome://extensions, click "Inspect" on UpworkAI, check for SW errors.`);
        return;
      }
      console.log(TAG, `[TRACE-5] BG response for ${job.upworkJobId}:`, JSON.stringify(resp ?? null));
      if (resp?.success)        console.log(TAG, `[TRACE-5] ✅ Submitted to API: ${job.title}`);
      else if (resp?.simulated) console.log(TAG, `[TRACE-5] 🔬 Simulated (sim mode ON): ${job.title}`);
      else if (resp?.queued)    console.log(TAG, `[TRACE-5] 📥 Queued (API offline): ${job.title}`);
      else if (resp?.skipped)   console.log(TAG, `[TRACE-5] ⏭ Duplicate in BG (sessionSeenIds or DB): ${job.upworkJobId} reason=${resp.reason}`);
      else if (resp?.error) {
        console.error(TAG, `[TRACE-5] ❌ BG returned error: ${resp.error}`);
        if (resp.hint) console.error(TAG, `[TRACE-5]    hint: ${resp.hint}`);
        console.warn(TAG, `[TRACE-5] Scanner paused. Will resume when Dashboard URL is saved in popup.`);
        // Fix 2: stopPoll() was undefined — use clearTimeout(pollTimer) directly
        clearTimeout(pollTimer);
        pollTimer = null;
        stopJobObserver();
      } else {
        console.warn(TAG, `[TRACE-5] ⚠️ Unexpected / null response from BG — SW may have been killed mid-request`, resp);
      }
    });
  }

  function submitEvent(event) {
    const sim = cfg.simulationMode ?? false;
    chrome.runtime.sendMessage({ type: "EVENT_DETECTED", event, simulationMode: sim }, resp => {
      if (!chrome.runtime.lastError && resp?.success) console.log(TAG, "✅ Event:", event.type);
    });
  }

  function rpc(payload) {
    return new Promise(r => chrome.runtime.sendMessage(payload, res => r(chrome.runtime.lastError ? null : res)));
  }
})();
