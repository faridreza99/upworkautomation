import { useState } from "react";
import { useForm, Controller } from "react-hook-form";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useCreateJob, useAnalyzeJob, getListJobsQueryKey } from "@workspace/api-client-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  Loader2, Link2, Brain, CheckCircle2, Sparkles, AlertCircle,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";

type Phase = "form" | "creating" | "analyzing" | "done";

type FormValues = {
  jobUrl: string;
  title: string;
  description: string;
  budgetType: "hourly" | "fixed";
  budgetMin: string;
  budgetMax: string;
  clientCountry: string;
  paymentVerified: boolean;
  skillsRaw: string;
};

function extractUpworkJobId(url: string): string | null {
  const m = url.match(/~([a-zA-Z0-9]+)/);
  return m ? m[1] : null;
}

function PhaseStep({
  phase, current, label, icon,
}: { phase: Phase; current: Phase; label: string; icon: React.ReactNode }) {
  const order: Phase[] = ["creating", "analyzing", "done"];
  const currentIdx = order.indexOf(current);
  const phaseIdx = order.indexOf(phase);
  const done = currentIdx > phaseIdx;
  const active = current === phase;

  return (
    <div className={cn("flex items-center gap-2 text-sm", done || active ? "text-foreground" : "text-muted-foreground")}>
      <div className={cn(
        "w-7 h-7 rounded-full flex items-center justify-center shrink-0 transition-colors",
        done ? "bg-emerald-500 text-white" : active ? "bg-primary text-white" : "bg-muted text-muted-foreground"
      )}>
        {done ? <CheckCircle2 className="w-4 h-4" /> : active ? <Loader2 className="w-4 h-4 animate-spin" /> : icon}
      </div>
      <span className={cn("font-medium", active && "text-primary")}>{label}</span>
    </div>
  );
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

type FetchState = "idle" | "loading" | "success" | "error";

export function SubmitJobDialog({ open, onOpenChange }: Props) {
  const [phase, setPhase] = useState<Phase>("form");
  const [createdJobId, setCreatedJobId] = useState<number | null>(null);
  const [fetchState, setFetchState] = useState<FetchState>("idle");
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const { toast } = useToast();

  const createJob = useCreateJob();
  const analyzeJob = useAnalyzeJob();

  const form = useForm<FormValues>({
    defaultValues: {
      jobUrl: "",
      title: "",
      description: "",
      budgetType: "hourly",
      budgetMin: "",
      budgetMax: "",
      clientCountry: "",
      paymentVerified: false,
      skillsRaw: "",
    },
  });

  const budgetType = form.watch("budgetType");
  const jobUrl = form.watch("jobUrl");
  const detectedJobId = extractUpworkJobId(jobUrl);
  const isUpworkUrl = jobUrl.includes("upwork.com/jobs");

  function handleClose() {
    if (phase === "creating" || phase === "analyzing") return;
    onOpenChange(false);
    setTimeout(() => {
      form.reset();
      setPhase("form");
      setCreatedJobId(null);
      setFetchState("idle");
      setFetchError(null);
    }, 200);
  }

  async function handleFetchUrl() {
    const url = form.getValues("jobUrl").trim();
    if (!url) return;

    setFetchState("loading");
    setFetchError(null);

    try {
      const base = import.meta.env.BASE_URL ?? "/";
      const res = await fetch(`${base}api/scrape`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });

      const data = await res.json();

      if (!res.ok) {
        setFetchState("error");
        setFetchError(data.error ?? `Server returned ${res.status}`);
        return;
      }

      // Auto-fill all fields from scraped data
      if (data.title)       form.setValue("title", data.title);
      if (data.description) form.setValue("description", data.description);
      if (data.budgetType)  form.setValue("budgetType", data.budgetType);
      if (data.budgetMin)   form.setValue("budgetMin", String(data.budgetMin));
      if (data.budgetMax)   form.setValue("budgetMax", String(data.budgetMax));
      if (data.clientCountry) form.setValue("clientCountry", data.clientCountry);
      if (data.paymentVerified) form.setValue("paymentVerified", data.paymentVerified);
      if (data.skills?.length) form.setValue("skillsRaw", data.skills.join(", "));

      setFetchState("success");
      toast({ title: "Job details fetched!", description: `Auto-filled from Upwork${data.skills?.length ? ` · ${data.skills.length} skills extracted` : ""}` });
    } catch (err: any) {
      setFetchState("error");
      setFetchError(err?.message ?? "Network error — check your connection");
    }
  }

  async function onSubmit(values: FormValues) {
    const skills = values.skillsRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const upworkJobId = extractUpworkJobId(values.jobUrl) ?? undefined;

    try {
      setPhase("creating");
      const job = await createJob.mutateAsync({
        data: {
          upworkJobId,
          title: values.title.trim(),
          description: values.description.trim(),
          budgetType: values.budgetType,
          budgetMin: values.budgetMin ? parseFloat(values.budgetMin) : undefined,
          budgetMax: values.budgetMax ? parseFloat(values.budgetMax) : undefined,
          clientCountry: values.clientCountry.trim() || undefined,
          paymentVerified: values.paymentVerified,
          skills,
          jobUrl: values.jobUrl.trim() || undefined,
        },
      });

      setCreatedJobId(job.id);
      qc.invalidateQueries({ queryKey: getListJobsQueryKey() });

      setPhase("analyzing");
      await analyzeJob.mutateAsync({ id: job.id });
      qc.invalidateQueries({ queryKey: getListJobsQueryKey() });

      setPhase("done");
      toast({ title: "Job analyzed!", description: `"${job.title}" has been scored by AI.` });

      setTimeout(() => {
        handleClose();
        navigate(`/jobs/${job.id}`);
      }, 900);
    } catch (err: any) {
      const msg = err?.response?.data?.error ?? err?.message ?? "Something went wrong";
      setPhase("form");
      toast({ title: "Submission failed", description: msg, variant: "destructive" });
    }
  }

  const isSubmitting = phase === "creating" || phase === "analyzing";
  const isFetching = fetchState === "loading";

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-xl font-serif">Submit a Job</DialogTitle>
          <DialogDescription>
            Paste an Upwork URL and hit <strong>Fetch</strong> to auto-fill everything, or fill in manually.
          </DialogDescription>
        </DialogHeader>

        {/* Progress steps */}
        <AnimatePresence>
          {phase !== "form" && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="rounded-xl bg-muted/40 border border-border p-4 space-y-3"
            >
              <PhaseStep phase="creating" current={phase} label="Saving job" icon={<span className="text-xs font-bold">1</span>} />
              <PhaseStep phase="analyzing" current={phase} label="Running AI analysis" icon={<Brain className="w-3.5 h-3.5" />} />
              <PhaseStep phase="done" current={phase} label="Complete — redirecting" icon={<CheckCircle2 className="w-3.5 h-3.5" />} />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Form */}
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">

          {/* URL field with Fetch button */}
          <div className="space-y-1.5">
            <Label htmlFor="jobUrl" className="flex items-center gap-1.5">
              <Link2 className="w-3.5 h-3.5" /> Upwork Job URL
              <span className="text-muted-foreground font-normal">(optional)</span>
            </Label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input
                  id="jobUrl"
                  placeholder="https://www.upwork.com/jobs/~01abc..."
                  {...form.register("jobUrl")}
                  disabled={isSubmitting || isFetching}
                  className={cn(
                    fetchState === "success" && "border-emerald-500/50 focus-visible:ring-emerald-500/30",
                    fetchState === "error" && "border-red-500/50",
                  )}
                />
                {detectedJobId && fetchState !== "success" && (
                  <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none">
                    <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 text-xs">
                      ID ✓
                    </Badge>
                  </div>
                )}
              </div>
              <Button
                type="button"
                variant={fetchState === "success" ? "default" : "outline"}
                disabled={!isUpworkUrl || isSubmitting || isFetching}
                onClick={handleFetchUrl}
                className={cn(
                  "gap-2 shrink-0 transition-all",
                  fetchState === "success" && "bg-emerald-600 hover:bg-emerald-700 text-white border-emerald-600"
                )}
              >
                {isFetching ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /> Fetching…</>
                ) : fetchState === "success" ? (
                  <><CheckCircle2 className="w-4 h-4" /> Fetched</>
                ) : (
                  <><Sparkles className="w-4 h-4" /> Fetch</>
                )}
              </Button>
            </div>

            {/* Fetch feedback */}
            <AnimatePresence mode="wait">
              {fetchState === "success" && (
                <motion.p
                  key="ok"
                  initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                  className="text-xs text-emerald-400 flex items-center gap-1"
                >
                  <CheckCircle2 className="w-3 h-3" /> Job details auto-filled from Upwork. Review and adjust below.
                </motion.p>
              )}
              {fetchState === "error" && fetchError && (
                <motion.p
                  key="err"
                  initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                  className="text-xs text-red-400 flex items-start gap-1"
                >
                  <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" /> {fetchError}
                </motion.p>
              )}
              {fetchState === "idle" && isUpworkUrl && (
                <motion.p
                  key="hint"
                  initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                  className="text-xs text-muted-foreground"
                >
                  Upwork URL detected — click <strong>Fetch</strong> to auto-fill title, description, skills &amp; budget.
                </motion.p>
              )}
              {fetchState === "idle" && !isUpworkUrl && (
                <motion.p key="tip" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                  className="text-xs text-muted-foreground">
                  Paste an Upwork job URL to auto-fill all fields, or fill in manually below.
                </motion.p>
              )}
            </AnimatePresence>
          </div>

          {/* Title */}
          <div className="space-y-1.5">
            <Label htmlFor="title">Job Title <span className="text-destructive">*</span></Label>
            <Input
              id="title"
              placeholder="e.g. Senior React Developer for SaaS Dashboard"
              {...form.register("title", { required: "Title is required" })}
              disabled={isSubmitting}
            />
            {form.formState.errors.title && (
              <p className="text-xs text-destructive">{form.formState.errors.title.message}</p>
            )}
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <Label htmlFor="description">Job Description <span className="text-destructive">*</span></Label>
            <Textarea
              id="description"
              rows={5}
              placeholder="Paste the full job description here. The more detail, the more accurate the AI scoring…"
              {...form.register("description", { required: "Description is required" })}
              disabled={isSubmitting}
              className="resize-none"
            />
            {form.formState.errors.description && (
              <p className="text-xs text-destructive">{form.formState.errors.description.message}</p>
            )}
          </div>

          {/* Budget */}
          <div className="space-y-3">
            <Label>Budget</Label>
            <div className="grid grid-cols-3 gap-3">
              <Controller
                control={form.control}
                name="budgetType"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange} disabled={isSubmitting}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="hourly">Hourly</SelectItem>
                      <SelectItem value="fixed">Fixed</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
              <Input
                type="number"
                placeholder={budgetType === "hourly" ? "Min $/hr" : "Amount $"}
                {...form.register("budgetMin")}
                disabled={isSubmitting}
              />
              <Input
                type="number"
                placeholder={budgetType === "hourly" ? "Max $/hr" : "Max $"}
                {...form.register("budgetMax")}
                disabled={isSubmitting}
              />
            </div>
          </div>

          {/* Skills */}
          <div className="space-y-1.5">
            <Label htmlFor="skills">Skills</Label>
            <Input
              id="skills"
              placeholder="React, Node.js, TypeScript, PostgreSQL"
              {...form.register("skillsRaw")}
              disabled={isSubmitting}
            />
            <p className="text-xs text-muted-foreground">Comma-separated</p>
          </div>

          {/* Country + Payment verified */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="country">Client Country</Label>
              <Input
                id="country"
                placeholder="US, CA, AU…"
                {...form.register("clientCountry")}
                disabled={isSubmitting}
              />
            </div>
            <div className="flex flex-col justify-end pb-1">
              <Controller
                control={form.control}
                name="paymentVerified"
                render={({ field }) => (
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={field.value}
                      onCheckedChange={field.onChange}
                      disabled={isSubmitting}
                    />
                    <Label className="cursor-pointer" onClick={() => field.onChange(!field.value)}>
                      Payment Verified
                    </Label>
                  </div>
                )}
              />
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-3 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={handleClose}
              disabled={isSubmitting}
              className="flex-1"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isSubmitting}
              className="flex-1 gap-2"
            >
              {isSubmitting ? (
                <><Loader2 className="w-4 h-4 animate-spin" />
                  {phase === "creating" ? "Saving…" : phase === "analyzing" ? "Analyzing…" : "Done!"}
                </>
              ) : (
                <><Brain className="w-4 h-4" /> Submit & Analyze</>
              )}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
