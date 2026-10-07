import { EventStore } from './event-store';
import { EvidenceLedger } from '../domain/evidence';
import { PolicyCatalog } from '../domain/policy';
import { PaymentLedger, paymentFactKey } from '../domain/payment-ledger';
import { RuleEngine } from '../domain/rules';
import { ClaimReportedPayload, ClaimState, DomainEvent, EvidenceRecord, PaymentEntry } from '../domain/types';
import { newId, iso } from '../domain/ids';

export class ClaimService {
  private readonly paymentLedger = new PaymentLedger();

  constructor(private readonly events: EventStore, private readonly policies: PolicyCatalog, private readonly rules: RuleEngine, private readonly evidence: EvidenceLedger) {}

  create(input: ClaimReportedPayload, actor: string, key?: string): ClaimState {
    const id = newId('claim');
    this.events.append(id, 'claim.reported', { ...input, lossAt: iso(input.lossAt), reportedAt: iso(input.reportedAt) }, actor, key);
    this.events.append(id, 'policy.snapshot.created', { policy: this.policies.snapshot(input.policyId, input.lossAt), ruleSnapshot: this.rules.freeze() }, 'system', `policy:${id}`);
    return this.get(id);
  }

  addEvent(id: string, type: DomainEvent['type'], payload: unknown, actor: string, key?: string, occurredAt?: string): ClaimState { this.assertExists(id); this.events.append(id, type, payload, actor, key, occurredAt); return this.get(id); }

  addEvidence(id: string, input: { kind: string; source: string; content: unknown; receivedAt?: string; supersedes?: string }, actor: string, key?: string): ClaimState {
    const claim = this.get(id); const record = this.evidence.add(input, claim.evidence); return this.addEvent(id, 'evidence.added', { evidence: record }, actor, key, input.receivedAt);
  }

  reviewEvidence(id: string, evidenceId: string, accepted: boolean, actor: string, key?: string): ClaimState {
    const claim = this.get(id); const record = this.evidence.review(evidenceId, accepted, claim.evidence); return this.addEvent(id, 'evidence.reviewed', { evidence: record }, actor, key);
  }

  get(id: string): ClaimState { return this.replay(id, this.events.list(id)); }
  replay(id: string, events: DomainEvent[]): ClaimState {
    const state = this.empty(id);
    for (const event of events.sort((a, b) => a.sequence - b.sequence)) this.apply(state, event);
    if (!state.policy) throw new Error(`claim ${id} has no policy snapshot`);
    return state;
  }

  private empty(id: string): ClaimState { return { id, policyId: '', status: 'reported', lossAt: '', reportedAt: '', channel: '', participants: [], loss: { currency: 'CNY', gross: 0 }, evidence: [], requiredEvidence: new Set(), completedSurveys: [], pendingDocuments: [], riskSignals: [], riskScore: 0, payments: [], paymentSummary: { stages: {}, factsByKey: {} }, approvedMinor: 0, audit: [], processedEventIds: new Set(), processedPaymentFacts: new Set(), version: 0 }; }
  private assertExists(id: string): void { if (this.events.list(id).length === 0) throw new Error(`unknown claim ${id}`); }

  private apply(state: ClaimState, event: DomainEvent): void {
    if (state.processedEventIds.has(event.id)) return; state.processedEventIds.add(event.id); state.version = event.sequence;
    const payload = event.payload as any;
    if (event.type === 'claim.reported') { state.policyId = payload.policyId; state.lossAt = payload.lossAt; state.reportedAt = payload.reportedAt; state.channel = payload.channel; state.participants = payload.participants; state.loss = payload.loss; state.status = 'reported'; }
    if (event.type === 'policy.snapshot.created') { state.policy = payload.policy; state.ruleSnapshot = payload.ruleSnapshot; }
    if (event.type === 'evidence.added') { state.evidence = [...state.evidence.filter((e) => e.id !== payload.evidence.id), payload.evidence]; state.status = state.status === 'reported' ? 'investigating' : state.status; }
    if (event.type === 'evidence.reviewed') { state.evidence = state.evidence.map((e) => e.id === payload.evidence.id ? payload.evidence : e); }
    if (event.type === 'documents.requested') { state.pendingDocuments = [...new Set([...(state.pendingDocuments), ...(payload.kinds ?? [])])]; state.status = 'awaiting_documents'; }
    if (event.type === 'documents.received') { state.pendingDocuments = state.pendingDocuments.filter((kind) => !(payload.kinds ?? []).includes(kind)); if (!state.pendingDocuments.length) state.status = 'ready_for_adjustment'; }
    if (event.type === 'survey.completed') { state.completedSurveys = [...new Set([...state.completedSurveys, payload.taskId])]; }
    if (event.type === 'risk.assessed') { state.riskSignals = payload.signals; state.riskScore = payload.score; }
    if (event.type === 'adjustment.approved') { state.approvedMinor = payload.approvedMinor; state.requiredEvidence = new Set(payload.requiredEvidence); state.status = 'ready_for_adjustment'; }
    if (event.type === 'payment.authorized' || event.type === 'payment.settled' || event.type === 'payment.reversed' || event.type === 'payment.recovered') {
      const payment = payload.payment as PaymentEntry;
      // Defense in depth: even if two events carrying the same business fact ever reach replay
      // (reordered recovery, duplicate notification), only one fund fact is ever appended.
      const factKey = paymentFactKey(payment.kind, payment.sourceId);
      if (!state.processedPaymentFacts.has(factKey)) {
        state.processedPaymentFacts.add(factKey);
        state.payments = [...state.payments, payment];
      }
    }
    if (event.type === 'claim.reopened') state.status = 'reopened';
    if (event.type === 'claim.rejected') state.status = 'rejected';
    // Recalculate the money position from facts after every change so callers always see
    // authorized / settled / reversed / recoverable separated, with duplicates collapsed.
    state.paymentSummary = this.paymentLedger.summary(state.payments, { [state.loss.currency]: state.approvedMinor });
    if (event.type === 'payment.authorized' || event.type === 'payment.settled' || event.type === 'payment.reversed' || event.type === 'payment.recovered') {
      const payment = payload.payment as PaymentEntry;
      if (payment.kind === 'reversal') state.status = 'reopened';
      else if (payment.kind === 'settlement' && state.approvedMinor > 0 && (state.paymentSummary.stages[payment.amount.currency]?.netPaidMinor ?? 0) >= state.approvedMinor) state.status = 'settled';
      else if (payment.kind === 'settlement') state.status = 'partially_paid';
    }
    state.audit.push({ sequence: event.sequence, eventId: event.id, type: event.type, occurredAt: event.occurredAt, actor: event.actor, summary: `${event.type} accepted` });
  }
}
