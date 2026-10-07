import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/index';
import { ClaimState } from '../src/domain/types';

function approvedClaim(app: ReturnType<typeof buildApp>, approvedMinor: number): ClaimState {
  const claim = app.claims.create(
    { policyId: 'P-100', lossAt: '2026-08-01T08:00:00Z', reportedAt: '2026-08-01T09:00:00Z', channel: 'api', participants: [], loss: { currency: 'CNY', gross: 1000 } },
    'test',
  );
  return app.claims.addEvent(claim.id, 'adjustment.approved', { approvedMinor, requiredEvidence: [] }, 'adjuster', `approval:${claim.id}`);
}

const cny = (state: ClaimState) => state.paymentSummary.stages.CNY;

test('gateway retry of the same settlement after timeout produces exactly one fund fact', () => {
  const app = buildApp();
  const claim = approvedClaim(app, 100_000);

  const first = app.payments.settle(claim.id, { amount: 500, currency: 'CNY', sourceId: 'gw-pay-1' }, 'gateway');
  // The claim moves to a new version before the gateway retries (other activity / timeout window).
  app.risks.assess(claim.id, 'system');
  const retry = app.payments.settle(claim.id, { amount: 500, currency: 'CNY', sourceId: 'gw-pay-1' }, 'gateway');

  assert.equal(retry.payments.length, 1, 'retried callback must not append a second ledger entry');
  assert.equal(first.payments[0].id, retry.payments[0].id, 'retry resolves to the same payment fact');
  assert.equal(cny(retry).settledMinor, 50_000);
  assert.equal(cny(retry).netPaidMinor, 50_000);
  assert.equal(app.events.list(claim.id).filter((e) => e.type === 'payment.settled').length, 1);
});

test('a retried callback never trips the approved cap, and conflicting notifications are rejected', () => {
  const app = buildApp();
  const claim = approvedClaim(app, 100_000);

  app.payments.settle(claim.id, { amount: 1000, currency: 'CNY', sourceId: 'gw-pay-2' }, 'gateway');
  const retry = app.payments.settle(claim.id, { amount: 1000, currency: 'CNY', sourceId: 'gw-pay-2' }, 'gateway');
  assert.equal(cny(retry).settledMinor, 100_000, 'duplicate does not accumulate');

  // Same business source id but a different amount is a conflicting callback, not a retry.
  assert.throws(
    () => app.payments.settle(claim.id, { amount: 999, currency: 'CNY', sourceId: 'gw-pay-2' }, 'gateway'),
    /conflicting payment notification/,
  );
  // Genuinely new money still cannot breach the approved payout.
  assert.throws(
    () => app.payments.settle(claim.id, { amount: 0.01, currency: 'CNY', sourceId: 'gw-pay-3' }, 'gateway'),
    /exceeds approved/,
  );
});

test('retried reversal callback posts once, links to the original payment, and cannot over-correct', () => {
  const app = buildApp();
  const claim = approvedClaim(app, 100_000);
  app.payments.settle(claim.id, { amount: 500, currency: 'CNY', sourceId: 'gw-pay-4' }, 'gateway');

  const reversed = app.payments.reverse(claim.id, { amount: 500, currency: 'CNY', sourceId: 'gw-ref-1', originalSourceId: 'gw-pay-4' }, 'gateway');
  const retried = app.payments.reverse(claim.id, { amount: 500, currency: 'CNY', sourceId: 'gw-ref-1', originalSourceId: 'gw-pay-4' }, 'gateway');

  assert.equal(retried.payments.length, 2, 'reversal retry must not post a second correction');
  const reversal = retried.payments.find((p) => p.kind === 'reversal')!;
  assert.equal(reversal.originalSourceId, 'gw-pay-4');
  assert.equal(reversal.originalPaymentId, reversed.payments[0].id);
  assert.equal(cny(retried).reversedMinor, 50_000);
  assert.equal(cny(retried).netPaidMinor, 0);

  // Reversals must correspond to a real original payment.
  assert.throws(
    () => app.payments.reverse(claim.id, { amount: 10, currency: 'CNY', sourceId: 'gw-ref-x', originalSourceId: 'missing' }, 'gateway'),
    /references unknown payment/,
  );
  // Two distinct corrections against one original cannot total more than the original fact.
  assert.throws(
    () => app.payments.reverse(claim.id, { amount: 500, currency: 'CNY', sourceId: 'gw-ref-2', originalSourceId: 'gw-pay-4' }, 'gateway'),
    /corrections exceed original/,
  );
});

test('advance authorization and final payment are separately traceable and do not double-consume the cap', () => {
  const app = buildApp();
  const claim = approvedClaim(app, 100_000);

  // Advance: hold 400.
  const authorized = app.payments.authorize(claim.id, { amount: 400, currency: 'CNY', sourceId: 'gw-auth-1' }, 'gateway');
  assert.equal(cny(authorized).authorizedMinor, 40_000);
  assert.equal(cny(authorized).committedMinor, 40_000);

  // Final payment draws the advance down: the hold is released as money goes out, no double count.
  const advanced = app.payments.settle(claim.id, { amount: 400, currency: 'CNY', sourceId: 'gw-pay-adv', authorizationSourceId: 'gw-auth-1' }, 'gateway');
  assert.equal(cny(advanced).authorizedMinor, 0);
  assert.equal(cny(advanced).settledMinor, 40_000);
  assert.equal(cny(advanced).committedMinor, 40_000);
  assert.equal(advanced.payments.find((p) => p.kind === 'settlement')!.authorizationSourceId, 'gw-auth-1');

  // Tail payment for the remaining approved capacity.
  const settled = app.payments.settle(claim.id, { amount: 600, currency: 'CNY', sourceId: 'gw-pay-final' }, 'gateway');
  assert.equal(cny(settled).settledMinor, 100_000);
  assert.equal(cny(settled).committedMinor, 100_000);
  assert.equal(settled.status, 'settled');

  // Each stage can be reconciled against its own gateway source.
  const sources = settled.payments.map((p) => `${p.kind}:${p.sourceId}`);
  assert.deepEqual(sources, ['authorization:gw-auth-1', 'settlement:gw-pay-adv', 'settlement:gw-pay-final']);
});

test('reversing an unused authorization releases the hold; partial drawdown keeps only the remainder open', () => {
  const app = buildApp();
  const claim = approvedClaim(app, 100_000);

  app.payments.authorize(claim.id, { amount: 400, currency: 'CNY', sourceId: 'gw-auth-2' }, 'gateway');
  app.payments.reverse(claim.id, { amount: 100, currency: 'CNY', sourceId: 'gw-ref-3', originalSourceId: 'gw-auth-2' }, 'gateway');
  const partial = app.claims.get(claim.id);
  assert.equal(cny(partial).authorizedMinor, 30_000, 'reversed part of the hold is released');
  assert.equal(cny(partial).reversedMinor, 0, 'correcting a hold never reduces settled money');

  app.payments.settle(claim.id, { amount: 200, currency: 'CNY', sourceId: 'gw-pay-5', authorizationSourceId: 'gw-auth-2' }, 'gateway');
  const drawn = app.claims.get(claim.id);
  assert.equal(cny(drawn).authorizedMinor, 10_000, 'only the undrawn, unreversed remainder stays held');
  assert.equal(cny(drawn).settledMinor, 20_000);
  assert.equal(cny(drawn).committedMinor, 30_000);
});

test('recovery claws back settled money and duplicate recovery callbacks collapse', () => {
  const app = buildApp();
  const claim = approvedClaim(app, 100_000);
  app.payments.settle(claim.id, { amount: 1000, currency: 'CNY', sourceId: 'gw-pay-6' }, 'gateway');

  app.payments.recover(claim.id, { amount: 100, currency: 'CNY', sourceId: 'gw-rec-1', originalSourceId: 'gw-pay-6' }, 'gateway');
  const retried = app.payments.recover(claim.id, { amount: 100, currency: 'CNY', sourceId: 'gw-rec-1', originalSourceId: 'gw-pay-6' }, 'gateway');
  assert.equal(cny(retried).recoveredMinor, 10_000);
  assert.equal(cny(retried).netPaidMinor, 90_000);
  assert.equal(cny(retried).recoverableMinor, 90_000);

  // Another 900 recovery is allowed (100 + 900 = 1000), one cent more is not.
  app.payments.recover(claim.id, { amount: 900, currency: 'CNY', sourceId: 'gw-rec-2', originalSourceId: 'gw-pay-6' }, 'gateway');
  assert.throws(
    () => app.payments.recover(claim.id, { amount: 0.01, currency: 'CNY', sourceId: 'gw-rec-3', originalSourceId: 'gw-pay-6' }, 'gateway'),
    /corrections exceed original/,
  );
});

test('after stream recovery (replace) and out-of-order duplicates, replay still yields one valid fact per business payment', () => {
  const app = buildApp();
  const claim = approvedClaim(app, 100_000);
  app.payments.settle(claim.id, { amount: 300, currency: 'CNY', sourceId: 'gw-pay-7' }, 'gateway');

  // Simulate service recovery restoring a stream that already contains a duplicated delivery
  // of the same payment.settled notification (same business fact, different event envelope).
  const events = app.events.list(claim.id);
  const settledEvent = events.find((event) => event.type === 'payment.settled')!;
  const duplicatedDelivery = { ...settledEvent, id: 'event_duplicate_delivery', idempotencyKey: 'payment-fact:settlement:gw-pay-7' };
  app.events.replace(claim.id, [...events, duplicatedDelivery]);

  const replayed = app.claims.get(claim.id);
  assert.equal(replayed.payments.length, 1, 'replayed duplicate notification cannot double-write the ledger');
  assert.equal(cny(replayed).settledMinor, 30_000);
  assert.equal(replayed.processedPaymentFacts.size, 1);

  // Gateway retry arriving after recovery resolves to the recovered event and adds nothing.
  const eventCount = app.events.list(claim.id).length;
  const retried = app.payments.settle(claim.id, { amount: 300, currency: 'CNY', sourceId: 'gw-pay-7' }, 'gateway');
  assert.equal(app.events.list(claim.id).length, eventCount);
  assert.equal(retried.payments.length, 1);
  assert.equal(cny(retried).settledMinor, 30_000);
});

test('out-of-order reversal before its original payment is rejected cleanly, then accepted once the payment exists', () => {
  const app = buildApp();
  const claim = approvedClaim(app, 100_000);
  assert.throws(
    () => app.payments.reverse(claim.id, { amount: 50, currency: 'CNY', sourceId: 'gw-ref-4', originalSourceId: 'gw-pay-8' }, 'gateway'),
    /references unknown payment/,
  );
  app.payments.settle(claim.id, { amount: 50, currency: 'CNY', sourceId: 'gw-pay-8' }, 'gateway');
  const reversed = app.payments.reverse(claim.id, { amount: 50, currency: 'CNY', sourceId: 'gw-ref-4', originalSourceId: 'gw-pay-8' }, 'gateway');
  assert.equal(reversed.payments.length, 2);
  assert.equal(cny(reversed).netPaidMinor, 0);
  assert.equal(reversed.status, 'reopened');
});
