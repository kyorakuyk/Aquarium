import assert from 'node:assert/strict';
import test from 'node:test';
import { createInteractionGate } from '../src/core/interactions/gate.ts';
import type { InteractionAction, InteractionSource } from '../src/core/interactions/model.ts';
import { openDatabase } from '../src/store/db.ts';
import { createInteractionLogRepository } from '../src/store/interaction-log-repo.ts';
import type { SessionKey } from '../src/core/shared/events.ts';
import { groupSession, makeConfig } from './pipeline-test-helpers.ts';

interface GateFacts {
  muted?: boolean;
  online?: boolean;
  asleep?: boolean;
  otherKinId?: number;
  botId?: number;
  messageSenderId?: number | null | ((messageId: string) => number);
  messageTime?: number | ((messageId: string) => number);
  selfRole?: 'owner' | 'admin' | 'member';
  adminTargetId?: number;
  unknownRoleId?: number;
  execute?: () => Promise<void>;
  executionFails?: boolean;
}

function makeGate(repository: ReturnType<typeof createInteractionLogRepository>, config: ReturnType<typeof makeConfig>, facts: GateFacts = {}, now: () => number) {
  return createInteractionGate({
    getConfig: () => config,
    log: repository,
    isMuted: () => facts.muted === true,
    isOnline: () => facts.online !== false,
    isAsleep: () => facts.asleep === true,
    isOtherKin: (_account: number, targetId: number) => facts.otherKinId === targetId,
    isMarkedBot: (_account: number, targetId: number) => facts.botId === targetId,
    getMessageSenderId: (_session: unknown, messageId: string) => {
      if (facts.messageSenderId === null) return undefined;
      if (typeof facts.messageSenderId === 'function') return facts.messageSenderId(messageId);
      return facts.messageSenderId ?? 42;
    },
    getMessageTime: (_session: unknown, messageId: string) => typeof facts.messageTime === 'function'
      ? facts.messageTime(messageId) : facts.messageTime,
    getSelfRole: () => facts.selfRole ?? 'admin',
    getTargetRole: (_session: unknown, targetId: number) => facts.unknownRoleId === targetId
      ? undefined : facts.adminTargetId === targetId ? 'admin' : 'member',
    ...(facts.execute
      ? { execute: facts.execute }
      : facts.executionFails ? { execute: async () => { throw new Error('test adapter failure'); } } : {}),
    now,
  });
}

function enable(config: ReturnType<typeof makeConfig>, action: 'react' | 'poke' | 'recall' | 'admin') {
  if (action === 'admin') config.interactions.admin.enabled = true;
  else config.interactions[action].enabled = true;
  return config;
}

test('InteractionGate blocks every safety boundary and records blocked and dry-run outcomes', async () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createInteractionLogRepository(database);
    let clock = 100_000;
    const message = (messageId: string, session: SessionKey = groupSession): InteractionAction => ({ kind: 'react', session, messageId, emojiId: '49' });
    const poke = (targetId: number): InteractionAction => ({ kind: 'poke', session: groupSession, targetId });
    const mute = (targetId: number, seconds = 60): InteractionAction => ({ kind: 'mute', session: groupSession, targetId, seconds });
    const recall = (messageId: string): InteractionAction => ({ kind: 'recall', session: groupSession, messageId, ownMessage: false });
    const adminConfig = enable(makeConfig(), 'admin');
    adminConfig.interactions.master_ids = [adminConfig.owner];
    const targetAdminConfig = enable(makeConfig(), 'admin');
    targetAdminConfig.interactions.master_ids = [targetAdminConfig.owner];
    const adminTargetUnknownConfig = enable(makeConfig(), 'admin');
    adminTargetUnknownConfig.interactions.master_ids = [adminTargetUnknownConfig.owner];
    const ownerTargetConfig = enable(makeConfig(), 'admin');
    ownerTargetConfig.owner = 707;
    ownerTargetConfig.interactions.master_ids = [ownerTargetConfig.owner];
    const notMasterConfig = enable(makeConfig(), 'admin');
    notMasterConfig.interactions.master_ids = [notMasterConfig.owner];
    const recallConfig = enable(makeConfig(), 'recall');
    recallConfig.interactions.recall.others = true;
    recallConfig.interactions.admin.enabled = true;
    recallConfig.interactions.master_ids = [recallConfig.owner];
    const privateSession: SessionKey = { ...groupSession, kind: 'private', peer: 987654 };
    type Scenario = {
      reason: string;
      config: ReturnType<typeof makeConfig>;
      action: InteractionAction;
      source?: InteractionSource;
      requesterId?: number;
      facts: GateFacts;
    };
    const scenarios: Scenario[] = [
      { reason: 'disabled', config: makeConfig(), action: message('disabled'), facts: {} },
      { reason: 'muted', config: enable(makeConfig(), 'react'), action: message('muted'), facts: { muted: true } },
      { reason: 'asleep', config: enable(makeConfig(), 'react'), action: message('asleep'), facts: { asleep: true } },
      { reason: 'offline', config: enable(makeConfig(), 'react'), action: message('offline'), facts: { online: false } },
      { reason: 'group_only', config: enable(makeConfig(), 'react'), action: message('private', privateSession), facts: {} },
      { reason: 'self_target', config: enable(makeConfig(), 'poke'), action: poke(groupSession.account), facts: {} },
      { reason: 'target_is_bot', config: enable(makeConfig(), 'poke'), action: poke(701), facts: { botId: 701 } },
      { reason: 'target_is_kin', config: enable(makeConfig(), 'poke'), action: poke(702), facts: { otherKinId: 702 } },
      { reason: 'target_unknown', config: enable(makeConfig(), 'react'), action: message('unknown'), facts: { messageSenderId: null } },
      { reason: 'owner_command_required', config: adminConfig, action: mute(705), source: 'llm', requesterId: adminConfig.owner, facts: {} },
      { reason: 'not_master', config: notMasterConfig, action: mute(706), source: 'owner_command', requesterId: notMasterConfig.owner + 1, facts: {} },
      { reason: 'not_admin', config: adminConfig, action: mute(703), source: 'owner_command', facts: { selfRole: 'member' } },
      { reason: 'target_is_admin', config: targetAdminConfig, action: mute(704), source: 'owner_command', facts: { adminTargetId: 704 } },
      { reason: 'target_role_unknown', config: adminTargetUnknownConfig, action: mute(708), source: 'owner_command', facts: { unknownRoleId: 708 } },
      { reason: 'target_is_owner', config: ownerTargetConfig, action: mute(ownerTargetConfig.owner), source: 'owner_command', facts: {} },
      { reason: 'mute_too_long', config: adminConfig, action: mute(709, 601), source: 'owner_command', facts: {} },
      { reason: 'message_unavailable_or_old', config: recallConfig, action: recall('old-message'), source: 'owner_command', facts: {} },
    ];
    for (const [index, scenario] of scenarios.entries()) {
      const result = await makeGate(repository, scenario.config, scenario.facts, () => clock + index)
        .check(scenario.action, scenario.source ?? 'rule', { requesterId: scenario.requesterId ?? scenario.config.owner });
      assert.equal(result.verdict, 'blocked');
      assert.equal(result.reason, scenario.reason);
    }

    const failureConfig = enable(makeConfig(), 'react');
    for (let index = 0; index < 3; index += 1) {
      const failed = await makeGate(repository, failureConfig, {
        executionFails: true,
        messageSenderId: 900 + index,
      }, () => clock + index).check(message(`failed-${index}`), 'rule');
      assert.equal(failed.verdict, 'failed');
    }
    const cooled = await makeGate(repository, failureConfig, { messageSenderId: 999 }, () => clock + 3)
      .check(message('cooldown'), 'rule');
    assert.equal(cooled.reason, 'failure_cooldown');

    const selfRecallConfig = enable(makeConfig(), 'recall');
    const selfRecall = await makeGate(repository, selfRecallConfig, { asleep: true }, () => clock + 4)
      .check({ kind: 'recall', session: groupSession, messageId: 'own-recall', ownMessage: true }, 'rule');
    assert.equal(selfRecall.verdict, 'dry_run');

    database.exec('DELETE FROM interaction_log');
    clock = 500_000;
    const recallRateConfig = enable(makeConfig(), 'recall');
    recallRateConfig.interactions.recall.others = true;
    recallRateConfig.interactions.admin.enabled = true;
    recallRateConfig.interactions.master_ids = [recallRateConfig.owner];
    for (let index = 0; index < 5; index += 1) {
      const at = clock + index * 60_001;
      const sent = await makeGate(repository, recallRateConfig, {
        messageSenderId: 920 + index,
        messageTime: at - 1_000,
      }, () => at).check(recall(`recall-${index}`), 'owner_command', { requesterId: recallRateConfig.owner });
      assert.equal(sent.verdict, 'dry_run');
    }
    const recallLimitedAt = clock + 5 * 60_001;
    const recallLimited = await makeGate(repository, recallRateConfig, {
      messageSenderId: 930,
      messageTime: recallLimitedAt - 1_000,
    }, () => recallLimitedAt).check(recall('recall-limited'), 'owner_command', { requesterId: recallRateConfig.owner });
    assert.equal(recallLimited.reason, 'rate_limit:recall:group_hour');

    const allowed = await makeGate(repository, enable(makeConfig(), 'poke'), {}, () => clock + 4)
      .check(poke(710), 'rule', { sourceMessageId: 'dry-run' });
    assert.equal(allowed.verdict, 'dry_run');
    assert.equal(repository.interactionLogsForMessage(`${groupSession.account}:group:${groupSession.peer}`, 'dry-run').length, 1);
  } finally {
    database.close();
  }
});

test('InteractionGate enforces per-account minute, per-action hour and per-sender gap windows', async () => {
  let clock = 100_000;
  const database = openDatabase(':memory:');
  try {
    const repository = createInteractionLogRepository(database);
    const config = enable(makeConfig(), 'react');
    const action = (index: number) => ({ kind: 'react', session: groupSession, messageId: `rate-${index}`, emojiId: '49' });
    const senderFromMessage = (messageId: string) => 800 + Number(messageId.split('-').at(-1));
    const makeRateGate = (sender = senderFromMessage) => makeGate(repository, config, { messageSenderId: sender }, () => clock);

    for (let index = 0; index < 4; index += 1) {
      assert.equal((await makeRateGate().check(action(index), 'rule')).verdict, 'dry_run');
    }
    const fifth = await makeRateGate().check(action(4), 'rule');
    assert.equal(fifth.reason, 'rate_limit:react:minute');

    clock += 60_001;
    assert.equal((await makeRateGate().check(action(5), 'rule')).verdict, 'dry_run');

    database.exec('DELETE FROM interaction_log');
    clock = 200_000;
    config.interactions.react.per_hour_max = 1;
    assert.equal((await makeRateGate().check(action(6), 'rule')).verdict, 'dry_run');
    clock += 60_001;
    assert.equal((await makeRateGate().check(action(7), 'rule')).reason, 'rate_limit:react:hour');

    database.exec('DELETE FROM interaction_log');
    clock = 300_000;
    config.interactions.react.per_hour_max = 12;
    config.interactions.react.per_sender_gap_s = 60;
    const sameSender = makeRateGate(() => 999);
    assert.equal((await sameSender.check(action(8), 'rule')).verdict, 'dry_run');
    assert.equal((await sameSender.check(action(9), 'rule')).reason, 'rate_limit:react:sender');
    clock += 60_000;
    assert.equal((await sameSender.check(action(10), 'rule')).verdict, 'dry_run');

    database.exec('DELETE FROM interaction_log');
    clock = 400_000;
    let arrivals = 0;
    let concurrent = 0;
    let maxConcurrent = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const concurrentGate = makeGate(repository, config, {
      messageSenderId: senderFromMessage,
      execute: async () => {
        arrivals += 1;
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        if (arrivals === 1) await barrier;
        concurrent -= 1;
      },
    }, () => clock);
    const pending = Array.from({ length: 5 }, (_, index) => concurrentGate.check(action(20 + index), 'rule'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    const results = await Promise.all(pending);
    assert.equal(maxConcurrent, 1);
    assert.equal(results.filter((result) => result.verdict === 'executed').length, 4);
    assert.equal(results.filter((result) => result.reason === 'rate_limit:react:minute').length, 1);
  } finally {
    database.close();
  }
});
