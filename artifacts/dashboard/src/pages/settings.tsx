import {
  useGetSettings, useUpdateSettings, getGetSettingsQueryKey,
  useGetScannerStatus, useTriggerScanner,
} from '@workspace/api-client-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { TagInput } from '@/components/tag-input';
import { useForm, Controller } from 'react-hook-form';
import { useEffect } from 'react';
import { toast } from 'sonner';
import {
  Save, Rss, Play, Clock, AlertCircle, Loader2,
  RefreshCw, Zap, Search, Wrench, ShieldOff, Globe,
  Bot, Bell, Ban,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow, parseISO } from 'date-fns';
import { cn } from '@/lib/utils';

type FormValues = {
  minHourlyRate: number;
  minFixedBudget: number;
  minAiScore: number;
  autoApplyEnabled: boolean;
  telegramEnabled: boolean;
  telegramBotToken: string;
  telegramChatId: string;
  portfolioDescription: string;
  scanEnabled: boolean;
  scanIntervalMinutes: number;
  keywords: string[];
  userSkills: string[];
  blacklistedClients: string[];
  preferredCountries: string[];
  paymentVerifiedOnly: boolean;
  // Phase 2
  priorHireRequired: boolean;
  maxApplicants: number;
  maxJobAgeDays: number;
  blockedCountries: string[];
  autoProposalEnabled: boolean;
  manualApprovalMode: boolean;
  notifyOnContract: boolean;
};

export function SettingsPage() {
  const { data: settings, isLoading } = useGetSettings();
  const updateSettings = useUpdateSettings();
  const queryClient = useQueryClient();

  const { data: scannerStatus, refetch: refetchScanner } = useGetScannerStatus({
    query: { refetchInterval: 5000 } as any,
  });
  const triggerScanner = useTriggerScanner();

  const form = useForm<FormValues>({
    defaultValues: {
      minHourlyRate: 0,
      minFixedBudget: 0,
      minAiScore: 70,
      autoApplyEnabled: false,
      telegramEnabled: false,
      telegramBotToken: '',
      telegramChatId: '',
      portfolioDescription: '',
      scanEnabled: false,
      scanIntervalMinutes: 30,
      keywords: [],
      userSkills: [],
      blacklistedClients: [],
      preferredCountries: [],
      paymentVerifiedOnly: false,
      // Phase 2
      priorHireRequired: false,
      maxApplicants: 0,
      maxJobAgeDays: 0,
      blockedCountries: [],
      autoProposalEnabled: false,
      manualApprovalMode: false,
      notifyOnContract: false,
    },
  });

  useEffect(() => {
    if (settings) {
      form.reset({
        minHourlyRate: settings.minHourlyRate || 0,
        minFixedBudget: settings.minFixedBudget || 0,
        minAiScore: settings.minAiScore || 70,
        autoApplyEnabled: settings.autoApplyEnabled || false,
        telegramEnabled: (settings as any).telegramEnabled || false,
        telegramBotToken: (settings as any).telegramBotToken || '',
        telegramChatId: (settings as any).telegramChatId || '',
        portfolioDescription: settings.portfolioDescription || '',
        scanEnabled: (settings as any).scanEnabled || false,
        scanIntervalMinutes: (settings as any).scanIntervalMinutes || 30,
        keywords: settings.keywords || [],
        userSkills: settings.userSkills || [],
        blacklistedClients: settings.blacklistedClients || [],
        preferredCountries: settings.preferredCountries || [],
        paymentVerifiedOnly: settings.paymentVerifiedOnly ?? false,
        // Phase 2
        priorHireRequired: (settings as any).priorHireRequired ?? false,
        maxApplicants: (settings as any).maxApplicants ?? 0,
        maxJobAgeDays: (settings as any).maxJobAgeDays ?? 0,
        blockedCountries: (settings as any).blockedCountries ?? [],
        autoProposalEnabled: (settings as any).autoProposalEnabled ?? false,
        manualApprovalMode: (settings as any).manualApprovalMode ?? false,
        notifyOnContract: (settings as any).notifyOnContract ?? false,
      });
    }
  }, [settings, form]);

  const onSubmit = (data: FormValues) => {
    updateSettings.mutate({ data: data as any }, {
      onSuccess: () => {
        toast.success('Settings saved');
        queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
        refetchScanner();
      },
      onError: () => {
        toast.error('Failed to save settings');
      },
    });
  };

  function handleTriggerScan() {
    triggerScanner.mutate(undefined, {
      onSuccess: () => {
        toast.success('Scan started! New jobs will appear shortly.');
        setTimeout(() => refetchScanner(), 1500);
      },
      onError: (err: any) => {
        const msg = err?.response?.data?.error ?? 'Scanner is busy, try again in a moment.';
        toast.error(msg);
      },
    });
  }

  if (isLoading) {
    return (
      <div className="p-8 max-w-3xl mx-auto space-y-6">
        <Skeleton className="h-12 w-1/3 mb-8" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const scanEnabled = form.watch('scanEnabled');
  const keywords = form.watch('keywords');
  const userSkills = form.watch('userSkills');
  const isRunning = scannerStatus?.running ?? false;
  const lastRun = scannerStatus?.lastRunAt ? parseISO(scannerStatus.lastRunAt) : null;
  const nextRun = scannerStatus?.nextRunAt ? parseISO(scannerStatus.nextRunAt) : null;

  return (
    <div className="p-8 max-w-4xl mx-auto space-y-8 pb-24">
      <div>
        <h1 className="text-3xl font-bold font-serif tracking-tight">Settings</h1>
        <p className="text-muted-foreground mt-1">Configure automation, AI thresholds, and job scanner.</p>
      </div>

      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8">

        {/* ── Job Filtering ── */}
        <Card>
          <CardHeader>
            <CardTitle>Job Filtering Thresholds</CardTitle>
            <CardDescription>Only monitor jobs that meet these criteria.</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <Label>Minimum Hourly Rate ($)</Label>
              <Input type="number" {...form.register('minHourlyRate', { valueAsNumber: true })} />
            </div>
            <div className="space-y-2">
              <Label>Minimum Fixed Budget ($)</Label>
              <Input type="number" {...form.register('minFixedBudget', { valueAsNumber: true })} />
            </div>
            <div className="space-y-2">
              <Label>Minimum AI Apply Score</Label>
              <Input type="number" max="100" min="0" {...form.register('minAiScore', { valueAsNumber: true })} />
              <p className="text-xs text-muted-foreground">Jobs scoring below this will be skipped automatically.</p>
            </div>

            <div className="md:col-span-2 border-t border-border pt-4">
              <Controller
                control={form.control}
                name="paymentVerifiedOnly"
                render={({ field }) => (
                  <div className="flex items-center justify-between rounded-lg border border-border bg-muted/20 px-4 py-3">
                    <div className="space-y-0.5">
                      <Label className="flex items-center gap-2 cursor-pointer" htmlFor="payment-verified-toggle">
                        <span className="text-yellow-400">💳</span> Payment Verified Only
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        Skip jobs where the client has not verified their payment method. Strongly reduces scam risk.
                      </p>
                    </div>
                    <Switch
                      id="payment-verified-toggle"
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  </div>
                )}
              />
            </div>
          </CardContent>
        </Card>

        {/* ── Keywords & Skills ── */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Search className="w-5 h-5 text-primary" />
              Keywords &amp; Skills
            </CardTitle>
            <CardDescription>
              Used by the RSS scanner to find relevant jobs and by the AI to score your fit. Type a term and press <kbd className="bg-muted px-1 rounded text-xs">Enter</kbd> or <kbd className="bg-muted px-1 rounded text-xs">,</kbd> to add. Paste comma-separated lists to bulk-add.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">

            {/* Keywords */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="flex items-center gap-1.5">
                  <Search className="w-3.5 h-3.5" /> Search Keywords
                </Label>
                <span className="text-xs text-muted-foreground">{keywords.length} added</span>
              </div>
              <Controller
                control={form.control}
                name="keywords"
                render={({ field }) => (
                  <TagInput
                    value={field.value}
                    onChange={field.onChange}
                    placeholder="React developer, Node.js backend, AI chatbot…"
                    badgeClassName="bg-blue-500/15 text-blue-400 border-blue-500/30 hover:bg-blue-500/20"
                  />
                )}
              />
              <p className="text-xs text-muted-foreground">
                Plain English search phrases — the scanner queries Upwork RSS with these exactly (e.g. "senior React developer", "AI integration").
              </p>
            </div>

            <div className="border-t border-border" />

            {/* Skills */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="flex items-center gap-1.5">
                  <Wrench className="w-3.5 h-3.5" /> Your Skills
                </Label>
                <span className="text-xs text-muted-foreground">{userSkills.length} added</span>
              </div>
              <Controller
                control={form.control}
                name="userSkills"
                render={({ field }) => (
                  <TagInput
                    value={field.value}
                    onChange={field.onChange}
                    placeholder="React, TypeScript, Node.js, PostgreSQL, OpenAI…"
                    badgeClassName="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/20"
                  />
                )}
              />
              <p className="text-xs text-muted-foreground">
                Your tech stack. The AI uses these to calculate fit scores — the more complete, the better the scoring.
              </p>
            </div>

            <div className="border-t border-border" />

            {/* Blacklisted Clients */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="flex items-center gap-1.5">
                  <ShieldOff className="w-3.5 h-3.5 text-red-400" /> Blacklisted Clients
                </Label>
                <span className="text-xs text-muted-foreground">
                  {form.watch('blacklistedClients').length} blocked
                </span>
              </div>
              <Controller
                control={form.control}
                name="blacklistedClients"
                render={({ field }) => (
                  <TagInput
                    value={field.value}
                    onChange={field.onChange}
                    placeholder="Acme Corp, BadClient Inc, spammer@example.com…"
                    badgeClassName="bg-red-500/15 text-red-400 border-red-500/30 hover:bg-red-500/20"
                  />
                )}
              />
              <p className="text-xs text-muted-foreground">
                Jobs from these clients are automatically skipped during scanning and scored 0 by the AI. Match is case-insensitive against the client name or company.
              </p>
            </div>

            <div className="border-t border-border" />

            {/* Preferred Countries */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="flex items-center gap-1.5">
                  <Globe className="w-3.5 h-3.5 text-teal-400" /> Preferred Countries
                </Label>
                <span className="text-xs text-muted-foreground">
                  {(form.watch('preferredCountries') ?? []).length === 0
                    ? 'all countries'
                    : `${(form.watch('preferredCountries') ?? []).length} preferred`}
                </span>
              </div>
              <Controller
                control={form.control}
                name="preferredCountries"
                render={({ field }) => (
                  <TagInput
                    value={field.value}
                    onChange={field.onChange}
                    placeholder="United States, United Kingdom, Canada…"
                    badgeClassName="bg-teal-500/15 text-teal-400 border-teal-500/30 hover:bg-teal-500/20"
                  />
                )}
              />
              <p className="text-xs text-muted-foreground">
                When set, the AI gives a score bonus to jobs from these countries and flags others as a concern. Leave empty to accept all countries equally.
              </p>
            </div>

            {/* Scanner query preview */}
            {(keywords.length > 0 || userSkills.length > 0) && (
              <div className="rounded-lg bg-muted/30 border border-border p-3 space-y-2">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Scanner will search ({Math.min(keywords.length + userSkills.length, 6)} queries per run)
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {[...keywords, ...userSkills].slice(0, 6).map((q, i) => (
                    <Badge key={i} variant="outline" className="text-xs font-mono">
                      "{q}"
                    </Badge>
                  ))}
                  {keywords.length + userSkills.length > 6 && (
                    <Badge variant="outline" className="text-xs text-muted-foreground">
                      +{keywords.length + userSkills.length - 6} more (used on next run)
                    </Badge>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── RSS Scanner ── */}
        <Card className="border-primary/20">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Rss className="w-5 h-5 text-primary" />
                  RSS Job Scanner
                </CardTitle>
                <CardDescription className="mt-1">
                  Automatically scans Upwork RSS feeds for new jobs matching your keywords and skills above, then runs AI analysis on each.
                </CardDescription>
              </div>
              <div className="shrink-0">
                {isRunning ? (
                  <Badge className="gap-1.5 bg-amber-500/15 text-amber-400 border-amber-500/30">
                    <Loader2 className="w-3 h-3 animate-spin" /> Scanning…
                  </Badge>
                ) : scannerStatus?.enabled ? (
                  <Badge className="gap-1.5 bg-emerald-500/15 text-emerald-400 border-emerald-500/30">
                    <Zap className="w-3 h-3" /> Active
                  </Badge>
                ) : (
                  <Badge variant="outline" className="gap-1.5 text-muted-foreground">
                    <Clock className="w-3 h-3" /> Inactive
                  </Badge>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">

            <div className="flex items-center justify-between p-4 border rounded-xl bg-card">
              <div className="space-y-0.5">
                <Label className="text-base">Enable Auto-Scan</Label>
                <p className="text-sm text-muted-foreground">Runs in the background on the server at the configured interval.</p>
              </div>
              <Controller
                control={form.control}
                name="scanEnabled"
                render={({ field }) => (
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                )}
              />
            </div>

            {scanEnabled && (
              <div className="space-y-2 pl-4 border-l-2 border-primary/20">
                <Label>Scan Interval</Label>
                <Controller
                  control={form.control}
                  name="scanIntervalMinutes"
                  render={({ field }) => (
                    <Select value={String(field.value)} onValueChange={(v) => field.onChange(Number(v))}>
                      <SelectTrigger className="w-52">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="15">Every 15 minutes</SelectItem>
                        <SelectItem value="30">Every 30 minutes</SelectItem>
                        <SelectItem value="60">Every hour</SelectItem>
                        <SelectItem value="120">Every 2 hours</SelectItem>
                        <SelectItem value="240">Every 4 hours</SelectItem>
                        <SelectItem value="480">Every 8 hours</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>
            )}

            {/* Live stats */}
            {scannerStatus && (
              <div className="rounded-xl bg-muted/30 border border-border p-4 space-y-3">
                <p className="text-sm font-medium flex items-center gap-2">
                  <RefreshCw className="w-4 h-4 text-muted-foreground" /> Scanner Status
                </p>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wide">Last Run</p>
                    <p className="font-medium mt-0.5">
                      {lastRun ? formatDistanceToNow(lastRun, { addSuffix: true }) : 'Never'}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wide">Jobs Found</p>
                    <p className="font-medium mt-0.5">{scannerStatus.lastRunJobsFound ?? 0} in feeds</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wide">New Imported</p>
                    <p className="font-medium mt-0.5 text-emerald-400">+{scannerStatus.lastRunNewJobs ?? 0}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wide">Total Imported</p>
                    <p className="font-medium mt-0.5 text-primary">{scannerStatus.totalJobsImported}</p>
                  </div>
                </div>
                {nextRun && (
                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    Next scan {formatDistanceToNow(nextRun, { addSuffix: true })}
                  </p>
                )}
                {scannerStatus.lastRunError && (
                  <p className="text-xs text-red-400 flex items-start gap-1">
                    <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
                    {scannerStatus.lastRunError}
                  </p>
                )}
              </div>
            )}

            <div className="flex items-center gap-3">
              <Button
                type="button"
                variant="outline"
                className="gap-2"
                disabled={isRunning || triggerScanner.isPending}
                onClick={handleTriggerScan}
              >
                {isRunning || triggerScanner.isPending ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /> Scanning…</>
                ) : (
                  <><Play className="w-4 h-4" /> Scan Now</>
                )}
              </Button>
              <p className="text-xs text-muted-foreground">
                Manually trigger one scan run — useful for testing your keyword configuration.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* ── Advanced Filtering (Phase 2) ── */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Ban className="w-5 h-5 text-destructive" />
              Advanced Filtering
            </CardTitle>
            <CardDescription>Fine-grained AI pre-filtering rules applied before scoring.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <Label>Max Applicants (0 = any)</Label>
                <Input type="number" min="0" {...form.register('maxApplicants', { valueAsNumber: true })} />
                <p className="text-xs text-muted-foreground">Skip jobs with more applicants than this number.</p>
              </div>
              <div className="space-y-2">
                <Label>Max Job Age (days, 0 = any)</Label>
                <Input type="number" min="0" {...form.register('maxJobAgeDays', { valueAsNumber: true })} />
                <p className="text-xs text-muted-foreground">Skip jobs posted more than N days ago.</p>
              </div>
            </div>

            <div className="flex items-center justify-between p-4 border rounded-xl bg-card">
              <div className="space-y-0.5">
                <Label className="text-base">Prior Hire Required</Label>
                <p className="text-sm text-muted-foreground">Only show jobs from clients who have hired before on Upwork.</p>
              </div>
              <Controller
                control={form.control}
                name="priorHireRequired"
                render={({ field }) => (
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                )}
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="flex items-center gap-1.5">
                  <Ban className="w-3.5 h-3.5 text-red-400" /> Blocked Countries
                </Label>
                <span className="text-xs text-muted-foreground">
                  {(form.watch('blockedCountries') ?? []).length === 0 ? 'none blocked' : `${(form.watch('blockedCountries') ?? []).length} blocked`}
                </span>
              </div>
              <Controller
                control={form.control}
                name="blockedCountries"
                render={({ field }) => (
                  <TagInput
                    value={field.value}
                    onChange={field.onChange}
                    placeholder="Russia, Nigeria, Bangladesh…"
                    badgeClassName="bg-red-500/15 text-red-400 border-red-500/30 hover:bg-red-500/20"
                  />
                )}
              />
              <p className="text-xs text-muted-foreground">Jobs from these client countries are automatically scored 0 and skipped.</p>
            </div>
          </CardContent>
        </Card>

        {/* ── Automation & Notifications ── */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Bot className="w-5 h-5 text-primary" />
              Automation &amp; Apply Mode
            </CardTitle>
            <CardDescription>Control how UpworkAI acts on your behalf.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex items-center justify-between p-4 border rounded-xl bg-card">
              <div className="space-y-0.5">
                <Label className="text-base">Auto-Apply to High Score Jobs</Label>
                <p className="text-sm text-muted-foreground">Automatically send generated proposals for jobs scoring above your threshold.</p>
              </div>
              <Controller
                control={form.control}
                name="autoApplyEnabled"
                render={({ field }) => (
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                )}
              />
            </div>

            <div className="flex items-center justify-between p-4 border rounded-xl bg-card">
              <div className="space-y-0.5">
                <Label className="text-base">AI Proposal Generation</Label>
                <p className="text-sm text-muted-foreground">Automatically generate a proposal draft for every new high-score job.</p>
              </div>
              <Controller
                control={form.control}
                name="autoProposalEnabled"
                render={({ field }) => (
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                )}
              />
            </div>

            <div className="flex items-center justify-between p-4 border rounded-xl bg-card">
              <div className="space-y-0.5">
                <Label className="text-base">Manual Approval Mode</Label>
                <p className="text-sm text-muted-foreground">Require your review before any proposal is submitted, even with auto-apply on.</p>
              </div>
              <Controller
                control={form.control}
                name="manualApprovalMode"
                render={({ field }) => (
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                )}
              />
            </div>
          </CardContent>
        </Card>

        {/* ── Notifications ── */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Bell className="w-5 h-5 text-amber-400" />
              Notifications
            </CardTitle>
            <CardDescription>Configure when and how you get alerted.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* ── Telegram ── */}
            <div className="flex items-center justify-between p-4 border rounded-xl bg-card">
              <div className="space-y-0.5">
                <Label className="text-base">Telegram Alerts</Label>
                <p className="text-sm text-muted-foreground">
                  Receive instant notifications for new jobs, high scores, messages, interviews, and contract offers via Telegram Bot.
                </p>
              </div>
              <Controller
                control={form.control}
                name="telegramEnabled"
                render={({ field }) => (
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                )}
              />
            </div>

            {form.watch('telegramEnabled') && (
              <div className="space-y-4 pl-4 border-l-2 border-blue-500/30">
                <div className="space-y-2">
                  <Label>Telegram Bot Token</Label>
                  <Input
                    placeholder="123456789:ABCdef..."
                    type="password"
                    {...form.register('telegramBotToken')}
                  />
                  <p className="text-xs text-muted-foreground">
                    Create a bot via <span className="font-mono">@BotFather</span> on Telegram and paste the token here.
                  </p>
                </div>
                <div className="space-y-2">
                  <Label>Telegram Chat ID</Label>
                  <Input
                    placeholder="-1001234567890 or your personal ID"
                    {...form.register('telegramChatId')}
                  />
                  <p className="text-xs text-muted-foreground">
                    Send any message to your bot, then visit{' '}
                    <span className="font-mono">https://api.telegram.org/bot&lt;TOKEN&gt;/getUpdates</span>{' '}
                    to find your Chat ID.
                  </p>
                </div>
              </div>
            )}

            <div className="flex items-center justify-between p-4 border rounded-xl bg-card">
              <div className="space-y-0.5">
                <Label className="text-base">Notify on Contract Offers</Label>
                <p className="text-sm text-muted-foreground">Send a notification when the extension detects a contract offer from a buyer.</p>
              </div>
              <Controller
                control={form.control}
                name="notifyOnContract"
                render={({ field }) => (
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                )}
              />
            </div>
          </CardContent>
        </Card>

        {/* ── AI Profile ── */}
        <Card>
          <CardHeader>
            <CardTitle>AI Profile</CardTitle>
            <CardDescription>
              Free-text context the AI reads when scoring jobs and generating proposals. Describe your experience, specialties, and what kind of work you're looking for.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <Label>Portfolio &amp; Background</Label>
              <Textarea
                className="min-h-[150px] font-mono text-sm"
                placeholder="I am a senior full-stack developer with 8 years of experience. I specialize in React, Node.js, and AI integrations. I prefer long-term contracts with US-based startups..."
                {...form.register('portfolioDescription')}
              />
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end">
          <Button type="submit" size="lg" disabled={updateSettings.isPending} className="font-bold gap-2">
            {updateSettings.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Save Configuration
          </Button>
        </div>
      </form>
    </div>
  );
}
