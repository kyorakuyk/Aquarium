import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { resolveSession } from '../src/config/resolve.ts';
import { createAnchoredContextWindow } from '../src/core/conversation/context-window.ts';
import { contextStep } from '../src/core/conversation/steps/context.ts';
import type { StepContext } from '../src/core/conversation/steps/types.ts';
import { createRateLimiter } from '../src/core/shared/rate-limit.ts';
import { sessionId } from '../src/core/shared/events.ts';
import { promptTemplateStore } from '../src/core/prompt/templates.ts';
import type { SlotResult } from '../src/llm/slots.ts';
import type { StoreRepository } from '../src/store/repository.ts';
import { baseTime, groupSession, makeConfig, makeIncoming, withRepository, FakeAdapter } from './pipeline-test-helpers.ts';

function privateContext(
  repository: StoreRepository,
  personaRoot: string,
  peerId: number,
): StepContext {
  const session = { account: groupSession.account, kind: 'private' as const, peer: peerId };
  const config = makeConfig({ nicknames: [] });
  const adapter = new FakeAdapter();
  const modelCall = async (): Promise<SlotResult> => ({
    text: '回复',
    provider: 'fake',
    model: 'fake-model',
    usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, costCny: 0 },
  });
  const now = () => baseTime;
  const context: StepContext = {
    message: makeIncoming({ session, senderId: peerId, plainText: '你好', time: baseTime }),
    processOptions: {},
    currentSessionId: sessionId(session),
    options: {
      getConfig: () => config,
      repository,
      adapter,
      getNickname: () => adapter.nickname,
      personaRoot,
    },
    contextWindow: createAnchoredContextWindow(),
    now,
    wait: async () => {},
    random: () => 0.5,
    modelCall,
    rateLimiter: createRateLimiter(now),
    trace: [],
    state: {
      config,
      settings: resolveSession(config, session),
      sentMessageIds: [],
      promptTemplates: promptTemplateStore.get(),
      promptFingerprints: [],
    },
  };
  context.options.affinityService = {
    getCurrent: () => ({ level: 'ordinary_friend' }),
    promptBlock: () => undefined,
  } as unknown as NonNullable<typeof context.options.affinityService>;
  return context;
}

test('private bound counterpart gets the close audience without changing affinity storage', async () => {
  await withRepository(async (repository, personaRoot) => {
    fs.writeFileSync(path.join(personaRoot, 'personas', 'default.md'), [
      '---',
      'name: 测试角色',
      'aliases: []',
      'identity: { kind: 角色, selfAwareness: 清楚身份, nameRule: fixed }',
      'traits: { order: 0, morality: 0, talk: 0, mind: 0 }',
      'speech:',
      '  firstPerson: 我',
      '  length: { min: 1, max: 100 }',
      '  segmenting: multi',
      '  catchphrases: []',
      'audience:',
      '  stranger: AUDIENCE_STRANGER',
      '  acquaintance: AUDIENCE_ACQUAINTANCE',
      '  close: AUDIENCE_CLOSE',
      'boundaries: { hard: [不要编造] }',
      'counterparts:',
      '  - name: 岛村抱月',
      '    aliases: [岛村]',
      '    label: 恋人',
      '---',
      '角色正文。',
    ].join('\n'), 'utf8');
    repository.createPersonaCounterpartBinding({
      account: groupSession.account,
      personaId: 'default',
      counterpartName: '岛村抱月',
      userId: 77,
      createdAt: baseTime,
    });

    const bound = privateContext(repository, personaRoot, 77);
    assert.deepEqual(await contextStep(bound), { next: true });
    const boundSystem = String(bound.state.prompt?.[0]?.content);
    assert.ok(boundSystem.includes('AUDIENCE_CLOSE'));
    assert.ok(!boundSystem.includes('AUDIENCE_ACQUAINTANCE'));
    assert.deepEqual(repository.listPersonaCounterpartClaims(groupSession.account, 'default'), []);

    const unbound = privateContext(repository, personaRoot, 78);
    assert.deepEqual(await contextStep(unbound), { next: true });
    const unboundSystem = String(unbound.state.prompt?.[0]?.content);
    assert.ok(unboundSystem.includes('AUDIENCE_ACQUAINTANCE'));
    assert.ok(!unboundSystem.includes('AUDIENCE_CLOSE'));
    assert.deepEqual(repository.listPersonaCounterpartClaims(groupSession.account, 'default'), []);
  });
});
