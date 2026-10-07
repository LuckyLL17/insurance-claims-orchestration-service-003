import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/index';

test('creates a claim with a historical policy snapshot and replays it', () => {
  const app = buildApp();
  const claim = app.claims.create({ policyId: 'P-100', lossAt: '2026-08-01T08:00:00Z', reportedAt: '2026-08-01T09:00:00Z', channel: 'mobile', participants: [{ kind: 'vehicle', id: 'car-1' }], loss: { currency: 'CNY', gross: 18000 } }, 'test', 'claim-key');
  assert.equal(claim.policy?.version, 2);
  const evidence = app.claims.addEvidence(claim.id, { kind: 'loss-photo', source: 'mobile', content: { image: 'a' } }, 'test');
  const reviewed = app.claims.reviewEvidence(evidence.id, evidence.evidence[0].id, true, 'adjuster');
  assert.equal(reviewed.evidence[0].accepted, true);
  assert.equal(app.replay.execute(claim.id).state.version, reviewed.version);
});

test('prevents payment over approved amount and accepts idempotent risk assessment', () => {
  const app = buildApp();
  const claim = app.claims.create({ policyId: 'P-100', lossAt: '2026-08-01T08:00:00Z', reportedAt: '2026-08-01T09:00:00Z', channel: 'agent', participants: [{ kind: 'vehicle', id: 'car-2' }, { kind: 'repair_shop', id: 'shop-1' }], loss: { currency: 'CNY', gross: 18000 } }, 'test');
  app.claims.addEvidence(claim.id, { kind: 'loss-photo', source: 'agent', content: 'photo' }, 'test');
  const assessed = app.risks.assess(claim.id, 'risk');
  assert.equal(assessed.riskScore, 0);
  assert.throws(() => app.payments.settle(claim.id, { amount: 1, currency: 'CNY', sourceId: 'p-1' }, 'pay'), /exceeds approved/);
});

test('rejects stale task submissions after lease version changes', () => {
  const app = buildApp();
  const claim = app.claims.create({ policyId: 'P-100', lossAt: '2026-08-01T08:00:00Z', reportedAt: '2026-08-01T09:00:00Z', channel: 'agent', participants: [], loss: { currency: 'CNY', gross: 3000 } }, 'test');
  const task = app.tasks.create(claim.id, 'survey'); const lease = app.tasks.lease(claim.id, task.id, 'adjuster-a', 60_000);
  assert.throws(() => app.tasks.submit(claim.id, task.id, 'adjuster-a', lease.version - 1, {}, 'adjuster-a'), /stale/);
});

const approvedClaim = (app: ReturnType<typeof buildApp>, approvedMinor: number) => {
  const claim = app.claims.create({ policyId: 'P-100', lossAt: '2026-08-01T08:00:00Z', reportedAt: '2026-08-01T09:00:00Z', channel: 'mobile', participants: [{ kind: 'person', id: 'person-1' }], loss: { currency: 'CNY', gross: 18000 } }, 'test');
  app.claims.addEvent(claim.id, 'adjustment.approved', { approvedMinor, requiredEvidence: [] }, 'adjuster');
  return claim;
};

test('gateway retries of the same payment produce a single money fact', () => {
  const app = buildApp();
  const claim = approvedClaim(app, 100_00);
  const first = app.payments.settle(claim.id, { amount: 100, currency: 'CNY', sourceId: 'pay-1' }, 'gateway');
  app.claims.addEvidence(claim.id, { kind: 'receipt', source: 'repair_shop', content: 'invoice' }, 'test');
  const retried = app.payments.settle(claim.id, { amount: 100, currency: 'CNY', sourceId: 'pay-1' }, 'gateway');
  assert.equal(retried.payments.length, 1);
  assert.equal(retried.payments[0].id, first.payments[0].id);
  assert.equal(app.replay.execute(claim.id).events.filter((event) => event.type === 'payment.settled').length, 1);
  assert.equal(app.replay.execute(claim.id).state.payments.length, 1);
  assert.throws(() => app.payments.settle(claim.id, { amount: 60, currency: 'CNY', sourceId: 'pay-1' }, 'gateway'), /conflicting/);
});

test('staged advance and final payments are capped by the approved amount and retries stay within it', () => {
  const app = buildApp();
  const claim = approvedClaim(app, 100_00);
  app.payments.settle(claim.id, { amount: 60, currency: 'CNY', sourceId: 'advance-1' }, 'gateway');
  app.payments.settle(claim.id, { amount: 40, currency: 'CNY', sourceId: 'final-1' }, 'gateway');
  assert.throws(() => app.payments.settle(claim.id, { amount: 0.01, currency: 'CNY', sourceId: 'extra-1' }, 'gateway'), /exceeds approved/);
  const retry = app.payments.settle(claim.id, { amount: 40, currency: 'CNY', sourceId: 'final-1' }, 'gateway');
  assert.equal(retry.payments.length, 2);
  assert.equal(app.payments.summary(claim.id).netPaidMinor, 100_00);
});

test('reversals reconcile to their original payment and duplicate callbacks post once', () => {
  const app = buildApp();
  const claim = approvedClaim(app, 100_00);
  app.payments.settle(claim.id, { amount: 100, currency: 'CNY', sourceId: 'pay-1' }, 'gateway');
  assert.throws(() => app.payments.reverse(claim.id, { amount: 10, currency: 'CNY', sourceId: 'rev-0' }, 'gateway'), /original payment source/);
  assert.throws(() => app.payments.reverse(claim.id, { amount: 10, currency: 'CNY', sourceId: 'rev-0', reverses: 'ghost' }, 'gateway'), /unknown payment source/);
  app.payments.reverse(claim.id, { amount: 40, currency: 'CNY', sourceId: 'rev-1', reverses: 'pay-1' }, 'gateway');
  const duplicate = app.payments.reverse(claim.id, { amount: 40, currency: 'CNY', sourceId: 'rev-1', reverses: 'pay-1' }, 'gateway');
  assert.equal(duplicate.payments.filter((entry) => entry.kind === 'reversal').length, 1);
  assert.equal(app.payments.summary(claim.id).netPaidMinor, 60_00);
  assert.throws(() => app.payments.reverse(claim.id, { amount: 60.01, currency: 'CNY', sourceId: 'rev-2', reverses: 'pay-1' }, 'gateway'), /exceeds reversible/);
  app.payments.reverse(claim.id, { amount: 60, currency: 'CNY', sourceId: 'rev-2', reverses: 'pay-1' }, 'gateway');
  const sourced = app.replay.execute(claim.id).state;
  assert.equal(app.payments.summary(claim.id).netPaidMinor, 0);
  assert.equal(sourced.payments.filter((entry) => entry.kind === 'reversal').length, 2);
});

test('replay after duplicate notifications still yields one effective money fact', () => {
  const app = buildApp();
  const claim = approvedClaim(app, 100_00);
  const settled = app.payments.settle(claim.id, { amount: 100, currency: 'CNY', sourceId: 'pay-1' }, 'gateway');
  app.claims.addEvent(claim.id, 'payment.settled', { payment: settled.payments[0] }, 'gateway', 'payment:settlement:retry-envelope');
  app.claims.addEvent(claim.id, 'payment.settled', { payment: { ...settled.payments[0], id: 'payment_legacy-duplicate' } }, 'gateway', 'payment:settlement:legacy');
  const replayed = app.replay.execute(claim.id);
  assert.equal(replayed.state.payments.length, 1);
  assert.equal(replayed.paymentSummary.netPaidMinor, 100_00);
  assert.equal(replayed.paymentSummary.settledMinor, 100_00);
});

test('recompute distinguishes authorized, settled, reversed and recoverable amounts', () => {
  const app = buildApp();
  const claim = approvedClaim(app, 200_00);
  app.payments.authorize(claim.id, { amount: 100, currency: 'CNY', sourceId: 'pay-1' }, 'gateway');
  assert.equal(app.payments.summary(claim.id).authorizedMinor, 100_00);
  app.payments.settle(claim.id, { amount: 100, currency: 'CNY', sourceId: 'pay-1' }, 'gateway');
  app.payments.authorize(claim.id, { amount: 50, currency: 'CNY', sourceId: 'pay-2' }, 'gateway');
  app.payments.reverse(claim.id, { amount: 30, currency: 'CNY', sourceId: 'rev-1', reverses: 'pay-1' }, 'gateway');
  const summary = app.replay.execute(claim.id).paymentSummary;
  assert.deepEqual(summary, { authorizedMinor: 50_00, settledMinor: 100_00, reversedMinor: 30_00, recoveredMinor: 0, netPaidMinor: 70_00, recoverableMinor: 70_00 });
  assert.throws(() => app.payments.authorize(claim.id, { amount: 80.01, currency: 'CNY', sourceId: 'pay-3' }, 'gateway'), /exceeds approved/);
});
