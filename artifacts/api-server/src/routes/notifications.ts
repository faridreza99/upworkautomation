import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { db, notificationsTable } from "@workspace/db";
import {
  ListNotificationsQueryParams,
  MarkNotificationReadParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/notifications", async (req, res): Promise<void> => {
  const parsed = ListNotificationsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { unreadOnly, limit = 50 } = parsed.data;

  let query = db
    .select()
    .from(notificationsTable)
    .orderBy(desc(notificationsTable.createdAt))
    .limit(limit);

  if (unreadOnly) {
    const rows = await db
      .select()
      .from(notificationsTable)
      .where(eq(notificationsTable.read, false))
      .orderBy(desc(notificationsTable.createdAt))
      .limit(limit);
    res.json(rows);
    return;
  }

  const rows = await query;
  res.json(rows);
});

router.patch("/notifications/:id/read", async (req, res): Promise<void> => {
  const params = MarkNotificationReadParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [notification] = await db
    .update(notificationsTable)
    .set({ read: true })
    .where(eq(notificationsTable.id, params.data.id))
    .returning();

  if (!notification) {
    res.status(404).json({ error: "Notification not found" });
    return;
  }

  res.json(notification);
});

router.post("/notifications/read-all", async (_req, res): Promise<void> => {
  await db
    .update(notificationsTable)
    .set({ read: true })
    .where(eq(notificationsTable.read, false));

  res.json({ success: true });
});

export default router;
