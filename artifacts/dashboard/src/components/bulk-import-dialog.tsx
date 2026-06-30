import { useState, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { createJob, analyzeJob, getListJobsQueryKey } from "@workspace/api-client-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import {
  Loader2, CheckCircle2, XCircle, Clock, Brain, Upload,
  ChevronRight, ArrowRight, ExternalLink, RotateCcw, FileText,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────

type ParsedJob = {
  title: string;
  description: string;
  jobUrl?: string;
  upworkJobId?: string;
  budgetType: "hourly" | "fixed";
  budgetMin?: number;
  budgetMax?: number;
  skills: string[];
  clientCountry?: string;
  paymentVerified: boolean;
};

type JobStatus = "pending" | "creating" | "analyzing" | "done" | "error";

type QueueItem = ParsedJob & {
  id: string; // local temp id
  status: JobStatus;
  jobId?: number;
  applyScore?: number;
  recommendation?: string;
  error?: string;
};

type Step = "input" | "preview" | "processing" | "done";

// ─── Parser ───────────────────────────────────────────────────────────────────

function extractUpworkJobId(text: string): string | null {
  const m = text.match(/~([a-zA-Z0-9]+)/);
  return m ? m[1] : null;
}

function parseBudget(text: string): { budgetType: "hourly" | "fixed"; budgetMin?: number; budgetMax?: number } {
  const isHourly = /\/hr|hourly/i.test(text);
  const nums = (text.match(/[\d,]+(?:\.\d+)?/g) ?? []).map((n) => parseFloat(n.replace(/,/g, "")));
  return {
    budgetType: isHourly ? "hourly" : "fixed",
    budgetMin: nums[0],
    budgetMax: nums[1] ?? nums[0],
  };
}

function parseBlock(block: string, index: number): ParsedJob {
  const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);

  let title = "";
  let description = block.trim();
  let jobUrl = "";
  let skills: string[] = [];
  let budgetType: "hourly" | "fixed" = "hourly";
  let budgetMin: number | undefined;
  let budgetMax: number | undefined;
  let clientCountry: string | undefined;
  let paymentVerified = false;

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.startsWith("title:")) {
      title = line.replace(/^title:\s*/i, "").trim();
    } else if (lower.startsWith("skills:") || lower.startsWith("skill:")) {
      skills = line.replace(/^skills?:\s*/i, "").split(",").map((s) => s.trim()).filter(Boolean);
    } else if (lower.startsWith("budget:")) {
      const b = parseBudget(line);
      budgetType = b.budgetType;
      budgetMin = b.budgetMin;
      budgetMax = b.budgetMax;
    } else if (lower.startsWith("country:") || lower.startsWith("location:")) {
      clientCountry = line.replace(/^(country|location):\s*/i, "").trim();
    } else if (lower.includes("payment verified") || lower.includes("verified payment")) {
      paymentVerified = true;
    } else if (/https?:\/\//.test(line)) {
      jobUrl = line.trim();
    }
  }

  // Auto-detect budget from anywhere in block
  if (!budgetMin) {
    const budgetMatch = block.match(/\$[\d,]+-?\$?[\d,]*\s*\/?hr/i) ?? block.match(/\$[\d,]+/);
    if (budgetMatch) {
      const b = parseBudget(budgetMatch[0]);
      budgetType = b.budgetType;
      budgetMin = b.budgetMin;
      budgetMax = b.budgetMax;
    }
  }

  // Extract title: first non-URL short line if not explicitly set
  if (!title) {
    const titleLine = lines.find(
      (l) => l.length > 5 && l.length < 120 && !/https?:\/\//.test(l) && !l.includes(":")
    );
    title = titleLine ?? `Job ${index + 1}`;
  }

  const upworkJobId = jobUrl ? (extractUpworkJobId(jobUrl) ?? undefined) : undefined;

  return { title, description, jobUrl: jobUrl || undefined, upworkJobId, budgetType, budgetMin, budgetMax, skills, clientCountry, paymentVerified };
}

function parseInput(input: string): ParsedJob[] {
  // Split by separator lines (---, ===, or blank lines ≥2)
  const blocks = input
    .split(/^-{3,}$|^={3,}$/m)
    .map((b) => b.trim())
    .filter((b) => b.length > 20); // minimum meaningful length

  if (blocks.length > 1) {
    return blocks.map((b, i) => parseBlock(b, i));
  }

  // Try URL-per-line mode
  const urlLines = input.trim().split("\n").map((l) => l.trim()).filter((l) => /https?:\/\/.*upwork\.com/.test(l));
  if (urlLines.length > 1) {
    return urlLines.map((url, i) => ({
      title: `Upwork Job ${i + 1}`,
      description: `Job submitted from URL: ${url}`,
      jobUrl: url,
      upworkJobId: extractUpworkJobId(url) ?? undefined,
      budgetType: "hourly" as const,
      skills: [],
      paymentVerified: false,
    }));
  }

  // Single job fallback
  return [parseBlock(input, 0)];
}

// ─── Status icon ──────────────────────────────────────────────────────────────

function StatusIcon({ status }: { status: JobStatus }) {
  switch (status) {
    case "pending":   return <Clock className="w-4 h-4 text-muted-foreground" />;
    case "creating":  return <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />;
    case "analyzing": return <Brain className="w-4 h-4 text-amber-400 animate-pulse" />;
    case "done":      return <CheckCircle2 className="w-4 h-4 text-emerald-400" />;
    case "error":     return <XCircle className="w-4 h-4 text-red-400" />;
  }
}

function StatusLabel({ status }: { status: JobStatus }) {
  const map: Record<JobStatus, { label: string; className: string }> = {
    pending:   { label: "Queued",    className: "bg-muted/50 text-muted-foreground border-border" },
    creating:  { label: "Saving…",   className: "bg-blue-500/15 text-blue-400 border-blue-500/30" },
    analyzing: { label: "Analyzing…",className: "bg-amber-500/15 text-amber-400 border-amber-500/30" },
    done:      { label: "Done",      className: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" },
    error:     { label: "Error",     className: "bg-red-500/15 text-red-400 border-red-500/30" },
  };
  const { label, className } = map[status];
  return <Badge className={cn("text-xs", className)}>{label}</Badge>;
}

function ScorePill({ score, recommendation }: { score?: number; recommendation?: string }) {
  if (score == null) return null;
  const color = score >= 75 ? "text-emerald-400" : score >= 50 ? "text-amber-400" : "text-red-400";
  const rec = recommendation ?? "";
  return (
    <span className={cn("font-mono font-bold text-sm", color)}>
      {score}<span className="text-xs font-normal text-muted-foreground">/100</span>
      {rec && <span className={cn("ml-2 text-xs uppercase tracking-wide", color)}>{rec}</span>}
    </span>
  );
}

// ─── Main dialog ──────────────────────────────────────────────────────────────

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

const DELAY_MS = 800; // polite delay between jobs

export function BulkImportDialog({ open, onOpenChange }: Props) {
  const [step, setStep] = useState<Step>("input");
  const [raw, setRaw] = useState("");
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [processing, setProcessing] = useState(false);
  const qc = useQueryClient();
  const { toast } = useToast();

  // Derived
  const parsed = step === "preview" || step === "processing" || step === "done" ? queue : [];
  const total = queue.length;
  const done = queue.filter((j) => j.status === "done").length;
  const errors = queue.filter((j) => j.status === "error").length;
  const progress = total > 0 ? Math.round(((done + errors) / total) * 100) : 0;

  const patchItem = useCallback((id: string, patch: Partial<QueueItem>) => {
    setQueue((prev) => prev.map((item) => item.id === id ? { ...item, ...patch } : item));
  }, []);

  function handleParse() {
    const items = parseInput(raw);
    setQueue(items.map((p, i) => ({ ...p, id: `item-${i}`, status: "pending" })));
    setStep("preview");
  }

  async function handleStart() {
    setStep("processing");
    setProcessing(true);

    const snapshot = queue; // stable ref

    for (const item of snapshot) {
      patchItem(item.id, { status: "creating" });

      try {
        const job = await createJob({
          title: item.title,
          description: item.description,
          budgetType: item.budgetType,
          budgetMin: item.budgetMin,
          budgetMax: item.budgetMax,
          skills: item.skills,
          jobUrl: item.jobUrl,
          upworkJobId: item.upworkJobId,
          clientCountry: item.clientCountry,
          paymentVerified: item.paymentVerified,
        });

        patchItem(item.id, { status: "analyzing", jobId: job.id });

        const analysis = await analyzeJob(job.id);
        patchItem(item.id, {
          status: "done",
          applyScore: analysis.applyScore,
          recommendation: analysis.recommendation,
        });

        qc.invalidateQueries({ queryKey: getListJobsQueryKey() });
      } catch (err: any) {
        const msg = err?.response?.data?.error ?? err?.message ?? "Unknown error";
        patchItem(item.id, { status: "error", error: msg });
      }

      // Polite delay between jobs
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }

    setProcessing(false);
    setStep("done");
    qc.invalidateQueries({ queryKey: getListJobsQueryKey() });
    toast({ title: `Import complete`, description: `${done + 1} analyzed, ${errors} errors` });
  }

  function handleReset() {
    setStep("input");
    setRaw("");
    setQueue([]);
    setProcessing(false);
  }

  function handleClose() {
    if (processing) return;
    onOpenChange(false);
    setTimeout(handleReset, 200);
  }

  const detectedCount = raw.trim().length > 10 ? parseInput(raw).length : 0;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl max-h-[88vh] flex flex-col gap-0 p-0">
        {/* Header */}
        <div className="px-6 pt-6 pb-4 border-b border-border shrink-0">
          <DialogTitle className="text-xl font-serif flex items-center gap-2">
            <Upload className="w-5 h-5 text-primary" />
            Bulk Import & Analyze
          </DialogTitle>
          <DialogDescription className="mt-1">
            Paste multiple job descriptions separated by <code className="bg-muted px-1 rounded text-xs">---</code>, or one Upwork URL per line. Each job is created and AI-analyzed in sequence.
          </DialogDescription>

          {/* Step indicators */}
          <div className="flex items-center gap-2 mt-4 text-xs text-muted-foreground">
            {(["input", "preview", "processing", "done"] as Step[]).map((s, i, arr) => (
              <span key={s} className="flex items-center gap-2">
                <span className={cn(
                  "px-2 py-0.5 rounded-full font-medium capitalize",
                  step === s ? "bg-primary text-white" : "bg-muted text-muted-foreground"
                )}>{s}</span>
                {i < arr.length - 1 && <ChevronRight className="w-3 h-3" />}
              </span>
            ))}
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-hidden">
          <AnimatePresence mode="wait">

            {/* ── Step 1: Input ── */}
            {step === "input" && (
              <motion.div key="input" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="flex flex-col gap-4 p-6 h-full">
                <Textarea
                  className="flex-1 min-h-[300px] font-mono text-sm resize-none"
                  placeholder={`Paste job descriptions separated by ---\n\nTitle: Senior React Developer\nSkills: React, TypeScript, Node.js\nBudget: $80-120/hr\nCountry: US\n\nWe are looking for an experienced React developer...\n\n---\n\nTitle: AI Chatbot Integration\nSkills: Python, OpenAI, FastAPI\n\nBuild a customer service chatbot using GPT-4...\n\n---\n\nOr paste Upwork URLs (one per line):\nhttps://www.upwork.com/jobs/~01abc123`}
                  value={raw}
                  onChange={(e) => setRaw(e.target.value)}
                />
                <div className="flex items-center justify-between">
                  <div className="text-sm text-muted-foreground flex items-center gap-2">
                    {raw.trim().length > 10 && (
                      <Badge variant="outline" className="gap-1.5">
                        <FileText className="w-3 h-3" />
                        {detectedCount} job{detectedCount !== 1 ? "s" : ""} detected
                      </Badge>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" onClick={handleClose}>Cancel</Button>
                    <Button onClick={handleParse} disabled={detectedCount === 0} className="gap-2">
                      Preview Jobs <ArrowRight className="w-4 h-4" />
                    </Button>
                  </div>
                </div>

                {/* Format tips */}
                <div className="rounded-lg bg-muted/30 border border-border p-3 text-xs text-muted-foreground space-y-1">
                  <p className="font-medium text-foreground">Accepted formats:</p>
                  <p>• <strong>Blocks</strong> — separate multiple descriptions with <code className="bg-muted px-1 rounded">---</code> on its own line</p>
                  <p>• <strong>URLs</strong> — one <code className="bg-muted px-1 rounded">upwork.com</code> URL per line</p>
                  <p>• <strong>Labels</strong> — prefix lines with <code className="bg-muted px-1 rounded">Title:</code>, <code className="bg-muted px-1 rounded">Skills:</code>, <code className="bg-muted px-1 rounded">Budget:</code>, <code className="bg-muted px-1 rounded">Country:</code></p>
                </div>
              </motion.div>
            )}

            {/* ── Step 2: Preview ── */}
            {step === "preview" && (
              <motion.div key="preview" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="flex flex-col h-full">
                <ScrollArea className="flex-1 px-6 py-4">
                  <div className="space-y-2">
                    {queue.map((item, i) => (
                      <div key={item.id} className="flex items-start gap-3 p-3 rounded-lg border border-border bg-card hover:border-border/80 transition-colors">
                        <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center text-xs font-bold text-muted-foreground shrink-0 mt-0.5">
                          {i + 1}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm leading-tight">{item.title}</p>
                          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{item.description}</p>
                          <div className="flex flex-wrap gap-2 mt-2">
                            {item.skills.slice(0, 4).map((s) => (
                              <Badge key={s} variant="outline" className="text-xs py-0">{s}</Badge>
                            ))}
                            {item.skills.length > 4 && (
                              <Badge variant="outline" className="text-xs py-0">+{item.skills.length - 4}</Badge>
                            )}
                            {item.budgetMin && (
                              <Badge variant="outline" className="text-xs py-0">
                                ${item.budgetMin}{item.budgetMax && item.budgetMax !== item.budgetMin ? `–${item.budgetMax}` : ""}
                                {item.budgetType === "hourly" ? "/hr" : ""}
                              </Badge>
                            )}
                            {item.jobUrl && (
                              <Badge variant="outline" className="text-xs py-0 text-blue-400 border-blue-500/30">URL ✓</Badge>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
                <div className="px-6 py-4 border-t border-border flex gap-2 shrink-0">
                  <Button variant="outline" onClick={() => setStep("input")} className="gap-2">
                    <RotateCcw className="w-4 h-4" /> Edit
                  </Button>
                  <Button onClick={handleStart} className="flex-1 gap-2">
                    <Brain className="w-4 h-4" />
                    Analyze {queue.length} job{queue.length !== 1 ? "s" : ""} with AI
                  </Button>
                </div>
              </motion.div>
            )}

            {/* ── Step 3/4: Processing + Done ── */}
            {(step === "processing" || step === "done") && (
              <motion.div key="processing" initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                className="flex flex-col h-full">
                {/* Progress bar */}
                <div className="px-6 pt-4 pb-3 border-b border-border shrink-0 space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">
                      {step === "done"
                        ? `Completed — ${done} analyzed${errors > 0 ? `, ${errors} errors` : ""}`
                        : `Processing ${queue.findIndex((j) => j.status === "creating" || j.status === "analyzing") + 1} of ${total}…`}
                    </span>
                    <span className="font-mono font-bold text-primary">{progress}%</span>
                  </div>
                  <Progress value={progress} className="h-2" />
                  <div className="flex gap-4 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1"><CheckCircle2 className="w-3 h-3 text-emerald-400" /> {done} done</span>
                    <span className="flex items-center gap-1"><XCircle className="w-3 h-3 text-red-400" /> {errors} errors</span>
                    <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> {total - done - errors} queued</span>
                  </div>
                </div>

                {/* Queue rows */}
                <ScrollArea className="flex-1 px-6 py-3">
                  <div className="space-y-2">
                    {queue.map((item) => (
                      <motion.div
                        key={item.id}
                        layout
                        className={cn(
                          "flex items-center gap-3 p-3 rounded-lg border transition-colors",
                          item.status === "done" ? "border-emerald-500/20 bg-emerald-500/5" :
                          item.status === "error" ? "border-red-500/20 bg-red-500/5" :
                          item.status === "creating" || item.status === "analyzing" ? "border-primary/30 bg-primary/5" :
                          "border-border bg-card/50"
                        )}
                      >
                        <StatusIcon status={item.status} />
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm truncate">{item.title}</p>
                          {item.error && (
                            <p className="text-xs text-red-400 mt-0.5 truncate">{item.error}</p>
                          )}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <StatusLabel status={item.status} />
                          {item.status === "done" && (
                            <ScorePill score={item.applyScore} recommendation={item.recommendation} />
                          )}
                          {item.status === "done" && item.jobId && (
                            <Link href={`/jobs/${item.jobId}`} onClick={handleClose}>
                              <Button size="sm" variant="ghost" className="h-7 px-2">
                                <ExternalLink className="w-3.5 h-3.5" />
                              </Button>
                            </Link>
                          )}
                        </div>
                      </motion.div>
                    ))}
                  </div>
                </ScrollArea>

                {/* Footer */}
                <div className="px-6 py-4 border-t border-border shrink-0 flex gap-2">
                  {step === "done" ? (
                    <>
                      <Button variant="outline" onClick={handleReset} className="gap-2">
                        <Upload className="w-4 h-4" /> Import More
                      </Button>
                      <Button onClick={handleClose} className="flex-1">Done</Button>
                    </>
                  ) : (
                    <Button variant="outline" disabled className="flex-1 gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Processing… do not close
                    </Button>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </DialogContent>
    </Dialog>
  );
}
