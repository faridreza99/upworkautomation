import { Router } from "express";
import { db, jobsTable, settingsTable, applyTriggersTable } from "@workspace/db";
import { desc, and, notInArray, gte, eq } from "drizzle-orm";
import { generateProposalWithAI } from "../lib/ai.js";
import { logger } from "../lib/logger.js";

const router = Router();
const TG_API = "https://api.telegram.org";

// ── Telegram helpers ────────────────────────────────────────────────────────

async function tgReply(token: string, chatId: string, text: string): Promise<void> {
  try {
    await fetch(`${TG_API}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
  } catch (err) {
    logger.warn({ err }, "[TG-WEBHOOK] Failed to send reply");
  }
}

// ── Best job selection ──────────────────────────────────────────────────────

async function selectBestJob() {
  // Prefer: highest applyScore, not already applied/rejected, payment verified
  const rows = await db
    .select()
    .from(jobsTable)
    .where(
      notInArray(jobsTable.status, ["applied", "rejected"])
    )
    .orderBy(desc(jobsTable.applyScore))
    .limit(10);

  if (!rows.length) return null;

  // Prefer recommend=apply and payment verified; fall back to any scored job
  const best =
    rows.find((j) => j.aiRecommendation === "apply" && j.paymentVerified) ??
    rows.find((j) => j.aiRecommendation === "apply") ??
    rows.find((j) => j.applyScore != null) ??
    rows[0]!;

  return best ?? null;
}

// ── POST /api/telegram/webhook ──────────────────────────────────────────────
router.post("/telegram/webhook", async (req, res): Promise<void> => {
  // Ack Telegram immediately (must respond within 10 s)
  res.sendStatus(200);

  const update = req.body as TelegramUpdate;
  const message = update?.message;
  if (!message?.text) return;

  const fromId = String(message.from?.id ?? "");
  const chatId = String(message.chat?.id ?? "");
  const text = (message.text ?? "").trim();

  // ── Load settings ────────────────────────────────────────────────────────
  const rows = await db.select().from(settingsTable).limit(1);
  const s = rows[0];
  if (!s?.telegramEnabled || !s.telegramBotToken || !s.telegramChatId) return;

  const token = s.telegramBotToken;
  const allowedChatId = String(s.telegramChatId);

  // ── Security: only respond to the configured chat ────────────────────────
  if (chatId !== allowedChatId && fromId !== allowedChatId) {
    logger.warn({ chatId, fromId }, "[TG-WEBHOOK] Message from unknown chat — ignored");
    return;
  }

  const cmd = text.toUpperCase().replace(/^\//, "").split(" ")[0] ?? "";
  logger.info({ cmd, chatId }, "[TG-WEBHOOK] Command received");

  // ── /STATUS command ──────────────────────────────────────────────────────
  if (cmd === "STATUS") {
    const recentJobs = await db
      .select()
      .from(jobsTable)
      .orderBy(desc(jobsTable.createdAt))
      .limit(5);

    const pendingTriggers = await db
      .select()
      .from(applyTriggersTable)
      .where(eq(applyTriggersTable.status, "pending"));

    const lines = [
      "📊 <b>UpworkAI Status</b>",
      "",
      `🔍 <b>Recent jobs:</b> ${recentJobs.length}`,
      ...recentJobs.map(
        (j) =>
          `  • ${j.title.slice(0, 50)} — score: ${j.applyScore ?? "?"}/100 [${j.status}]`
      ),
      "",
      `🚀 <b>Pending apply triggers:</b> ${pendingTriggers.length}`,
      "",
      "Commands: /apply /status /skip",
    ];

    await tgReply(token, allowedChatId, lines.join("\n"));
    return;
  }

  // ── /APPLY command ───────────────────────────────────────────────────────
  if (cmd === "APPLY") {
    await tgReply(token, allowedChatId, "🔍 Finding the best job and generating proposal…");

    const job = await selectBestJob();
    if (!job) {
      await tgReply(token, allowedChatId, "⚠️ No suitable job found. Wait for the scanner to detect new jobs.");
      return;
    }

    if (!job.jobUrl) {
      await tgReply(
        token,
        allowedChatId,
        `⚠️ Job found (<b>${job.title.slice(0, 60)}</b>) but has no URL. Cannot auto-apply.`
      );
      return;
    }

    await tgReply(
      token,
      allowedChatId,
      `✅ Job selected:\n<b>${job.title.slice(0, 80)}</b>\nScore: ${job.applyScore ?? "?"}/100\n\n⏳ Generating proposal with OpenAI…`
    );

    let proposal: string;
    try {
      const result = await generateProposalWithAI(job, s, "professional", null, true);
      proposal = result.content;
    } catch (err) {
      logger.error({ err }, "[TG-WEBHOOK] Proposal generation failed");
      await tgReply(token, allowedChatId, "❌ OpenAI proposal generation failed. Try again.");
      return;
    }

    // Store the trigger — extension will pick it up within 30 s
    const [trigger] = await db
      .insert(applyTriggersTable)
      .values({
        jobId: job.id,
        proposalText: proposal,
        status: "pending",
        triggeredBy: "telegram",
      })
      .returning();

    logger.info({ triggerId: trigger?.id, jobId: job.id }, "[TG-WEBHOOK] Apply trigger created");

    const preview = proposal.slice(0, 200).replace(/</g, "&lt;").replace(/>/g, "&gt;");
    await tgReply(
      token,
      allowedChatId,
      [
        `🚀 <b>Apply trigger queued!</b> (ID: ${trigger?.id})`,
        "",
        `📋 Job: <b>${job.title.slice(0, 60)}</b>`,
        `🔗 URL: ${job.jobUrl}`,
        "",
        `📝 Proposal preview:\n<i>${preview}…</i>`,
        "",
        "The Chrome extension will open Upwork and submit this proposal automatically within 30 seconds.",
      ].join("\n")
    );
    return;
  }

  // ── /SKIP command — cancel pending triggers ──────────────────────────────
  if (cmd === "SKIP") {
    const pending = await db
      .select()
      .from(applyTriggersTable)
      .where(eq(applyTriggersTable.status, "pending"));

    if (!pending.length) {
      await tgReply(token, allowedChatId, "ℹ️ No pending apply triggers to cancel.");
      return;
    }

    for (const t of pending) {
      await db
        .update(applyTriggersTable)
        .set({ status: "cancelled", completedAt: new Date() })
        .where(eq(applyTriggersTable.id, t.id));
    }

    await tgReply(
      token,
      allowedChatId,
      `🚫 Cancelled ${pending.length} pending trigger(s).`
    );
    return;
  }

  // ── Unknown command ──────────────────────────────────────────────────────
  await tgReply(
    token,
    allowedChatId,
    [
      "🤖 <b>UpworkAI Command Center</b>",
      "",
      "/apply — Find best job, generate proposal, auto-submit via extension",
      "/status — Show recent jobs and system status",
      "/skip — Cancel all pending apply triggers",
    ].join("\n")
  );
});

// ── Types ───────────────────────────────────────────────────────────────────

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; username?: string };
    chat: { id: number; type: string };
    text?: string;
  };
}

export default router;
