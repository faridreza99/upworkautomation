import {
  useGetDashboardStats,
  useGetJobStats,
  useGetRecentActivity,
  useListJobs,
} from '@workspace/api-client-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, AreaChart, Area, Legend, CartesianGrid,
} from 'recharts';
import { Link } from 'wouter';
import {
  Activity, Briefcase, CheckCircle, Clock, FileText,
  AlertCircle, TrendingUp, Target, ShieldAlert,
  RefreshCw, ExternalLink, MapPin, DollarSign, BarChart2,
} from 'lucide-react';
import { formatDistanceToNow, startOfWeek, subWeeks, format } from 'date-fns';
import { Skeleton } from '@/components/ui/skeleton';
import { motion, AnimatePresence } from 'framer-motion';
import { useState, useEffect, useMemo } from 'react';
import type { Job } from '@workspace/api-client-react';

const COLORS = ['hsl(var(--chart-1))', 'hsl(var(--chart-2))', 'hsl(var(--chart-3))', 'hsl(var(--chart-4))', 'hsl(var(--chart-5))'];

function scoreColor(score: number | null | undefined) {
  if (score == null) return 'text-muted-foreground';
  if (score >= 70) return 'text-emerald-400';
  if (score >= 50) return 'text-yellow-400';
  return 'text-rose-400';
}

function scoreBg(score: number | null | undefined) {
  if (score == null) return 'bg-muted/40 text-muted-foreground border-border';
  if (score >= 70) return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30';
  if (score >= 50) return 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30';
  return 'bg-rose-500/10 text-rose-400 border-rose-500/30';
}

function recoBadge(rec: Job['aiRecommendation']) {
  if (rec === 'apply') return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30';
  if (rec === 'skip') return 'bg-rose-500/15 text-rose-400 border-rose-500/30';
  if (rec === 'review') return 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30';
  return 'bg-muted/40 text-muted-foreground border-border';
}

function formatBudget(job: Job) {
  if (job.budgetType === 'hourly') {
    if (job.budgetMin && job.budgetMax) return `$${job.budgetMin}–$${job.budgetMax}/hr`;
    if (job.budgetMin) return `$${job.budgetMin}+/hr`;
    return 'Hourly';
  }
  if (job.budgetMin && job.budgetMax) return `$${job.budgetMin}–$${job.budgetMax}`;
  if (job.budgetMin) return `$${job.budgetMin}+`;
  if (job.budgetMax) return `Up to $${job.budgetMax}`;
  return 'Fixed';
}

function LiveJobFeed() {
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [prevIds, setPrevIds] = useState<Set<number>>(new Set());

  const { data: jobs, isLoading, isFetching, dataUpdatedAt } = useListJobs(
    { limit: 12 },
    { query: { refetchInterval: 30_000 } as any }
  );

  useEffect(() => {
    if (dataUpdatedAt) setLastUpdated(new Date(dataUpdatedAt));
  }, [dataUpdatedAt]);

  useEffect(() => {
    if (jobs) setPrevIds(new Set(jobs.map((j) => j.id)));
  }, [jobs]);

  const isNew = (id: number) => !prevIds.has(id);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              Live Job Feed
              {isFetching ? (
                <RefreshCw className="w-3.5 h-3.5 text-muted-foreground animate-spin" />
              ) : (
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                </span>
              )}
            </CardTitle>
            <CardDescription className="mt-0.5">
              Most recent jobs · auto-refreshes every 30 s
            </CardDescription>
          </div>
          {lastUpdated && (
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {formatDistanceToNow(lastUpdated, { addSuffix: true })}
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <div className="space-y-0 divide-y divide-border">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="px-6 py-4 flex items-center gap-4">
                <Skeleton className="h-9 w-9 rounded-lg flex-shrink-0" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-3 w-1/3" />
                </div>
                <Skeleton className="h-6 w-16 rounded-full" />
              </div>
            ))}
          </div>
        ) : !jobs?.length ? (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-3">
            <Briefcase className="w-10 h-10 opacity-30" />
            <p className="text-sm">No jobs yet — submit one or enable the RSS scanner.</p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            <AnimatePresence initial={false}>
              {jobs.map((job, i) => (
                <motion.div
                  key={job.id}
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.25, delay: isNew(job.id) ? 0 : i * 0.03 }}
                  className="group px-6 py-3.5 flex items-center gap-4 hover:bg-muted/20 transition-colors"
                >
                  {/* Score badge */}
                  <div className={`flex-shrink-0 w-11 h-11 rounded-xl border flex flex-col items-center justify-center font-mono font-bold text-sm ${scoreBg(job.applyScore)}`}>
                    {job.applyScore != null ? job.applyScore : '—'}
                    {job.applyScore != null && (
                      <span className="text-[9px] font-sans font-normal opacity-70 -mt-0.5">score</span>
                    )}
                  </div>

                  {/* Main content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Link href={`/jobs/${job.id}`} className="font-medium text-sm truncate max-w-sm hover:text-primary transition-colors">
                        {job.title}
                      </Link>
                      {job.aiRecommendation && (
                        <Badge variant="outline" className={`text-[10px] px-1.5 py-0 h-4 uppercase tracking-wide ${recoBadge(job.aiRecommendation)}`}>
                          {job.aiRecommendation}
                        </Badge>
                      )}
                      {job.status === 'analyzing' && (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 bg-blue-500/10 text-blue-400 border-blue-500/30">
                          analyzing…
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground flex-wrap">
                      <span className="flex items-center gap-1">
                        <DollarSign className="w-3 h-3" />{formatBudget(job)}
                      </span>
                      {job.clientCountry && (
                        <span className="flex items-center gap-1">
                          <MapPin className="w-3 h-3" />{job.clientCountry}
                        </span>
                      )}
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {formatDistanceToNow(new Date(job.createdAt), { addSuffix: true })}
                      </span>
                      {job.winProbability != null && (
                        <span className={`flex items-center gap-1 font-mono ${scoreColor(job.winProbability)}`}>
                          <TrendingUp className="w-3 h-3" />{job.winProbability}% win
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    {job.jobUrl && (
                      <a
                        href={job.jobUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                        title="Open on Upwork"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    )}
                    <Link
                      href={`/jobs/${job.id}`}
                      className="px-3 py-1 rounded-md text-xs font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                    >
                      View
                    </Link>
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}

        {jobs && jobs.length > 0 && (
          <div className="border-t border-border px-6 py-3 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Showing {jobs.length} most recent jobs</span>
            <Link href="/jobs" className="text-xs text-primary hover:underline font-medium">
              View all jobs →
            </Link>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const TOOLTIP_STYLE = {
  backgroundColor: 'hsl(var(--card))',
  border: '1px solid hsl(var(--border))',
  borderRadius: '8px',
  color: 'hsl(var(--foreground))',
  fontSize: '12px',
};

function AnalyticsTab({ jobs }: { jobs: Job[] }) {
  const analytics = useMemo(() => {
    // Pipeline funnel
    const total = jobs.length;
    const analyzed = jobs.filter(j => j.applyScore != null).length;
    const actioned = jobs.filter(j => ['approved', 'applied'].includes(j.status)).length;
    const applied = jobs.filter(j => j.status === 'applied').length;
    const funnel = [
      { stage: 'Detected', count: total },
      { stage: 'Analyzed', count: analyzed },
      { stage: 'Approved', count: actioned },
      { stage: 'Applied', count: applied },
    ];

    // Weekly volume — last 8 weeks stacked by outcome
    const now = new Date();
    const weeklyData = Array.from({ length: 8 }, (_, i) => {
      const weekStart = startOfWeek(subWeeks(now, 7 - i));
      const weekEnd = new Date(weekStart.getTime() + 7 * 864e5);
      const wj = jobs.filter(j => { const d = new Date(j.createdAt); return d >= weekStart && d < weekEnd; });
      return {
        week: format(weekStart, 'MMM d'),
        Applied: wj.filter(j => j.status === 'applied').length,
        Approved: wj.filter(j => j.status === 'approved').length,
        Skipped: wj.filter(j => j.status === 'skipped').length,
        Other: wj.filter(j => !['applied', 'approved', 'skipped'].includes(j.status)).length,
      };
    });

    // Score bracket conversion rate
    const brackets = [
      { range: '0–20', min: 0, max: 20 },
      { range: '20–40', min: 20, max: 40 },
      { range: '40–60', min: 40, max: 60 },
      { range: '60–80', min: 60, max: 80 },
      { range: '80–100', min: 80, max: 101 },
    ];
    const scoreBrackets = brackets.map(({ range, min, max }) => {
      const inRange = jobs.filter(j => j.applyScore != null && j.applyScore >= min && j.applyScore < max);
      const actionedCount = inRange.filter(j => ['applied', 'approved'].includes(j.status)).length;
      return {
        range,
        Jobs: inRange.length,
        'Actioned %': inRange.length > 0 ? Math.round((actionedCount / inRange.length) * 100) : 0,
      };
    });

    // Top 8 skills in applied + approved jobs
    const skillCounts: Record<string, number> = {};
    jobs.filter(j => ['applied', 'approved'].includes(j.status)).forEach(j => {
      (j.skills ?? []).forEach(s => { skillCounts[s] = (skillCounts[s] ?? 0) + 1; });
    });
    const topSkills = Object.entries(skillCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([skill, count]) => ({ skill, count }));

    // AI recommendation accuracy
    const applyRec = jobs.filter(j => j.aiRecommendation === 'apply');
    const applyActioned = applyRec.filter(j => ['applied', 'approved'].includes(j.status)).length;
    const skipRec = jobs.filter(j => j.aiRecommendation === 'skip');
    const skipSkipped = skipRec.filter(j => j.status === 'skipped').length;
    const reviewRec = jobs.filter(j => j.aiRecommendation === 'review');
    const reviewActioned = reviewRec.filter(j => ['applied', 'approved', 'skipped'].includes(j.status)).length;
    const aiAccuracy = [
      { name: '"Apply" actioned', pct: applyRec.length ? Math.round((applyActioned / applyRec.length) * 100) : 0, n: applyRec.length, color: '#10b981' },
      { name: '"Skip" skipped', pct: skipRec.length ? Math.round((skipSkipped / skipRec.length) * 100) : 0, n: skipRec.length, color: '#f43f5e' },
      { name: '"Review" resolved', pct: reviewRec.length ? Math.round((reviewActioned / reviewRec.length) * 100) : 0, n: reviewRec.length, color: '#f59e0b' },
    ];

    // Avg win probability by outcome
    const avgWin = (subset: Job[]) => {
      const withWin = subset.filter(j => j.winProbability != null);
      return withWin.length ? Math.round(withWin.reduce((s, j) => s + (j.winProbability ?? 0), 0) / withWin.length) : null;
    };
    const winByOutcome = [
      { outcome: 'Applied', avg: avgWin(jobs.filter(j => j.status === 'applied')), color: '#10b981' },
      { outcome: 'Approved', avg: avgWin(jobs.filter(j => j.status === 'approved')), color: '#3b82f6' },
      { outcome: 'Skipped', avg: avgWin(jobs.filter(j => j.status === 'skipped')), color: '#f43f5e' },
    ].filter(x => x.avg !== null);

    return { funnel, weeklyData, scoreBrackets, topSkills, aiAccuracy, winByOutcome };
  }, [jobs]);

  const hasData = jobs.length > 0;

  return (
    <div className="space-y-6">
      {/* Conversion funnel */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {analytics.funnel.map((step, i) => {
          const prev = i > 0 ? analytics.funnel[i - 1].count : step.count;
          const pct = prev > 0 ? Math.round((step.count / analytics.funnel[0].count) * 100) : 0;
          return (
            <Card key={step.stage}>
              <CardContent className="pt-5 pb-4">
                <div className="text-xs text-muted-foreground mb-1 font-medium uppercase tracking-wider">{step.stage}</div>
                <div className="text-3xl font-bold font-mono mb-1">{step.count}</div>
                <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
                  <motion.div
                    className="h-full rounded-full bg-primary"
                    initial={{ width: 0 }}
                    animate={{ width: `${pct}%` }}
                    transition={{ duration: 0.8, delay: i * 0.1 }}
                  />
                </div>
                <div className="text-xs text-muted-foreground mt-1">{pct}% of total</div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Weekly volume */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Weekly Job Volume</CardTitle>
            <CardDescription>Jobs detected per week broken down by outcome</CardDescription>
          </CardHeader>
          <CardContent>
            {!hasData ? (
              <div className="h-[220px] flex items-center justify-center text-muted-foreground text-sm">No data yet</div>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <AreaChart data={analytics.weeklyData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="week" tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} />
                  <YAxis tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} allowDecimals={false} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Area type="monotone" dataKey="Applied" stackId="1" stroke="#10b981" fill="#10b981" fillOpacity={0.7} />
                  <Area type="monotone" dataKey="Approved" stackId="1" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.7} />
                  <Area type="monotone" dataKey="Skipped" stackId="1" stroke="#f43f5e" fill="#f43f5e" fillOpacity={0.5} />
                  <Area type="monotone" dataKey="Other" stackId="1" stroke="hsl(var(--muted-foreground))" fill="hsl(var(--muted))" fillOpacity={0.4} />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Score bracket conversion */}
        <Card>
          <CardHeader>
            <CardTitle>Score → Conversion Rate</CardTitle>
            <CardDescription>% of jobs in each score bracket actioned (approved/applied)</CardDescription>
          </CardHeader>
          <CardContent>
            {!hasData ? (
              <div className="h-[220px] flex items-center justify-center text-muted-foreground text-sm">No data yet</div>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={analytics.scoreBrackets} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="range" tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} />
                  <YAxis tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} unit="%" domain={[0, 100]} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => [`${v}%`, 'Actioned']} />
                  <Bar dataKey="Actioned %" radius={[4, 4, 0, 0]}>
                    {analytics.scoreBrackets.map((_, i) => (
                      <Cell key={i} fill={i < 2 ? '#f43f5e' : i < 3 ? '#f59e0b' : '#10b981'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Top skills in actioned jobs */}
        <Card>
          <CardHeader>
            <CardTitle>Top Skills in Applied Jobs</CardTitle>
            <CardDescription>Most common skills among approved & applied postings</CardDescription>
          </CardHeader>
          <CardContent>
            {analytics.topSkills.length === 0 ? (
              <div className="h-[220px] flex items-center justify-center text-muted-foreground text-sm">No applied jobs yet</div>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={analytics.topSkills} layout="vertical" margin={{ top: 0, right: 16, left: 60, bottom: 0 }}>
                  <XAxis type="number" tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} allowDecimals={false} />
                  <YAxis type="category" dataKey="skill" tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} width={56} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} />
                  <Bar dataKey="count" radius={[0, 4, 4, 0]} fill="hsl(var(--chart-1))" />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* AI recommendation accuracy */}
        <Card>
          <CardHeader>
            <CardTitle>AI Recommendation Accuracy</CardTitle>
            <CardDescription>How often AI recommendations were acted on</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5 pt-2">
            {analytics.aiAccuracy.map((item) => (
              <div key={item.name}>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-sm font-medium text-muted-foreground">{item.name}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">({item.n} jobs)</span>
                    <span className="text-sm font-bold font-mono" style={{ color: item.color }}>{item.pct}%</span>
                  </div>
                </div>
                <div className="h-2 bg-secondary rounded-full overflow-hidden">
                  <motion.div
                    className="h-full rounded-full"
                    style={{ backgroundColor: item.color }}
                    initial={{ width: 0 }}
                    animate={{ width: `${item.pct}%` }}
                    transition={{ duration: 0.8, delay: 0.2 }}
                  />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Win probability by outcome */}
        <Card>
          <CardHeader>
            <CardTitle>Avg Win Probability by Outcome</CardTitle>
            <CardDescription>AI-predicted win % compared across final job statuses</CardDescription>
          </CardHeader>
          <CardContent>
            {analytics.winByOutcome.length === 0 ? (
              <div className="h-[180px] flex items-center justify-center text-muted-foreground text-sm">No scored jobs yet</div>
            ) : (
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={analytics.winByOutcome} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="outcome" tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))' }} />
                  <YAxis tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} unit="%" domain={[0, 100]} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => [`${v}%`, 'Avg Win Prob']} />
                  <Bar dataKey="avg" radius={[4, 4, 0, 0]}>
                    {analytics.winByOutcome.map((item, i) => (
                      <Cell key={i} fill={item.color} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export function Dashboard() {
  const { data: stats, isLoading: statsLoading } = useGetDashboardStats();
  const { data: jobStats, isLoading: jobStatsLoading } = useGetJobStats();
  const { data: activity, isLoading: activityLoading } = useGetRecentActivity();
  const { data: allJobs = [] } = useListJobs(undefined, { query: { refetchInterval: 60_000 } as any });

  return (
    <div className="p-8 space-y-8 max-w-7xl mx-auto">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold font-serif tracking-tight">Command Center</h1>
          <p className="text-muted-foreground mt-1">Live market overview and automation performance.</p>
        </div>
        {stats?.pendingApproval ? (
          <Link href="/jobs?status=approved" className="inline-flex items-center gap-2 px-4 py-2 bg-primary/10 text-primary hover:bg-primary/20 transition-colors rounded-full font-medium text-sm">
            <AlertCircle className="w-4 h-4" />
            {stats.pendingApproval} Pending Approval
          </Link>
        ) : null}
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview" className="flex items-center gap-1.5">
            <Activity className="w-3.5 h-3.5" /> Overview
          </TabsTrigger>
          <TabsTrigger value="analytics" className="flex items-center gap-1.5">
            <BarChart2 className="w-3.5 h-3.5" /> Analytics
          </TabsTrigger>
        </TabsList>

        <TabsContent value="analytics" className="mt-6">
          <AnalyticsTab jobs={allJobs} />
        </TabsContent>

        <TabsContent value="overview" className="mt-6 space-y-8">

      {/* Stat cards */}
      {statsLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-32 w-full rounded-xl" />)}
        </div>
      ) : stats ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Today's Jobs</CardTitle>
              <Briefcase className="w-4 h-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold font-mono">{stats.todayJobs}</div>
              <p className="text-xs text-muted-foreground mt-1">Total {stats.totalJobs} monitored</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Applied</CardTitle>
              <FileText className="w-4 h-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold font-mono">{stats.appliedJobs}</div>
              <p className="text-xs text-muted-foreground mt-1">Success rate: {(stats.successRate * 100).toFixed(1)}%</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Avg Apply Score</CardTitle>
              <Target className="w-4 h-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold font-mono text-emerald-500">{stats.avgApplyScore.toFixed(1)}</div>
              <p className="text-xs text-muted-foreground mt-1">Out of 100</p>
            </CardContent>
          </Card>
          <Card className={stats.unreadNotifications ? "border-primary/50 bg-primary/5" : ""}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Notifications</CardTitle>
              <Activity className="w-4 h-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold font-mono">{stats.unreadNotifications || 0}</div>
              <p className="text-xs text-muted-foreground mt-1">Unread messages</p>
            </CardContent>
          </Card>
        </div>
      ) : null}

      {/* Live job feed */}
      <LiveJobFeed />

      {/* Charts + Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-8">
          <Card>
            <CardHeader>
              <CardTitle>Score Distribution</CardTitle>
              <CardDescription>AI analysis scores across all monitored jobs</CardDescription>
            </CardHeader>
            <CardContent>
              {jobStatsLoading ? (
                <Skeleton className="h-[300px] w-full" />
              ) : jobStats?.scoreDistribution ? (
                <div className="h-[300px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={jobStats.scoreDistribution}>
                      <XAxis dataKey="range" fontSize={12} tickLine={false} axisLine={false} />
                      <YAxis fontSize={12} tickLine={false} axisLine={false} />
                      <Tooltip
                        cursor={{ fill: 'rgba(255,255,255,0.05)' }}
                        contentStyle={{ backgroundColor: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: '8px' }}
                      />
                      <Bar dataKey="count" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="h-[300px] flex items-center justify-center text-muted-foreground">No data available</div>
              )}
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle>Status Breakdown</CardTitle>
              </CardHeader>
              <CardContent className="flex justify-center">
                {jobStatsLoading ? (
                  <Skeleton className="h-[200px] w-full" />
                ) : jobStats?.byStatus ? (
                  <div className="h-[200px] w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={jobStats.byStatus}
                          dataKey="count"
                          nameKey="status"
                          cx="50%"
                          cy="50%"
                          innerRadius={60}
                          outerRadius={80}
                          paddingAngle={5}
                        >
                          {jobStats.byStatus.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                          ))}
                        </Pie>
                        <Tooltip contentStyle={{ backgroundColor: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: '8px' }} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                ) : null}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Average Metrics</CardTitle>
              </CardHeader>
              <CardContent>
                {jobStatsLoading ? (
                  <Skeleton className="h-[200px] w-full" />
                ) : jobStats?.avgScores ? (
                  <div className="space-y-6 mt-4">
                    <div>
                      <div className="flex justify-between mb-2">
                        <span className="text-sm font-medium text-muted-foreground flex items-center gap-2"><Target className="w-4 h-4"/> Apply Score</span>
                        <span className="text-sm font-bold font-mono">{jobStats.avgScores.applyScore.toFixed(1)}</span>
                      </div>
                      <div className="h-2 bg-secondary rounded-full overflow-hidden">
                        <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${jobStats.avgScores.applyScore}%` }} />
                      </div>
                    </div>
                    <div>
                      <div className="flex justify-between mb-2">
                        <span className="text-sm font-medium text-muted-foreground flex items-center gap-2"><ShieldAlert className="w-4 h-4"/> Risk Score</span>
                        <span className="text-sm font-bold font-mono">{jobStats.avgScores.riskScore.toFixed(1)}</span>
                      </div>
                      <div className="h-2 bg-secondary rounded-full overflow-hidden">
                        <div className="h-full bg-rose-500 rounded-full" style={{ width: `${jobStats.avgScores.riskScore}%` }} />
                      </div>
                    </div>
                    <div>
                      <div className="flex justify-between mb-2">
                        <span className="text-sm font-medium text-muted-foreground flex items-center gap-2"><TrendingUp className="w-4 h-4"/> Win Probability</span>
                        <span className="text-sm font-bold font-mono">{jobStats.avgScores.winProbability.toFixed(1)}</span>
                      </div>
                      <div className="h-2 bg-secondary rounded-full overflow-hidden">
                        <div className="h-full bg-blue-500 rounded-full" style={{ width: `${jobStats.avgScores.winProbability}%` }} />
                      </div>
                    </div>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          </div>
        </div>

        <div className="lg:col-span-1">
          <Card className="h-full">
            <CardHeader>
              <CardTitle>Recent Activity</CardTitle>
              <CardDescription>Latest automated actions</CardDescription>
            </CardHeader>
            <CardContent>
              {activityLoading ? (
                <div className="space-y-4">
                  {[1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-16 w-full" />)}
                </div>
              ) : activity?.length ? (
                <div className="space-y-6 relative before:absolute before:inset-0 before:ml-5 before:-translate-x-px md:before:mx-auto md:before:translate-x-0 before:h-full before:w-0.5 before:bg-gradient-to-b before:from-transparent before:via-border before:to-transparent">
                  {activity.map((item) => (
                    <div key={item.id} className="relative flex items-center justify-between md:justify-normal md:odd:flex-row-reverse group is-active">
                      <div className="flex items-center justify-center w-10 h-10 rounded-full border border-border bg-card shrink-0 md:order-1 md:group-odd:-translate-x-1/2 md:group-even:translate-x-1/2 shadow-sm relative z-10">
                        {item.type === 'job_analyzed' ? <Activity className="w-4 h-4 text-blue-500" /> :
                         item.type === 'proposal_generated' ? <FileText className="w-4 h-4 text-emerald-500" /> :
                         <CheckCircle className="w-4 h-4 text-muted-foreground" />}
                      </div>
                      <div className="w-[calc(100%-4rem)] md:w-[calc(50%-2.5rem)] p-4 rounded-xl border border-border bg-card shadow-sm">
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-bold text-sm">{item.type.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase())}</span>
                          <span className="text-xs text-muted-foreground flex items-center gap-1"><Clock className="w-3 h-3"/> {formatDistanceToNow(new Date(item.createdAt), { addSuffix: true })}</span>
                        </div>
                        <p className="text-sm text-muted-foreground line-clamp-2">{item.message}</p>
                        {item.jobTitle && item.jobId && (
                          <Link href={`/jobs/${item.jobId}`} className="block mt-2 text-xs font-medium text-primary hover:underline truncate">
                            {item.jobTitle}
                          </Link>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center p-8 text-muted-foreground">No recent activity</div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
