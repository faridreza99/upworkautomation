import { Router } from "express";
import { db, applyTriggersTable, jobsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { logger } from "../lib/logger.js";

const router = Router();

// ── GET /api/apply-trigger/pending ─────────────────────────────────────────
// Extension polls this every 30 s. Returns the oldest "pending" trigger
// together with the full job record so the extension can navigate + apply.
router.get("/apply-trigger/pending", async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(applyTriggersTable)
    .where(eq(applyTriggersTable.status, "pending"))
    .orderBy(applyTriggersTable.createdAt)
    .limit(1);

  if (!rows.length) {
    res.json({ trigger: null });
    return;
  }

  const trigger = rows[0]!;
  const jobs = await db.select().from(jobsTable).where(eq(jobsTable.id, trigger.jobId)).limit(1);
  const job = jobs[0] ?? null;

  res.json({ trigger, job });
});

// ── POST /api/apply-trigger/:id/claim ──────────────────────────────────────
// Extension claims a trigger so no other tab picks it up.
router.post("/apply-trigger/:id/claim", async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!id) { res.status(400).json({ error: "invalid id" }); return; }

  await db
    .update(applyTriggersTable)
    .set({ status: "claimed", claimedAt: new Date() })
    .where(eq(applyTriggersTable.id, id));

  req.log.info({ triggerId: id }, "[APPLY-TRIGGER] claimed");
  res.json({ ok: true });
});

// ── POST /api/apply-trigger/:id/complete ───────────────────────────────────
// Extension reports success or failure after attempting to submit.
router.post("/apply-trigger/:id/complete", async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!id) { res.status(400).json({ error: "invalid id" }); return; }

  const { success, error } = req.body as { success: boolean; error?: string };

  await db
    .update(applyTriggersTable)
    .set({
      status: success ? "submitted" : "failed",
      errorMessage: error ?? null,
      completedAt: new Date(),
    })
    .where(eq(applyTriggersTable.id, id));

  req.log.info({ triggerId: id, success }, "[APPLY-TRIGGER] completed");
  res.json({ ok: true });
});

// ── GET /api/apply-trigger/queue ───────────────────────────────────────────
// Dashboard / monitor page reads the last 20 triggers.
router.get("/apply-trigger/queue", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(applyTriggersTable)
    .orderBy(desc(applyTriggersTable.createdAt))
    .limit(20);

  res.json({ triggers: rows });
});

export default router;
