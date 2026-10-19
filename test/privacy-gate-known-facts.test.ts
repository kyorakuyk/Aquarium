import assert from 'node:assert/strict';
import test from 'node:test';
import { AquariumConfigSchema } from '../src/config/schema.ts';
import { sessionId } from '../src/core/events.ts';
import { createMessagePipeline } from '../src/core/pipeline.ts';
import { createPrivacyGateService } from '../src/core/privacy/group-gate.ts';
import { createImpressionsService } from '../src/core/impressions/service.ts';
import type { PrivateFactRecord } from '../src/store/privacy-repo.ts';
import {
  baseTime,
  FakeAdapter,
  groupSession,
  makeConfig,
  makeIncoming,
  withRepository,
} from './pipeline-test-helpers.ts';

test('touched L1 fact enters knownFacts after memberTags and is excluded from debug traces', async () => {
  await withRepository(async (repository, personaRoot) => {
    const privateText = '最近在准备考研，承受压力很大';
    const fact: Omit<PrivateFactRecord, 'id'> = {
      account: groupSession.account,
      ownerId: 42,
      sessionId: `${groupSession.account}:private:42`,
      text: privateText,
      keywords: ['考研', '压力'],
      level: 'L1',
      levelSource: 'auto',
      mentions: 1,
      mentionEvidence: [],
      evidence: [],
      status: 'active',
      createdAt: baseTime,
      updatedAt: baseTime,
    };
    const factId = repository.insertPrivateFact(fact);
    repository.insertTag({
      account: groupSession.account,
      sessionId: sessionId(groupSession),
      userId: 42,
      text: '夜猫子',
      norm: '夜猫子',
      status: 'confirmed',
      source: 'auto',
      samples: 2,
      evidence: [],
      firstSeen: baseTime,
      lastSeen: baseTime,
      supersededBy: null,
      updatedAt: baseTime,
    });
    const baseConfig = makeConfig();
    const config = AquariumConfigSchema.parse({
      ...baseConfig,
      debug: { ...baseConfig.debug, enabled: true },
    });
    const adapter = new FakeAdapter();
    const impressionsService = createImpressionsService({ repository, getConfig: () => config });
    let replyPrompt = '';
    let gateDebugEnabled = false;
    let replyDebugEnabled = false;
    const privacyGateService = createPrivacyGateService({
      repository,
      getConfig: () => config,
      callModel: async (_slot, _messages, options) => {
        gateDebugEnabled = options.debugTrace !== undefined;
        return {
          text: JSON.stringify({ touches: [factId] }),
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
      impressionsService,
      privacyGateService,
      callModel: async (_slot, messages, options) => {
        replyDebugEnabled = options.debugTrace !== undefined;
        replyPrompt = JSON.stringify(messages);
        return {
          text: '我记得你提过。',
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
      messageId: 'known-facts-pipeline',
      plainText: '考研这件事最近压力大吗？',
      mentionsSelf: true,
      senderId: 42,
      time: baseTime,
    });

    const result = await pipeline(incoming);
    const decision = repository.recentDecisions(1)[0];

    assert.deepEqual(result, { replied: true, reason: 'replied' });
    assert.ok(replyPrompt.indexOf('夜猫子') < replyPrompt.indexOf('你私下知道：'));
    assert.ok(replyPrompt.includes(`你私下知道：${privateText}（对方已经在群里提过；别人问起才接，不要主动透露细节）`));
    assert.equal(gateDebugEnabled, false);
    assert.equal(replyDebugEnabled, false);
    assert.equal(repository.debugTracesFor(sessionId(groupSession), incoming.messageId).length, 0);
    assert.equal(JSON.stringify(decision?.detail).includes(privateText), false);
    assert.deepEqual(
      (decision?.detail as { promptBlocks?: Array<{ id: string }> }).promptBlocks?.map(({ id }) => id),
      ['persona', 'rules', 'groupNote', 'memberTags', 'knownFacts'],
    );
    assert.deepEqual(adapter.sent.length, 1);
  });
});
