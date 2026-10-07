import { PaymentEntry, PaymentSummary } from './types';
import { asMinor, newId, iso } from './ids';

export class PaymentLedger {
  post(entries: PaymentEntry[], input: { kind: PaymentEntry['kind']; amount: number; currency: string; sourceId: string; reverses?: string }): PaymentEntry {
    const amount = asMinor(input.amount);
    if (amount <= 0) throw new Error('payment amount must be positive');
    const existing = this.postedEntry(entries, input.kind, input.sourceId);
    if (existing) {
      if (existing.amount.currency === input.currency && existing.amount.minor === this.sign(input.kind, amount)) return structuredClone(existing);
      throw new Error(`conflicting payment source ${input.sourceId}`);
    }
    const entry: PaymentEntry = { id: newId('payment'), kind: input.kind, amount: { currency: input.currency, minor: this.sign(input.kind, amount) }, sourceId: input.sourceId, status: 'posted', createdAt: iso() };
    if (input.reverses) entry.reverses = input.reverses;
    return entry;
  }

  postedEntry(entries: PaymentEntry[], kind: PaymentEntry['kind'], sourceId: string): PaymentEntry | undefined {
    return entries.find((entry) => entry.kind === kind && entry.sourceId === sourceId && entry.status === 'posted');
  }

  reversedAgainst(entries: PaymentEntry[], sourceId: string): number {
    return entries
      .filter((entry) => entry.kind === 'reversal' && entry.status === 'posted' && entry.reverses === sourceId)
      .reduce((sum, entry) => sum - entry.amount.minor, 0);
  }

  balance(entries: PaymentEntry[]): number { return entries.filter((entry) => entry.status === 'posted').reduce((sum, entry) => sum + entry.amount.minor, 0); }
  settlementBalance(entries: PaymentEntry[]): number { return entries.filter((entry) => entry.kind === 'settlement' && entry.status === 'posted').reduce((sum, entry) => sum + entry.amount.minor, 0); }

  committed(entries: PaymentEntry[]): number {
    const posted = entries.filter((entry) => entry.status === 'posted');
    const settledSources = new Set(posted.filter((entry) => entry.kind === 'settlement').map((entry) => entry.sourceId));
    return posted.filter((entry) => entry.kind !== 'authorization' || !settledSources.has(entry.sourceId)).reduce((sum, entry) => sum + entry.amount.minor, 0);
  }

  summarize(entries: PaymentEntry[]): PaymentSummary {
    const posted = entries.filter((entry) => entry.status === 'posted');
    const settledSources = new Set(posted.filter((entry) => entry.kind === 'settlement').map((entry) => entry.sourceId));
    const sum = (kind: PaymentEntry['kind']) => posted.filter((entry) => entry.kind === kind).reduce((total, entry) => total + Math.abs(entry.amount.minor), 0);
    const authorizedMinor = posted.filter((entry) => entry.kind === 'authorization' && !settledSources.has(entry.sourceId)).reduce((total, entry) => total + entry.amount.minor, 0);
    const settledMinor = sum('settlement'); const reversedMinor = sum('reversal'); const recoveredMinor = sum('recovery');
    const netPaidMinor = settledMinor - reversedMinor - recoveredMinor;
    return { authorizedMinor, settledMinor, reversedMinor, recoveredMinor, netPaidMinor, recoverableMinor: Math.max(0, netPaidMinor) };
  }

  entriesForSource(entries: PaymentEntry[], sourceId: string): PaymentEntry[] {
    return entries
      .filter((entry) => entry.sourceId === sourceId || entry.reverses === sourceId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((entry) => structuredClone(entry));
  }

  netForCurrency(entries: PaymentEntry[], currency: string): number {
    return entries
      .filter((entry) => entry.amount.currency === currency && entry.status === 'posted')
      .reduce((sum, entry) => sum + entry.amount.minor, 0);
  }

  private sign(kind: PaymentEntry['kind'], amount: number): number { return kind === 'reversal' || kind === 'recovery' ? -amount : amount; }
}
