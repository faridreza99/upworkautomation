export type NotificationEventType =
  | "new_job"
  | "high_score_job"
  | "message_received"
  | "interview_invite"
  | "contract_offer"
  | "proposal_reply"
  | "info";

export interface JobNotificationData {
  title: string;
  budgetMin?: number | null;
  budgetMax?: number | null;
  budgetType?: string | null;
  clientCountry?: string | null;
  paymentVerified?: boolean | null;
  applyScore?: number | null;
  winProbability?: number | null;
  riskScore?: number | null;
  recommendation?: string | null;
  jobUrl?: string | null;
}

export interface NotificationEvent {
  type: NotificationEventType;
  title: string;
  body: string;
  job?: JobNotificationData;
  metadata?: Record<string, unknown>;
}

export interface NotificationProvider {
  readonly name: string;
  isEnabled(): Promise<boolean>;
  send(event: NotificationEvent): Promise<void>;
}
