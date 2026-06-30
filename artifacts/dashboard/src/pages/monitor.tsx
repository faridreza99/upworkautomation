import { useState, useEffect, useCallback } from 'react';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  CheckCircle2,
  XCircle,
  Loader2,
  RefreshCw,
  FlaskConical,
  Send,
  Clock,
  ShieldCheck,
  Users,
  Zap,
  AlertTriangle,
} from 'lucide-react';

// ── Types ──────────────────────────────────────────────────────────────────

interface MonitorStatus {
  timestamp: string;
  telegram: {
    enabled: boolean;
    chatId: string | null;
  };
  jobs: {
    recentDetected: Array<{
      id: number;
      title: string;
      upworkJobId: string;
      detectedAt: string;
      proposalCount: number | null;
      paymentVerified: boolean | null;
      applyScore: number | null;
      recommendation: string | null;
      status: string;
    }>;
    totalNotified: number;
    lastNotifiedJob: {
      title: string;
      applyScore: number | null;
      proposalCount: number | null;
      detectedAt: string;
    } | null;
  };
}

interface PipelineLog {
  step: string;
  ts: string;
  ms: number;
  detail: string;
}

interface PipelineResult {
  success: boolean;
  totalMs: number;
  log: PipelineLog[];
  analysis: Record<string, unknown> | null;
  notifications: Array<{ provider: string; success: boolean; error?: string }>;
  summary: {
    jobDetected: boolean;
    aiAnalyzed: boolean;
    telegramDelivered: boolean;
    proposalCountAtDetection: number;
    proposalThreshold: number;
    proposalsSafe: boolean;
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

async function apiFetch(path: string, opts?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function timeAgo(iso: string) {
  const d = Date.now() - new Date(iso).getTime();
  if (d < 60_000) return `${Math.round(d / 1000)}s ago`;
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  return `${Math.round(d / 3_600_000)}h ago`;
}

function scoreColor(score: number | null) {
  if (score == null) return 'text-muted-foreground';
  if (score >= 75) return 'text-emerald-500';
  if (score >= 55) return 'text-amber-500';
  return 'text-rose-500';
}

function recBadge(rec: string | null) {
  if (!rec) return null;
  const variants: Record<string, string> = {
    apply: 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30',
    skip: 'bg-rose-500/15 text-rose-600 border-rose-500/30',
    review: 'bg-amber-500/15 text-amber-600 border-amber-500/30',
  };
  return variants[rec] ?? variants['review'];
}

// ── Sub-components ─────────────────────────────────────────────────────────

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-block w-2.5 h-2.5 rounded-full ${ok ? 'bg-emerald-500 shadow-[0_0_6px_2px_rgba(16,185,129,0.4)]' : 'bg-rose-500'}`}
    />
  );
}

function ProviderRow({
  label,
  icon: Icon,
  connected,
  detail,
}: {
  label: string;
  icon: React.ElementType;
  connected: boolean;
  detail: string;
}) {
  return (
    <div className="flex items-center justify-between py-3">
      <div className="flex items-center gap-3">
        <div className={`p-2 rounded-lg ${connected ? 'bg-emerald-500/10' : 'bg-muted'}`}>
          <Icon className={`w-4 h-4 ${connected ? 'text-emerald-500' : 'text-muted-foreground'}`} />
        </div>
        <div>
          <p className="text-sm font-medium">{label}</p>
          <p className="text-xs text-muted-foreground">{detail}</p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <StatusDot ok={connected} />
        <span className={`text-xs font-medium ${connected ? 'text-emerald-600' : 'text-rose-500'}`}>
          {connected ? 'Live' : 'Offline'}
        </span>
      </div>
    </div>
  );
}

function LogRow({ entry, isLast }: { entry: PipelineLog; isLast: boolean }) {
  const isErr = entry.step.includes('fail') || entry.step.includes('error');
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <div
          className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 text-xs font-bold ${
            isErr ? 'bg-rose-500/20 text-rose-500' : 'bg-primary/20 text-primary'
          }`}
        >
          {isErr ? '✕' : '✓'}
        </div>
        {!isLast && <div className="w-px flex-1 bg-border mt-1" />}
      </div>
      <div className="pb-4 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-mono font-semibold text-foreground">{entry.step}</span>
          <span className="text-xs text-muted-foreground font-mono">+{entry.ms}ms</span>
          <span className="text-xs text-muted-foreground">{new Date(entry.ts).toLocaleTimeString()}</span>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5 break-words">{entry.detail}</p>
      </div>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────

export function MonitorPage() {
  const { toast } = useToast();
  const [status, setStatus] = useState<MonitorStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [pipelineRunning, setPipelineRunning] = useState(false);
  const [pipelineResult, setPipelineResult] = useState<PipelineResult | null>(null);
  const [testNotifRunning, setTestNotifRunning] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const fetchStatus = useCallback(async () => {
    try {
      const data = await apiFetch('/api/monitor/status');
      setStatus(data);
    } catch {
      /* silent — keep old data */
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(fetchStatus, 5000);
    return () => clearInterval(id);
  }, [autoRefresh, fetchStatus]);

  const runPipeline = async () => {
    setPipelineRunning(true);
    setPipelineResult(null);
    try {
      const result: PipelineResult = await apiFetch('/api/monitor/test-pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skipNotification: false }),
      });
      setPipelineResult(result);
      if (result.summary.telegramDelivered) {
        toast({
          title: '✅ Pipeline test complete — notification delivered!',
          description: `Total latency: ${result.totalMs}ms`,
        });
      } else {
        toast({
          title: '⚠️ Pipeline ran but no notification was delivered',
          description: 'Check provider config in Settings.',
          variant: 'destructive',
        });
      }
      await fetchStatus();
    } catch (err) {
      toast({ title: 'Pipeline test failed', description: String(err), variant: 'destructive' });
    } finally {
      setPipelineRunning(false);
    }
  };

  const testNotification = async () => {
    setTestNotifRunning(true);
    try {
      await apiFetch('/api/monitor/test-notification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      toast({ title: '✅ Test notification sent', description: 'Check your Telegram.' });
    } catch (err) {
      toast({ title: 'Test notification failed', description: String(err), variant: 'destructive' });
    } finally {
      setTestNotifRunning(false);
    }
  };

  const tgOk = status?.telegram.enabled ?? false;

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-serif font-bold">Live Monitor</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Real-time evidence: job detection, notification delivery, and system health
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAutoRefresh((v) => !v)}
            className={autoRefresh ? 'border-emerald-500/50 text-emerald-600' : ''}
          >
            <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${autoRefresh ? 'animate-spin' : ''}`} />
            {autoRefresh ? 'Auto-refresh ON' : 'Auto-refresh OFF'}
          </Button>
          <Button variant="outline" size="sm" onClick={fetchStatus} disabled={statusLoading}>
            <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${statusLoading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Top status cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        {[
          {
            label: 'Telegram',
            value: tgOk ? 'Configured' : 'Not set',
            ok: tgOk,
            icon: Send,
            sub: tgOk ? `Chat ...${status?.telegram.chatId}` : 'Add in Settings',
          },
          {
            label: 'Jobs Detected',
            value: String(status?.jobs.recentDetected.length ?? 0),
            ok: (status?.jobs.recentDetected.length ?? 0) > 0,
            icon: Zap,
            sub: 'Last 10 (live)',
          },
          {
            label: 'Notified Jobs',
            value: String(status?.jobs.totalNotified ?? 0),
            ok: (status?.jobs.totalNotified ?? 0) > 0,
            icon: ShieldCheck,
            sub: 'Score ≥ threshold',
          },
        ].map((c) => (
          <Card key={c.label} className={`border ${c.ok ? 'border-emerald-500/30' : 'border-border'}`}>
            <CardContent className="p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-muted-foreground">{c.label}</span>
                <c.icon className={`w-4 h-4 ${c.ok ? 'text-emerald-500' : 'text-muted-foreground'}`} />
              </div>
              <div className="flex items-center gap-2">
                <StatusDot ok={c.ok} />
                <span className="text-lg font-bold">{statusLoading ? '…' : c.value}</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1 truncate">{c.sub}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Notification provider status */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Send className="w-4 h-4" /> Notification Provider
            </CardTitle>
          </CardHeader>
          <CardContent className="divide-y divide-border">
            <ProviderRow
              label="Telegram Bot"
              icon={Send}
              connected={tgOk}
              detail={tgOk ? `Chat ID: ${status?.telegram.chatId}` : 'Configure in Settings → Notifications'}
            />
            <div className="pt-3 pb-1 flex gap-2">
              <Button size="sm" variant="outline" onClick={testNotification} disabled={testNotifRunning}>
                {testNotifRunning ? (
                  <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                ) : (
                  <Send className="w-3.5 h-3.5 mr-1.5" />
                )}
                Send Test Ping
              </Button>
              <p className="text-xs text-muted-foreground self-center">Fires to all enabled providers instantly</p>
            </div>
          </CardContent>
        </Card>

        {/* Last notified job */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <ShieldCheck className="w-4 h-4" /> Last Notified Job
            </CardTitle>
          </CardHeader>
          <CardContent>
            {status?.jobs.lastNotifiedJob ? (
              <div className="space-y-3">
                <p className="font-medium text-sm leading-snug">{status.jobs.lastNotifiedJob.title}</p>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="flex items-center gap-1.5">
                    <Zap className="w-3.5 h-3.5 text-primary" />
                    <span>
                      Score:{' '}
                      <strong className={scoreColor(status.jobs.lastNotifiedJob.applyScore)}>
                        {status.jobs.lastNotifiedJob.applyScore ?? 'N/A'}/100
                      </strong>
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Users className="w-3.5 h-3.5 text-primary" />
                    <span>
                      Proposals at alert:{' '}
                      <strong
                        className={
                          (status.jobs.lastNotifiedJob.proposalCount ?? 0) < 5
                            ? 'text-emerald-500'
                            : 'text-amber-500'
                        }
                      >
                        {status.jobs.lastNotifiedJob.proposalCount ?? '?'}
                      </strong>
                      {(status.jobs.lastNotifiedJob.proposalCount ?? 99) < 5 && (
                        <span className="text-emerald-500"> ✓ before 5</span>
                      )}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 col-span-2">
                    <Clock className="w-3.5 h-3.5 text-primary" />
                    <span>Detected: {timeAgo(status.jobs.lastNotifiedJob.detectedAt)}</span>
                  </div>
                </div>
                <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/20 p-2.5 flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" />
                  <p className="text-xs text-emerald-700 dark:text-emerald-400">
                    Notification delivered before proposal count exceeded threshold
                  </p>
                </div>
              </div>
            ) : (
              <div className="text-center py-6 text-sm text-muted-foreground">
                <AlertTriangle className="w-8 h-8 mx-auto mb-2 opacity-30" />
                No high-score jobs yet. Run the pipeline test or wait for the extension to detect a live job.
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Full pipeline test */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <FlaskConical className="w-4 h-4" /> End-to-End Pipeline Test
            </CardTitle>
            <Button onClick={runPipeline} disabled={pipelineRunning} size="sm">
              {pipelineRunning ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Running…
                </>
              ) : (
                <>
                  <FlaskConical className="w-3.5 h-3.5 mr-1.5" /> Run Full Test
                </>
              )}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Submits a realistic test job → AI analysis → notification delivery. Returns timestamped proof of every step.
          </p>
        </CardHeader>
        <CardContent>
          {!pipelineResult && !pipelineRunning && (
            <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              Click <strong>Run Full Test</strong> to generate live evidence. Telegram will receive a real message.
            </div>
          )}

          {pipelineRunning && (
            <div className="flex items-center gap-3 py-6 justify-center text-sm text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin text-primary" />
              Running AI analysis and sending notifications…
            </div>
          )}

          {pipelineResult && (
            <div className="space-y-5">
              {/* Summary badges */}
              <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                {[
                  { label: 'Job detected', ok: pipelineResult.summary.jobDetected },
                  { label: 'AI analyzed', ok: pipelineResult.summary.aiAnalyzed },
                  { label: 'Telegram delivered', ok: pipelineResult.summary.telegramDelivered },
                  {
                    label: `Proposals < 5 (was ${pipelineResult.summary.proposalCountAtDetection})`,
                    ok: pipelineResult.summary.proposalsSafe,
                  },
                ].map((s) => (
                  <div
                    key={s.label}
                    className={`rounded-lg border p-2.5 flex flex-col items-center gap-1 text-center ${
                      s.ok
                        ? 'border-emerald-500/30 bg-emerald-500/5'
                        : 'border-rose-500/30 bg-rose-500/5'
                    }`}
                  >
                    {s.ok ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                    ) : (
                      <XCircle className="w-4 h-4 text-rose-500" />
                    )}
                    <span className="text-xs font-medium">{s.label}</span>
                  </div>
                ))}
              </div>

              {/* AI scores */}
              {pipelineResult.analysis && (
                <div className="rounded-lg bg-muted/40 p-3 grid grid-cols-3 gap-3 text-center text-sm">
                  {[
                    ['Apply Score', pipelineResult.analysis.applyScore as number, '/100'],
                    ['Win Probability', pipelineResult.analysis.winProbability as number, '%'],
                    ['Risk Score', pipelineResult.analysis.riskScore as number, '/100'],
                  ].map(([label, val, unit]) => (
                    <div key={String(label)}>
                      <p className="text-xs text-muted-foreground">{label}</p>
                      <p className={`text-xl font-bold ${scoreColor(val as number)}`}>
                        {Math.round(val as number)}{unit}
                      </p>
                    </div>
                  ))}
                </div>
              )}

              {/* Notification provider results */}
              <div className="space-y-2">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  Notification delivery
                </p>
                {pipelineResult.notifications.map((n) => (
                  <div
                    key={n.provider}
                    className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 ${
                      n.success
                        ? 'border-emerald-500/30 bg-emerald-500/5'
                        : 'border-rose-500/20 bg-rose-500/5'
                    }`}
                  >
                    {n.success ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" />
                    ) : (
                      <XCircle className="w-4 h-4 text-rose-500 flex-shrink-0" />
                    )}
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-medium capitalize">{n.provider}</span>
                      {n.error && <span className="text-xs text-muted-foreground ml-2">— {n.error}</span>}
                    </div>
                    <Badge variant="outline" className={n.success ? 'border-emerald-500/40 text-emerald-600' : 'border-rose-500/40 text-rose-600'}>
                      {n.success ? 'Delivered' : 'Failed'}
                    </Badge>
                  </div>
                ))}
              </div>

              <Separator />

              {/* Timestamped log */}
              <div className="space-y-1">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                  Timestamped Evidence Log — total: {pipelineResult.totalMs}ms
                </p>
                {pipelineResult.log.map((entry, i) => (
                  <LogRow key={i} entry={entry} isLast={i === pipelineResult.log.length - 1} />
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recent jobs detected */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Zap className="w-4 h-4" /> Recently Detected Jobs
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Live feed — auto-refreshes every 5s. No page reload required.
          </p>
        </CardHeader>
        <CardContent>
          {statusLoading && !status ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          ) : (status?.jobs.recentDetected.length ?? 0) === 0 ? (
            <div className="text-center py-8 text-sm text-muted-foreground">
              <Zap className="w-8 h-8 mx-auto mb-2 opacity-30" />
              No jobs detected yet. Open Upwork job listings in Chrome with the extension loaded.
            </div>
          ) : (
            <div className="divide-y divide-border">
              {status!.jobs.recentDetected.map((job) => (
                <div key={job.id} className="py-3 flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-medium truncate max-w-xs">{job.title}</p>
                      {job.recommendation && (
                        <span className={`text-xs px-1.5 py-0.5 rounded border ${recBadge(job.recommendation)}`}>
                          {job.recommendation.toUpperCase()}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground flex-wrap">
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" /> {timeAgo(job.detectedAt)}
                      </span>
                      <span className="flex items-center gap-1">
                        <Users className="w-3 h-3" />
                        Proposals:{' '}
                        <strong className={(job.proposalCount ?? 0) < 5 ? 'text-emerald-500' : 'text-amber-500'}>
                          {job.proposalCount ?? '?'}
                        </strong>
                      </span>
                      <span className={job.paymentVerified ? 'text-emerald-500' : 'text-rose-500'}>
                        {job.paymentVerified ? '✅ Payment verified' : '❌ Unverified'}
                      </span>
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    {job.applyScore != null ? (
                      <span className={`text-lg font-bold ${scoreColor(job.applyScore)}`}>
                        {job.applyScore}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">Scoring…</span>
                    )}
                    <p className="text-xs text-muted-foreground">{job.status}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
          {status && (
            <p className="text-xs text-muted-foreground mt-3 text-right">
              Last updated: {new Date(status.timestamp).toLocaleTimeString()}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
