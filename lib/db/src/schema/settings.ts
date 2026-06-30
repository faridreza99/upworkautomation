import {
  pgTable,
  serial,
  real,
  boolean,
  text,
  timestamp,
  json,
  integer,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const settingsTable = pgTable("settings", {
  id: serial("id").primaryKey(),
  // Budget filters
  minHourlyRate: real("min_hourly_rate"),
  minFixedBudget: real("min_fixed_budget"),
  // Client filters
  paymentVerifiedOnly: boolean("payment_verified_only").notNull().default(false),
  priorHireRequired: boolean("prior_hire_required").notNull().default(false),
  maxApplicants: integer("max_applicants"),
  maxJobAgeDays: integer("max_job_age_days"),
  // Geography
  preferredCountries: json("preferred_countries").$type<string[]>().notNull().default([]),
  blockedCountries: json("blocked_countries").$type<string[]>().notNull().default([]),
  // Keywords & skills
  keywords: json("keywords").$type<string[]>().notNull().default([]),
  userSkills: json("user_skills").$type<string[]>().notNull().default([]),
  blacklistedClients: json("blacklisted_clients").$type<string[]>().notNull().default([]),
  // Automation
  autoApplyEnabled: boolean("auto_apply_enabled").notNull().default(false),
  autoReplyEnabled: boolean("auto_reply_enabled").notNull().default(false),
  autoProposalEnabled: boolean("auto_proposal_enabled").notNull().default(false),
  manualApprovalMode: boolean("manual_approval_mode").notNull().default(true),
  minAiScore: real("min_ai_score"),
  // AI profile
  portfolioDescription: text("portfolio_description"),
  // Notifications — WhatsApp
  whatsappEnabled: boolean("whatsapp_enabled").notNull().default(false),
  whatsappNumber: text("whatsapp_number"),
  notifyOnHighScore: boolean("notify_on_high_score").notNull().default(true),
  notifyOnMessage: boolean("notify_on_message").notNull().default(true),
  notifyOnInterview: boolean("notify_on_interview").notNull().default(true),
  notifyOnContract: boolean("notify_on_contract").notNull().default(true),
  // Notifications — Telegram
  telegramEnabled: boolean("telegram_enabled").notNull().default(false),
  telegramBotToken: text("telegram_bot_token"),
  telegramChatId: text("telegram_chat_id"),
  // Scanner
  scanEnabled: boolean("scan_enabled").notNull().default(false),
  scanIntervalMinutes: integer("scan_interval_minutes").notNull().default(30),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertSettingsSchema = createInsertSchema(settingsTable).omit({
  id: true,
  updatedAt: true,
});
export type InsertSettings = z.infer<typeof insertSettingsSchema>;
export type Settings = typeof settingsTable.$inferSelect;
