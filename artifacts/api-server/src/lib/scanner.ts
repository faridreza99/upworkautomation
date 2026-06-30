/**
 * Upwork RSS Job Scanner
 *
 * Periodically fetches Upwork RSS feeds for configured keywords,
 * deduplicates against existing jobs, and auto-creates + AI-analyzes new ones.
 */

import * as cheerio from "cheerio";
import { XMLParser } from "fast-xml-parser";
import { eq, desc } from "drizzle-orm";
import { db, jobsTable, settingsTable, notificationsTable } from "@workspace/db";
import { proposalsTable } from "@workspace/db";
import { analyzeJobWithAI, generateProposalWithAI } from "./ai.js";
import { logger } from "./logger.js";
import { notificationService } from "./notify/service.js";
import type { Settings } from "@workspace/db";

// ─── RSS ──────────────────────────────────────────────────────────────────────

const RSS_BASE = "https://www.upwork.com/ab/feed/jobs/rss";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const MAX_QUERIES = 6;
const FETCH_DELAY_MS = 1200; // polite delay between RSS requests

interface RSSItem {
  title: string;
  link: string;
  description: string; // CDATA HTML
  pubDate: string;
  guid: string;
}

interface ParsedItem {
  title: string;
  jobUrl: string;
  upworkJobId: string | null;
  description: string;
  budgetType: "hourly" | "fixed";
  budgetMin: number | null;
  budgetMax: number | null;
  skills: string[];
  clientCountry: string | null;
}

const xmlParser = new XMLParser({ ignoreAttributes: false, cdataPropName: "__cdata" });

function extractJobId(url: string): string | null {
  const m = url.match(/~([a-zA-Z0-9]+)/);
  return m ? m[1] : null;
}

function parseBudgetText(text: string): { budgetType: "hourly" | "fixed"; budgetMin: number | null; budgetMax: number | null } {
  const isHourly = /\/hr|hourly/i.test(text);
  const nums = (text.match(/[\d,]+(?:\.\d+)?/g) ?? [])
    .map((n) => parseFloat(n.replace(/,/g, "")))
    .filter((n) => !isNaN(n) && n > 0);
  return {
    budgetType: isHourly ? "hourly" : "fixed",
    budgetMin: nums[0] ?? null,
    budgetMax: nums[1] ?? nums[0] ?? null,
  };
}

function parseRSSDescription(html: string): {
  description: string;
  budgetType: "hourly" | "fixed";
  budgetMin: number | null;
  budgetMax: number | null;
  skills: string[];
  clientCountry: string | null;
} {
  const $ = cheerio.load(html);

  // Extract structured fields from Upwork RSS CDATA HTML
  let budgetType: "hourly" | "fixed" = "hourly";
  let budgetMin: number | null = null;
  let budgetMax: number | null = null;
  let skills: string[] = [];
  let clientCountry: string | null = null;

  // Upwork RSS description format:
  // <b>Budget</b>: $50.00-$100.00 Hourly<br/>
  // <b>Skills</b>: React, TypeScript<br/>
  // <b>Country</b>: United States<br/>
  $("b").each((_, el) => {
    const label = $(el).text().trim().toLowerCase();
    const nextText = ($(el).next().text() + $(el).parent().text())
      .replace($(el).text(), "")
      .split("<br")[0]
      .trim();

    // Get the text content after the <b> tag
    const fullText = $(el).parent().text();
    const afterLabel = fullText.substring(fullText.indexOf($(el).text()) + $(el).text().length).split("\n")[0].trim();

    if (label === "budget" || label === "budget:") {
      const parsed = parseBudgetText(afterLabel);
      budgetType = parsed.budgetType;
      budgetMin = parsed.budgetMin;
      budgetMax = parsed.budgetMax;
    } else if (label === "skills" || label === "skills:") {
      skills = afterLabel.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (label === "country" || label === "country:") {
      clientCountry = afterLabel || null;
    }
  });

  // Fallback: regex on raw HTML for budget
  if (!budgetMin) {
    const budgetMatch = html.match(/Budget[:\s]+([^<\n]{3,60})/i);
    if (budgetMatch) {
      const parsed = parseBudgetText(budgetMatch[1]);
      budgetType = parsed.budgetType;
      budgetMin = parsed.budgetMin;
      budgetMax = parsed.budgetMax;
    }
  }

  // Fallback: regex for skills
  if (!skills.length) {
    const skillsMatch = html.match(/Skills[:\s]+([^<\n]{3,200})/i);
    if (skillsMatch) {
      skills = skillsMatch[1].split(",").map((s) => s.trim()).filter(Boolean);
    }
  }

  // Fallback: regex for country
  if (!clientCountry) {
    const countryMatch = html.match(/Country[:\s]+([^<\n]{2,80})/i);
    if (countryMatch) {
      clientCountry = countryMatch[1].trim() || null;
    }
  }

  // Extract plain description (remove HTML tags, keep meaningful text)
  const plainText = $.text().replace(/\s+/g, " ").trim();
  // Strip the metadata fields from description start
  const descCleaned = plainText
    .replace(/^(Budget|Hourly Range|Fixed-Price|Posted On|Category|Skills?|Country|Subcategory):?\s*[^\n.]*/gim, "")
    .replace(/\s+/g, " ")
    .trim();

  return { description: descCleaned || plainText, budgetType, budgetMin, budgetMax, skills, clientCountry };
}

async function fetchRSSFeed(query: string): Promise<RSSItem[]> {
  const url = `${RSS_BASE}?q=${encodeURIComponent(query)}&sort=recency&paging=0;20`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/rss+xml,application/xml,text/xml,*/*" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`RSS ${res.status}: ${url}`);

  const xml = await res.text();
  const parsed = xmlParser.parse(xml);
  const channel = parsed?.rss?.channel;
  if (!channel) return [];

  const items: any[] = Array.isArray(channel.item) ? channel.item : channel.item ? [channel.item] : [];

  return items.map((item) => ({
    title: typeof item.title === "string" ? item.title : (item.title?.__cdata ?? ""),
    link: item.link ?? item.guid ?? "",
    description: item.description?.__cdata ?? item.description ?? "",
    pubDate: item.pubDate ?? "",
    guid: item.guid?.__cdata ?? item.guid ?? item.link ?? "",
  }));
}

function parseRSSItem(item: RSSItem): ParsedItem {
  const { description, budgetType, budgetMin, budgetMax, skills, clientCountry } =
    parseRSSDescription(item.description);

  return {
    title: item.title.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim(),
    jobUrl: item.link,
    upworkJobId: extractJobId(item.link),
    description: description || item.title,
    budgetType,
    budgetMin,
    budgetMax,
    skills,
    clientCountry,
  };
}

// ─── State ────────────────────────────────────────────────────────────────────

interface ScannerState {
  enabled: boolean;
  running: boolean;
  intervalMinutes: number;
  lastRunAt: string | null;
  lastRunJobsFound: number;
  lastRunNewJobs: number;
  lastRunError: string | null;
  nextRunAt: string | null;
  totalJobsImported: number;
}

let state: ScannerState = {
  enabled: false,
  running: false,
  intervalMinutes: 30,
  lastRunAt: null,
  lastRunJobsFound: 0,
  lastRunNewJobs: 0,
  lastRunError: null,
  nextRunAt: null,
  totalJobsImported: 0,
};

let intervalId: NodeJS.Timeout | null = null;

// ─── Core scan ────────────────────────────────────────────────────────────────

async function runScan(): Promise<void> {
  if (state.running) {
    logger.info("Scanner already running, skipping");
    return;
  }

  state.running = true;
  state.lastRunError = null;

  logger.info("RSS scanner starting run");

  try {
    // Load fresh settings from DB
    const settingsRows = await db.select().from(settingsTable).limit(1);
    const settings = settingsRows[0] ?? null;

    const keywords: string[] = settings?.keywords ?? [];
    const userSkills: string[] = settings?.userSkills ?? [];
    const blacklistedClients: string[] = settings?.blacklistedClients ?? [];
    const minAiScore = settings?.minAiScore ?? 70;

    // Build queries: keywords first, then fill up with skills
    const allTerms = [
      ...keywords,
      ...userSkills.filter((s) => !keywords.some((k) => k.toLowerCase() === s.toLowerCase())),
    ];
    const queries = allTerms.slice(0, MAX_QUERIES);

    if (queries.length === 0) {
      logger.info("Scanner: no keywords or skills configured, skipping");
      state.lastRunAt = new Date().toISOString();
      state.lastRunJobsFound = 0;
      state.lastRunNewJobs = 0;
      state.running = false;
      return;
    }

    logger.info({ queries }, "Scanner fetching RSS feeds");

    let totalFound = 0;
    let totalNew = 0;

    for (const query of queries) {
      try {
        const items = await fetchRSSFeed(query);
        totalFound += items.length;
        logger.info({ query, count: items.length }, "RSS feed fetched");

        for (const item of items) {
          const parsed = parseRSSItem(item);

          // Dedup: check by upworkJobId first, then by title similarity
          let exists = false;
          if (parsed.upworkJobId) {
            const existing = await db
              .select({ id: jobsTable.id })
              .from(jobsTable)
              .where(eq(jobsTable.upworkJobId, parsed.upworkJobId))
              .limit(1);
            exists = existing.length > 0;
          }

          if (!exists && !parsed.upworkJobId) {
            // Check for same title within last 7 days
            const existing = await db
              .select({ id: jobsTable.id })
              .from(jobsTable)
              .where(eq(jobsTable.title, parsed.title))
              .limit(1);
            exists = existing.length > 0;
          }

          if (exists) continue;

          // Blacklist pre-filter — skip before hitting DB or AI
          if (blacklistedClients.length > 0) {
            const haystack = `${parsed.title} ${parsed.description} ${parsed.clientCountry ?? ""}`.toLowerCase();
            const hit = blacklistedClients.find((c) => haystack.includes(c.toLowerCase()));
            if (hit) {
              logger.info({ title: parsed.title, hit }, "Scanner: skipping blacklisted client");
              continue;
            }
          }

          // Create new job
          const [newJob] = await db.insert(jobsTable).values({
            upworkJobId: parsed.upworkJobId ?? undefined,
            title: parsed.title,
            description: parsed.description,
            budgetType: parsed.budgetType,
            budgetMin: parsed.budgetMin ?? undefined,
            budgetMax: parsed.budgetMax ?? undefined,
            skills: parsed.skills,
            clientCountry: parsed.clientCountry ?? undefined,
            jobUrl: parsed.jobUrl,
            status: "analyzing",
          }).returning();

          totalNew++;
          state.totalJobsImported++;

          logger.info({ jobId: newJob.id, title: newJob.title }, "Scanner: new job created");

          // AI analysis — fire async, don't block the loop
          (async () => {
            try {
              const analysis = await analyzeJobWithAI(newJob, settings);

              await db
                .update(jobsTable)
                .set({
                  applyScore: analysis.applyScore,
                  riskScore: analysis.riskScore,
                  winProbability: analysis.winProbability,
                  aiRecommendation: analysis.recommendation,
                  aiReasoning: analysis.reasoning,
                  status: analysis.recommendation === "skip" ? "skipped" : "approved",
                  updatedAt: new Date(),
                })
                .where(eq(jobsTable.id, newJob.id));

              // Notification for high-score jobs
              if (analysis.applyScore >= minAiScore && settings?.notifyOnHighScore) {
                await db.insert(notificationsTable).values({
                  type: "high_score_job",
                  message: `🔍 Scanner found high-score job: "${newJob.title}" scored ${analysis.applyScore}/100`,
                  jobId: newJob.id,
                  read: false,
                });

                notificationService.send({
                  type: "high_score_job",
                  title: `Scanner: ${newJob.title}`,
                  body: analysis.reasoning ?? "",
                  job: {
                    title: newJob.title,
                    budgetMin: newJob.budgetMin,
                    budgetMax: newJob.budgetMax,
                    budgetType: newJob.budgetType,
                    clientCountry: newJob.clientCountry,
                    paymentVerified: newJob.paymentVerified,
                    applyScore: analysis.applyScore,
                    winProbability: analysis.winProbability,
                    riskScore: analysis.riskScore,
                    recommendation: analysis.recommendation,
                    jobUrl: newJob.jobUrl,
                  },
                }).catch(() => {});
              }

              // Auto-generate proposal if enabled
              const s = settings as any;
              if (analysis.recommendation !== "skip" && analysis.applyScore >= minAiScore && s?.autoProposalEnabled) {
                try {
                  const proposal = await generateProposalWithAI(newJob, settings, "professional", null, false);
                  const proposalStatus =
                    s.autoApplyEnabled && !s.manualApprovalMode ? "approved" : "draft";
                  await db.insert(proposalsTable).values({
                    jobId: newJob.id,
                    content: proposal.content,
                    coverLetter: proposal.coverLetter,
                    status: proposalStatus,
                  });
                  logger.info({ jobId: newJob.id, proposalStatus }, "Scanner: auto-generated proposal");
                } catch (pErr: any) {
                  logger.warn({ jobId: newJob.id, err: pErr.message }, "Scanner: auto-proposal generation failed");
                }
              }

              logger.info({ jobId: newJob.id, score: analysis.applyScore }, "Scanner: job analyzed");
            } catch (err: any) {
              logger.error({ jobId: newJob.id, err: err.message }, "Scanner: AI analysis failed");
              await db.update(jobsTable).set({ status: "new", updatedAt: new Date() }).where(eq(jobsTable.id, newJob.id));
            }
          })();
        }

        // Polite delay between queries
        await new Promise((r) => setTimeout(r, FETCH_DELAY_MS));
      } catch (err: any) {
        logger.warn({ query, err: err.message }, "Scanner: RSS fetch failed for query");
      }
    }

    state.lastRunAt = new Date().toISOString();
    state.lastRunJobsFound = totalFound;
    state.lastRunNewJobs = totalNew;
    logger.info({ totalFound, totalNew }, "RSS scanner run complete");
  } catch (err: any) {
    state.lastRunError = err.message ?? "Unknown error";
    logger.error({ err: err.message }, "Scanner run failed");
  } finally {
    state.running = false;
    updateNextRun();
  }
}

function updateNextRun() {
  if (!state.enabled || !state.lastRunAt) {
    state.nextRunAt = null;
    return;
  }
  const next = new Date(state.lastRunAt);
  next.setMinutes(next.getMinutes() + state.intervalMinutes);
  state.nextRunAt = next.toISOString();
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function startScanner(enabled: boolean, intervalMinutes: number) {
  // Stop existing interval
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }

  state.enabled = enabled;
  state.intervalMinutes = intervalMinutes;

  if (!enabled) {
    state.nextRunAt = null;
    logger.info("RSS scanner disabled");
    return;
  }

  logger.info({ intervalMinutes }, "RSS scanner starting");

  // Run immediately on start
  runScan().catch(() => {});

  // Schedule recurring scans
  intervalId = setInterval(() => {
    runScan().catch(() => {});
  }, intervalMinutes * 60 * 1000);
}

export function stopScanner() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  state.enabled = false;
  state.nextRunAt = null;
  logger.info("RSS scanner stopped");
}

export function triggerScan(): void {
  runScan().catch((err) => logger.error({ err }, "Triggered scan failed"));
}

export function getScannerStatus(): ScannerState {
  return { ...state };
}

export function updateScannerConfig(enabled: boolean, intervalMinutes: number) {
  const wasEnabled = state.enabled;
  const oldInterval = state.intervalMinutes;

  if (enabled !== wasEnabled || intervalMinutes !== oldInterval) {
    startScanner(enabled, intervalMinutes);
  }
}

/**
 * Bootstrap: load settings from DB and start scanner if enabled.
 */
export async function initScanner() {
  try {
    const rows = await db.select().from(settingsTable).limit(1);
    const settings = rows[0];
    if (settings?.scanEnabled) {
      startScanner(true, settings.scanIntervalMinutes ?? 30);
    } else {
      logger.info("RSS scanner disabled in settings, not starting");
    }
  } catch (err: any) {
    logger.warn({ err: err.message }, "Could not init scanner from settings");
  }
}
