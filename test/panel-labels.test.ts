import assert from 'node:assert/strict';
import test from 'node:test';
import { decisionLabel, decisionTone } from '../panel/src/labels.ts';

test('decision labels preserve reason categories and tone mapping', () => {
  const cases: Array<[string, string, 'positive' | 'neutral' | 'warn']> = [
    ['replied', '已回复', 'positive'],
    ['not_mentioned', '没被叫到', 'neutral'],
    ['disabled', '未启用', 'neutral'],
    ['duplicate', '重复消息', 'neutral'],
    ['command_ignored', '指令已忽略', 'neutral'],
    ['command_mute', '管理指令', 'positive'],
    ['mode_mention_only', '只在被叫时', 'neutral'],
    ['batched', '合并处理', 'neutral'],
    ['backoff', '退避中', 'neutral'],
    ['prefilter', '粗筛跳过', 'neutral'],
    ['judge_skip', '判断不接', 'neutral'],
    ['judge_parse_error', '出错', 'warn'],
    ['judge_error', '出错', 'warn'],
    ['budget', '预算用尽', 'warn'],
    ['proactive_cooldown', '主动冷却', 'neutral'],
    ['rate_limited', '限流', 'warn'],
    ['muted', '闭嘴中', 'warn'],
    ['empty_reply', '空回复', 'warn'],
    ['llm_error', '出错', 'warn'],
    ['send_error', '出错', 'warn'],
    ['persona_error', '出错', 'warn'],
    ['command_error', '出错', 'warn'],
    ['future_reason', 'future_reason', 'neutral'],
    ['toString', 'toString', 'neutral'],
  ];

  for (const [reason, expectedLabel, expectedTone] of cases) {
    assert.equal(decisionLabel(reason), expectedLabel, `label for ${reason}`);
    assert.equal(decisionTone(reason), expectedTone, `tone for ${reason}`);
  }
});
