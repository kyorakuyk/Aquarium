import assert from 'node:assert/strict';
import test from 'node:test';
import { adjustThresholdForTalk } from '../src/core/activity/threshold.ts';
import { promptTemplateStore } from '../src/core/prompt/templates.ts';
import { renderMoodBlocks } from '../src/core/mood/render.ts';
import { sessionId, type SessionKey } from '../src/core/shared/events.ts';
import { createRepository } from '../src/store/repository.ts';
import { groupSession, withRepository } from './pipeline-test-helpers.ts';

test('energy 低于 0.35 时浮动词把困意与 arousal 词用顿号连接', () => {
  const template = promptTemplateStore.get().affect;
  const tired = renderMoodBlocks(template, { mainEmotion: '平静', subEmotions: [] }, 0.2, 0.34);
  const expected = template.float.wrap.replaceAll('{{floats}}', `${template.float.arousalLow}、有点困`);
  assert.equal(tired.float, expected);

  const boundary = renderMoodBlocks(template, { mainEmotion: '平静', subEmotions: [] }, 0.2, 0.35);
  assert.equal(boundary.float, template.float.wrap.replaceAll('{{floats}}', template.float.arousalLow));
});

test('心灵能量只按档位与人格来源注入文字，充沛时不输出', () => {
  const template = promptTemplateStore.get().affect;
  const innerTired = renderMoodBlocks(template, { mainEmotion: '平静', subEmotions: [] }, 0.5, 1, 'tired', 'inner');
  const outerDrained = renderMoodBlocks(template, { mainEmotion: '平静', subEmotions: [] }, 0.5, 1, 'drained', 'outer');
  const mixedFull = renderMoodBlocks(template, { mainEmotion: '平静', subEmotions: [] }, 0.5, 1, 'full', 'mixed');

  assert.equal(innerTired.reserve, '有点累，想一个人待会儿');
  assert.equal(outerDrained.reserve, '很累，很需要有人陪');
  assert.equal(mixedFull.reserve, undefined);
  assert.equal(/\d/u.test(innerTired.reserve ?? ''), false);
});

test('低于 0.25 的 energy 加成在 talk 偏移之后、阈值限幅之前应用', () => {
  assert.equal(adjustThresholdForTalk(0.5, 0, 0.24), 0.6);
  assert.equal(adjustThresholdForTalk(0.5, 0, 0.25), 0.5);
  assert.equal(adjustThresholdForTalk(0.2, 2, 0.24), 0.2);
});

test('按账号计数最近 60 分钟已回复的 decisions，排除越界、未来和其他账号', async () => {
  await withRepository(async (repository) => {
    const now = new Date(2026, 9, 18, 12).getTime();
    const other: SessionKey = { account: groupSession.account + 1, kind: 'group', peer: groupSession.peer };
    const record = (session: SessionKey, messageId: string, time: number, replied = true) => repository.recordDecision({
      time,
      sessionId: sessionId(session),
      messageId,
      replied,
      reason: 'replied',
      detail: {},
    });
    record(groupSession, 'exact-cutoff', now - 60 * 60_000);
    record(groupSession, 'recent', now - 30 * 60_000);
    record(groupSession, 'too-old', now - 60 * 60_000 - 1);
    record(groupSession, 'future', now + 1);
    record(groupSession, 'skipped', now - 10 * 60_000, false);
    record(other, 'other-account', now - 10 * 60_000);

    assert.equal(repository.replyCountLastHourForAccount(groupSession.account, now), 2);
  });
});
