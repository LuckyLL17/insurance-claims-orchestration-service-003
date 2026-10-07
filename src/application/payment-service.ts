import { ClaimService } from './claim-service';
import { PaymentLedger } from '../domain/payment-ledger';
export class PaymentService {
  constructor(private readonly claims: ClaimService, private readonly ledger: PaymentLedger) {}

  authorize(claimId: string, input: { amount: number; currency: string; sourceId: string }, actor: string) {
    const claim = this.claims.get(claimId); if (claim.status === 'rejected') throw new Error('rejected claim cannot be paid');
    const amountMinor = Math.round(input.amount * 100);
    if (!this.ledger.postedEntry(claim.payments, 'authorization', input.sourceId) && this.ledger.committed(claim.payments) + amountMinor > claim.approvedMinor) throw new Error('authorization exceeds approved amount');
    const payment = this.ledger.post(claim.payments, { ...input, kind: 'authorization' });
    return this.claims.addEvent(claimId, 'payment.authorized', { payment }, actor, `payment:authorization:${input.sourceId}`);
  }

  settle(claimId: string, input: { amount: number; currency: string; sourceId: string }, actor: string) {
    const claim = this.claims.get(claimId); if (claim.status === 'rejected') throw new Error('rejected claim cannot be paid');
    const amountMinor = Math.round(input.amount * 100);
    const consumed = this.ledger.postedEntry(claim.payments, 'authorization', input.sourceId);
    const committed = this.ledger.committed(claim.payments) - (consumed?.amount.minor ?? 0);
    if (!this.ledger.postedEntry(claim.payments, 'settlement', input.sourceId) && committed + amountMinor > claim.approvedMinor) throw new Error('payment exceeds approved amount');
    const payment = this.ledger.post(claim.payments, { ...input, kind: 'settlement' });
    return this.claims.addEvent(claimId, 'payment.settled', { payment }, actor, `payment:settlement:${input.sourceId}`);
  }

  reverse(claimId: string, input: { amount: number; currency: string; sourceId: string; reverses?: string }, actor: string) {
    const claim = this.claims.get(claimId);
    if (!input.reverses) throw new Error('reversal must reference the original payment source');
    const original = this.ledger.postedEntry(claim.payments, 'settlement', input.reverses) ?? this.ledger.postedEntry(claim.payments, 'authorization', input.reverses);
    if (!original) throw new Error(`unknown payment source ${input.reverses}`);
    const amountMinor = Math.round(input.amount * 100);
    if (!this.ledger.postedEntry(claim.payments, 'reversal', input.sourceId) && this.ledger.reversedAgainst(claim.payments, input.reverses) + amountMinor > original.amount.minor) throw new Error('reversal exceeds reversible amount');
    const payment = this.ledger.post(claim.payments, { ...input, kind: 'reversal' });
    return this.claims.addEvent(claimId, 'payment.reversed', { payment }, actor, `payment:reversal:${input.sourceId}`);
  }

  summary(claimId: string) { const claim = this.claims.get(claimId); return { claimId, ...this.ledger.summarize(claim.payments), approvedMinor: claim.approvedMinor }; }
}
