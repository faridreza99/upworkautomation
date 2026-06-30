import type { NotificationProvider, NotificationEvent, JobNotificationData } from "./provider.js";
import { db, settingsTable } from "@workspace/db";
import { logger } from "../logger.js";

const TELEGRAM_API = "https://api.telegram.org";
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

function formatBudget(job: JobNotificationData): string {
  if (!job.budgetMin && !job.budgetMax) return "Not specified";
  const type = job.budgetType === "hourly" ? "/hr" : " fixed";
  if (job.budgetMin && job.budgetMax && job.budgetMin !== job.budgetMax) {
    return `$${job.budgetMin}–$${job.budgetMax}${type}`;
  }
  return `$${job.budgetMax ?? job.budgetMin}${type}`;
}

function formatMessage(event: NotificationEvent): string {
  const j = event.job;

  if (!j) {
    const labels: Record<string, string> = {
      message_received: "💬 New Buyer Message",
      interview_invite: "🎯 Interview Invitation!",
      contract_offer: "🤝 Contract Offer!",
      proposal_reply: "📩 Proposal Reply",
    };
    const header = labels[event.type] ?? `🔔 ${event.title}`;
    return `${header}\n\n${event.body}`;
  }

  const icons: Record<string, string> = {
    new_job: "🚀",
    high_score_job: "⭐",
    payment_verified: "💳",
    message_received: "💬",
    interview_invite: "🎯",
    contract_offer: "🤝",
    proposal_reply: "📩",
    info: "ℹ️",
  };

  const icon = icons[event.type] ?? "🔔";
  const score = j.applyScore != null ? `${Math.round(j.applyScore)}/100` : "N/A";
  const win = j.winProbability != null ? `${Math.round(j.winProbability)}%` : "N/A";
  const risk = j.riskScore != null ? `${Math.round(j.riskScore)}/100` : "N/A";
  const rec = j.recommendation ? j.recommendation.toUpperCase() : "REVIEW";
  const payment = j.paymentVerified ? "✅ Verified" : "❌ Not Verified";
  const country = j.clientCountry ?? "Unknown";
  const budget = formatBudget(j);
  const urlLine = j.jobUrl ? `\n🔗 ${j.jobUrl}` : "";

  return (
    `${icon} New Upwork Job\n\n` +
    `📋 Title: ${j.title}\n` +
    `💰 Budget: ${budget}\n` +
    `🌍 Country: ${country}\n` +
    `💳 Payment: ${payment}\n` +
    `🎯 AI Score: ${score}\n` +
    `🏆 Win Chance: ${win}\n` +
    `⚠️ Risk: ${risk}\n` +
    `💡 Decision: ${rec}` +
    urlLine +
    `\n\nOpen your dashboard to review and apply.`
  );
}

async function doSend(token: string, chatId: string, text: string): Promise<void> {
  const url = `${TELEGRAM_API}/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    throw new Error(`Telegram API ${res.status}: ${JSON.stringify(body)}`);
  }
}

async function sendWithRetry(
  token: string,
  chatId: string,
  text: string,
  eventType: string,
  attempt = 1
): Promise<void> {
  try {
    await doSend(token, chatId, text);
    logger.info({ type: eventType, chatId }, "[TELEGRAM] sent successfully");
  } catch (err: unknown) {
    if (attempt < MAX_RETRIES) {
      logger.warn({ type: eventType, attempt }, "[TELEGRAM] retrying...");
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      return sendWithRetry(token, chatId, text, eventType, attempt + 1);
    }
    logger.warn({ type: eventType, err }, "[TELEGRAM] failed (non-blocking)");
  }
}

export class TelegramNotificationProvider implements NotificationProvider {
  readonly name = "telegram";

  async isEnabled(): Promise<boolean> {
    try {
      const rows = await db.select().from(settingsTable).limit(1);
      const s = rows[0];
      return !!(s?.telegramEnabled && s.telegramBotToken && s.telegramChatId);
    } catch {
      return false;
    }
  }

  async send(event: NotificationEvent): Promise<void> {
    const rows = await db.select().from(settingsTable).limit(1);
    const s = rows[0];
    if (!s?.telegramEnabled || !s.telegramBotToken || !s.telegramChatId) return;

    // Per-event notification preference gate
    if ((event.type === "high_score_job" || event.type === "new_job") && !s.notifyOnHighScore) return;
    if (event.type === "message_received" && !s.notifyOnMessage) return;
    if (event.type === "interview_invite" && !s.notifyOnInterview) return;
    if (event.type === "contract_offer" && !(s as any).notifyOnContract) return;

    const text = formatMessage(event);
    const { telegramBotToken: token, telegramChatId: chatId } = s;

    // Fire-and-forget: pipeline is not blocked by notification delivery or retries
    void sendWithRetry(token, chatId, text, event.type);
  }
}
