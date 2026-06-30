import { useGetJob, useUpdateJob, useAnalyzeJob, useGenerateProposal, useListProposals, getGetJobQueryKey, getListProposalsQueryKey } from '@workspace/api-client-react';
import { useParams } from 'wouter';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ScoreGauge } from '@/components/ScoreGauge';
import { Check, X, Bot, FileText, ArrowLeft, ExternalLink } from 'lucide-react';
import { Link } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export function JobDetail() {
  const { id } = useParams();
  const jobId = parseInt(id || '0', 10);
  const queryClient = useQueryClient();
  const [proposalModalOpen, setProposalModalOpen] = useState(false);
  const [bidAmount, setBidAmount] = useState('');
  const [tone, setTone] = useState('professional');

  const { data: job, isLoading: jobLoading } = useGetJob(jobId, { 
    query: { enabled: !!jobId, queryKey: getGetJobQueryKey(jobId) } 
  });

  const { data: proposals, isLoading: proposalsLoading } = useListProposals(
    { limit: 10 },
    { query: { enabled: !!jobId, queryKey: getListProposalsQueryKey({ limit: 10 }) } }
  );

  const jobProposals = proposals?.filter(p => p.jobId === jobId) || [];

  const updateJob = useUpdateJob();
  const analyzeJob = useAnalyzeJob();
  const generateProposal = useGenerateProposal();

  const handleStatusChange = (status: 'approved' | 'skipped') => {
    updateJob.mutate({ id: jobId, data: { status } }, {
      onSuccess: () => {
        toast.success(`Job marked as ${status}`);
        queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(jobId) });
      }
    });
  };

  const handleAnalyze = () => {
    const promise = analyzeJob.mutateAsync({ id: jobId });
    toast.promise(promise, {
      loading: 'Running AI analysis...',
      success: 'Analysis complete',
      error: 'Analysis failed'
    });
    promise.then(() => {
      queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(jobId) });
    });
  };

  const handleGenerateProposal = () => {
    const promise = generateProposal.mutateAsync({
      id: jobId,
      data: {
        bidAmount: bidAmount ? parseFloat(bidAmount) : undefined,
        tone: tone as any
      }
    });
    
    toast.promise(promise, {
      loading: 'Generating proposal...',
      success: 'Proposal generated successfully',
      error: 'Failed to generate proposal'
    });

    promise.then(() => {
      setProposalModalOpen(false);
      queryClient.invalidateQueries({ queryKey: getListProposalsQueryKey({ limit: 10 }) });
    });
  };

  if (jobLoading) {
    return <div className="p-8"><Skeleton className="h-64 w-full" /></div>;
  }

  if (!job) return <div className="p-8 text-center">Job not found</div>;

  return (
    <div className="p-8 space-y-6 max-w-5xl mx-auto pb-24">
      <Link href="/jobs" className="inline-flex items-center text-sm font-medium text-muted-foreground hover:text-foreground transition-colors mb-4">
        <ArrowLeft className="w-4 h-4 mr-2" /> Back to Jobs
      </Link>

      <div className="flex flex-col md:flex-row justify-between items-start gap-4">
        <div>
          <h1 className="text-3xl font-bold font-serif">{job.title}</h1>
          <div className="flex flex-wrap items-center gap-3 mt-3">
            <Badge variant="outline" className="capitalize px-3 py-1 text-sm">{job.status}</Badge>
            {job.aiRecommendation && (
              <Badge className="px-3 py-1 text-sm capitalize">
                {job.aiRecommendation}
              </Badge>
            )}
            <span className="text-muted-foreground text-sm font-medium border-l pl-3">
              {job.budgetType === 'hourly' ? `${job.budgetMin}-${job.budgetMax}/hr` : `Fixed: $${job.budgetMin}`}
            </span>
            <span className="text-muted-foreground text-sm font-medium border-l pl-3">
              {job.clientCountry}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {job.jobUrl && (
            <Button variant="outline" size="sm" asChild>
              <a href={job.jobUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="w-4 h-4 mr-2" /> Upwork
              </a>
            </Button>
          )}
          <Button variant="outline" onClick={() => handleStatusChange('skipped')} disabled={updateJob.isPending}>
            <X className="w-4 h-4 mr-2" /> Skip
          </Button>
          <Button onClick={() => handleStatusChange('approved')} disabled={updateJob.isPending}>
            <Check className="w-4 h-4 mr-2" /> Approve
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="md:col-span-2 space-y-6">
          <Tabs defaultValue="details">
            <TabsList className="mb-4">
              <TabsTrigger value="details">Job Details</TabsTrigger>
              <TabsTrigger value="proposals">Proposals ({jobProposals.length})</TabsTrigger>
            </TabsList>
            
            <TabsContent value="details" className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>Description</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="prose dark:prose-invert max-w-none whitespace-pre-wrap font-sans text-sm">
                    {job.description}
                  </div>
                  {job.skills && job.skills.length > 0 && (
                    <div className="mt-6 pt-6 border-t">
                      <h4 className="font-semibold mb-3">Required Skills</h4>
                      <div className="flex flex-wrap gap-2">
                        {job.skills.map(skill => (
                          <Badge key={skill} variant="secondary">{skill}</Badge>
                        ))}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="proposals" className="space-y-4">
              <div className="flex justify-end">
                <Button onClick={() => setProposalModalOpen(true)}>
                  <Bot className="w-4 h-4 mr-2" /> Generate Proposal
                </Button>
              </div>

              {proposalsLoading ? (
                <Skeleton className="h-40 w-full" />
              ) : jobProposals.length === 0 ? (
                <Card className="bg-muted/50 border-dashed">
                  <CardContent className="flex flex-col items-center justify-center p-12 text-center text-muted-foreground">
                    <FileText className="w-12 h-12 mb-4 opacity-20" />
                    <p>No proposals generated for this job yet.</p>
                  </CardContent>
                </Card>
              ) : (
                jobProposals.map(proposal => (
                  <Card key={proposal.id}>
                    <CardHeader className="pb-3 border-b mb-3">
                      <div className="flex justify-between items-center">
                        <CardTitle className="text-base flex items-center gap-2">
                          Proposal Draft <Badge variant="outline">{proposal.status}</Badge>
                        </CardTitle>
                        <span className="font-mono font-medium">${proposal.bidAmount || 'N/A'}</span>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <div className="bg-muted p-4 rounded-md font-mono text-sm whitespace-pre-wrap">
                        {proposal.content}
                      </div>
                    </CardContent>
                  </Card>
                ))
              )}
            </TabsContent>
          </Tabs>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2 border-b">
              <CardTitle>AI Analysis</CardTitle>
              <Button variant="ghost" size="icon" onClick={handleAnalyze} disabled={analyzeJob.isPending}>
                <Bot className="w-4 h-4" />
              </Button>
            </CardHeader>
            <CardContent className="pt-6">
              {job.applyScore != null ? (
                <div className="space-y-6">
                  <div className="grid grid-cols-2 gap-4">
                    <ScoreGauge score={job.applyScore} label="Apply Score" type="success" className="col-span-2 py-6" />
                    <ScoreGauge score={job.riskScore || 0} label="Risk" type="danger" />
                    <ScoreGauge score={job.winProbability || 0} label="Win Prob" type="info" />
                  </div>
                  
                  {job.aiReasoning && (
                    <div className="pt-4 border-t">
                      <h4 className="font-semibold text-sm mb-2 text-muted-foreground uppercase tracking-wider">Reasoning</h4>
                      <p className="text-sm">{job.aiReasoning}</p>
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  <Bot className="w-12 h-12 mx-auto mb-4 opacity-20" />
                  <p className="mb-4">No analysis available.</p>
                  <Button onClick={handleAnalyze} disabled={analyzeJob.isPending}>
                    Run Analysis
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <Dialog open={proposalModalOpen} onOpenChange={setProposalModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Generate Proposal</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Bid Amount ($)</Label>
              <Input 
                type="number" 
                value={bidAmount} 
                onChange={e => setBidAmount(e.target.value)} 
                placeholder={job.budgetMin?.toString() || "0"}
              />
            </div>
            <div className="space-y-2">
              <Label>Tone</Label>
              <Select value={tone} onValueChange={setTone}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="professional">Professional</SelectItem>
                  <SelectItem value="friendly">Friendly</SelectItem>
                  <SelectItem value="confident">Confident</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setProposalModalOpen(false)}>Cancel</Button>
            <Button onClick={handleGenerateProposal} disabled={generateProposal.isPending}>
              {generateProposal.isPending ? 'Generating...' : 'Generate'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
