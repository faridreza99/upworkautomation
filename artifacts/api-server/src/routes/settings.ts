import { Router, type IRouter } from "express";
import { db, settingsTable } from "@workspace/db";
import { UpdateSettingsBody } from "@workspace/api-zod";

const router: IRouter = Router();

async function getOrCreateSettings() {
  const rows = await db.select().from(settingsTable).limit(1);
  if (rows.length > 0) return rows[0];

  const [created] = await db
    .insert(settingsTable)
    .values({
      minHourlyRate: 25,
      minFixedBudget: 100,
      paymentVerifiedOnly: true,
      preferredCountries: ["US", "GB", "CA", "AU"],
      keywords: ["React", "Node.js", "TypeScript"],
      blacklistedClients: [],
      autoApplyEnabled: false,
      autoReplyEnabled: false,
      minAiScore: 70,
      userSkills: ["React", "Node.js", "TypeScript", "PostgreSQL"],
      portfolioDescription:
        "Experienced full-stack developer specializing in React, Node.js, and TypeScript.",
      whatsappEnabled: false,
      notifyOnHighScore: true,
      notifyOnMessage: true,
      notifyOnInterview: true,
    })
    .returning();

  return created;
}

router.get("/settings", async (_req, res): Promise<void> => {
  const settings = await getOrCreateSettings();
  res.json({
    ...settings,
    preferredCountries: settings.preferredCountries ?? [],
    keywords: settings.keywords ?? [],
    blacklistedClients: settings.blacklistedClients ?? [],
    userSkills: settings.userSkills ?? [],
  });
});

router.patch("/settings", async (req, res): Promise<void> => {
  const parsed = UpdateSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const existing = await getOrCreateSettings();

  const [updated] = await db
    .update(settingsTable)
    .set({ ...parsed.data, updatedAt: new Date() })
    .returning();

  const result = updated ?? existing;

  res.json({
    ...result,
    preferredCountries: result.preferredCountries ?? [],
    keywords: result.keywords ?? [],
    blacklistedClients: result.blacklistedClients ?? [],
    userSkills: result.userSkills ?? [],
  });
});

export default router;
