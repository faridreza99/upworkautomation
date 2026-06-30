/**
 * UpworkAI DOM Diagnostic Script — paste into Chrome DevTools Console
 * on any Upwork job detail page while logged in.
 *
 * What it does:
 *   1. TreeWalker scan — every text node matching payment/proposal/verified/hires/spent/client
 *   2. Full HTML dump — "About the client" section
 *   3. Full HTML dump — proposal/applicant section
 *   4. All SVG elements near client/proposal area
 *   5. All aria-label attributes on the page
 *   6. All data-* attributes on the page
 *   7. Shadow DOM scan
 *   8. React fiber data (window globals: __NEXT_DATA__, __APOLLO_STATE__, etc.)
 *   9. Auto-downloads upwork-diag.json
 */
(function upworkDiag() {
  console.log("[DIAG] Starting UpworkAI DOM diagnostic…");
  const result = {
    meta: {
      url: location.href,
      title: document.title,
      ts: new Date().toISOString(),
      bodyTextLength: document.body?.innerText?.length ?? 0,
    },

    // ── 1. TreeWalker: every text node matching keywords ──────────────────
    textNodes: [],

    // ── 2. About the client section HTML ─────────────────────────────────
    aboutClientSection: null,
    aboutClientSectionSelector: null,

    // ── 3. Proposal/applicant section HTML ────────────────────────────────
    proposalSection: null,
    proposalSectionSelector: null,

    // ── 4. SVG elements with aria-label or title near client/proposal area ─
    svgElements: [],

    // ── 5. All aria-label attributes on page ─────────────────────────────
    ariaLabels: [],

    // ── 6. All data-* attributes (unique, with element context) ──────────
    dataAttributes: [],

    // ── 7. Shadow DOM ─────────────────────────────────────────────────────
    shadowDomHosts: [],

    // ── 8. React / Next.js window globals ─────────────────────────────────
    windowGlobals: {},

    // ── 9. Full page li elements (client facts usually in a list) ─────────
    allListItems: [],

    // ── 10. Job page key element attempts ────────────────────────────────
    keyElementAttempts: [],
  };

  // ──────────────────────────────────────────────────────────────────────────
  // 1. TreeWalker — every matching text node
  // ──────────────────────────────────────────────────────────────────────────
  const KEYWORDS = /payment|verified|verif|proposal|applicant|hires?|spent|client|bid/i;
  try {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      const text = (node.textContent || "").trim();
      if (!text || text.length > 500 || text.length < 2) continue;
      if (!KEYWORDS.test(text)) continue;

      const p  = node.parentElement;
      const gp = p?.parentElement;
      const ggp = gp?.parentElement;

      result.textNodes.push({
        text,
        parent: {
          tag: p?.tagName,
          id: p?.id || null,
          class: p?.className?.toString() || null,
          dataTest: p?.getAttribute("data-test") || null,
          dataCy: p?.getAttribute("data-cy") || null,
          dataQa: p?.getAttribute("data-qa") || null,
          ariaLabel: p?.getAttribute("aria-label") || null,
          role: p?.getAttribute("role") || null,
        },
        grandparent: {
          tag: gp?.tagName,
          id: gp?.id || null,
          class: gp?.className?.toString() || null,
          dataTest: gp?.getAttribute("data-test") || null,
          ariaLabel: gp?.getAttribute("aria-label") || null,
        },
        greatGrandparent: {
          tag: ggp?.tagName,
          id: ggp?.id || null,
          class: ggp?.className?.toString() || null,
          dataTest: ggp?.getAttribute("data-test") || null,
        },
      });
    }
    console.log(`[DIAG] TreeWalker: ${result.textNodes.length} matching text nodes`);
  } catch (e) {
    result.textNodes = [{ error: e.message }];
    console.warn("[DIAG] TreeWalker error:", e);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 2. "About the client" section — find by heading text, dump full HTML
  // ──────────────────────────────────────────────────────────────────────────
  try {
    const allEls = [...document.querySelectorAll("*")];

    // Strategy A: find a leaf element whose entire text is "About the client"
    const aboutHead = allEls.find(el => {
      const t = (el.textContent || "").trim();
      return /^about\s+(the\s+)?client$/i.test(t) && el.children.length === 0;
    });

    if (aboutHead) {
      // Walk up to find the section container
      let sec = aboutHead;
      for (let i = 0; i < 10 && sec && sec !== document.body; i++) {
        sec = sec.parentElement;
        const cls = sec?.className?.toString() || "";
        const tag = sec?.tagName || "";
        if (tag === "SECTION" || tag === "ASIDE" ||
            /widget|card|panel|module|sidebar|about|client/i.test(cls)) break;
      }
      result.aboutClientSection = sec?.outerHTML?.slice(0, 8000) || null;
      result.aboutClientSectionSelector = `${sec?.tagName}#${sec?.id}.${sec?.className?.toString()?.split(" ").join(".")}`;
      console.log("[DIAG] About the client section found:", result.aboutClientSectionSelector);
    } else {
      // Strategy B: search for container with "about" + "client" in class/id
      const fallbackSels = [
        '[class*="aboutClient" i]', '[class*="about-client" i]',
        '[class*="ClientInfo" i]',  '[class*="client-info" i]',
        '[data-test*="client" i]',  '[id*="client" i]',
      ];
      for (const sel of fallbackSels) {
        const el = document.querySelector(sel);
        if (el) {
          result.aboutClientSection = el.outerHTML?.slice(0, 8000) || null;
          result.aboutClientSectionSelector = sel;
          console.log("[DIAG] About the client (fallback):", sel);
          break;
        }
      }
      if (!result.aboutClientSection) {
        console.warn("[DIAG] 'About the client' section NOT found by any strategy");
      }
    }
  } catch (e) {
    result.aboutClientSection = { error: e.message };
    console.warn("[DIAG] aboutClient error:", e);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 3. Proposal/applicant section
  // ──────────────────────────────────────────────────────────────────────────
  try {
    const proposalSels = [
      '[data-test*="proposal" i]', '[data-test*="applicant" i]',
      '[class*="proposal" i]',     '[class*="Proposal" i]',
      '[class*="applicant" i]',    '[id*="proposal" i]',
    ];
    for (const sel of proposalSels) {
      const el = document.querySelector(sel);
      if (el) {
        result.proposalSection = el.closest("section, div, aside")?.outerHTML?.slice(0, 4000) || el.outerHTML?.slice(0, 4000);
        result.proposalSectionSelector = sel;
        console.log("[DIAG] Proposal section:", sel);
        break;
      }
    }
    // Also search body text for proposal patterns
    const bodyText = document.body.innerText || "";
    const propMatch = bodyText.match(/(Less\s+than\s+\d+|\d+\s*\+|\d+\s*[-–]\s*\d+)\s*(proposals?|bids?|applicants?)/i);
    if (propMatch) {
      result.proposalTextInBody = propMatch[0];
      console.log("[DIAG] Proposal text in body:", propMatch[0]);
    }
  } catch (e) {
    result.proposalSection = { error: e.message };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 4. SVG elements with aria-label or <title>
  // ──────────────────────────────────────────────────────────────────────────
  try {
    const svgs = [...document.querySelectorAll("svg")];
    for (const svg of svgs) {
      const ariaLabel = svg.getAttribute("aria-label") || null;
      const title     = svg.querySelector("title")?.textContent || null;
      const cls       = svg.className?.baseVal || svg.className?.toString() || null;
      const parentText = svg.closest("[aria-label], [data-test], li, dt")?.textContent?.trim()?.slice(0, 80) || null;

      if (!ariaLabel && !title && !/payment|verif|proposal|client/i.test(cls || "")) continue;

      result.svgElements.push({ ariaLabel, title, class: cls, parentText });
    }
    console.log(`[DIAG] SVG elements with labels: ${result.svgElements.length}`);
  } catch (e) {
    console.warn("[DIAG] SVG scan error:", e);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 5. All aria-label attributes (unique values)
  // ──────────────────────────────────────────────────────────────────────────
  try {
    const seen = new Set();
    for (const el of document.querySelectorAll("[aria-label]")) {
      const v = el.getAttribute("aria-label");
      if (!v || seen.has(v)) continue;
      seen.add(v);
      result.ariaLabels.push({
        value: v,
        tag: el.tagName,
        class: el.className?.toString()?.slice(0, 60),
        text: el.textContent?.trim()?.slice(0, 60),
      });
    }
    console.log(`[DIAG] aria-label elements: ${result.ariaLabels.length}`);
  } catch (e) {
    console.warn("[DIAG] aria-label scan error:", e);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 6. All data-* attributes (unique, with tag + text)
  // ──────────────────────────────────────────────────────────────────────────
  try {
    const dataMap = {};
    for (const el of document.querySelectorAll("*")) {
      for (const attr of el.attributes) {
        if (!attr.name.startsWith("data-")) continue;
        const key = `${attr.name}="${attr.value}"`;
        if (!dataMap[key]) {
          dataMap[key] = {
            attr: attr.name,
            value: attr.value,
            tag: el.tagName,
            class: el.className?.toString()?.slice(0, 50),
            text: el.textContent?.trim()?.slice(0, 60),
          };
        }
      }
    }
    result.dataAttributes = Object.values(dataMap);
    console.log(`[DIAG] Unique data-* attributes: ${result.dataAttributes.length}`);
  } catch (e) {
    console.warn("[DIAG] data-* scan error:", e);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 7. Shadow DOM
  // ──────────────────────────────────────────────────────────────────────────
  try {
    for (const el of document.querySelectorAll("*")) {
      if (!el.shadowRoot) continue;
      const text = el.shadowRoot.textContent?.trim() || "";
      result.shadowDomHosts.push({
        tag: el.tagName,
        id: el.id || null,
        class: el.className?.toString()?.slice(0, 60),
        shadowText: text.slice(0, 500),
        hasPaymentText: /payment|verif/i.test(text),
      });
    }
    console.log(`[DIAG] Shadow DOM hosts: ${result.shadowDomHosts.length}`);
  } catch (e) {
    console.warn("[DIAG] Shadow DOM scan error:", e);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 8. React / Next.js window globals
  // ──────────────────────────────────────────────────────────────────────────
  const GLOBAL_KEYS = [
    "__NEXT_DATA__", "__APOLLO_STATE__", "__INITIAL_STATE__",
    "__REDUX_STATE__", "__PRELOADED_STATE__", "__RELAY_STORE__",
    "initialState", "__APP_STATE__", "__DATA__",
  ];
  for (const key of GLOBAL_KEYS) {
    try {
      if (!window[key]) continue;
      const json = JSON.stringify(window[key]);
      result.windowGlobals[key] = {
        sizeBytes: json.length,
        hasPayment: /payment/i.test(json),
        hasVerif: /verif/i.test(json),
        paymentExcerpts: [],
      };
      if (result.windowGlobals[key].hasPayment || result.windowGlobals[key].hasVerif) {
        const rx = /.{0,80}(?:payment|verif).{0,100}/gi;
        let m;
        while ((m = rx.exec(json)) !== null && result.windowGlobals[key].paymentExcerpts.length < 10) {
          result.windowGlobals[key].paymentExcerpts.push(m[0].replace(/\s+/g, " ").slice(0, 200));
        }
      }
      console.log(`[DIAG] window.${key}: ${json.length} bytes, hasPayment=${result.windowGlobals[key].hasPayment}`);
    } catch (e) {
      result.windowGlobals[key] = { error: e.message };
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 9. All <li> elements (client facts are typically in a list)
  // ──────────────────────────────────────────────────────────────────────────
  try {
    const lis = [...document.querySelectorAll("li")];
    result.allListItems = lis.slice(0, 100).map(li => ({
      text: li.textContent?.trim()?.slice(0, 100),
      class: li.className?.toString()?.slice(0, 60),
      dataTest: li.getAttribute("data-test") || null,
      ariaLabel: li.getAttribute("aria-label") || null,
      innerHTML: li.innerHTML?.slice(0, 300),
    }));
    console.log(`[DIAG] List items: ${lis.length} total, capturing ${result.allListItems.length}`);
  } catch (e) {
    console.warn("[DIAG] li scan error:", e);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 10. Key element probe — try known selectors and log hits/misses
  // ──────────────────────────────────────────────────────────────────────────
  const PROBE_SELS = [
    '[data-test="payment-verified"]',
    '[data-test="payment-method-verified"]',
    '[data-test="payment-not-verified"]',
    '[data-test="proposals-count"]',
    '[data-test="applicants-count"]',
    '[data-test="client-payment-verified"]',
    '[data-cy="payment-verified"]',
    '[aria-label*="payment" i]',
    '[aria-label*="verified" i]',
    '[class*="paymentVerified"]',
    '[class*="payment-verified"]',
    '[class*="PaymentVerified"]',
    '.up-icon-verified-payment',
    '[class*="proposal-count" i]',
    '[class*="ProposalCount"]',
  ];
  for (const sel of PROBE_SELS) {
    try {
      const el = document.querySelector(sel);
      result.keyElementAttempts.push({
        selector: sel,
        found: !!el,
        text: el?.textContent?.trim()?.slice(0, 80) || null,
        tag: el?.tagName || null,
        class: el?.className?.toString()?.slice(0, 60) || null,
      });
    } catch (e) {
      result.keyElementAttempts.push({ selector: sel, found: false, error: e.message });
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Output: auto-download as JSON + print to console
  // ──────────────────────────────────────────────────────────────────────────
  const json = JSON.stringify(result, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "upwork-diag.json";
  a.click();
  URL.revokeObjectURL(a.href);

  console.log("[DIAG] ✅ Done — upwork-diag.json downloaded");
  console.log("[DIAG] Summary:");
  console.log("  textNodes matched:", result.textNodes.length);
  console.log("  aboutClientSection found:", !!result.aboutClientSection);
  console.log("  proposalSection found:", !!result.proposalSection);
  console.log("  svgElements:", result.svgElements.length);
  console.log("  ariaLabels:", result.ariaLabels.length);
  console.log("  dataAttributes:", result.dataAttributes.length);
  console.log("  shadowDomHosts:", result.shadowDomHosts.length);
  console.log("  windowGlobals:", Object.keys(result.windowGlobals).join(", "));
  console.log("  keyElement hits:", result.keyElementAttempts.filter(k => k.found).map(k => k.selector).join(", ") || "NONE");

  return result;
})();
