import { useListProposals, useApproveProposal, getListProposalsQueryKey } from '@workspace/api-client-react';
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Check, Send, Edit, FileText } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Link } from 'wouter';

export function Proposals() {
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const queryClient = useQueryClient();
  
  const { data: proposals, isLoading } = useListProposals(
    statusFilter !== 'all' ? { status: statusFilter as any } : undefined,
    { query: { queryKey: ['/api/proposals', statusFilter !== 'all' ? { status: statusFilter } : undefined] } }
  );

  const approveProposal = useApproveProposal();

  const handleApprove = (id: number) => {
    approveProposal.mutate({ id }, {
      onSuccess: () => {
        toast.success('Proposal approved');
        queryClient.invalidateQueries({ queryKey: getListProposalsQueryKey(statusFilter !== 'all' ? { status: statusFilter as any } : undefined) });
      }
    });
  };

  return (
    <div className="p-8 space-y-6 max-w-7xl mx-auto">
      <div className="flex flex-col md:flex-row items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold font-serif tracking-tight">Proposals</h1>
          <p className="text-muted-foreground mt-1">Manage AI-generated bids and drafts.</p>
        </div>
        
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Filter by status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="draft">Drafts</SelectItem>
            <SelectItem value="approved">Approved</SelectItem>
            <SelectItem value="sent">Sent</SelectItem>
            <SelectItem value="rejected">Rejected</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {isLoading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-64 w-full rounded-xl" />
          ))
        ) : proposals?.length === 0 ? (
          <div className="col-span-full text-center p-12 border rounded-xl bg-card/50 text-muted-foreground">
            <FileText className="w-12 h-12 mx-auto mb-4 opacity-20" />
            No proposals found.
          </div>
        ) : (
          proposals?.map((proposal) => (
            <Card key={proposal.id} className="flex flex-col">
              <CardHeader className="pb-3 border-b">
                <div className="flex justify-between items-start">
                  <div>
                    <CardTitle className="text-lg font-bold">
                      <Link href={`/jobs/${proposal.jobId}`} className="hover:text-primary transition-colors">
                        {proposal.jobTitle || `Job #${proposal.jobId}`}
                      </Link>
                    </CardTitle>
                    <div className="text-sm font-mono text-muted-foreground mt-1">
                      Bid: ${proposal.bidAmount || 'N/A'} {proposal.estimatedDuration && `• ${proposal.estimatedDuration}`}
                    </div>
                  </div>
                  <Badge variant={proposal.status === 'approved' ? 'default' : 'outline'} className="capitalize">
                    {proposal.status}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="pt-4 flex-1">
                <div className="relative h-32 overflow-hidden bg-muted p-4 rounded-md font-mono text-xs whitespace-pre-wrap">
                  {proposal.content}
                  <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-muted to-transparent" />
                </div>
              </CardContent>
              <CardFooter className="border-t pt-4 bg-muted/20 gap-2 justify-end">
                <Button variant="outline" size="sm">
                  <Edit className="w-4 h-4 mr-2" /> Edit
                </Button>
                {proposal.status === 'draft' && (
                  <Button size="sm" onClick={() => handleApprove(proposal.id)} disabled={approveProposal.isPending}>
                    <Check className="w-4 h-4 mr-2" /> Approve
                  </Button>
                )}
                {proposal.status === 'approved' && (
                  <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 text-white">
                    <Send className="w-4 h-4 mr-2" /> Mark Sent
                  </Button>
                )}
              </CardFooter>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
