import { PaymentEntry } from './types';
import { asMinor, newId, iso } from './ids';

export class PaymentLedger {
  post(entries: PaymentEntry[], input: { kind: PaymentEntry['kind']; amount: number; currency: string; sourceId: string }): PaymentEntry {
    const sameSource = entries.filter((entry) => entry.sourceId === input.sourceId);
    const sameKind = sameSource.filter((entry) => entry.kind === input.kind);
    const hasOpenAuthorization = sameSource.some((entry) => entry.kind === 'authorization' && entry.status !== 'voided');
    if (sameKind.some((entry) => entry.status === 'posted' && input.kind !== 'reversal')) {
      if (input.kind === 'settlement' && hasOpenAuthorization) {
        const latest = sameKind.at(-1);
        if (latest && latest.amount.currency === input.currency && latest.amount.minor === Math.round(input.amount * 100)) {
          return structuredClone(latest);
        }
      }
      throw new Error(`duplicate payment source ${input.sourceId}`);
    }
    const amount = asMinor(input.amount);
    if (amount <= 0) throw new Error('payment amount must be positive');
    const signedMinor = input.kind === 'reversal' || input.kind === 'recovery' ? -amount : amount;
    return { id: newId('payment'), kind: input.kind, amount: { currency: input.currency, minor: signedMinor }, sourceId: input.sourceId, status: 'posted', createdAt: iso() };
  }

  balance(entries: PaymentEntry[]): number { return entries.filter((entry) => entry.status === 'posted').reduce((sum, entry) => sum + entry.amount.minor, 0); }
  settlementBalance(entries: PaymentEntry[]): number { return entries.filter((entry) => entry.kind === 'settlement' && entry.status === 'posted').reduce((sum, entry) => sum + entry.amount.minor, 0); }

  entriesForSource(entries: PaymentEntry[], sourceId: string): PaymentEntry[] {
    return entries
      .filter((entry) => entry.sourceId === sourceId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((entry) => structuredClone(entry));
  }

  netForCurrency(entries: PaymentEntry[], currency: string): number {
    return entries
      .filter((entry) => entry.amount.currency === currency && entry.status === 'posted')
      .reduce((sum, entry) => sum + entry.amount.minor, 0);
  }
}
