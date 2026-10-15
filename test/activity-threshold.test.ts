import assert from 'node:assert/strict';
import test from 'node:test';
import { createActivityThreshold } from '../src/core/activity/threshold.ts';

type ProactiveMode = 'natural' | 'active' | 'busy';

function recordJudgments(
  threshold: ReturnType<typeof createActivityThreshold>,
  sessionId: string,
  mode: ProactiveMode,
  count: number,
  firstAt: number,
): void {
  for (let index = 0; index < count; index += 1) {
    threshold.recordJudgment(sessionId, mode, 0.8, firstAt + index * 1_000);
  }
}

test('uses each mode initial threshold until fewer than four expectations remain in the 60-minute window', () => {
  const threshold = createActivityThreshold();

  assert.equal(threshold.getThreshold('natural-session', 'natural', 0), 0.5);
  assert.equal(threshold.getThreshold('active-session', 'active', 0), 0.35);
  assert.equal(threshold.getThreshold('busy-session', 'busy', 0), 0.7);
  recordJudgments(threshold, 'active-session', 'active', 3, 0);
  assert.equal(threshold.getThreshold('active-session', 'active', 2_000), 0.35);
  assert.equal(threshold.getThreshold('active-session', 'active', 3_602_001), 0.35);
});

test('raises the threshold when actual replies exceed the mode target frequency', () => {
  const threshold = createActivityThreshold();
  recordJudgments(threshold, 'account:group:1', 'natural', 3, 0);
  for (let index = 0; index < 3; index += 1) {
    threshold.recordProactiveReply('account:group:1', 'natural', 3_000 + index * 1_000);
  }

  const appliedThreshold = threshold.getThreshold('account:group:1', 'natural', 6_000);
  assert.equal(threshold.recordJudgment('account:group:1', 'natural', 0.8, 6_000), undefined);
  assert.equal(appliedThreshold, 0.5);
  assert.equal(threshold.getThreshold('account:group:1', 'natural', 6_000), 0.55);
});

test('leaves the threshold unchanged when actual replies equal the mode target', () => {
  const threshold = createActivityThreshold();
  recordJudgments(threshold, 'account:group:1', 'natural', 3, 0);
  for (let index = 0; index < 2; index += 1) {
    threshold.recordProactiveReply('account:group:1', 'natural', 3_000 + index * 1_000);
  }

  threshold.recordJudgment('account:group:1', 'natural', 0.8, 5_000);
  assert.equal(threshold.getThreshold('account:group:1', 'natural', 5_000), 0.5);
});

test('low actual replies lower the threshold and the mode frequency coefficient is applied', () => {
  const threshold = createActivityThreshold();
  recordJudgments(threshold, 'natural-session', 'natural', 3, 0);
  assert.equal(threshold.getThreshold('natural-session', 'natural', 3_000), 0.5);
  threshold.recordJudgment('natural-session', 'natural', 0.8, 3_000);
  assert.equal(threshold.getThreshold('natural-session', 'natural', 3_000), 0.45);

  recordJudgments(threshold, 'active-session', 'active', 3, 0);
  for (let index = 0; index < 3; index += 1) {
    threshold.recordProactiveReply('active-session', 'active', 3_000 + index * 1_000);
  }
  assert.equal(threshold.getThreshold('active-session', 'active', 6_000), 0.35);
  threshold.recordJudgment('active-session', 'active', 0.8, 6_000);
  assert.equal(threshold.getThreshold('active-session', 'active', 6_000), 0.3);

  recordJudgments(threshold, 'busy-session', 'busy', 3, 0);
  threshold.recordProactiveReply('busy-session', 'busy', 3_000);
  assert.equal(threshold.getThreshold('busy-session', 'busy', 4_000), 0.7);
  threshold.recordJudgment('busy-session', 'busy', 0.8, 4_000);
  assert.equal(threshold.getThreshold('busy-session', 'busy', 4_000), 0.75);
});

test('clamps dynamic thresholds to the configured minimum and maximum', () => {
  const threshold = createActivityThreshold();
  recordJudgments(threshold, 'low-session', 'natural', 20, 0);
  assert.equal(threshold.getThreshold('low-session', 'natural', 19_000), 0.2);

  for (let index = 0; index < 20; index += 1) {
    threshold.recordProactiveReply('high-session', 'active', index * 1_000);
  }
  recordJudgments(threshold, 'high-session', 'active', 14, 20_000);
  assert.equal(threshold.getThreshold('high-session', 'active', 33_000), 0.9);
});

test('expires expected judgments and actual replies outside the rolling hour', () => {
  const threshold = createActivityThreshold();
  for (let index = 0; index < 3; index += 1) {
    threshold.recordProactiveReply('account:group:1', 'natural', index * 1_000);
  }
  recordJudgments(threshold, 'account:group:1', 'natural', 3, 3_600_001);
  assert.equal(threshold.getThreshold('account:group:1', 'natural', 3_603_001), 0.5);
  threshold.recordJudgment('account:group:1', 'natural', 0.8, 3_603_001);
  assert.equal(threshold.getThreshold('account:group:1', 'natural', 3_603_001), 0.45);
  assert.equal(threshold.getThreshold('account:group:1', 'natural', 7_203_002), 0.5);
});

test('includes an expected judgment exactly at the rolling 60-minute cutoff', () => {
  const threshold = createActivityThreshold();
  recordJudgments(threshold, 'account:group:1', 'natural', 3, 0);

  threshold.recordJudgment('account:group:1', 'natural', 0.8, 3_600_000);
  assert.equal(threshold.getThreshold('account:group:1', 'natural', 3_600_000), 0.45);
});

test('enforces the 120-second proactive cooldown per session with an inclusive deadline', () => {
  const threshold = createActivityThreshold();
  threshold.recordProactiveReply('account:group:1', 'natural', 1_000);

  assert.equal(threshold.isProactiveCooldown('account:group:1', 120_999), true);
  assert.equal(threshold.isProactiveCooldown('account:group:1', 121_000), false);
  assert.equal(threshold.isProactiveCooldown('account:group:2', 120_999), false);
  assert.equal(threshold.isProactiveCooldown('account:group:1', 999), true);
});
