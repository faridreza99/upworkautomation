/**
 * POST /api/events
 * Receives buyer events from the Chrome extension:
 * message_received | interview_invite | contract_offer | proposal_reply
 * Creates a DB notification and fires the notification service (WhatsApp, etc.)
 */
import { Router, type IRouter } from "express";
import { db, notificationsTable } from "@workspace/db";
import { z } from "zod/v4";
import { notificationService } from "../lib/notify/service.js";

const router: IRouter = Router();

const EventBody = z.object({
  type: z.enum(["message_received", "interview_invite", "contract_offer", "proposal_reply", "info"]),
  title: z.string().min(1),
  body: z.string().default(""),
  senderName: z.string().optional(),
  url: z.string().optional(),
  timestamp: z.string().optional(),
});

router.post("/events", async (req, res): Promise<void> => {
  const parsed = EventBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { type, title, body, senderName, url } = parsed.data;

  // Persist as notification
  const [notification] = await db
    .insert(notificationsTable)
    .values({
      type: type as "message_received" | "interview_invite" | "contract_offer" | "info",
      message: body || title,
      read: false,
    })
    .returning();

  // Fire notification providers (WhatsApp etc.) asynchronously
  notificationService
    .send({
      type,
      title,
      body: senderName ? `${senderName}: ${body || title}` : body || title,
      metadata: { url, notificationId: notification.id },
    })
    .catch((err) => req.log.warn({ err }, "Notification provider error for event"));

  res.status(201).json({ success: true, notification });
});

export default router;
