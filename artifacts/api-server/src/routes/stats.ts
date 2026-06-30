import { Router, type IRouter } from "express";
import { eq, count, avg, sql, desc } from "drizzle-orm";
import { db, jobsTable, proposalsTable, notificationsTable } from "@workspace/db";

const router: IRouter = Router();

router.get("/stats/dashboard", async (_req, res): Promise<void> => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [totals] = await db
    .select({
      totalJobs: count(jobsTable.id),
    })
    .from(jobsTable);

  const [applied] = await db
    .select({ count: count(jobsTable.id) })
    .from(jobsTable)
    .where(eq(jobsTable.status, "applied"));

  const [pending] = await db
    .select({ count: count(jobsTable.id) })
    .from(jobsTable)
    .where(eq(jobsTable.status, "approved"));

  const [todayJobs] = await db
    .select({ count: count(jobsTable.id) })
    .from(jobsTable)
    .where(sql`${jobsTable.createdAt} >= ${today}`);

  const [scoreAvg] = await db
    .select({ avg: avg(jobsTable.applyScore) })
    .from(jobsTable)
    .where(sql`${jobsTable.applyScore} IS NOT NULL`);

  const [unreadCount] = await db
    .select({ count: count(notificationsTable.id) })
    .from(notificationsTable)
    .where(eq(notificationsTable.read, false));

  const totalApplied = applied?.count ?? 0;
  const totalJobsCount = totals?.totalJobs ?? 0;
  const successRate =
    totalJobsCount > 0 ? (Number(totalApplied) / Number(totalJobsCount)) * 100 : 0;

  res.json({
    totalJobs: Number(totalJobsCount),
    appliedJobs: Number(totalApplied),
    successRate: Math.round(successRate * 10) / 10,
    avgApplyScore: Math.round(Number(scoreAvg?.avg ?? 0) * 10) / 10,
    pendingApproval: Number(pending?.count ?? 0),
    todayJobs: Number(todayJobs?.count ?? 0),
    unreadNotifications: Number(unreadCount?.count ?? 0),
  });
});

router.get("/stats/jobs", async (_req, res): Promise<void> => {
  const byStatus = await db
    .select({
      status: jobsTable.status,
      count: count(jobsTable.id),
    })
    .from(jobsTable)
    .groupBy(jobsTable.status);

  const byBudgetType = await db
    .select({
      budgetType: jobsTable.budgetType,
      count: count(jobsTable.id),
    })
    .from(jobsTable)
    .groupBy(jobsTable.budgetType);

  const [avgScores] = await db
    .select({
      applyScore: avg(jobsTable.applyScore),
      riskScore: avg(jobsTable.riskScore),
      winProbability: avg(jobsTable.winProbability),
    })
    .from(jobsTable)
    .where(sql`${jobsTable.applyScore} IS NOT NULL`);

  // score distribution buckets 0-20, 20-40, 40-60, 60-80, 80-100
  const buckets = [
    { range: "0-20", min: 0, max: 20 },
    { range: "20-40", min: 20, max: 40 },
    { range: "40-60", min: 40, max: 60 },
    { range: "60-80", min: 60, max: 80 },
    { range: "80-100", min: 80, max: 101 },
  ];

  const scoreDistribution = await Promise.all(
    buckets.map(async ({ range, min, max }) => {
      const [row] = await db
        .select({ count: count(jobsTable.id) })
        .from(jobsTable)
        .where(
          sql`${jobsTable.applyScore} >= ${min} AND ${jobsTable.applyScore} < ${max}`
        );
      return { range, count: Number(row?.count ?? 0) };
    })
  );

  res.json({
    byStatus: byStatus.map((r) => ({
      status: r.status,
      count: Number(r.count),
    })),
    byBudgetType: byBudgetType.map((r) => ({
      budgetType: r.budgetType,
      count: Number(r.count),
    })),
    avgScores: {
      applyScore: Math.round(Number(avgScores?.applyScore ?? 0) * 10) / 10,
      riskScore: Math.round(Number(avgScores?.riskScore ?? 0) * 10) / 10,
      winProbability: Math.round(Number(avgScores?.winProbability ?? 0) * 10) / 10,
    },
    scoreDistribution,
  });
});

router.get("/stats/recent-activity", async (_req, res): Promise<void> => {
  const recentJobs = await db
    .select({
      id: jobsTable.id,
      title: jobsTable.title,
      status: jobsTable.status,
      applyScore: jobsTable.applyScore,
      aiRecommendation: jobsTable.aiRecommendation,
      createdAt: jobsTable.createdAt,
    })
    .from(jobsTable)
    .orderBy(desc(jobsTable.createdAt))
    .limit(10);

  const activity = recentJobs.map((job) => ({
    id: job.id,
    type: job.status,
    message: getActivityMessage(job.status, job.title, job.applyScore),
    jobId: job.id,
    jobTitle: job.title,
    score: job.applyScore,
    createdAt: job.createdAt.toISOString(),
  }));

  res.json(activity);
});

function getActivityMessage(
  status: string,
  title: string,
  score: number | null
): string {
  switch (status) {
    case "new":
      return `New job detected: ${title}`;
    case "analyzing":
      return `AI analyzing: ${title}`;
    case "approved":
      return `Job approved for apply: ${title} (score: ${score ?? "N/A"})`;
    case "applied":
      return `Proposal sent for: ${title}`;
    case "skipped":
      return `Skipped: ${title}`;
    case "rejected":
      return `Rejected by AI: ${title}`;
    default:
      return `Job updated: ${title}`;
  }
}

export default router;
