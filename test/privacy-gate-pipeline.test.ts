import assert from 'node:assert/strict';
import test from 'node:test';
import { AquariumConfigSchema } from '../src/config/schema.ts';
import { sessionId } from '../src/core/events.ts';
import { createMessagePipeline } from '../src/core/pipeline.ts';
import { createPrivacyGateService } from '../src/core/privacy/group-gate.ts';
import type { PrivateFactRecord } from '../src/store/privacy-repo.ts';
import {
  baseTime,
  FakeAdapter,
  groupSession,
  makeConfig,
  makeIncoming,
  withRepository,
} from './pipeline-test-helpers.ts';

function fact(text: string): Omit<PrivateFactRecord, 'id'> {
  return {
    account: groupSession.account,
    ownerId: 42,
    sessionId: `${groupSession.account}:private:42`,
    text,
    keywords: ['考研', '压力'],
    level: 'L0',
    levelSource: 'auto',
    mentions: 0,
    mentionEvidence: [],
    evidence: [],
    status: 'active',
    createdAt: baseTime,
    updatedAt: baseTime,
  };
}

async function runGroupReply(options: { replyText: string; touchFact: boolean }) {
  return withRepository(async (repository, personaRoot) => {
    const privateText = '最近在准备考研，承受压力很大';
    const factId = repository.insertPrivateFact(fact(privateText));
    const baseConfig = makeConfig();
    const config = AquariumConfigSchema.parse({
      ...baseConfig,
      debug: { ...baseConfig.debug, enabled: true },
    });
    const adapter = new FakeAdapter();
    let gateTraceEnabled: boolean | undefined;
    let replyTraceEnabled: boolean | undefined;
    let replyPromptText = '';
    const privacyGateService = createPrivacyGateService({
      repository,
      getConfig: () => config,
      callModel: async (_slot, messages, callOptions) => {
        gateTraceEnabled = callOptions.debugTrace !== undefined;
        assert.ok(String(messages[1]?.content).includes(privateText));
        return {
          text: JSON.stringify({ touches: options.touchFact ? [factId] : [] }),
          provider: 'fake',
          model: 'fake-judge',
          usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
        };
      },
    });
    const pipeline = createMessagePipeline({
      getConfig: () => config,
      repository,
      adapter,
      getNickname: () => adapter.nickname,
      personaRoot,
      privacyGateService,
      callModel: async (_slot, messages, callOptions) => {
        replyTraceEnabled = callOptions.debugTrace !== undefined;
        replyPromptText = JSON.stringify(messages);
        return {
          text: options.replyText,
          provider: 'fake',
          model: 'fake-reply',
          usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
        };
      },
      now: () => baseTime,
      wait: async () => {},
      random: () => 0.5,
    });

    const incoming = makeIncoming({
      messageId: 'privacy-gate-pipeline',
      plainText: '小鱼，考研最近怎么样？',
      mentionsSelf: true,
      senderId: 42,
      time: baseTime,
    });
    const result = await pipeline(incoming);
    const decision = repository.recentDecisions(1)[0];
    const detailText = JSON.stringify(decision?.detail);

    return {
      result,
      adapter,
      factId,
      privateText,
      detailText,
      replyPromptText,
      gateTraceEnabled,
      replyTraceEnabled,
      debugTraceCount: repository.debugTracesFor(sessionId(groupSession), incoming.messageId).length,
      decisionReason: repository.recentDecisions(1)[0]?.reason,
      messageId: incoming.messageId,
    };
  });
}

test('called group reply applies the L0 rule without exposing fact text to reply prompt or debug trace', async () => {
  const run = await runGroupReply({ replyText: '我在听。', touchFact: true });

  assert.deepEqual(run.result, { replied: true, reason: 'replied' });
  assert.equal(run.adapter.sent.length, 1);
  assert.equal(run.gateTraceEnabled, false);
  assert.equal(run.replyTraceEnabled, false);
  assert.equal(run.debugTraceCount, 0);
  assert.equal(run.decisionReason, 'replied');
  assert.ok(run.replyPromptText.includes('群里正在聊的话题可能涉及别人的私事。你对此一无所知，不追问、不展开、不猜测。'));
  assert.equal(run.replyPromptText.includes(run.privateText), false);
  assert.equal(run.detailText.includes(run.privateText), false);
});

test('egress drops a generated group reply containing two L0 keywords before any adapter side effect', async () => {
  const run = await runGroupReply({ replyText: '考研压力确实不小。', touchFact: false });

  assert.deepEqual(run.result, { replied: false, reason: 'privacy_egress' });
  assert.deepEqual(run.adapter.calls, []);
  assert.equal(run.gateTraceEnabled, false);
  assert.equal(run.replyTraceEnabled, false);
  assert.equal(run.debugTraceCount, 0);
  assert.ok(run.detailText.includes(`"id":${run.factId}`));
  assert.equal(run.detailText.includes(run.privateText), false);
});
