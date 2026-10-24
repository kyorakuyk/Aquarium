import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProtocolAdapter } from '../src/adapters/types.ts';
import { createAccountInteractionRuntime } from '../src/app/interactions.ts';
import { createAffinityService } from '../src/core/affinity/service.ts';
import { createManagementCommands } from '../src/core/conversation/management.ts';
import { createRateLimiter } from '../src/core/shared/rate-limit.ts';
import { createSleepWakeState } from '../src/core/sleep/index.ts';
import {
  createReactionRuleService,
  isClosingMention,
  isPositiveSocialMessage,
  isSeriousTopic,
  loadEmojiWhitelist,
  selectEmoji,
  type ReactionAttempt,
  type ReactionRuleService,
} from '../src/core/interactions/reaction-rules.ts';
import type { InteractionDecision } from '../src/core/interactions/model.ts';
import type { MoodBand } from '../src/store/affect-repo.ts';
import { createInteractionLogRepository } from '../src/store/interaction-log-repo.ts';
import { openDatabase } from '../src/store/db.ts';
import { createRepository } from '../src/store/repository.ts';
import { sessionId } from '../src/core/shared/events.ts';
import {
  baseTime,
  createProactiveHarness,
  groupSession,
  makeConfig,
  makeIncoming,
  withRepository,
} from './pipeline-test-helpers.ts';

function verifyWhitelistAndClassifiers(): void {
  const whitelist = loadEmojiWhitelist();
  const bands: MoodBand[] = ['low', 'annoyed', 'calm', 'happy', 'excited'];
  assert.deepEqual(Object.keys(whitelist), bands);
  assert.deepEqual(bands.map((band) => whitelist[band].length), [4, 4, 6, 6, 6]);
  const ids = bands.flatMap((band) => whitelist[band].map((entry) => entry.emoji_id));
  assert.equal(new Set(ids).size, ids.length);

  for (const band of bands) {
    const first = selectEmoji(whitelist, band, undefined, () => 0);
    const next = selectEmoji(whitelist, band, first.emoji_id, () => 0);
    assert.ok(whitelist[band].some((entry) => entry.emoji_id === first.emoji_id));
    assert.notEqual(next.emoji_id, first.emoji_id);
  }

  assert.equal(isPositiveSocialMessage('谢谢你，今天终于通过了！'), true);
  assert.equal(isPositiveSocialMessage('我发一张今天拍的照片给你看'), true);
  assert.equal(isPositiveSocialMessage('群里在聊服务器配置'), false);
  assert.equal(isPositiveSocialMessage('我想分享一个坏消息'), false);
  assert.equal(isPositiveSocialMessage('我不想分享'), false);
  assert.equal(isSeriousTopic('我想分享一个坏消息'), true);
  assert.equal(isSeriousTopic('家人生病住院了'), true);
  assert.equal(isSeriousTopic('我今天看了新番，笑死了'), false);
  assert.equal(isClosingMention({ mentionsSelf: true, plainText: '晚安！' }), true);
  assert.equal(isClosingMention({ mentionsSelf: false, plainText: '晚安！' }), false);
  assert.equal(isClosingMention({ mentionsSelf: true, plainText: '晚安，我还有个问题' }), false);
}

async function verifyRuleServiceAndLogging(): Promise<void> {
  const whitelist = loadEmojiWhitelist();
  const gateCalls: Array<{ action: { emojiId: string }; context: Record<string, unknown> }> = [];
  const gate = {
    async check(action: { emojiId: string }, source: string, context: Record<string, unknown>) {
      gateCalls.push({ action, context });
      const reason = typeof context.policyBlockedReason === 'string' ? context.policyBlockedReason : 'executed';
      return {
        action,
        source,
        verdict: reason === 'executed' ? 'executed' : 'blocked',
        reason,
        at: baseTime,
      };
    },
  };
  const service = createReactionRuleService({ gate, whitelist });
  const limits = { perUserPerMinute: 100, perSessionPerMinute: 100, minIntervalSec: 0 };
  const attempt = (message: ReturnType<typeof makeIncoming>, trigger: ReactionAttempt['trigger']) => ({
    message,
    trigger,
    moodBand: 'happy' as const,
    affinityLevel: 'more_than_friends' as const,
    random: () => 0,
    rateLimiter: createRateLimiter(() => baseTime),
    limits,
  });

  const first = await service.tryReact(attempt(makeIncoming({
    session: groupSession, messageId: 'reaction-first', plainText: '谢谢！', mentionsSelf: true,
  }), 'closing_mention'));
  const second = await service.tryReact(attempt(makeIncoming({
    session: groupSession, messageId: 'reaction-second', plainText: '晚安！', mentionsSelf: true,
  }), 'closing_mention'));
  assert.equal(first?.verdict, 'executed');
  assert.equal(second?.verdict, 'executed');
  assert.notEqual(gateCalls[0]?.action.emojiId, gateCalls[1]?.action.emojiId);
  assert.equal(typeof gateCalls[0]?.context.sharedRateLimit, 'function');
  assert.equal(gateCalls[0]?.context.sourceMessageId, 'reaction-first');

  const positiveMessage = makeIncoming({
    session: groupSession, messageId: 'positive-silence', plainText: '谢谢你！',
  });
  assert.equal(await service.tryReact({
    ...attempt(positiveMessage, 'positive_silence'), affinityLevel: 'acquaintance',
  }), undefined);
  const callsBeforeOrdinaryFriend = gateCalls.length;
  assert.equal(await service.tryReact({
    ...attempt(positiveMessage, 'positive_silence'), affinityLevel: 'ordinary_friend',
  }), undefined);
  assert.equal(gateCalls.length, callsBeforeOrdinaryFriend);
  const positiveBoundary = await service.tryReact({
    ...attempt(positiveMessage, 'positive_silence'), random: () => 0.25,
  });
  assert.equal(positiveBoundary?.verdict, 'blocked');
  assert.equal(positiveBoundary?.reason, 'probability_skip');
  const positive = await service.tryReact({
    ...attempt(positiveMessage, 'positive_silence'), random: () => 0.24,
  });
  assert.equal(positive?.verdict, 'executed');
  const scaledPositive = await service.tryReact({
    ...attempt(positiveMessage, 'positive_silence'), probabilityScale: 0.5, random: () => 0.125,
  });
  assert.equal(scaledPositive?.reason, 'probability_skip');

  const closingBoundary = await service.tryReact({
    ...attempt(makeIncoming({
      session: groupSession, messageId: 'closing-boundary', plainText: '晚安', mentionsSelf: true,
    }), 'closing_mention'),
    random: () => 0.6,
  });
  assert.equal(closingBoundary?.reason, 'probability_skip');
  const busyBoundary = await service.tryReact({
    ...attempt(makeIncoming({ session: groupSession, messageId: 'busy-boundary', plainText: 'ordinary' }), 'busy_suppressed'),
    random: () => 0.7,
  });
  assert.equal(busyBoundary?.reason, 'probability_skip');
  assert.equal(gateCalls.length, 7);

  const serious = await service.tryReact(attempt(makeIncoming({
    session: groupSession, messageId: 'serious-reaction', plainText: '家人生病住院了',
  }), 'busy_suppressed'));
  assert.equal(serious?.verdict, 'blocked');
  assert.equal(serious?.reason, 'serious_topic');
  assert.equal(gateCalls[7]?.context.policyBlockedReason, 'serious_topic');
  assert.deepEqual(Object.keys(whitelist), ['low', 'annoyed', 'calm', 'happy', 'excited']);
}

async function verifyRuntimeTargetProtection(): Promise<void> {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    const log = createInteractionLogRepository(database);
    const otherAccount = groupSession.account + 1;
    const kinGroupId = repository.createKinGroup('interaction-test');
    repository.setKinGroupMembers(kinGroupId, [groupSession.account, otherAccount]);
    const id = sessionId(groupSession);
    repository.saveMessage({
      sessionId: id,
      messageId: 'other-kin-message',
      senderId: otherAccount,
      senderName: 'Other bot',
      isSelf: false,
      plainText: 'hello',
      segments: [{ type: 'text', text: 'hello' }],
      time: 1_800_000_000_000,
    });
    repository.saveMessage({
      sessionId: id,
      messageId: 'eligible-message',
      senderId: 42,
      senderName: 'Member',
      isSelf: false,
      plainText: '晚安',
      segments: [{ type: 'text', text: '晚安' }],
      time: 1_800_000_000_000,
    });
    const config = makeConfig({ sessions: { [id]: { interactions: { react: { enabled: true } } } } });
    const emojiId = loadEmojiWhitelist().happy[0]!.emoji_id;
    const adapterCalls: Array<{ messageId: string; emojiId: string }> = [];
    const adapter = {
      account: groupSession.account,
      react: async (_session: unknown, messageId: string, emojiId: string) => {
        adapterCalls.push({ messageId, emojiId });
      },
    } as unknown as ProtocolAdapter;
    const management = createManagementCommands({ getConfig: () => config, repository, adapter });
    const runtime = createAccountInteractionRuntime({
      account: groupSession.account,
      adapter,
      getConfig: () => config,
      repository,
      interactionLogRepository: log,
      sleepWakeState: createSleepWakeState(),
      isMuted: management.isMuted,
      isOnline: () => true,
      now: () => 1_800_000_000_100,
    });

    const result = await runtime.gate.check({
      kind: 'react', session: groupSession, messageId: 'other-kin-message', emojiId,
    });
    assert.equal(result.reason, 'target_is_kin');
    assert.equal(result.verdict, 'blocked');
    assert.equal(adapterCalls.length, 0);

    const executionTime = 1_800_000_000_100;
    const executed = await runtime.reactionService.tryReact({
      message: makeIncoming({
        session: groupSession, messageId: 'eligible-message', plainText: '晚安',
        mentionsSelf: true, time: executionTime - 100,
      }),
      trigger: 'closing_mention',
      moodBand: 'happy',
      random: () => 0,
      rateLimiter: createRateLimiter(() => executionTime),
      limits: { perUserPerMinute: 100, perSessionPerMinute: 100, minIntervalSec: 0 },
    });
    assert.equal(executed?.verdict, 'executed');
    if (executed?.action.kind !== 'react') throw new Error('Expected a reaction decision');
    assert.deepEqual(adapterCalls, [{ messageId: 'eligible-message', emojiId: executed.action.emojiId }]);
    assert.deepEqual(log.interactionLogsForMessage(id, 'eligible-message').map(({ verdict, reason }) => ({ verdict, reason })), [
      { verdict: 'executed', reason: 'executed' },
    ]);

    repository.saveMessage({
      sessionId: id,
      messageId: 'mute-after',
      senderId: 42,
      senderName: 'Member',
      isSelf: false,
      plainText: '晚安',
      segments: [{ type: 'text', text: '晚安' }],
      time: executionTime,
    });
    management.muteAll();
    const muted = await runtime.reactionService.tryReact({
      message: makeIncoming({
        session: groupSession, messageId: 'mute-after', plainText: '晚安',
        mentionsSelf: true, time: executionTime,
      }),
      trigger: 'closing_mention',
      moodBand: 'happy',
      random: () => 0,
      rateLimiter: createRateLimiter(() => executionTime + 1),
      limits: { perUserPerMinute: 100, perSessionPerMinute: 100, minIntervalSec: 0 },
    });
    assert.equal(muted?.verdict, 'blocked');
    assert.equal(muted?.reason, 'muted');
    assert.equal(adapterCalls.length, 1);
    assert.deepEqual(log.interactionLogsForMessage(id, 'mute-after').map(({ verdict, reason }) => ({ verdict, reason })), [
      { verdict: 'blocked', reason: 'muted' },
    ]);
  } finally {
    database.close();
  }
}

function executedReaction(input: ReactionAttempt): InteractionDecision {
  return {
    action: { kind: 'react', session: input.message.session, messageId: input.message.messageId, emojiId: 'test-emoji' },
    source: 'rule',
    verdict: 'executed',
    reason: 'executed',
    at: baseTime,
  };
}

async function verifyPipelineTriggers(): Promise<void> {
  await withRepository(async (repository, personaRoot) => {
    const triggers: string[] = [];
    const reactionService: ReactionRuleService = {
      async tryReact(input) {
        triggers.push(input.trigger);
        return executedReaction(input);
      },
    };
    const busy = createProactiveHarness(repository, personaRoot, {
      mode: 'busy',
      judgeText: '{"probability":0.5,"reason":"low"}',
      reactionService,
    });

    const busyResult = await busy.pipeline(makeIncoming({
      messageId: 'busy-suppressed', plainText: '我今天终于完成了。', time: baseTime - 500,
    }));
    assert.equal(busyResult.reason, 'judge_skip');
    assert.deepEqual(triggers, ['busy_suppressed']);

    const closing = createProactiveHarness(repository, personaRoot, { reactionService });
    const closingResult = await closing.pipeline(makeIncoming({
      messageId: 'closing-mention', plainText: '谢谢！', mentionsSelf: true, time: baseTime - 400,
    }));
    assert.deepEqual(closingResult, { replied: false, reason: 'interaction_reacted' });
    assert.deepEqual(triggers, ['busy_suppressed', 'closing_mention']);
    assert.equal(closing.adapter.sent.length, 0);

    let activeConfig: ReturnType<typeof makeConfig> | undefined;
    const affinityService = createAffinityService({
      repository,
      getConfig: () => activeConfig ?? makeConfig(),
    });
    const positiveCalls: Array<{ trigger: string; affinityLevel?: string; probabilityScale?: number }> = [];
    const activeReactionService: ReactionRuleService = {
      async tryReact(input) {
        positiveCalls.push({
          trigger: input.trigger,
          affinityLevel: input.affinityLevel,
          probabilityScale: input.probabilityScale,
        });
        return undefined;
      },
    };
    const active = createProactiveHarness(repository, personaRoot, {
      mode: 'active',
      judgeText: '{"probability":0.1,"reason":"not needed"}',
      probScale: 0.5,
      reactionService: activeReactionService,
      affinityService,
    });
    activeConfig = active.config;
    affinityService.setManual({
      account: groupSession.account,
      userId: 42,
      value: 70,
      now: baseTime - 1_000,
    });
    const positiveResult = await active.pipeline(makeIncoming({
      messageId: 'positive-silence', plainText: '谢谢你，今天终于通过了。', time: baseTime - 300,
    }));
    assert.equal(positiveResult.reason, 'judge_skip');
    assert.deepEqual(positiveCalls, [{
      trigger: 'positive_silence', affinityLevel: 'more_than_friends', probabilityScale: 0.5,
    }]);
  });
}

test('P1 reaction rules stay allowlisted, gated, conservative, and connected to message routing', async () => {
  verifyWhitelistAndClassifiers();
  await verifyRuleServiceAndLogging();
  await verifyRuntimeTargetProtection();
  await verifyPipelineTriggers();
});
