import { db, settingsTable } from "@workspace/db";
import { logger } from "./logger.js";

const TG_API = "https://api.telegram.org";

export async function registerTelegramWebhook(): Promise<void> {
  try {
    const rows = await db.select().from(settingsTable).limit(1);
    const s = rows[0];
    if (!s?.telegramEnabled || !s.telegramBotToken) {
      logger.info("[TELEGRAM-SETUP] Telegram not configured — skipping webhook registration");
      return;
    }

    const domains = (process.env["REPLIT_DOMAINS"] ?? "").split(",").map((d) => d.trim()).filter(Boolean);
    const domain = domains[0];
    if (!domain) {
      logger.warn("[TELEGRAM-SETUP] REPLIT_DOMAINS not set — cannot register webhook");
      return;
    }

    const webhookUrl = `https://${domain}/api/telegram/webhook`;
    const token = s.telegramBotToken;

    const res = await fetch(`${TG_API}/bot${token}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: webhookUrl,
        allowed_updates: ["message"],
        drop_pending_updates: true,
      }),
    });

    const data = (await res.json()) as { ok: boolean; description?: string };
    if (data.ok) {
      logger.info({ webhookUrl }, "[TELEGRAM-SETUP] Webhook registered successfully");
    } else {
      logger.warn({ description: data.description }, "[TELEGRAM-SETUP] Webhook registration failed");
    }
  } catch (err) {
    logger.warn({ err }, "[TELEGRAM-SETUP] Failed to register Telegram webhook");
  }
}
