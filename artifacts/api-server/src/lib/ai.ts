import OpenAI from "openai";
import type { Job, Settings } from "@workspace/db";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export interface JobAnalysisBreakdown {
  skillMatch: number;
  budgetScore: number;
  clientQuality: number;
  countryScore: number;
  competitionScore: number;
  scamProbability: number;
}

export interface JobAnalysisResult {
  applyScore: number;
  riskScore: number;
  winProbability: number;
  recommendation: "apply" | "skip" | "review";
  reasoning: string;
  strengths: string[];
  concerns: string[];
  breakdown: JobAnalysisBreakdown;
}

export async function analyzeJobWithAI(
  job: Job,
  settings: Settings | null
): Promise<JobAnalysisResult> {
  const userSkills = settings?.userSkills ?? [];
  const minHourlyRate = settings?.minHourlyRate ?? 0;
  const minFixedBudget = settings?.minFixedBudget ?? 0;
  const paymentVerifiedOnly = settings?.paymentVerifiedOnly ?? false;
  const priorHireRequired = (settings as { priorHireRequired?: boolean } | null)?.priorHireRequired ?? false;
  const maxApplicants = (settings as { maxApplicants?: number | null } | null)?.maxApplicants ?? null;
  const maxJobAgeDays = (settings as { maxJobAgeDays?: number | null } | null)?.maxJobAgeDays ?? null;
  const keywords = settings?.keywords ?? [];
  const blacklistedClients = settings?.blacklistedClients ?? [];
  const preferredCountries = settings?.preferredCountries ?? [];
  const blockedCountries = (settings as { blockedCountries?: string[] } | null)?.blockedCountries ?? [];

  const fallback = (reason: string): JobAnalysisResult => ({
    applyScore: 0, riskScore: 100, winProbability: 0, recommendation: "skip",
    reasoning: reason, strengths: [], concerns: [reason],
    breakdown: { skillMatch: 0, budgetScore: 0, clientQuality: 0, countryScore: 0, competitionScore: 0, scamProbability: 100 },
  });

  // ── Pre-checks (no GPT call) ──────────────────────────────────────────────
  const haystack = `${job.title} ${job.description} ${job.clientCountry ?? ""}`.toLowerCase();

  const blacklistHit = blacklistedClients.find((c) => haystack.includes(c.toLowerCase()));
  if (blacklistHit) return fallback(`Client "${blacklistHit}" is on your blacklist.`);

  if (blockedCountries.length > 0 && job.clientCountry) {
    const hit = blockedCountries.find((c) => job.clientCountry!.toLowerCase().includes(c.toLowerCase()));
    if (hit) return fallback(`Country "${job.clientCountry}" is blocked.`);
  }

  // ── Payment verification hard filter ────────────────────────────────────
  // paymentVerified: true = verified, false = confirmed NOT verified, null = unknown.
  // Only hard-block on confirmed false — unknown status proceeds to GPT scoring
  // (Upwork markup changes can make every job appear unverified temporarily).
  if (paymentVerifiedOnly) {
    if (job.paymentVerified === false)
      return fallback("Client payment not verified.");
    // null/undefined = UNKNOWN — do NOT block; GPT will apply a risk penalty instead.
  }

  if (priorHireRequired && (job.clientHireRate == null || job.clientHireRate === 0)) return fallback("Client has no prior hire history.");

  // maxApplicants: treat 0 or null as "no limit" — 0 means the field was never
  // set by the user, not that zero applicants are allowed.
  if (maxApplicants != null && maxApplicants > 0 && job.proposalCount != null && job.proposalCount > maxApplicants) {
    return fallback(`Too many applicants (${job.proposalCount} > max ${maxApplicants}).`);
  }

  // Hard notification rule: proposals must be < 5 (mirrored from extension filter)
  // The extension already blocks at this threshold; this is API-level defense in depth.
  if (job.proposalCount != null && job.proposalCount >= 5) {
    return fallback(`Too many proposals: ${job.proposalCount} (notification rule requires < 5).`);
  }

  if (job.budgetType === "hourly" && job.budgetMax != null && job.budgetMax < minHourlyRate) {
    return fallback(`Hourly rate $${job.budgetMax}/hr is below your minimum $${minHourlyRate}/hr.`);
  }

  if (job.budgetType === "fixed" && job.budgetMax != null && job.budgetMax < minFixedBudget) {
    return fallback(`Fixed budget $${job.budgetMax} is below your minimum $${minFixedBudget}.`);
  }

  // ── GPT Analysis ─────────────────────────────────────────────────────────
  const prompt = `You are an expert Upwork proposal consultant. Analyze this job and return a precise JSON scoring.

JOB DETAILS:
Title: ${job.title}
Description: ${job.description?.slice(0, 1500)}
Budget: ${job.budgetType === "hourly" ? `$${job.budgetMin ?? "?"}–$${job.budgetMax ?? "?"}/hr` : `$${job.budgetMin ?? "?"}–$${job.budgetMax ?? "?"} fixed`}
Client Country: ${job.clientCountry ?? "Unknown"}
Client Hire Rate: ${job.clientHireRate != null ? `${job.clientHireRate}%` : "Unknown"}
Client Total Spent: ${job.clientTotalSpent != null ? `$${job.clientTotalSpent}` : "Unknown"}
Payment Verified: ${job.paymentVerified ? "Yes" : "No"}
Proposal Count: ${job.proposalCount ?? "Unknown"}
Required Skills: ${(job.skills ?? []).join(", ") || "Not specified"}

FREELANCER PROFILE:
Skills: ${userSkills.join(", ") || "Not specified"}
Min Hourly Rate: $${minHourlyRate}/hr
Min Fixed Budget: $${minFixedBudget}
Keywords: ${keywords.join(", ") || "None"}
Preferred Countries: ${preferredCountries.length > 0 ? preferredCountries.join(", ") : "Any"}
Max Job Age (days): ${maxJobAgeDays != null && maxJobAgeDays > 0 ? maxJobAgeDays : "Any"}

Return ONLY this exact JSON (no markdown):
{
  "applyScore": <0-100, overall recommendation score>,
  "riskScore": <0-100, job risk level — higher = riskier>,
  "winProbability": <0-100, estimated chance of winning>,
  "recommendation": <"apply" | "skip" | "review">,
  "reasoning": <2-3 sentence decision explanation>,
  "strengths": [<2-4 specific strengths>],
  "concerns": [<0-3 specific concerns>],
  "breakdown": {
    "skillMatch": <0-100, how well skills align>,
    "budgetScore": <0-100, how good the budget is>,
    "clientQuality": <0-100, client history quality>,
    "countryScore": <0-100, country preference alignment>,
    "competitionScore": <0-100, higher = less competition>,
    "scamProbability": <0-100, likelihood of scam>
  }
}

Rules: apply = applyScore ≥ 70, skip = applyScore < 40, review = 40–69.${preferredCountries.length > 0 ? ` Preferred countries: ${preferredCountries.join(", ")}. If country matches: countryScore ≥ 80 and note as strength. If not: countryScore ≤ 40 and reduce applyScore by 10–15.` : ""}${paymentVerifiedOnly && !job.paymentVerified ? " ⚠️ PAYMENT RISK: Freelancer requires payment-verified clients only. This client is NOT verified — set riskScore ≥ 60, add \"Payment not verified\" as a concern, and reduce applyScore by 20–35. Still score all other dimensions accurately." : ""}`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
    max_tokens: 900,
    temperature: 0.2,
  });

  const raw = response.choices[0]?.message?.content ?? "{}";

  let parsed: JobAnalysisResult;
  try {
    parsed = JSON.parse(raw) as JobAnalysisResult;
  } catch {
    parsed = {
      applyScore: 50, riskScore: 50, winProbability: 30, recommendation: "review",
      reasoning: "Could not parse AI response. Manual review recommended.",
      strengths: [], concerns: ["AI analysis failed — review manually"],
      breakdown: { skillMatch: 50, budgetScore: 50, clientQuality: 50, countryScore: 50, competitionScore: 50, scamProbability: 20 },
    };
  }

  // Clamp all numeric values to 0–100
  const clamp = (v: unknown) => Math.min(100, Math.max(0, Math.round(Number(v) || 0)));
  parsed.applyScore = clamp(parsed.applyScore);
  parsed.riskScore = clamp(parsed.riskScore);
  parsed.winProbability = clamp(parsed.winProbability);
  if (!parsed.breakdown) {
    parsed.breakdown = { skillMatch: 50, budgetScore: 50, clientQuality: 50, countryScore: 50, competitionScore: 50, scamProbability: 20 };
  }
  parsed.breakdown.skillMatch = clamp(parsed.breakdown.skillMatch);
  parsed.breakdown.budgetScore = clamp(parsed.breakdown.budgetScore);
  parsed.breakdown.clientQuality = clamp(parsed.breakdown.clientQuality);
  parsed.breakdown.countryScore = clamp(parsed.breakdown.countryScore);
  parsed.breakdown.competitionScore = clamp(parsed.breakdown.competitionScore);
  parsed.breakdown.scamProbability = clamp(parsed.breakdown.scamProbability);

  return parsed;
}

export interface ProposalContent {
  content: string;
  coverLetter: string;
}

export async function generateProposalWithAI(
  job: Job,
  settings: Settings | null,
  tone: string,
  bidAmount: number | null,
  includePortfolio: boolean
): Promise<ProposalContent> {
  const userSkills = settings?.userSkills ?? [];
  const portfolioDescription = settings?.portfolioDescription ?? "";

  const toneGuide =
    tone === "friendly" ? "warm and approachable while remaining professional"
    : tone === "confident" ? "assertive and confident, showing clear expertise"
    : "professional, formal, and results-focused";

  const prompt = `You are an expert Upwork proposal writer. Write a compelling, specific proposal.

JOB:
Title: ${job.title}
Description: ${job.description?.slice(0, 1200)}
Budget: ${job.budgetType === "hourly" ? `$${job.budgetMin ?? "?"}–$${job.budgetMax ?? "?"}/hr` : `$${job.budgetMin ?? "?"}–$${job.budgetMax ?? "?"} fixed`}
Skills: ${(job.skills ?? []).join(", ") || "Not specified"}

FREELANCER:
Skills: ${userSkills.join(", ") || "Not specified"}
${includePortfolio && portfolioDescription ? `Background: ${portfolioDescription}` : ""}
${bidAmount ? `Bid: $${bidAmount}` : ""}
Tone: ${toneGuide}

Return ONLY this JSON:
{
  "content": <200-350 word proposal: specific hook + problem understanding + approach + CTA>,
  "coverLetter": <2-3 sentence summary for quick review>
}

Proposal must: open with a specific hook referencing the job (NOT "I saw your job posting"), show understanding of the client's exact problem, highlight the 2-3 most relevant skills, end with a concrete next step or question.`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
    max_tokens: 1200,
    temperature: 0.7,
  });

  let parsed: ProposalContent;
  try {
    parsed = JSON.parse(response.choices[0]?.message?.content ?? "{}") as ProposalContent;
  } catch {
    parsed = { content: "Unable to generate proposal. Please try again.", coverLetter: "Proposal generation failed." };
  }

  return parsed;
}
