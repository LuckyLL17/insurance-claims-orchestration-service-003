import { ClaimService } from './claim-service';
import { EventStore } from './event-store';
import { PaymentLedger } from '../domain/payment-ledger';
export class ReplayService {
  constructor(private readonly events: EventStore, private readonly claims: ClaimService, private readonly ledger: PaymentLedger) {}
  execute(claimId: string, until?: number) { const events = this.events.list(claimId).filter((event) => until === undefined || event.sequence <= until); const state = this.claims.replay(claimId, events); return { claimId, eventCount: events.length, state, paymentSummary: this.ledger.summarize(state.payments), events }; }
}
