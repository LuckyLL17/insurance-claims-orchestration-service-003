import { PaymentEntry, PaymentKind, PaymentStageSummary, PaymentSummary } from './types';
import { asMinor, newId, iso } from './ids';

export interface PostPaymentInput {
  kind: PaymentKind;
  amount: number;
  currency: string;
  sourceId: string;
  /** Settlement only: gateway source of the authorization (advance) being drawn down. */
  authorizationSourceId?: string;
  /** Reversal/recovery only: gateway source of the original fact being corrected. */
  originalSourceId?: string;
}

/** Canonical identity of one business fund fact. Retries, reorders and replays must resolve to it. */
export const paymentFactKey = (kind: PaymentKind, sourceId: string): string => `payment-fact:${kind}:${sourceId}`;

export class PaymentLedger {
  /**
   * Post a fund fact idempotently.
   *
   * The canonical fact key is `${kind}:${sourceId}` — it does NOT depend on aggregate version,
   * so a gateway retry after timeout, a callback arriving after a reorder, or a replayed event
   * after service recovery all return the same already-posted entry instead of creating a second fact.
   * If the same business source id is reused for a fact with a different amount/currency/kind it is a
   * conflicting notification, not a retry, and is rejected rather than silently doubled.
   */
  post(entries: PaymentEntry[], input: PostPaymentInput, occurredAt?: string): PaymentEntry {
    const factKey = paymentFactKey(input.kind, input.sourceId);
    const existing = entries.find((entry) => paymentFactKey(entry.kind, entry.sourceId) === factKey && entry.status !== 'voided');
    if (existing) {
      const amountMinor = asMinor(input.amount);
      if (existing.amount.currency !== input.currency || existing.amount.minor !== this.signedMinor(input.kind, amountMinor)) {
        throw new Error(`conflicting payment notification for source ${input.sourceId}`);
      }
      return structuredClone(existing);
    }

    const amount = asMinor(input.amount);
    if (amount <= 0) throw new Error('payment amount must be positive');

    let authorizationPaymentId: string | undefined;
    let originalPaymentId: string | undefined;

    if (input.kind === 'settlement' && input.authorizationSourceId) {
      const authorizationKey = paymentFactKey('authorization', input.authorizationSourceId);
      const authorization = entries.find((entry) => paymentFactKey(entry.kind, entry.sourceId) === authorizationKey && entry.status === 'posted');
      if (!authorization) throw new Error(`settlement references unknown authorization ${input.authorizationSourceId}`);
      if (authorization.amount.currency !== input.currency) throw new Error('settlement currency must match its authorization');
      authorizationPaymentId = authorization.id;
    }

    if (input.kind === 'reversal' || input.kind === 'recovery') {
      if (!input.originalSourceId) throw new Error(`${input.kind} must reference an original payment source`);
      const original = this.findOriginal(entries, input.kind, input.originalSourceId);
      if (!original) throw new Error(`${input.kind} references unknown payment ${input.originalSourceId}`);
      if (original.amount.currency !== input.currency) throw new Error(`${input.kind} currency must match original payment`);
      if (amount > Math.abs(original.amount.minor)) throw new Error(`${input.kind} exceeds original payment amount`);
      // Corrections against one original fact are cumulative: a retried correction is idempotent by
      // its own source id, but two different corrections can never total more than the original fact.
      const alreadyCorrected = entries
        .filter((entry) => (entry.kind === 'reversal' || entry.kind === 'recovery') && entry.originalPaymentId === original.id && entry.status === 'posted')
        .reduce((sum, entry) => sum + Math.abs(entry.amount.minor), 0);
      if (alreadyCorrected + amount > Math.abs(original.amount.minor)) throw new Error(`${input.kind} corrections exceed original payment amount`);
      originalPaymentId = original.id;
    }

    const entry: PaymentEntry = {
      id: newId('payment'),
      kind: input.kind,
      amount: { currency: input.currency, minor: this.signedMinor(input.kind, amount) },
      sourceId: input.sourceId,
      status: 'posted',
      idempotencyKey: factKey,
      createdAt: iso(occurredAt),
    };
    if (input.kind === 'settlement') {
      entry.authorizationSourceId = input.authorizationSourceId;
      entry.authorizationPaymentId = authorizationPaymentId;
    }
    if (input.kind === 'reversal' || input.kind === 'recovery') {
      entry.originalSourceId = input.originalSourceId;
      entry.originalPaymentId = originalPaymentId;
    }
    return entry;
  }

  private signedMinor(kind: PaymentKind, amountMinor: number): number {
    return kind === 'reversal' || kind === 'recovery' ? -amountMinor : amountMinor;
  }

  /** A reversal corrects a settlement or authorization; a recovery claws back a settled payment. Lookup is by canonical fact key. */
  private findOriginal(entries: PaymentEntry[], kind: PaymentKind, sourceId: string): PaymentEntry | undefined {
    const originalKinds: PaymentKind[] = kind === 'reversal' ? ['settlement', 'authorization'] : ['settlement'];
    for (const originalKind of originalKinds) {
      const original = this.factForKey(entries, originalKind, sourceId);
      if (original && original.status === 'posted') return original;
    }
    return undefined;
  }

  factForKey(entries: PaymentEntry[], kind: PaymentKind, sourceId: string): PaymentEntry | undefined {
    return entries.find((entry) => paymentFactKey(entry.kind, entry.sourceId) === paymentFactKey(kind, sourceId) && entry.status !== 'voided');
  }

  /** Remaining open hold on an authorization: original amount minus settlements drawing it and reversals correcting it. */
  openAuthorization(entries: PaymentEntry[], authorizationSourceId: string): number {
    const authorization = this.factForKey(entries, 'authorization', authorizationSourceId);
    if (!authorization || authorization.status !== 'posted') return 0;
    const key = paymentFactKey('authorization', authorizationSourceId);
    const drawn = entries
      .filter((entry) => entry.kind === 'settlement' && entry.status === 'posted' && entry.authorizationSourceId && paymentFactKey('authorization', entry.authorizationSourceId) === key)
      .reduce((sum, entry) => sum + Math.abs(entry.amount.minor), 0);
    const reversed = entries
      .filter((entry) => entry.kind === 'reversal' && entry.status === 'posted' && entry.originalPaymentId === authorization.id)
      .reduce((sum, entry) => sum + Math.abs(entry.amount.minor), 0);
    return Math.max(0, authorization.amount.minor - drawn - reversed);
  }

  /** Signed balance of every posted fact (settlements + authorizations − reversals − recoveries). */
  balance(entries: PaymentEntry[]): number { return entries.filter((entry) => entry.status === 'posted').reduce((sum, entry) => sum + entry.amount.minor, 0); }
  settlementBalance(entries: PaymentEntry[]): number { return entries.filter((entry) => entry.kind === 'settlement' && entry.status === 'posted').reduce((sum, entry) => sum + entry.amount.minor, 0); }

  entriesForSource(entries: PaymentEntry[], sourceId: string): PaymentEntry[] {
    return entries
      .filter((entry) => entry.sourceId === sourceId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((entry) => structuredClone(entry));
  }

  /** Every fact (and its correction chain) for one currency, for reconciling a stage against the gateway source. */
  factsForCurrency(entries: PaymentEntry[], currency: string): PaymentEntry[] {
    return entries.filter((entry) => entry.amount.currency === currency).map((entry) => structuredClone(entry));
  }

  netForCurrency(entries: PaymentEntry[], currency: string): number {
    return entries
      .filter((entry) => entry.amount.currency === currency && entry.status === 'posted')
      .reduce((sum, entry) => sum + entry.amount.minor, 0);
  }

  emptySummary(currency: string): PaymentStageSummary {
    return { currency, authorizedMinor: 0, settledMinor: 0, reversedMinor: 0, recoveredMinor: 0, netPaidMinor: 0, recoverableMinor: 0, committedMinor: 0 };
  }

  /**
   * Recalculate the money position from facts only. Duplicate facts are collapsed by canonical key,
   * so replaying duplicate notifications can never move any number twice.
   */
  summary(entries: PaymentEntry[], approvedMinorByCurrency: Record<string, number> = {}): PaymentSummary {
    const factsByKey: Record<string, PaymentEntry> = {};
    const currencies = new Set<string>(Object.keys(approvedMinorByCurrency));
    for (const entry of entries) {
      if (entry.status === 'voided') continue;
      currencies.add(entry.amount.currency);
      const key = paymentFactKey(entry.kind, entry.sourceId);
      // First fact for a canonical key wins; any duplicate notification is ignored in every stage.
      factsByKey[key] ??= structuredClone(entry);
    }

    const stages: Record<string, PaymentStageSummary> = {};
    const facts = Object.values(factsByKey);
    const factById = new Map(facts.map((fact) => [fact.id, fact]));

    for (const currency of currencies) {
      const stage = this.emptySummary(currency);
      const inCurrency = facts.filter((entry) => entry.amount.currency === currency);

      const authorizations = inCurrency.filter((fact) => fact.kind === 'authorization');
      // How much of each authorization was drawn down by settlements, and reversed away.
      const drawnByAuthorization = new Map<string, number>();
      for (const settlement of inCurrency.filter((fact) => fact.kind === 'settlement' && fact.authorizationSourceId)) {
        const key = paymentFactKey('authorization', settlement.authorizationSourceId!);
        drawnByAuthorization.set(key, (drawnByAuthorization.get(key) ?? 0) + Math.abs(settlement.amount.minor));
      }
      const reversedAuthorizationByKey = new Map<string, number>();
      let reversedSettlementMinor = 0;
      for (const reversal of inCurrency.filter((fact) => fact.kind === 'reversal')) {
        const original = reversal.originalPaymentId ? factById.get(reversal.originalPaymentId) : undefined;
        const magnitude = Math.abs(reversal.amount.minor);
        if (original?.kind === 'authorization') reversedAuthorizationByKey.set(paymentFactKey('authorization', original.sourceId), (reversedAuthorizationByKey.get(paymentFactKey('authorization', original.sourceId)) ?? 0) + magnitude);
        else reversedSettlementMinor += magnitude;
      }

      let authorizedMinor = 0;
      for (const authorization of authorizations) {
        const key = paymentFactKey('authorization', authorization.sourceId);
        const remaining = authorization.amount.minor - (drawnByAuthorization.get(key) ?? 0) - (reversedAuthorizationByKey.get(key) ?? 0);
        authorizedMinor += Math.max(0, remaining);
      }

      stage.authorizedMinor = authorizedMinor;
      stage.settledMinor = inCurrency.filter((fact) => fact.kind === 'settlement').reduce((sum, fact) => sum + fact.amount.minor, 0);
      stage.reversedMinor = reversedSettlementMinor;
      stage.recoveredMinor = inCurrency.filter((fact) => fact.kind === 'recovery').reduce((sum, fact) => sum + Math.abs(fact.amount.minor), 0);
      stage.netPaidMinor = stage.settledMinor - stage.reversedMinor - stage.recoveredMinor;
      stage.recoverableMinor = Math.max(0, stage.netPaidMinor);
      // Open holds plus net money out is the approved capacity currently consumed.
      stage.committedMinor = stage.authorizedMinor + Math.max(0, stage.netPaidMinor);
      stages[currency] = stage;
    }

    return { stages, factsByKey };
  }
}
