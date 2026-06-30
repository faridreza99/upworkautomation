import { Router, type IRouter } from "express";
import { eq, desc, and, sql } from "drizzle-orm";
import { db, jobsTable } from "@workspace/db";
import {
  ListJobsQueryParams,
  CreateJobBody,
  GetJobParams,
  UpdateJobParams,
  UpdateJobBody,
  DeleteJobParams,
  AnalyzeJobParams,
  AnalyzeJobResponse,
  GenerateProposalParams,
  GenerateProposalBody,
  GenerateProposalResponse,
} from "@workspace/api-zod";
import { analyzeJobWithAI, generateProposalWithAI } from "../lib/ai";
import { proposalsTable, settingsTable } from "@workspace/db";
import { notificationService } from "../lib/notify/service.js";

const router: IRouter = Router();

router.get("/jobs", async (req, res): Promise<void> => {
  const parsed = ListJobsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { status, limit = 50, offset = 0 } = parsed.data;

  const conditions = [];
  if (status) conditions.push(eq(jobsTable.status, status));

  const jobs = await db
    .select()
    .from(jobsTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(jobsTable.createdAt))
    .limit(limit)
    .offset(offset);

  res.json(jobs.map((j) => ({ ...j, skills: j.skills ?? [] })));
});

router.post("/jobs", async (req, res): Promise<void> => {
  const parsed = CreateJobBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  // Log payment verification source from extension (stripped by Zod, so read before parsing)
  const rawPvSource = (req.body as Record<string, unknown>)._pvSource ?? "unknown";
  const rawPv = parsed.data.paymentVerified;
  const pvLabel = rawPv === true ? "VERIFIED" : rawPv === false ? "NOT_VERIFIED" : "UNKNOWN";
  req.log.info({
    upworkJobId: parsed.data.upworkJobId,
    title: (parsed.data.title ?? "").slice(0, 70),
    paymentStatus: pvLabel,
    pvSource: rawPvSource,
  }, "💳 JOB SUBMISSION — payment status");

  // check for duplicate upworkJobId
  if (parsed.data.upworkJobId) {
    const existing = await db
      .select()
      .from(jobsTable)
      .where(eq(jobsTable.upworkJobId, parsed.data.upworkJobId))
      .limit(1);
    if (existing.length > 0) {
      res.status(409).json({ error: "Job already exists", job: existing[0] });
      return;
    }
  }

  const [job] = await db
    .insert(jobsTable)
    .values({
      ...parsed.data,
      description:   parsed.data.description   ?? parsed.data.title,
      budgetType:    parsed.data.budgetType     ?? "fixed",
      budgetMin:     parsed.data.budgetMin      ?? null,
      budgetMax:     parsed.data.budgetMax      ?? null,
      clientCountry: parsed.data.clientCountry  ?? null,
      proposalCount: parsed.data.proposalCount  ?? null,
      skills:        parsed.data.skills         ?? [],
    })
    .returning();

  res.status(201).json({ ...job, skills: job.skills ?? [] });
});

router.get("/jobs/:id", async (req, res): Promise<void> => {
  const params = GetJobParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [job] = await db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.id, params.data.id));

  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  res.json({ ...job, skills: job.skills ?? [] });
});

router.patch("/jobs/:id", async (req, res): Promise<void> => {
  const params = UpdateJobParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateJobBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [job] = await db
    .update(jobsTable)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(jobsTable.id, params.data.id))
    .returning();

  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  res.json({ ...job, skills: job.skills ?? [] });
});

router.delete("/jobs/:id", async (req, res): Promise<void> => {
  const params = DeleteJobParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [job] = await db
    .delete(jobsTable)
    .where(eq(jobsTable.id, params.data.id))
    .returning();

  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  res.sendStatus(204);
});

router.post("/jobs/:id/analyze", async (req, res): Promise<void> => {
  const params = AnalyzeJobParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [job] = await db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.id, params.data.id));

  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  // get settings for user skills / preferences
  const [settings] = await db.select().from(settingsTable).limit(1);

  await db
    .update(jobsTable)
    .set({ status: "analyzing", updatedAt: new Date() })
    .where(eq(jobsTable.id, job.id));

  const analysis = await analyzeJobWithAI(job, settings ?? null);

  const recommendation = analysis.recommendation as "apply" | "skip" | "review";

  await db
    .update(jobsTable)
    .set({
      applyScore: analysis.applyScore,
      riskScore: analysis.riskScore,
      winProbability: analysis.winProbability,
      aiRecommendation: recommendation,
      aiReasoning: analysis.reasoning,
      status: recommendation === "apply" ? "approved" : recommendation === "skip" ? "skipped" : "new",
      updatedAt: new Date(),
    })
    .where(eq(jobsTable.id, job.id));

  const result = AnalyzeJobResponse.parse({
    jobId: job.id,
    ...analysis,
  });

  // ── Notification Audit Log ────────────────────────────────────────────────
  const threshold = settings?.minAiScore ?? 70;
  const willNotify = analysis.applyScore >= threshold;

  // Payment status label: three states
  const pvStatus =
    job.paymentVerified === true  ? "VERIFIED" :
    job.paymentVerified === false ? "NOT_VERIFIED" :
                                    "UNKNOWN";

  let auditReason: string;
  if (analysis.applyScore === 0 && analysis.recommendation === "skip") {
    auditReason = `PRE-FILTERED — ${analysis.reasoning}`;
  } else if (willNotify) {
    auditReason = `Score ${analysis.applyScore} ≥ threshold ${threshold}`;
  } else {
    auditReason = `Score ${analysis.applyScore} < threshold ${threshold}`;
  }

  req.log.info({
    jobId: job.id,
    title: job.title.slice(0, 70),
    paymentStatus: pvStatus,
    paymentVerifiedOnly: settings?.paymentVerifiedOnly ?? false,
    proposalCount: job.proposalCount ?? null,
    proposalRule: "< 5",
    applyScore: analysis.applyScore,
    riskScore: analysis.riskScore,
    winProbability: analysis.winProbability,
    recommendation: analysis.recommendation,
    threshold,
    notificationSent: willNotify,
    reason: auditReason,
  }, "📋 NOTIFICATION AUDIT");

  // Fire notification providers asynchronously — never blocks the response
  if (willNotify) {
    notificationService
      .send({
        type: analysis.applyScore >= 80 ? "high_score_job" : "new_job",
        title: `New matched job: ${job.title}`,
        body: analysis.reasoning ?? "",
        job: {
          title: job.title,
          budgetMin: job.budgetMin,
          budgetMax: job.budgetMax,
          budgetType: job.budgetType,
          clientCountry: job.clientCountry,
          paymentVerified: job.paymentVerified,
          applyScore: analysis.applyScore,
          winProbability: analysis.winProbability,
          riskScore: analysis.riskScore,
          recommendation: analysis.recommendation,
          jobUrl: job.jobUrl,
        },
      })
      .catch((err) => req.log.warn({ err }, "Notification failed for job alert"));
  }

  // Auto-generate proposal if autoProposalEnabled is on
  const s = settings as any;
  if (recommendation !== "skip" && analysis.applyScore >= (settings?.minAiScore ?? 70) && s?.autoProposalEnabled) {
    (async () => {
      try {
        const proposal = await generateProposalWithAI(job, settings ?? null, "professional", null, false);
        const proposalStatus = s.autoApplyEnabled && !s.manualApprovalMode ? "approved" : "draft";
        await db.insert(proposalsTable).values({
          jobId: job.id,
          content: proposal.content,
          coverLetter: proposal.coverLetter,
          status: proposalStatus,
        });
        req.log.info({ jobId: job.id, proposalStatus }, "Auto-generated proposal for job");
      } catch (err) {
        req.log.warn({ err, jobId: job.id }, "Auto-proposal generation failed");
      }
    })();
  }

  res.json(result);
});

router.post("/jobs/:id/proposal", async (req, res): Promise<void> => {
  const params = GenerateProposalParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = GenerateProposalBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [job] = await db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.id, params.data.id));

  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  const [settings] = await db.select().from(settingsTable).limit(1);

  const proposalContent = await generateProposalWithAI(
    job,
    settings ?? null,
    parsed.data.tone ?? "professional",
    parsed.data.bidAmount ?? null,
    parsed.data.includePortfolio ?? true
  );

  const [proposal] = await db
    .insert(proposalsTable)
    .values({
      jobId: job.id,
      content: proposalContent.content,
      coverLetter: proposalContent.coverLetter,
      bidAmount: parsed.data.bidAmount ?? null,
      status: "draft",
    })
    .returning();

  const result = GenerateProposalResponse.parse({
    ...proposal,
    jobTitle: job.title,
  });

  res.json(result);
});

export default router;
