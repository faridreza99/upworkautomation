import app from "./app";
import { logger } from "./lib/logger";
import { initScanner } from "./lib/scanner";
import { registerTelegramWebhook } from "./lib/telegram-setup";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Bootstrap RSS scanner (reads DB settings, starts if enabled)
  initScanner().catch((e) => logger.warn({ err: e.message }, "Scanner init failed"));

  // Register Telegram webhook URL with Bot API
  registerTelegramWebhook().catch((e) =>
    logger.warn({ err: e.message }, "Telegram webhook registration failed")
  );
});
