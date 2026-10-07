import { ClaimService } from './claim-service';
import { PaymentLedger, paymentFactKey, PostPaymentInput } from '../domain/payment-ledger';
import { PaymentEntry, PaymentKind } from '../domain/types';

export interface PaymentNotification {
  amount: number;
  currency: string;
  /** Gateway/business identifier of this fact; the same value is resent on retry and must be stable. */
  sourceId: string;
  /** Settlement (final payment) drawing down an earlier advance authorization: its gateway source. */
  authorizationSourceId?: string;
  /** Reversal/recovery: gateway source of the original payment being corrected. */
  originalSourceId?: string;
}

const EVENT_TYPE: Record<PaymentKind, 'payment.authorized' | 'payment.settled' | 'payment.reversed' | 'payment.recovered'> = {
  authorization: 'payment.authorized',
  settlement: 'payment.settled',
  reversal: 'payment.reversed',
  recovery: 'payment.recovered',
};

export class PaymentService {
  constructor(private readonly claims: ClaimService, private readonly ledger: PaymentLedger) {}

  /** Place a hold (e.g. an advance/prepayment reservation). Consumes approved capacity until drawn down or reversed. */
  authorize(claimId: string, input: PaymentNotification, actor: string, key?: string) {
    return this.post(claimId, 'authorization', input, actor, key);
  }

  /** Post a settlement — a standalone final payment, or the drawdown of an authorization (advance + final payment flow). */
  settle(claimId: string, input: PaymentNotification, actor: string, key?: string) {
    return this.post(claimId, 'settlement', input, actor, key);
  }

  /** Correct a payment that never should have completed (void authorization or refund settlement), linked to its source. */
  reverse(claimId: string, input: PaymentNotification, actor: string, key?: string) {
    return this.post(claimId, 'reversal', input, actor, key);
  }

  /** Claw back money already settled (overpayment / fraud), linked to the settlement source. */
  recover(claimId: string, input: PaymentNotification, actor: string, key?: string) {
    return this.post(claimId, 'recovery', input, actor, key);
  }

  private post(claimId: string, kind: PaymentKind, input: PaymentNotification, actor: string, explicitKey?: string) {
    const claim = this.claims.get(claimId);
    if (claim.status === 'rejected') throw new Error('rejected claim cannot be paid');

    const ledgerInput: PostPaymentInput = {
      kind,
      amount: input.amount,
      currency: input.currency,
      sourceId: input.sourceId,
      authorizationSourceId: input.authorizationSourceId,
      originalSourceId: input.originalSourceId,
    };

    // Resolve a retried notification to its existing fact BEFORE doing any cap arithmetic, so a
    // duplicate callback can never be rejected as "over limit" nor post a second money fact.
    const existing = this.ledger.factForKey(claim.payments, kind, input.sourceId);
    let payment: PaymentEntry;
    if (existing) {
      payment = this.ledger.post(claim.payments, ledgerInput);
    } else {
      if (input.currency !== claim.loss.currency) throw new Error('payment currency must match claim currency');
      if (kind === 'authorization' || kind === 'settlement') {
        const stage = claim.paymentSummary.stages[input.currency] ?? this.ledger.emptySummary(input.currency);
        const amountMinor = Math.round(input.amount * 100);
        // A final payment drawing down an advance authorization releases that hold; only the still
        // open part of the authorization is consumed as new capacity. Standalone settlements consume
        // capacity directly. Capacity consumed = open authorizations + net money already out.
        const drawnHoldRelease = kind === 'settlement' && input.authorizationSourceId
          ? Math.min(amountMinor, this.ledger.openAuthorization(claim.payments, input.authorizationSourceId))
          : 0;
        if (stage.committedMinor + amountMinor - drawnHoldRelease > claim.approvedMinor) throw new Error('payment exceeds approved amount');
      }
      payment = this.ledger.post(claim.payments, ledgerInput);
    }

    // The idempotency key is derived solely from the business fact — never from aggregate version,
    // so a timeout-retry on a later version, an out-of-order redelivery, or a replay after recovery
    // all append (or return) the same event.
    const eventKey = explicitKey ?? payment.idempotencyKey ?? paymentFactKey(kind, input.sourceId);
    return this.claims.addEvent(claimId, EVENT_TYPE[kind], { payment }, actor, eventKey, payment.createdAt);
  }
}
