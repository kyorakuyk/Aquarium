import assert from 'node:assert/strict';
import test from 'node:test';
import type { IncomingMessage, Segment } from '../src/core/shared/events.ts';
import {
  calculatePrefilterActivity,
  calculatePrefilterFeatures,
  evaluatePrefilter,
} from '../src/core/activity/prefilter.ts';

function message(segments: Segment[], plainText = ''): Pick<IncomingMessage, 'session' | 'segments' | 'plainText'> {
  return {
    session: { account: 100, kind: 'group', peer: 200 },
    segments,
    plainText,
  };
}

test('活跃按判断时点 30 分钟计算，冷场按批次首条消息之前的 20 分钟计算', () => {
  const now = 1_800_000_000_000;
  const atBoundary = calculatePrefilterActivity({
    now,
    firstMessageAt: now,
    lastBotMessageAt: now - 30 * 60_000,
    lastMessageBeforeBatchAt: now - 20 * 60_000,
  });
  const outsideWindow = calculatePrefilterActivity({
    now,
    firstMessageAt: now,
    lastBotMessageAt: now - 30 * 60_000 - 1,
    lastMessageBeforeBatchAt: now - 20 * 60_000 + 1,
  });
  const unknownHistory = calculatePrefilterActivity({
    now,
    firstMessageAt: now,
  });

  assert.deepEqual(atBoundary, { active: true, cold: true });
  assert.deepEqual(outsideWindow, { active: false, cold: false });
  assert.deepEqual(unknownHistory, { active: false, cold: false });
});

test('粗筛独立保留活跃与冷场事实并识别问号和 @ 他人', () => {
  const features = calculatePrefilterFeatures([
    message([
      { type: 'at', target: 100 },
      { type: 'at', target: 200 },
      { type: 'at', target: 'all' },
      { type: 'text', text: '你觉得呢？' },
    ], '你觉得呢？'),
  ], { active: true, cold: true });

  assert.deepEqual(features, {
    active: true,
    cold: true,
    question: true,
    mediaOnly: false,
    atOther: true,
  });
});

test('粗筛只在批次有图片或表情且没有文字或未知内容时标记 mediaOnly', () => {
  const mediaOnly = calculatePrefilterFeatures([
    message([
      { type: 'reply', messageId: 'previous' },
      { type: 'text', text: '  ' },
      { type: 'image', url: 'https://example.invalid/image' },
      { type: 'face', id: '1' },
    ]),
  ], { active: false, cold: false });
  const textAndImage = calculatePrefilterFeatures([
    message([
      { type: 'image', url: 'https://example.invalid/image' },
      { type: 'text', text: '看这个？' },
    ], '看这个？'),
  ], { active: false, cold: false });
  const unknownAndImage = calculatePrefilterFeatures([
    message([
      { type: 'image', url: 'https://example.invalid/image' },
      { type: 'unknown', raw: { type: 'video' } },
    ]),
  ], { active: false, cold: false });
  const mentionedImage = calculatePrefilterFeatures([
    message([
      { type: 'at', target: 200 },
      { type: 'image', url: 'https://example.invalid/image' },
    ]),
  ], { active: false, cold: false });

  assert.equal(mediaOnly.mediaOnly, true);
  assert.equal(textAndImage.mediaOnly, false);
  assert.equal(unknownAndImage.mediaOnly, false);
  assert.equal(mentionedImage.mediaOnly, false);
});

test('粗筛概率按固定逻辑回归权重计算并以 0.15 为判断下限', () => {
  const likely = evaluatePrefilter({
    active: true,
    cold: false,
    question: true,
    mediaOnly: false,
    atOther: false,
  });
  const unlikely = evaluatePrefilter({
    active: false,
    cold: true,
    question: false,
    mediaOnly: true,
    atOther: true,
  });
  const allFeatures = evaluatePrefilter({
    active: true,
    cold: true,
    question: true,
    mediaOnly: true,
    atOther: true,
  });

  assert.ok(Math.abs(likely.p0 - 0.7502601055951177) < 1e-12);
  assert.equal(likely.shouldJudge, true);
  assert.ok(unlikely.p0 < 0.15);
  assert.equal(unlikely.shouldJudge, false);
  assert.ok(Math.abs(allFeatures.p0 - 0.16798161486607552) < 1e-12);
});
