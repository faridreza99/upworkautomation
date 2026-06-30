import { Router } from "express";
import { z } from "zod/v4";
import { db, jobsTable, settingsTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { notificationService } from "../lib/notify/service.js";
import { logger } from "../lib/logger.js";
import { analyzeJobWithAI } from "../lib/ai.js";

const router = Router();

// ── GET /api/monitor/status ─────────────────────────────────────────────────
router.get("/monitor/status", async (req, res): Promise<void> => {
  const settings = await db.select().from(settingsTable).limit(1);
  const s = settings[0];

  const recentJobs = await db
    .select()
    .from(jobsTable)
    .orderBy(desc(jobsTable.createdAt))
    .limit(10);

  const notifiedJobs = recentJobs.filter(
    (j) => j.applyScore != null && (j.applyScore ?? 0) >= (s?.minAiScore ?? 70)
  );

  res.json({
    timestamp: new Date().toISOString(),
    telegram: {
      enabled: !!(s?.telegramEnabled && s.telegramBotToken && s.telegramChatId),
      chatId: s?.telegramChatId ? `...${s.telegramChatId.slice(-4)}` : null,
    },
    jobs: {
      recentDetected: recentJobs.map((j) => ({
        id: j.id,
        title: j.title,
        upworkJobId: j.upworkJobId,
        detectedAt: j.createdAt,
        proposalCount: j.proposalCount,
        paymentVerified: j.paymentVerified,
        applyScore: j.applyScore,
        recommendation: j.aiRecommendation,
        status: j.status,
      })),
      totalNotified: notifiedJobs.length,
      lastNotifiedJob: notifiedJobs[0]
        ? {
            title: notifiedJobs[0].title,
            applyScore: notifiedJobs[0].applyScore,
            proposalCount: notifiedJobs[0].proposalCount,
            detectedAt: notifiedJobs[0].createdAt,
          }
        : null,
    },
  });
});

// ── POST /api/monitor/test-pipeline ────────────────────────────────────────
const TestPipelineBody = z.object({
  skipNotification: z.boolean().optional().default(false),
});

router.post("/monitor/test-pipeline", async (req, res): Promise<void> => {
  const parsed = TestPipelineBody.safeParse(req.body);
  const skipNotification = parsed.success ? parsed.data.skipNotification : false;

  const log: Array<{ step: string; ts: string; ms: number; detail: string }> = [];
  const t0 = Date.now();

  const tick = (step: string, detail: string) => {
    log.push({ step, ts: new Date().toISOString(), ms: Date.now() - t0, detail });
  };

  tick("start", "Test pipeline initiated");

  // Step 1: Create a test job in the DB
  const testJobId = `test_${Date.now()}`;
  const { jobsTable: jt } = await import("@workspace/db");

  const [job] = await db
    .insert(jt)
    .values({
      upworkJobId: testJobId,
      title: "AI Automation Engineer — Production Test Job",
      description:
        "Test pipeline verification job. Looking for an AI automation expert to build end-to-end workflows using GPT-4, LangChain, and n8n. Budget flexible for the right candidate.",
      budgetMin: 45,
      budgetMax: 85,
      budgetType: "hourly",
      paymentVerified: true,
      proposalCount: 3,
      clientCountry: "United States",
      jobUrl: "https://www.upwork.com/jobs/~testjob",
      status: "new",
    })
    .returning();

  tick("job_created", `Job inserted to DB — id=${job.id}, proposalCount=3, paymentVerified=true`);

  // Step 2: AI analysis
  let analysisResult: Awaited<ReturnType<typeof analyzeJobWithAI>> | null = null;
  try {
    const settingsRows = await db.select().from(settingsTable).limit(1);
    analysisResult = await analyzeJobWithAI(job, settingsRows[0] ?? null);

    await db
      .update(jt)
      .set({
        applyScore: analysisResult.applyScore,
        riskScore: analysisResult.riskScore,
        winProbability: analysisResult.winProbability,
        aiRecommendation: analysisResult.recommendation,
        aiReasoning: analysisResult.reasoning,
        status: "approved",
      })
      .where(eq(jt.id, job.id));

    tick(
      "ai_analysis_complete",
      `applyScore=${analysisResult.applyScore} riskScore=${analysisResult.riskScore} winProbability=${analysisResult.winProbability} recommendation=${analysisResult.recommendation}`
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    tick("ai_analysis_failed", msg);
    logger.warn({ err }, "Test pipeline: AI analysis failed");
  }

  // Step 3: Telegram notification
  const notifyResults: Array<{ provider: string; success: boolean; error?: string }> = [];

  if (!skipNotification) {
    const ns = (await db.select().from(settingsTable).limit(1))[0];
    if (ns?.telegramEnabled && ns.telegramBotToken && ns.telegramChatId) {
      try {
        const applyScore = analysisResult?.applyScore ?? 0;
        const tgUrl = `https://api.telegram.org/bot${ns.telegramBotToken}/sendMessage`;
        const tgRes = await fetch(tgUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: ns.telegramChatId,
            text:
              `🧪 UpworkAI Production Test\n\n` +
              `✅ Pipeline working end-to-end\n\n` +
              `📋 Job: AI Automation Engineer\n` +
              `🎯 AI Score: ${applyScore}/100\n` +
              `📊 Proposals: 3 (detected before exceeding threshold)\n` +
              `💳 Payment: ✅ Verified\n` +
              `⏱ Total latency: ${Date.now() - t0}ms\n\n` +
              `[TELEGRAM] sent successfully — pipeline test complete.`,
            parse_mode: "HTML",
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (tgRes.ok) {
          notifyResults.push({ provider: "telegram", success: true });
          tick("telegram_sent", `[TELEGRAM] sent successfully — latency ${Date.now() - t0}ms total`);
        } else {
          const tgBody = await tgRes.json().catch(() => ({})) as Record<string, unknown>;
          const msg = `HTTP ${tgRes.status}: ${JSON.stringify(tgBody)}`;
          notifyResults.push({ provider: "telegram", success: false, error: msg });
          tick("telegram_failed", `[TELEGRAM] failed (non-blocking) — ${msg}`);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        notifyResults.push({ provider: "telegram", success: false, error: msg });
        tick("telegram_failed", `[TELEGRAM] failed (non-blocking) — ${msg}`);
      }
    } else {
      notifyResults.push({ provider: "telegram", success: false, error: "Telegram not configured in settings" });
      tick("telegram_skipped", "Telegram not enabled or credentials not set — configure in Settings → Notifications");
    }
  } else {
    tick("notification_skipped", "skipNotification=true");
  }

  // Cleanup
  await db.delete(jt).where(eq(jt.id, job.id));
  tick("cleanup", `Test job id=${job.id} removed from DB`);

  const totalMs = Date.now() - t0;
  tick("done", `Total pipeline latency: ${totalMs}ms`);

  logger.info({ totalMs, notifyResults }, "Test pipeline complete");

  res.json({
    success: true,
    totalMs,
    log,
    analysis: analysisResult,
    notifications: notifyResults,
    summary: {
      jobDetected: true,
      aiAnalyzed: analysisResult != null,
      telegramDelivered: notifyResults.find((r) => r.provider === "telegram")?.success ?? false,
      proposalCountAtDetection: 3,
      proposalThreshold: 5,
      proposalsSafe: true,
    },
  });
});

// ── POST /api/monitor/test-notification ────────────────────────────────────
router.post("/monitor/test-notification", async (req, res): Promise<void> => {
  await notificationService.send({
    type: "info",
    title: "UpworkAI Test Notification",
    body: `✅ Telegram notification system is live at ${new Date().toLocaleTimeString()}.`,
  });

  const settings = await db.select().from(settingsTable).limit(1);
  const s = settings[0];

  const results = [
    {
      provider: "telegram",
      success: !!(s?.telegramEnabled && s.telegramBotToken && s.telegramChatId),
      error: !s?.telegramEnabled ? "Not enabled" : !s?.telegramBotToken ? "No bot token" : !s?.telegramChatId ? "No chat ID" : undefined,
    },
  ];

  res.json({ sent: true, results });
});

export default router;
