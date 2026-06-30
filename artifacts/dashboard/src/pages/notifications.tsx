import { useListNotifications, useMarkNotificationRead, useMarkAllNotificationsRead, getListNotificationsQueryKey } from '@workspace/api-client-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { formatDistanceToNow } from 'date-fns';
import { useQueryClient } from '@tanstack/react-query';
import { Check, CheckCheck, MessageSquare, Briefcase, Star, Info } from 'lucide-react';
import { Link } from 'wouter';

export function Notifications() {
  const queryClient = useQueryClient();
  const { data: notifications, isLoading } = useListNotifications(
    { limit: 50 },
    { query: { queryKey: ['/api/notifications', { limit: 50 }] } }
  );

  const markRead = useMarkNotificationRead();
  const markAllRead = useMarkAllNotificationsRead();

  const handleMarkRead = (id: number) => {
    markRead.mutate({ id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListNotificationsQueryKey({ limit: 50 }) });
      }
    });
  };

  const handleMarkAllRead = () => {
    markAllRead.mutate(undefined, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListNotificationsQueryKey({ limit: 50 }) });
      }
    });
  };

  const getIcon = (type: string) => {
    switch(type) {
      case 'message_received': return <MessageSquare className="w-5 h-5 text-blue-500" />;
      case 'interview_invite': return <Briefcase className="w-5 h-5 text-emerald-500" />;
      case 'high_score_job': return <Star className="w-5 h-5 text-amber-500" />;
      default: return <Info className="w-5 h-5 text-muted-foreground" />;
    }
  };

  return (
    <div className="p-8 space-y-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold font-serif tracking-tight">Notifications</h1>
          <p className="text-muted-foreground mt-1">System alerts and crucial updates.</p>
        </div>
        <Button variant="outline" onClick={handleMarkAllRead} disabled={markAllRead.isPending}>
          <CheckCheck className="w-4 h-4 mr-2" /> Mark all as read
        </Button>
      </div>

      <div className="space-y-4">
        {isLoading ? (
          Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full rounded-xl" />
          ))
        ) : notifications?.length === 0 ? (
          <div className="text-center p-12 border rounded-xl bg-card/50 text-muted-foreground">
            No notifications to display.
          </div>
        ) : (
          notifications?.map((notification) => (
            <Card key={notification.id} className={`transition-colors ${!notification.read ? 'border-primary/50 bg-primary/5' : ''}`}>
              <CardContent className="p-4 flex items-start gap-4">
                <div className="mt-1 bg-card rounded-full p-2 border shadow-sm">
                  {getIcon(notification.type)}
                </div>
                <div className="flex-1">
                  <div className="flex justify-between items-start">
                    <p className={`text-sm ${!notification.read ? 'font-bold' : ''}`}>
                      {notification.message}
                    </p>
                    <span className="text-xs text-muted-foreground whitespace-nowrap ml-4">
                      {formatDistanceToNow(new Date(notification.createdAt), { addSuffix: true })}
                    </span>
                  </div>
                  <div className="flex items-center gap-4 mt-2">
                    <Badge variant="secondary" className="capitalize text-xs">
                      {notification.type.replace(/_/g, ' ')}
                    </Badge>
                    {notification.jobId && (
                      <Link href={`/jobs/${notification.jobId}`} className="text-xs font-medium text-primary hover:underline">
                        View Job
                      </Link>
                    )}
                  </div>
                </div>
                {!notification.read && (
                  <Button variant="ghost" size="icon" onClick={() => handleMarkRead(notification.id)} disabled={markRead.isPending}>
                    <Check className="w-4 h-4" />
                  </Button>
                )}
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
