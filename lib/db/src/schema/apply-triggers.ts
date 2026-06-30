import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { jobsTable } from "./jobs";

export const applyTriggersTable = pgTable("apply_triggers", {
  id: serial("id").primaryKey(),
  jobId: integer("job_id")
    .notNull()
    .references(() => jobsTable.id, { onDelete: "cascade" }),
  proposalText: text("proposal_text").notNull(),
  status: text("status", {
    enum: ["pending", "claimed", "submitted", "failed", "cancelled"],
  })
    .notNull()
    .default("pending"),
  triggeredBy: text("triggered_by").default("telegram"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  claimedAt: timestamp("claimed_at"),
  completedAt: timestamp("completed_at"),
});

export type ApplyTrigger = typeof applyTriggersTable.$inferSelect;
