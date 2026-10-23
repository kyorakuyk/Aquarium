import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decide,
  type PrivacyDecisionInput,
  type PrivacyInfo,
  type PrivacyTarget,
} from '../src/core/privacy/policy.ts';

const privateInfo: PrivacyInfo = {
  origin: 'private',
  sessionId: '900000001:private:42',
  ownerId: 42,
  level: 'L0',
};
const privateTarget: PrivacyTarget = { kind: 'private', sessionId: '900000001:private:99', peerId: 99 };
const groupTarget: PrivacyTarget = { kind: 'group', sessionId: '900000001:group:123456' };

function scenario(patch: Partial<PrivacyDecisionInput> = {}): PrivacyDecisionInput {
  return {
    info: patch.info ?? privateInfo,
    target: patch.target ?? groupTarget,
    purpose: patch.purpose ?? 'prompt',
  };
}

test('privacy policy applies the ordered scope rules to every purpose', () => {
  const sameSessionInfo: PrivacyInfo = { ...privateInfo, sessionId: 'same-session' };
  const sameSessionTarget: PrivacyTarget = { kind: 'private', sessionId: 'same-session', peerId: 42 };
  const groupInfo: PrivacyInfo = { origin: 'group', sessionId: 'source-group', ownerId: 99 };
  const cases: Array<{ name: string; input: PrivacyDecisionInput; expected: string }> = [
    { name: 'same-session prompt', input: scenario({ info: sameSessionInfo, target: sameSessionTarget }), expected: 'allow' },
    { name: 'same-session gate', input: scenario({ info: sameSessionInfo, target: sameSessionTarget, purpose: 'gate' }), expected: 'allow' },
    { name: 'same-session third-party', input: scenario({ info: sameSessionInfo, target: sameSessionTarget, purpose: 'third_party' }), expected: 'deny' },
    { name: 'private-to-group gate', input: scenario({ purpose: 'gate' }), expected: 'gate_only' },
    { name: 'private L0 to group prompt', input: scenario(), expected: 'deny' },
    { name: 'private L1 to group prompt', input: scenario({ info: { ...privateInfo, level: 'L1' } }), expected: 'allow' },
    { name: 'private L2 to group prompt', input: scenario({ info: { ...privateInfo, level: 'L2' } }), expected: 'allow' },
    { name: 'private L0 to kin prompt', input: scenario({ target: { kind: 'kin', groupId: 1 } as PrivacyTarget }), expected: 'deny' },
    { name: 'private L1 to kin prompt', input: scenario({
      info: { ...privateInfo, level: 'L1' }, target: { kind: 'kin', groupId: 1 } as PrivacyTarget,
    }), expected: 'allow' },
    { name: 'private L2 to kin prompt', input: scenario({
      info: { ...privateInfo, level: 'L2' }, target: { kind: 'kin', groupId: 1 } as PrivacyTarget,
    }), expected: 'allow' },
    { name: 'private L2 to kin third party', input: scenario({
      info: { ...privateInfo, level: 'L2' }, target: { kind: 'kin', groupId: 1 } as PrivacyTarget,
      purpose: 'third_party',
    }), expected: 'deny' },
    { name: 'group fact to kin prompt', input: scenario({
      info: groupInfo, target: { kind: 'kin', groupId: 1 } as PrivacyTarget,
    }), expected: 'allow' },
    { name: 'private-to-group third-party', input: scenario({ purpose: 'third_party' }), expected: 'deny' },
    { name: 'private-to-other-private prompt', input: scenario({ target: privateTarget }), expected: 'deny' },
    { name: 'private-to-other-private gate', input: scenario({ target: privateTarget, purpose: 'gate' }), expected: 'deny' },
    { name: 'private-to-other-private third-party', input: scenario({ target: privateTarget, purpose: 'third_party' }), expected: 'deny' },
    { name: 'group fact about this private target', input: scenario({
      info: groupInfo,
      target: { kind: 'private', sessionId: 'target-private', peerId: 99 },
    }), expected: 'allow' },
    { name: 'group fact about target for gate', input: scenario({
      info: groupInfo,
      target: { kind: 'private', sessionId: 'target-private', peerId: 99 },
      purpose: 'gate',
    }), expected: 'deny' },
    { name: 'group fact about target for third party', input: scenario({
      info: groupInfo,
      target: { kind: 'private', sessionId: 'target-private', peerId: 99 },
      purpose: 'third_party',
    }), expected: 'deny' },
    { name: 'group fact about a different private target', input: scenario({
      info: groupInfo,
      target: { kind: 'private', sessionId: 'target-private', peerId: 100 },
    }), expected: 'deny' },
    { name: 'unrelated group prompt', input: scenario({
      info: groupInfo,
      target: { kind: 'group', sessionId: 'other-group' },
    }), expected: 'deny' },
    { name: 'unrelated group gate', input: scenario({
      info: groupInfo,
      target: { kind: 'group', sessionId: 'other-group' },
      purpose: 'gate',
    }), expected: 'deny' },
    { name: 'unrelated group third party', input: scenario({
      info: groupInfo,
      target: { kind: 'group', sessionId: 'other-group' },
      purpose: 'third_party',
    }), expected: 'deny' },
  ];

  for (const { name, input, expected } of cases) assert.equal(decide(input), expected, name);
});

test('group events reach only a source-group member in a private prompt', () => {
  const info = {
    origin: 'group',
    sessionId: '900000001:group:123456',
    ownerId: null,
    eventGroupMemberIds: [99],
  } as PrivacyInfo;
  const target: PrivacyTarget = { kind: 'private', sessionId: '900000001:private:99', peerId: 99 };
  const input: PrivacyDecisionInput = { info, target, purpose: 'prompt' };

  assert.equal(decide(input), 'allow');
  assert.equal(decide({ ...input, target: { ...target, peerId: 100 } }), 'deny');
  assert.equal(decide({ ...input, purpose: 'gate' }), 'deny');
  assert.equal(decide({ ...input, purpose: 'third_party' }), 'deny');
  assert.equal(decide({
    ...input,
    info: { ...info, eventGroupMemberIds: ['99'] } as unknown as PrivacyInfo,
  }), 'deny');
});

test('event-note intent is enforced by the shared privacy decision', () => {
  const target: PrivacyTarget = { kind: 'group', sessionId: '900000001:group:123456' };
  const privateNote = {
    origin: 'private',
    sessionId: '900000001:private:99',
    ownerId: 99,
    level: 'L1',
    eventIntent: 'clarify',
  } as PrivacyInfo;

  assert.equal(decide({ info: privateNote, target, purpose: 'prompt' }), 'allow');
  assert.equal(decide({ info: privateNote, target, purpose: 'gate' }), 'gate_only');
  assert.equal(decide({
    info: { ...privateNote, eventIntent: 'advocate', level: 'L2', eventAdvocacyConfirmed: true }, target, purpose: 'prompt',
  }), 'deny');
  assert.equal(decide({
    info: { ...privateNote, eventIntent: 'confide', level: 'L2' }, target, purpose: 'prompt',
  }), 'deny');
  assert.equal(decide({
    info: { ...privateNote, eventIntent: 'private' } as unknown as PrivacyInfo,
    target,
    purpose: 'prompt',
  }), 'deny');
});

test('advocate notes require confirmation and L2 for proactive group delivery', () => {
  const target: PrivacyTarget = { kind: 'group', sessionId: '900000001:group:123456' };
  const advocate: PrivacyInfo = {
    origin: 'private',
    sessionId: '900000001:private:99',
    ownerId: 99,
    level: 'L2',
    eventIntent: 'advocate',
  };

  assert.equal(decide({ info: advocate, target, purpose: 'prompt' }), 'deny');
  assert.equal(decide({ info: { ...advocate, eventAdvocacyConfirmed: true }, target, purpose: 'prompt' }), 'deny');
  assert.equal(decide({
    info: { ...advocate, eventAdvocacyConfirmed: true }, target, purpose: 'proactive',
  }), 'allow');
  assert.equal(decide({
    info: { ...advocate, level: 'L1', eventAdvocacyConfirmed: true }, target, purpose: 'proactive',
  }), 'deny');
  assert.equal(decide({
    info: { ...advocate, eventIntent: 'clarify', eventAdvocacyConfirmed: true }, target, purpose: 'proactive',
  }), 'deny');
});

test('privacy policy denies malformed inputs and missing required fields', () => {
  const malformed: unknown[] = [
    null,
    undefined,
    {},
    { ...scenario(), info: { sessionId: 'source' } },
    { ...scenario(), info: { ...privateInfo, ownerId: undefined } },
    { ...scenario(), target: { sessionId: 'target' } },
    { ...scenario(), target: { ...groupTarget, sessionId: undefined } },
    { ...scenario(), purpose: 'unknown' },
    { ...scenario(), info: { ...privateInfo, ownerId: null, level: 'L2' } },
    { ...scenario(), info: { ...privateInfo, level: 'L3' } },
    { ...scenario(), info: { ...privateInfo, level: undefined } },
    { ...scenario(), info: { ...privateInfo, eventAdvocacyConfirmed: true } },
  ];

  for (const input of malformed) assert.equal(decide(input as PrivacyDecisionInput), 'deny');
});
