import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createMoodService } from '../src/core/mood/service.ts';
import { promptTemplateStore } from '../src/core/prompt/templates.ts';
import { sessionId } from '../src/core/shared/events.ts';
import { loadPersona } from '../src/persona/load.ts';
import { groupSession, makeConfig, withRepository } from './pipeline-test-helpers.ts';

test('人设倍率分别缩放正向充能和负向消耗，水位保持在 0 到 1', async () => {
  await withRepository(async (repository, personaRoot) => {
    fs.writeFileSync(path.join(personaRoot, 'personas', 'default.md'), [
      '---',
      'energy:',
      '  warmCharge: 3',
      '  hurtCost: 3',
      '  senderHourlyCap: 3',
      '---',
      '# {{name}}',
      '测试人设。',
    ].join('\n'), 'utf8');

    const config = makeConfig();
    let clock = new Date(2026, 9, 12, 9, 0).getTime();
    let appraisalCount = 0;
    const service = createMoodService({
      repository,
      getConfig: () => config,
      getEnergyMultipliers: () => loadPersona('default', '', { root: personaRoot }).energy,
      now: () => clock,
      callModel: async () => ({
        text: appraisalCount++ === 0
          ? '{"valence":0,"reserve":0.15,"arousal":0,"reason":"暖心"}'
          : '{"valence":0,"reserve":-0.15,"arousal":0,"reason":"伤人"}',
        provider: 'fake',
        model: 'fake-model',
        usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
      }),
    });
    const account = groupSession.account;
    const session = sessionId(groupSession);
    const template = promptTemplateStore.get().appraise;

    await service.afterReply({ account, sessionId: session, senderId: 42, now: clock, template, energySource: 'mixed' });
    await service.idle();
    const positive = repository.recentMoodEvents(account, 10).find((event) => event.source === 'appraise');
    assert.ok(Math.abs((positive?.appliedDr ?? 0) - 0.9) < 1e-9);
    assert.equal(positive?.reserveAfter, 1);

    clock += 100_000;
    await service.afterReply({ account, sessionId: session, senderId: 43, now: clock, template, energySource: 'mixed' });
    await service.idle();
    const negative = repository.recentMoodEvents(account, 10)
      .find((event) => event.source === 'appraise' && event.senderId === 43);
    assert.ok(Math.abs((negative?.appliedDr ?? 0) + 0.9) < 1e-9);
    assert.ok((negative?.reserveAfter ?? -1) >= 0);
  });
});
