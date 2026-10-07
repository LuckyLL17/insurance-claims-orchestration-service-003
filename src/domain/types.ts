export type ClaimStatus =
  | 'reported'
  | 'investigating'
  | 'awaiting_documents'
  | 'ready_for_adjustment'
  | 'partially_paid'
  | 'settled'
  | 'reopened'
  | 'rejected';

export type ClaimEventType =
  | 'claim.reported'
  | 'policy.snapshot.created'
  | 'evidence.added'
  | 'evidence.reviewed'
  | 'survey.assigned'
  | 'survey.completed'
  | 'documents.requested'
  | 'documents.received'
  | 'risk.assessed'
  | 'adjustment.approved'
  | 'payment.authorized'
  | 'payment.settled'
  | 'payment.reversed'
  | 'payment.recovered'
  | 'claim.reopened'
  | 'claim.rejected';

export interface Participant { kind: 'person' | 'vehicle' | 'device' | 'repair_shop' | 'account'; id: string; role?: string; }
export interface MonetaryAmount { currency: string; minor: number; }
export interface LossEstimate { currency: string; gross: number; deductible?: number; liabilityShare?: number; cap?: number; }
export interface PolicyVersion { policyId: string; version: number; effectiveFrom: string; effectiveTo?: string; coverages: string[]; deductibleMinor: number; limitMinor: number; }
export interface EvidenceRecord { id: string; kind: string; hash: string; version: number; receivedAt: string; reviewed: boolean; accepted?: boolean; source: string; supersedes?: string; }
export type PaymentKind = 'authorization' | 'settlement' | 'reversal' | 'recovery';
export type PaymentFactStatus = 'pending' | 'posted' | 'voided';
export interface PaymentEntry {
  id: string;
  kind: PaymentKind;
  amount: MonetaryAmount;
  /** Gateway/business identifier of this fact; stable across retries. The canonical fact key is `${kind}:${sourceId}`. */
  sourceId: string;
  status: PaymentFactStatus;
  /** Idempotency key the fact was accepted under, so retries after recovery resolve to the same fact. */
  idempotencyKey: string;
  /** Settlement only: gateway source/entry of the authorization it draws against (advance → final payment tracing). */
  authorizationSourceId?: string;
  authorizationPaymentId?: string;
  /** Reversal/recovery only: gateway source of the original payment fact being corrected. */
  originalSourceId?: string;
  /** Reversal/recovery only: ledger entry id of the original payment fact being corrected. */
  originalPaymentId?: string;
  createdAt: string;
}
export interface RuleSnapshot { version: string; frozenAt: string; ruleIds: string[]; }
export interface RiskSignal { code: string; score: number; explanation: string; participants: string[]; }
export interface AuditEntry { sequence: number; eventId: string; type: ClaimEventType; occurredAt: string; actor: string; summary: string; }

/** Recalculated money position for one currency. */
export interface PaymentStageSummary {
  currency: string;
  /** Open authorizations (holds) not drawn down by a settlement. */
  authorizedMinor: number;
  /** Gross posted settlements (advance + final payments), before any correction. */
  settledMinor: number;
  /** Posted reversals that corrected settled payments, as a positive magnitude. */
  reversedMinor: number;
  /** Posted recoveries (money pulled back after settlement), as a positive magnitude. */
  recoveredMinor: number;
  /** Net funds that have actually left: settlements − reversals − recoveries. */
  netPaidMinor: number;
  /** Amount that can still be pulled back: net paid capped at zero below (i.e. outstanding exposure). */
  recoverableMinor: number;
  /** Approved limit consumed by holds plus outstanding net settlements. */
  committedMinor: number;
}

export interface PaymentSummary {
  /** Position per currency; a zeroed entry is included even before any payment. */
  stages: Record<string, PaymentStageSummary>;
  /** One fund fact per canonical `${kind}:${sourceId}` key. */
  factsByKey: Record<string, PaymentEntry>;
}

export interface ClaimState {
  id: string;
  policyId: string;
  status: ClaimStatus;
  lossAt: string;
  reportedAt: string;
  channel: string;
  participants: Participant[];
  loss: LossEstimate;
  policy?: PolicyVersion;
  ruleSnapshot?: RuleSnapshot;
  evidence: EvidenceRecord[];
  requiredEvidence: Set<string>;
  completedSurveys: string[];
  pendingDocuments: string[];
  riskSignals: RiskSignal[];
  riskScore: number;
  payments: PaymentEntry[];
  paymentSummary: PaymentSummary;
  approvedMinor: number;
  audit: AuditEntry[];
  processedEventIds: Set<string>;
  /** Canonical payment fact keys (`${kind}:${sourceId}`) already applied, defending against duplicate/replayed fund facts. */
  processedPaymentFacts: Set<string>;
  version: number;
}

export interface DomainEvent<T = unknown> {
  id: string;
  aggregateId: string;
  type: ClaimEventType;
  occurredAt: string;
  sequence: number;
  actor: string;
  idempotencyKey?: string;
  payload: T;
}

export interface ClaimReportedPayload {
  policyId: string; lossAt: string; reportedAt: string; channel: string;
  participants: Participant[]; loss: LossEstimate;
}
