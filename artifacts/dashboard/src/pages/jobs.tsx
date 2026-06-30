import { useListJobs, useGenerateProposal, useUpdateJob, useAnalyzeJob, getListJobsQueryKey } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Link } from 'wouter';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDistanceToNow } from 'date-fns';
import { DollarSign, Globe, Shield, Clock, Plus, Upload, Search, X, SlidersHorizontal, ArrowUpDown, Zap, CheckCheck, Loader2, Square, CheckSquare, SkipForward, RefreshCw, Trash2 } from 'lucide-react';
import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { SubmitJobDialog } from '@/components/submit-job-dialog';
import { BulkImportDialog } from '@/components/bulk-import-dialog';
import type { Job } from '@workspace/api-client-react';
import { cn } from '@/lib/utils';

type RecFilter = 'all' | 'apply' | 'skip' | 'review' | 'none';
type SortOption = 'date_desc' | 'date_asc' | 'score_desc' | 'score_asc' | 'win_desc' | 'risk_asc';

const REC_OPTIONS: { value: RecFilter; label: string; cls: string; activeCls: string }[] = [
  { value: 'all',    label: 'All',    cls: 'border-border text-muted-foreground hover:bg-muted/50',                                  activeCls: 'bg-muted text-foreground border-border' },
  { value: 'apply',  label: '✓ Apply',  cls: 'border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10',  activeCls: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40' },
  { value: 'review', label: '~ Review', cls: 'border-yellow-500/30 text-yellow-400 hover:bg-yellow-500/10',    activeCls: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/40' },
  { value: 'skip',   label: '✕ Skip',   cls: 'border-rose-500/30 text-rose-400 hover:bg-rose-500/10',          activeCls: 'bg-rose-500/20 text-rose-400 border-rose-500/40' },
  { value: 'none',   label: 'Unscored', cls: 'border-border text-muted-foreground hover:bg-muted/50',           activeCls: 'bg-muted text-foreground border-border' },
];

function scoreColor(score: number | null | undefined) {
  if (score == null) return 'text-muted-foreground';
  if (score >= 70) return 'text-emerald-500';
  if (score >= 50) return 'text-yellow-500';
  return 'text-rose-500';
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

export function Jobs() {
  const [submitOpen, setSubmitOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);

  // Bulk selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isBulkPending, setIsBulkPending] = useState(false);

  const queryClient = useQueryClient();
  const bulkGenerate = useGenerateProposal();
  const bulkUpdate = useUpdateJob();
  const bulkAnalyze = useAnalyzeJob();

  function toggleSelect(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function clearSelection() { setSelectedIds(new Set()); }

  async function handleBulkQuickApply(selected: Job[]) {
    const eligible = selected.filter(j => j.applyScore != null && j.status !== 'applied' && j.status !== 'rejected' && j.status !== 'skipped');
    if (!eligible.length) { toast.error('No eligible jobs to apply to.'); return; }
    setIsBulkPending(true);
    const results = await Promise.allSettled(
      eligible.map(j =>
        bulkGenerate.mutateAsync({ id: j.id, data: {} })
          .then(() => bulkUpdate.mutateAsync({ id: j.id, data: { status: 'approved' } }))
      )
    );
    const ok = results.filter(r => r.status === 'fulfilled').length;
    const fail = results.length - ok;
    queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
    toast.success(`Quick Apply complete: ${ok} approved${fail ? `, ${fail} failed` : ''}.`);
    clearSelection();
    setIsBulkPending(false);
  }

  async function handleBulkSkip(selected: Job[]) {
    const eligible = selected.filter(j => j.status !== 'applied' && j.status !== 'rejected' && j.status !== 'skipped');
    if (!eligible.length) { toast.error('No eligible jobs to skip.'); return; }
    setIsBulkPending(true);
    const results = await Promise.allSettled(
      eligible.map(j => bulkUpdate.mutateAsync({ id: j.id, data: { status: 'skipped' } }))
    );
    const ok = results.filter(r => r.status === 'fulfilled').length;
    queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
    toast.success(`Skipped ${ok} job${ok !== 1 ? 's' : ''}.`);
    clearSelection();
    setIsBulkPending(false);
  }

  async function handleBulkReanalyze(selected: Job[]) {
    setIsBulkPending(true);
    const results = await Promise.allSettled(
      selected.map(j => bulkAnalyze.mutateAsync({ id: j.id }))
    );
    const ok = results.filter(r => r.status === 'fulfilled').length;
    queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
    toast.success(`Re-analyzing ${ok} job${ok !== 1 ? 's' : ''}.`);
    clearSelection();
    setIsBulkPending(false);
  }

  // Filter state
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [recFilter, setRecFilter] = useState<RecFilter>('all');
  const [countryFilter, setCountryFilter] = useState('all');
  const [minScore, setMinScore] = useState('');
  const [maxScore, setMaxScore] = useState('');
  const [sortBy, setSortBy] = useState<SortOption>('date_desc');

  const searchRef = useRef<HTMLInputElement>(null);

  const REC_KEYS = ['1', '2', '3', '4', '5'] as const;
  const REC_KEY_MAP: Record<string, RecFilter> = {
    '1': 'all', '2': 'apply', '3': 'review', '4': 'skip', '5': 'none',
  };

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement).isContentEditable;

    // Esc — clear all filters (works even while typing in search)
    if (e.key === 'Escape') {
      if (isTyping && document.activeElement === searchRef.current) {
        searchRef.current?.blur();
        return;
      }
      setSearch('');
      setStatusFilter('all');
      setRecFilter('all');
      setCountryFilter('all');
      setMinScore('');
      setMaxScore('');
      setSortBy('date_desc');
      return;
    }

    if (isTyping) return;

    // S — focus search
    if (e.key === 's' || e.key === 'S') {
      e.preventDefault();
      searchRef.current?.focus();
      return;
    }

    // 1–5 — toggle recommendation pills
    if (REC_KEYS.includes(e.key as any)) {
      setRecFilter(REC_KEY_MAP[e.key]);
    }
  }, []);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Always fetch all jobs — filter client-side for instant UX
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: allJobs, isLoading } = useListJobs(undefined, {
    query: { refetchInterval: 30_000 } as any,
  });

  // Unique countries from fetched data
  const countries = useMemo(() => {
    if (!allJobs) return [];
    const set = new Set<string>();
    allJobs.forEach((j) => { if (j.clientCountry) set.add(j.clientCountry); });
    return Array.from(set).sort();
  }, [allJobs]);

  // Client-side filtered + sorted jobs
  const jobs = useMemo(() => {
    if (!allJobs) return [];
    const q = search.toLowerCase().trim();
    const minS = minScore !== '' ? Number(minScore) : null;
    const maxS = maxScore !== '' ? Number(maxScore) : null;

    const filtered = allJobs.filter((job) => {
      if (q && !job.title.toLowerCase().includes(q) && !job.description.toLowerCase().includes(q)) return false;
      if (statusFilter !== 'all' && job.status !== statusFilter) return false;
      if (recFilter === 'none' && job.aiRecommendation != null) return false;
      if (recFilter !== 'all' && recFilter !== 'none' && job.aiRecommendation !== recFilter) return false;
      if (countryFilter !== 'all' && job.clientCountry !== countryFilter) return false;
      if (minS !== null && (job.applyScore == null || job.applyScore < minS)) return false;
      if (maxS !== null && (job.applyScore == null || job.applyScore > maxS)) return false;
      return true;
    });

    return [...filtered].sort((a, b) => {
      switch (sortBy) {
        case 'date_desc': return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        case 'date_asc':  return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        case 'score_desc': return (b.applyScore ?? -1) - (a.applyScore ?? -1);
        case 'score_asc':  return (a.applyScore ?? 101) - (b.applyScore ?? 101);
        case 'win_desc':   return (b.winProbability ?? -1) - (a.winProbability ?? -1);
        case 'risk_asc':   return (a.riskScore ?? 101) - (b.riskScore ?? 101);
        default: return 0;
      }
    });
  }, [allJobs, search, statusFilter, recFilter, countryFilter, minScore, maxScore, sortBy]);

  const hasActiveFilters = search || statusFilter !== 'all' || recFilter !== 'all' || countryFilter !== 'all' || minScore || maxScore || sortBy !== 'date_desc';

  function clearFilters() {
    setSearch('');
    setStatusFilter('all');
    setRecFilter('all');
    setCountryFilter('all');
    setMinScore('');
    setMaxScore('');
    setSortBy('date_desc');
  }

  return (
    <div className="p-8 space-y-6 max-w-7xl mx-auto">
      <SubmitJobDialog open={submitOpen} onOpenChange={setSubmitOpen} />
      <BulkImportDialog open={bulkOpen} onOpenChange={setBulkOpen} />

      {/* Header */}
      <div className="flex flex-col md:flex-row items-start md:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold font-serif tracking-tight">Jobs</h1>
          <p className="text-muted-foreground mt-1">Market opportunities and AI analysis.</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button variant="outline" onClick={() => setBulkOpen(true)} className="gap-2">
            <Upload className="w-4 h-4" /> Bulk Import
          </Button>
          <Button onClick={() => setSubmitOpen(true)} className="gap-2">
            <Plus className="w-4 h-4" /> Submit Job
          </Button>
        </div>
      </div>

      {/* Filter bar */}
      <div className="rounded-xl border border-border bg-card/60 p-4 space-y-3">
        {/* Row 1: search + status + country */}
        <div className="flex flex-wrap gap-3 items-center">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search title or description…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 pr-8"
              ref={searchRef}
            />
            {search && (
              <button onClick={() => setSearch('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[150px]">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="new">New</SelectItem>
              <SelectItem value="analyzing">Analyzing</SelectItem>
              <SelectItem value="approved">Approved</SelectItem>
              <SelectItem value="skipped">Skipped</SelectItem>
              <SelectItem value="applied">Applied</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
            </SelectContent>
          </Select>

          <Select value={countryFilter} onValueChange={setCountryFilter}>
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="Country" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Countries</SelectItem>
              {countries.map((c) => (
                <SelectItem key={c} value={c}>{c}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Score range */}
          <div className="flex items-center gap-1.5">
            <Input
              type="number"
              placeholder="Min score"
              value={minScore}
              onChange={(e) => setMinScore(e.target.value)}
              className="w-24 text-center"
              min={0}
              max={100}
            />
            <span className="text-muted-foreground text-sm">–</span>
            <Input
              type="number"
              placeholder="Max score"
              value={maxScore}
              onChange={(e) => setMaxScore(e.target.value)}
              className="w-24 text-center"
              min={0}
              max={100}
            />
          </div>

          <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortOption)}>
            <SelectTrigger className="w-[190px] gap-1">
              <ArrowUpDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <SelectValue placeholder="Sort by" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="date_desc">Newest first</SelectItem>
              <SelectItem value="date_asc">Oldest first</SelectItem>
              <SelectItem value="score_desc">Score: High → Low</SelectItem>
              <SelectItem value="score_asc">Score: Low → High</SelectItem>
              <SelectItem value="win_desc">Win Probability ↓</SelectItem>
              <SelectItem value="risk_asc">Lowest Risk first</SelectItem>
            </SelectContent>
          </Select>

          {hasActiveFilters && (
            <Button variant="ghost" size="sm" onClick={clearFilters} className="gap-1.5 text-muted-foreground hover:text-foreground">
              <X className="w-3.5 h-3.5" /> Clear
            </Button>
          )}
        </div>

        {/* Row 2: Recommendation toggle pills */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-muted-foreground flex items-center gap-1 mr-1">
            <SlidersHorizontal className="w-3.5 h-3.5" /> AI says:
          </span>
          {REC_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setRecFilter(opt.value)}
              className={cn(
                'px-3 py-1 rounded-full text-xs font-medium border transition-colors',
                recFilter === opt.value ? opt.activeCls : opt.cls
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Results count + select all + keyboard hints */}
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-3">
            <div className="text-xs text-muted-foreground">
              {isLoading ? 'Loading…' : (
                <span>
                  Showing <span className="font-medium text-foreground">{jobs.length}</span>
                  {allJobs && jobs.length !== allJobs.length && (
                    <span> of {allJobs.length}</span>
                  )} jobs
                  {hasActiveFilters && (
                    <span className="text-primary"> · filters active</span>
                  )}
                </span>
              )}
            </div>
            {jobs.length > 0 && !isLoading && (
              <button
                onClick={() => {
                  const allSelected = jobs.every(j => selectedIds.has(String(j.id)));
                  if (allSelected) clearSelection();
                  else setSelectedIds(new Set(jobs.map(j => String(j.id))));
                }}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                {jobs.every(j => selectedIds.has(String(j.id)))
                  ? <><CheckSquare className="w-3.5 h-3.5" /> Deselect all</>
                  : <><Square className="w-3.5 h-3.5" /> Select all</>
                }
              </button>
            )}
          </div>
          <div className="flex items-center gap-3 text-[11px] text-muted-foreground/60 select-none">
            <span><kbd className="px-1 py-0.5 rounded border border-border/60 bg-muted/40 font-mono text-[10px]">S</kbd> search</span>
            <span><kbd className="px-1 py-0.5 rounded border border-border/60 bg-muted/40 font-mono text-[10px]">1</kbd>–<kbd className="px-1 py-0.5 rounded border border-border/60 bg-muted/40 font-mono text-[10px]">5</kbd> filter</span>
            <span><kbd className="px-1 py-0.5 rounded border border-border/60 bg-muted/40 font-mono text-[10px]">Esc</kbd> clear</span>
          </div>
        </div>
      </div>

      {/* Job list */}
      <div className="grid gap-4 pb-24">
        {isLoading ? (
          Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-32 w-full rounded-xl" />
          ))
        ) : jobs.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-16 border rounded-xl bg-card/50 text-muted-foreground gap-3">
            <Search className="w-10 h-10 opacity-30" />
            <p className="text-sm">No jobs match your current filters.</p>
            {hasActiveFilters && (
              <Button variant="outline" size="sm" onClick={clearFilters}>Clear filters</Button>
            )}
          </div>
        ) : (
          jobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              search={search}
              isSelected={selectedIds.has(String(job.id))}
              anySelected={selectedIds.size > 0}
              onToggleSelect={() => toggleSelect(String(job.id))}
            />
          ))
        )}
      </div>

      {/* Bulk action toolbar */}
      <AnimatePresence>
        {selectedIds.size > 0 && (() => {
          const selectedJobs = (allJobs ?? []).filter(j => selectedIds.has(String(j.id)));
          return (
            <motion.div
              key="bulk-toolbar"
              initial={{ y: 80, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 80, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 400, damping: 32 }}
              className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50"
            >
              <div className="flex items-center gap-2 bg-card border border-border rounded-2xl shadow-2xl px-4 py-3 backdrop-blur-md">
                {/* Count badge */}
                <span className="text-sm font-semibold text-foreground px-2 mr-1">
                  {selectedIds.size} selected
                </span>
                <div className="w-px h-5 bg-border mx-1" />

                {/* Quick Apply All */}
                <button
                  onClick={() => handleBulkQuickApply(selectedJobs)}
                  disabled={isBulkPending}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/15 text-primary border border-primary/25 hover:bg-primary/25 text-xs font-semibold transition-all active:scale-95 disabled:opacity-50 disabled:cursor-wait"
                >
                  {isBulkPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
                  Quick Apply
                </button>

                {/* Skip All */}
                <button
                  onClick={() => handleBulkSkip(selectedJobs)}
                  disabled={isBulkPending}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-500/10 text-rose-400 border border-rose-500/25 hover:bg-rose-500/20 text-xs font-semibold transition-all active:scale-95 disabled:opacity-50 disabled:cursor-wait"
                >
                  <SkipForward className="w-3.5 h-3.5" />
                  Skip
                </button>

                {/* Re-analyze All */}
                <button
                  onClick={() => handleBulkReanalyze(selectedJobs)}
                  disabled={isBulkPending}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-500/10 text-blue-400 border border-blue-500/25 hover:bg-blue-500/20 text-xs font-semibold transition-all active:scale-95 disabled:opacity-50 disabled:cursor-wait"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Re-analyze
                </button>

                <div className="w-px h-5 bg-border mx-1" />

                {/* Clear selection */}
                <button
                  onClick={clearSelection}
                  disabled={isBulkPending}
                  className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50 text-xs transition-all"
                >
                  <X className="w-3.5 h-3.5" />
                  Clear
                </button>
              </div>
            </motion.div>
          );
        })()}
      </AnimatePresence>
    </div>
  );
}

function JobCard({
  job, search,
  isSelected, anySelected, onToggleSelect,
}: {
  job: Job; search: string;
  isSelected: boolean; anySelected: boolean; onToggleSelect: () => void;
}) {
  const queryClient = useQueryClient();
  const generateProposal = useGenerateProposal();
  const updateJob = useUpdateJob();
  const [done, setDone] = useState(false);

  const isTerminal = job.status === 'applied' || job.status === 'rejected' || job.status === 'skipped';
  const isAlreadyApproved = job.status === 'approved';
  const isAnalyzed = job.applyScore != null;
  const isAnalyzing = job.status === 'analyzing';
  const showQuickApply = isAnalyzed && !isTerminal;

  function handleQuickApply(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (generateProposal.isPending || updateJob.isPending || done) return;

    generateProposal.mutate(
      { id: job.id, data: {} },
      {
        onSuccess: () => {
          updateJob.mutate(
            { id: job.id, data: { status: 'approved' } },
            {
              onSuccess: () => {
                setDone(true);
                toast.success('Proposal generated & job approved!', {
                  description: job.title.slice(0, 60),
                });
                queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
              },
            }
          );
        },
        onError: () => {
          toast.error('Failed to generate proposal. Try again.');
        },
      }
    );
  }

  const isPending = generateProposal.isPending || updateJob.isPending;

  return (
    <Link href={`/jobs/${job.id}`}>
      <Card className={cn(
        'hover:border-primary/50 transition-colors cursor-pointer group relative',
        isSelected && 'border-primary/60 bg-primary/5',
      )}>
        {/* Checkbox — visible on hover or when any card selected */}
        <button
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggleSelect(); }}
          className={cn(
            'absolute top-3 left-3 z-10 rounded transition-all',
            anySelected || isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          )}
          aria-label={isSelected ? 'Deselect job' : 'Select job'}
        >
          {isSelected
            ? <CheckSquare className="w-4 h-4 text-primary" />
            : <Square className="w-4 h-4 text-muted-foreground" />
          }
        </button>

        <CardContent className={cn('p-6', (anySelected || isSelected) && 'pl-10')}>
          <div className="flex flex-col md:flex-row gap-4 justify-between">
            <div className="flex-1 space-y-3">
              <div className="flex items-start justify-between gap-4">
                <h3 className="text-lg font-bold group-hover:text-primary transition-colors leading-snug">
                  {search ? <HighlightText text={job.title} query={search} /> : job.title}
                </h3>
                <div className="flex gap-2 shrink-0 flex-wrap justify-end">
                  {job.aiRecommendation === 'apply'  && <Badge className="bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20 border-emerald-500/20">Apply</Badge>}
                  {job.aiRecommendation === 'skip'   && <Badge className="bg-rose-500/10 text-rose-500 hover:bg-rose-500/20 border-rose-500/20">Skip</Badge>}
                  {job.aiRecommendation === 'review' && <Badge className="bg-amber-500/10 text-amber-500 hover:bg-amber-500/20 border-amber-500/20">Review</Badge>}
                  <Badge variant="outline" className="capitalize">{job.status}</Badge>
                </div>
              </div>

              <p className="text-sm text-muted-foreground line-clamp-2">{job.description}</p>

              <div className="flex flex-wrap gap-4 text-sm font-medium text-muted-foreground pt-1">
                <div className="flex items-center gap-1 text-foreground">
                  <DollarSign className="w-4 h-4 text-muted-foreground" />
                  {formatBudget(job)}
                </div>
                <div className="flex items-center gap-1">
                  <Globe className="w-4 h-4" />
                  {job.clientCountry || 'Unknown'}
                </div>
                {job.paymentVerified && (
                  <div className="flex items-center gap-1 text-blue-500">
                    <Shield className="w-4 h-4" /> Verified
                  </div>
                )}
                {job.winProbability != null && (
                  <div className={`flex items-center gap-1 font-mono text-xs ${scoreColor(job.winProbability)}`}>
                    {job.winProbability}% win
                  </div>
                )}
                <div className="flex items-center gap-1">
                  <Clock className="w-4 h-4" />
                  {formatDistanceToNow(new Date(job.createdAt), { addSuffix: true })}
                </div>
              </div>

              {job.skills && job.skills.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {job.skills.slice(0, 6).map((skill) => (
                    <span key={skill} className="px-2 py-0.5 rounded-full bg-muted text-muted-foreground text-xs">
                      {skill}
                    </span>
                  ))}
                  {job.skills.length > 6 && (
                    <span className="px-2 py-0.5 rounded-full bg-muted text-muted-foreground text-xs">
                      +{job.skills.length - 6}
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* Score panel */}
            <div className="flex flex-col items-center justify-center border-l pl-6 ml-2 min-w-[120px] gap-3">
              {isAnalyzed ? (
                <div className="text-center">
                  <div className={`text-3xl font-mono font-bold ${scoreColor(job.applyScore)}`}>{job.applyScore}</div>
                  <div className="text-xs text-muted-foreground uppercase tracking-wider font-medium mt-1">Score</div>
                  {job.riskScore != null && (
                    <div className="text-xs text-muted-foreground mt-2 font-mono">
                      Risk <span className={scoreColor(100 - job.riskScore)}>{job.riskScore}</span>
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-center text-muted-foreground text-xs">
                  {isAnalyzing ? (
                    <div className="space-y-1">
                      <div className="w-8 h-8 rounded-full border-2 border-primary/30 border-t-primary animate-spin mx-auto" />
                      <span>Analyzing</span>
                    </div>
                  ) : '—'}
                </div>
              )}

              {/* Quick Apply button */}
              {showQuickApply && (
                <button
                  onClick={handleQuickApply}
                  disabled={isPending || done}
                  className={cn(
                    'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all',
                    done
                      ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30 cursor-default'
                      : isAlreadyApproved
                      ? 'bg-blue-500/10 text-blue-400 border-blue-500/20 hover:bg-blue-500/20'
                      : 'bg-primary/10 text-primary border-primary/20 hover:bg-primary/20 active:scale-95',
                    isPending && 'opacity-70 cursor-wait'
                  )}
                >
                  {isPending ? (
                    <><Loader2 className="w-3 h-3 animate-spin" /> Generating…</>
                  ) : done ? (
                    <><CheckCheck className="w-3 h-3" /> Approved</>
                  ) : (
                    <><Zap className="w-3 h-3" /> Quick Apply</>
                  )}
                </button>
              )}

              {isTerminal && (
                <span className="text-xs text-muted-foreground capitalize">{job.status}</span>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

function HighlightText({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;
  const parts = text.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'));
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase() ? (
          <mark key={i} className="bg-primary/20 text-primary rounded px-0.5">{part}</mark>
        ) : part
      )}
    </>
  );
}
