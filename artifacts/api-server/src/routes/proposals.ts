import { Router, type IRouter } from "express";
import { eq, desc, and } from "drizzle-orm";
import { db, proposalsTable, jobsTable } from "@workspace/db";
import {
  ListProposalsQueryParams,
  GetProposalParams,
  UpdateProposalParams,
  UpdateProposalBody,
  DeleteProposalParams,
  ApproveProposalParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/proposals", async (req, res): Promise<void> => {
  const parsed = ListProposalsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { status, limit = 50, offset = 0 } = parsed.data;

  const conditions = [];
  if (status) conditions.push(eq(proposalsTable.status, status));

  const rows = await db
    .select({
      id: proposalsTable.id,
      jobId: proposalsTable.jobId,
      jobTitle: jobsTable.title,
      content: proposalsTable.content,
      coverLetter: proposalsTable.coverLetter,
      bidAmount: proposalsTable.bidAmount,
      estimatedDuration: proposalsTable.estimatedDuration,
      status: proposalsTable.status,
      createdAt: proposalsTable.createdAt,
      updatedAt: proposalsTable.updatedAt,
    })
    .from(proposalsTable)
    .leftJoin(jobsTable, eq(proposalsTable.jobId, jobsTable.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(proposalsTable.createdAt))
    .limit(limit)
    .offset(offset);

  res.json(rows);
});

router.get("/proposals/:id", async (req, res): Promise<void> => {
  const params = GetProposalParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [row] = await db
    .select({
      id: proposalsTable.id,
      jobId: proposalsTable.jobId,
      jobTitle: jobsTable.title,
      content: proposalsTable.content,
      coverLetter: proposalsTable.coverLetter,
      bidAmount: proposalsTable.bidAmount,
      estimatedDuration: proposalsTable.estimatedDuration,
      status: proposalsTable.status,
      createdAt: proposalsTable.createdAt,
      updatedAt: proposalsTable.updatedAt,
    })
    .from(proposalsTable)
    .leftJoin(jobsTable, eq(proposalsTable.jobId, jobsTable.id))
    .where(eq(proposalsTable.id, params.data.id));

  if (!row) {
    res.status(404).json({ error: "Proposal not found" });
    return;
  }

  res.json(row);
});

router.patch("/proposals/:id", async (req, res): Promise<void> => {
  const params = UpdateProposalParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateProposalBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [proposal] = await db
    .update(proposalsTable)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(proposalsTable.id, params.data.id))
    .returning();

  if (!proposal) {
    res.status(404).json({ error: "Proposal not found" });
    return;
  }

  const [row] = await db
    .select({
      id: proposalsTable.id,
      jobId: proposalsTable.jobId,
      jobTitle: jobsTable.title,
      content: proposalsTable.content,
      coverLetter: proposalsTable.coverLetter,
      bidAmount: proposalsTable.bidAmount,
      estimatedDuration: proposalsTable.estimatedDuration,
      status: proposalsTable.status,
      createdAt: proposalsTable.createdAt,
      updatedAt: proposalsTable.updatedAt,
    })
    .from(proposalsTable)
    .leftJoin(jobsTable, eq(proposalsTable.jobId, jobsTable.id))
    .where(eq(proposalsTable.id, proposal.id));

  res.json(row);
});

router.delete("/proposals/:id", async (req, res): Promise<void> => {
  const params = DeleteProposalParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [proposal] = await db
    .delete(proposalsTable)
    .where(eq(proposalsTable.id, params.data.id))
    .returning();

  if (!proposal) {
    res.status(404).json({ error: "Proposal not found" });
    return;
  }

  res.sendStatus(204);
});

router.post("/proposals/:id/approve", async (req, res): Promise<void> => {
  const params = ApproveProposalParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [proposal] = await db
    .update(proposalsTable)
    .set({ status: "approved", updatedAt: new Date() })
    .where(eq(proposalsTable.id, params.data.id))
    .returning();

  if (!proposal) {
    res.status(404).json({ error: "Proposal not found" });
    return;
  }

  const [row] = await db
    .select({
      id: proposalsTable.id,
      jobId: proposalsTable.jobId,
      jobTitle: jobsTable.title,
      content: proposalsTable.content,
      coverLetter: proposalsTable.coverLetter,
      bidAmount: proposalsTable.bidAmount,
      estimatedDuration: proposalsTable.estimatedDuration,
      status: proposalsTable.status,
      createdAt: proposalsTable.createdAt,
      updatedAt: proposalsTable.updatedAt,
    })
    .from(proposalsTable)
    .leftJoin(jobsTable, eq(proposalsTable.jobId, jobsTable.id))
    .where(eq(proposalsTable.id, proposal.id));

  res.json(row);
});

export default router;
