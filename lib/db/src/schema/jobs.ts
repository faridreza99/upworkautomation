import {
  pgTable,
  serial,
  text,
  real,
  boolean,
  integer,
  timestamp,
  json,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const jobsTable = pgTable("jobs", {
  id: serial("id").primaryKey(),
  upworkJobId: text("upwork_job_id").unique(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  budgetType: text("budget_type", { enum: ["hourly", "fixed"] }).notNull(),
  budgetMin: real("budget_min"),
  budgetMax: real("budget_max"),
  clientCountry: text("client_country"),
  clientHireRate: real("client_hire_rate"),
  clientTotalSpent: real("client_total_spent"),
  paymentVerified: boolean("payment_verified"),
  proposalCount: integer("proposal_count"),
  skills: json("skills").$type<string[]>().notNull().default([]),
  status: text("status", {
    enum: ["new", "analyzing", "approved", "skipped", "applied", "rejected"],
  })
    .notNull()
    .default("new"),
  applyScore: real("apply_score"),
  riskScore: real("risk_score"),
  winProbability: real("win_probability"),
  aiRecommendation: text("ai_recommendation", {
    enum: ["apply", "skip", "review"],
  }),
  aiReasoning: text("ai_reasoning"),
  jobUrl: text("job_url"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertJobSchema = createInsertSchema(jobsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertJob = z.infer<typeof insertJobSchema>;
export type Job = typeof jobsTable.$inferSelect;
