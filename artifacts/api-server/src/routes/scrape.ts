/**
 * Upwork Job Scraper
 * Fetches a public Upwork job page and extracts structured data.
 * Uses multiple strategies in priority order: JSON-LD → embedded JSON → HTML elements.
 */
import { Router, type IRouter } from "express";
import * as cheerio from "cheerio";
import { z } from "zod";

const router: IRouter = Router();

const ScrapeBody = z.object({
  url: z.string().url("Must be a valid URL"),
});

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

type ScrapedJob = {
  title: string;
  description: string;
  budgetType: "hourly" | "fixed";
  budgetMin: number | null;
  budgetMax: number | null;
  skills: string[];
  clientCountry: string | null;
  clientHireRate: number | null;
  clientTotalSpent: number | null;
  paymentVerified: boolean;
  proposalCount: number | null;
  jobUrl: string;
  upworkJobId: string | null;
};

function extractJobId(url: string): string | null {
  const m = url.match(/~([a-zA-Z0-9]+)/);
  return m ? m[1] : null;
}

function parseMoney(text: string): number | null {
  const cleaned = text.replace(/[^0-9.KMkm]/g, "");
  if (!cleaned) return null;
  const val = parseFloat(cleaned);
  if (isNaN(val)) return null;
  if (/[Kk]/.test(cleaned)) return val * 1000;
  if (/[Mm]/.test(cleaned)) return val * 1_000_000;
  return val;
}

function parseBudget(text: string): { budgetType: "hourly" | "fixed"; budgetMin: number | null; budgetMax: number | null } {
  const isHourly = /\/hr|hourly/i.test(text);
  const nums = (text.match(/[\d,.]+/g) ?? [])
    .map((n) => parseFloat(n.replace(/,/g, "")))
    .filter((n) => !isNaN(n) && n > 0);
  return {
    budgetType: isHourly ? "hourly" : "fixed",
    budgetMin: nums[0] ?? null,
    budgetMax: nums[1] ?? nums[0] ?? null,
  };
}

function cleanText(t: string): string {
  return t.replace(/\s+/g, " ").trim();
}

/**
 * Strategy 1 — JSON-LD structured data
 */
function fromJsonLd($: cheerio.CheerioAPI): Partial<ScrapedJob> {
  const result: Partial<ScrapedJob> = {};
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).text() ?? "{}");
      const job = Array.isArray(data) ? data.find((d) => d["@type"] === "JobPosting") : data["@type"] === "JobPosting" ? data : null;
      if (!job) return;
      if (job.title) result.title = cleanText(job.title);
      if (job.description) result.description = cleanText(job.description.replace(/<[^>]+>/g, " "));
      if (job.jobLocation?.address?.addressCountry) result.clientCountry = job.jobLocation.address.addressCountry;
      if (job.baseSalary) {
        const { minValue, maxValue, unitText } = job.baseSalary.value ?? {};
        result.budgetType = /hour/i.test(unitText ?? "") ? "hourly" : "fixed";
        result.budgetMin = minValue ?? null;
        result.budgetMax = maxValue ?? minValue ?? null;
      }
    } catch { /* ignore */ }
  });
  return result;
}

/**
 * Strategy 2 — Upwork embedded window.__NUXT_DATA__ or similar JSON blobs
 */
function fromEmbeddedJson($: cheerio.CheerioAPI): Partial<ScrapedJob> {
  const result: Partial<ScrapedJob> = {};
  $("script:not([src])").each((_, el) => {
    const src = $(el).text();
    if (!src.includes("ciphertext") && !src.includes("jobDetails")) return;

    // Try to find title-like strings
    const titleMatch = src.match(/"title"\s*:\s*"([^"]{10,120})"/);
    if (titleMatch && !result.title) result.title = titleMatch[1];

    const descMatch = src.match(/"description"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (descMatch && !result.description) {
      result.description = descMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\t/g, " ").replace(/<[^>]+>/g, "").trim();
    }

    const countryMatch = src.match(/"country"\s*:\s*"([A-Z]{2,3})"/);
    if (countryMatch && !result.clientCountry) result.clientCountry = countryMatch[1];
  });
  return result;
}

/**
 * Strategy 3 — Direct HTML element parsing
 */
function fromHtml($: cheerio.CheerioAPI): Partial<ScrapedJob> {
  const result: Partial<ScrapedJob> = {};

  // Title
  const titleSelectors = [
    "h1[data-test='job-title']",
    "h1.m-0-bottom",
    "h1.job-title",
    "[data-test='job-title']",
    "h1",
  ];
  for (const sel of titleSelectors) {
    const t = $(sel).first().text().trim();
    if (t && t.length > 3 && t.length < 200) { result.title = t; break; }
  }

  // Description
  const descSelectors = [
    "[data-test='description']",
    ".description-text",
    ".o-trusted-html-content",
    ".job-description",
    "[class*='description']",
  ];
  for (const sel of descSelectors) {
    const el = $(sel).first();
    if (el.length) {
      const t = cleanText(el.text());
      if (t.length > 50) { result.description = t; break; }
    }
  }

  // Budget
  const budgetSelectors = [
    "[data-test='budget']",
    "[data-test='hourly-rate']",
    ".js-budget",
    "[class*='budget']",
    "[class*='price']",
    "[class*='rate']",
  ];
  for (const sel of budgetSelectors) {
    const t = $(sel).first().text().trim();
    if (t && /\$/.test(t)) {
      const parsed = parseBudget(t);
      result.budgetType = parsed.budgetType;
      result.budgetMin = parsed.budgetMin;
      result.budgetMax = parsed.budgetMax;
      break;
    }
  }

  // Skills
  const skillSelectors = [
    "[data-test='token']",
    ".skill-badge",
    ".o-tag-skill",
    "[class*='skill']",
    "[data-test='attr-item']",
  ];
  const skills: string[] = [];
  for (const sel of skillSelectors) {
    $(sel).each((_, el) => {
      const t = $(el).text().trim();
      if (t && t.length < 60 && !skills.includes(t)) skills.push(t);
    });
    if (skills.length > 0) break;
  }
  result.skills = skills;

  // Client country
  const countrySelectors = [
    "[data-test='client-country']",
    ".client-country",
    "[class*='country']",
  ];
  for (const sel of countrySelectors) {
    const t = $(sel).first().text().trim();
    if (t && t.length > 1 && t.length < 80) { result.clientCountry = t; break; }
  }

  // Payment verified
  result.paymentVerified = $(
    "[data-test='payment-verified'], .payment-verified, [class*='payment-verified']"
  ).length > 0;

  // Proposal count
  const propText = $("[data-test='proposals-count'], .proposals-count").first().text();
  const propNum = parseInt(propText.match(/\d+/)?.[0] ?? "", 10);
  result.proposalCount = isNaN(propNum) ? null : propNum;

  // Client hire rate
  const hireText = $("[data-test='hire-rate'], [class*='hire-rate']").first().text();
  const hireNum = parseFloat(hireText.match(/[\d.]+/)?.[0] ?? "");
  result.clientHireRate = isNaN(hireNum) ? null : hireNum;

  // Client total spent
  const spentText = $("[data-test='total-spent'], [class*='total-spent']").first().text();
  const spentVal = parseMoney(spentText);
  result.clientTotalSpent = spentVal;

  return result;
}

/**
 * Fallback — grab page title and as much body text as possible
 */
function fromMeta($: cheerio.CheerioAPI): Partial<ScrapedJob> {
  const metaTitle = $("meta[property='og:title']").attr("content") ??
                    $("meta[name='title']").attr("content") ??
                    $("title").text();
  const metaDesc = $("meta[property='og:description']").attr("content") ??
                   $("meta[name='description']").attr("content") ?? "";
  return {
    title: metaTitle ? cleanText(metaTitle.replace(/\s*[|\-–].*$/, "")) : undefined,
    description: metaDesc ? cleanText(metaDesc) : undefined,
  };
}

/**
 * Main scrape handler
 */
router.post("/scrape", async (req, res): Promise<void> => {
  const parsed = ScrapeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request: provide a valid url" });
    return;
  }

  const { url } = parsed.data;

  // Only allow Upwork URLs
  if (!url.includes("upwork.com")) {
    res.status(400).json({ error: "Only Upwork job URLs are supported" });
    return;
  }

  let html: string;
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      res.status(502).json({
        error: `Upwork returned ${response.status}. The page may require login or the URL may be invalid.`,
      });
      return;
    }

    html = await response.text();
  } catch (err: any) {
    const msg = err?.name === "TimeoutError" ? "Request timed out (15s)" : err?.message ?? "Network error";
    res.status(502).json({ error: `Failed to fetch page: ${msg}` });
    return;
  }

  const $ = cheerio.load(html);

  // Check for login wall
  const pageText = $("body").text().toLowerCase();
  if (pageText.includes("log in to view") || pageText.includes("sign in to view") || $("title").text().toLowerCase().includes("login")) {
    res.status(403).json({
      error: "This job requires login to view. Try copying the job description manually.",
    });
    return;
  }

  // Merge strategies — later ones fill in any gaps
  const meta = fromMeta($);
  const jsonLd = fromJsonLd($);
  const embedded = fromEmbeddedJson($);
  const htmlData = fromHtml($);

  const job: ScrapedJob = {
    title: htmlData.title ?? jsonLd.title ?? embedded.title ?? meta.title ?? "Untitled Job",
    description: htmlData.description ?? jsonLd.description ?? embedded.description ?? meta.description ?? "",
    budgetType: htmlData.budgetType ?? jsonLd.budgetType ?? "hourly",
    budgetMin: htmlData.budgetMin ?? jsonLd.budgetMin ?? null,
    budgetMax: htmlData.budgetMax ?? jsonLd.budgetMax ?? null,
    skills: (htmlData.skills?.length ? htmlData.skills : []),
    clientCountry: htmlData.clientCountry ?? jsonLd.clientCountry ?? embedded.clientCountry ?? null,
    clientHireRate: htmlData.clientHireRate ?? null,
    clientTotalSpent: htmlData.clientTotalSpent ?? null,
    paymentVerified: htmlData.paymentVerified ?? false,
    proposalCount: htmlData.proposalCount ?? null,
    jobUrl: url,
    upworkJobId: extractJobId(url),
  };

  res.json(job);
});

export default router;
