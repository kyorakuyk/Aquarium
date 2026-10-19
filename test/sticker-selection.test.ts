import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import yaml from 'yaml';
import { AquariumConfigSchema, type AquariumConfig } from '../src/config/schema.ts';
import type { StickerRecord } from '../src/store/sticker-repo.ts';
import type { StoredDecision } from '../src/store/repository.ts';
import { canSendStickerOnly, selectStickerCandidates } from '../src/core/stickers/selection.ts';
import { parseStickerReply } from '../src/core/stickers/parse.ts';

const config = AquariumConfigSchema.parse(yaml.parse(
  fs.readFileSync(path.resolve('config.example.yaml'), 'utf8'),
));
const now = 1_800_000_000_000;

function sticker(id: number, descAi: string, tags: string[] = []): StickerRecord {
  return {
    id,
    account: 10001,
    emojiId: `emoji-${id}`,
    md5: String(id).padStart(32, '0'),
    file: `${String(id).padStart(32, '0')}.png`,
    descQq: '',
    descAi,
    manualDesc: '',
    tags,
    enabled: true,
    missing: false,
    useCount: 0,
    lastUsedAt: null,
    descriptionAttempts: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

function decision(id: number, time: number, detail: unknown = {}, replied = true): StoredDecision {
  return {
    id,
    time,
    sessionId: '10001:group:123',
    messageId: `message-${id}`,
    replied,
    reason: replied ? 'replied' : 'empty_reply',
    detail,
  };
}

function offerConfig(overrides: Partial<AquariumConfig['stickers']> = {}): AquariumConfig['stickers'] {
  return { ...config.stickers, enabled: true, ...overrides };
}

test('表情候选按二元组、心情与近期使用评分，同分顺序按会话小时稳定', () => {
  const history = [
    decision(1, now - 600_000, { stickerSent: 3 }),
    ...Array.from({ length: 9 }, (_, index) => decision(index + 2, now - 500_000 + index, {})),
  ];
  const input = {
    config: offerConfig({ candidates: 4 }),
    stickers: [
      sticker(1, '开心', ['开心']),
      sticker(2, '伤心', ['难过']),
      sticker(3, '开心', ['难过']),
      sticker(4, '开心', ['快乐']),
    ],
    history,
    messageText: '开心',
    moodBand: 'happy' as const,
    sessionId: '10001:group:123',
    now,
  };

  const selected = selectStickerCandidates(input);
  assert.deepEqual(selected?.candidates.map((candidate) => candidate.id), [1, 4, 2, 3]);

  const tieInput = {
    ...input,
    messageText: 'xyz',
    moodBand: 'calm' as const,
    history: [],
    stickers: [sticker(11, ''), sticker(12, ''), sticker(13, '')],
  };
  assert.deepEqual(
    selectStickerCandidates(tieInput)?.candidates.map((candidate) => candidate.id),
    selectStickerCandidates(tieInput)?.candidates.map((candidate) => candidate.id),
  );
});

test('候选机会受启用、库存、两小时比例和冷却共同限制', () => {
  const stickers = [sticker(1, '开心'), sticker(2, '开心'), sticker(3, '开心')];
  const base = {
    config: offerConfig(),
    stickers,
    history: [] as StoredDecision[],
    messageText: '开心',
    moodBand: 'happy' as const,
    sessionId: '10001:group:123',
    now,
  };
  assert.equal(selectStickerCandidates({ ...base, config: { ...base.config, enabled: false } }), null);
  assert.equal(selectStickerCandidates({ ...base, stickers: stickers.slice(0, 2) }), null);
  assert.equal(selectStickerCandidates({
    ...base,
    history: [decision(1, now - 60_000, { stickerSent: 1 })],
  }), null);

  const belowRatio = [
    decision(1, now - 60_000, { stickerSent: 1 }),
    ...Array.from({ length: 4 }, (_, index) => decision(index + 2, now - 50_000 + index)),
  ];
  assert.equal(selectStickerCandidates({ ...base, history: belowRatio }), null);
  const cooldownElapsed = { ...base, now: now + 300_000, history: belowRatio };
  assert.notEqual(selectStickerCandidates(cooldownElapsed), null);
});

test('只发表情比例低于阈值才允许发出无正文回复', () => {
  assert.equal(canSendStickerOnly([], now, 0.1), true);
  assert.equal(canSendStickerOnly([
    decision(1, now - 60_000, { stickerOnly: true, stickerSent: 1 }),
    decision(2, now - 30_000),
  ], now, 0.1), false);
  assert.equal(canSendStickerOnly([
    decision(1, now - 60_000, { stickerOnly: true, stickerSent: 1 }),
    ...Array.from({ length: 10 }, (_, index) => decision(index + 2, now - 50_000 + index)),
  ], now, 0.2), true);
});

test('表情标记支持全角标点，全部剥离并只保留第一个合法编号', () => {
  const offer = {
    candidates: [
      { id: 1, emojiId: 'emoji-1', file: 'a.png', descAi: '开心', tags: [] },
      { id: 2, emojiId: 'emoji-2', file: 'b.png', descAi: '难过', tags: [] },
      { id: 3, emojiId: 'emoji-3', file: 'c.png', descAi: '惊讶', tags: [] },
    ],
    promptList: '1 开心 / 2 难过 / 3 惊讶',
  };
  const parsed = parseStickerReply(
    'A [表情：3] B 【表情:2】 C 【表情：1】 D [表情:9] E 【表情：x】 F [表情：] G',
    offer,
  );
  assert.equal(parsed.text, 'A  B  C  D  E  F  G');
  assert.equal(parsed.sticker?.id, 3);
  for (const marker of ['[表情：3]', '【表情:3】', '【表情：3】']) {
    const variant = parseStickerReply(marker, offer);
    assert.equal(variant.text, '');
    assert.equal(variant.sticker?.id, 3, marker);
  }

  const textOnly = parseStickerReply('嗯呢 [表情:1]', null);
  assert.equal(textOnly.text, '嗯呢');
  assert.equal(textOnly.sticker, undefined);
});
