import type { NotificationProvider, NotificationEvent } from "./provider.js";
import { logger } from "../logger.js";

export class NotificationService {
  private providers: NotificationProvider[] = [];

  register(provider: NotificationProvider): this {
    this.providers.push(provider);
    return this;
  }

  async send(event: NotificationEvent): Promise<void> {
    let anySucceeded = false;
    const errors: string[] = [];

    for (const p of this.providers) {
      const enabled = await p.isEnabled().catch(() => false);
      if (!enabled) continue;
      try {
        await p.send(event);
        logger.info({ provider: p.name, type: event.type }, "Notification sent");
        anySucceeded = true;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ provider: p.name, type: event.type, err }, "Notification provider failed");
        errors.push(`${p.name}: ${msg}`);
      }
    }

    if (errors.length > 0 && !anySucceeded) {
      logger.error({ errors, type: event.type }, "All notification providers failed");
    } else if (errors.length > 0) {
      logger.warn({ errors, type: event.type }, "Some notification providers failed (others succeeded)");
    }
  }
}

import { TelegramNotificationProvider } from "./telegram-provider.js";

export const notificationService = new NotificationService()
  .register(new TelegramNotificationProvider());
