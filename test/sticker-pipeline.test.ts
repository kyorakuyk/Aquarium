import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionId } from '../src/core/shared/events.ts';
import type { StickerOffer } from '../src/core/stickers/selection.ts';
import type { StickerService } from '../src/core/stickers/service.ts';
import { baseTime, createHarness, groupSession, makeConfig, makeIncoming, withRepository } from './pipeline-test-helpers.ts';

function stickerOffer(): StickerOffer {
  return {
    candidates: [
      { id: 7, emojiId: 'emoji-7', file: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png', descAi: '摊手无奈', tags: ['无语'] },
      { id: 8, emojiId: 'emoji-8', file: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png', descAi: '开心', tags: ['开心'] },
    ],
    promptList: '1 摊手无奈 / 2 开心',
  };
}

function fakeStickerService(offer: StickerOffer | null, options: {
  sendError?: boolean;
  onlyStickerRatio?: number;
} = {}): StickerService & { sent: number[]; uses: number[] } {
  const sent: number[] = [];
  const uses: number[] = [];
  return {
    account: groupSession.account,
    sent,
    uses,
    async sync() {
      return { account: groupSession.account, received: 0, inserted: 0, downloaded: 0, described: 0, markedMissing: 0, skippedByBudget: false };
    },
    async collect() { return { ok: true }; },
    async upload() { return { synced: true }; },
    async modifyCustomFace() {},
    getLastSyncAt() { return null; },
    offer() { return offer; },
    stickerBase64() { return 'AAAA'; },
    async sendSticker({ sticker }) {
      if (options.sendError) throw new Error('send_custom_face 失败');
      sent.push(sticker.id);
      return { messageId: `sticker-out-${sent.length}` };
    },
    recordUse(stickerId) { uses.push(stickerId); },
  };
}

test('未给表情机会时不注入 stickers 块，也不发送表情', async () => {
  await withRepository(async (repository, personaRoot) => {
    const service = fakeStickerService(null);
    const harness = createHarness(repository, makeConfig(), personaRoot, {
      replyText: '普通回复。',
      stickerService: service,
    });

    const result = await harness.pipeline(makeIncoming({ messageId: 'sticker-none' }));

    assert.deepEqual(result, { replied: true, reason: 'replied' });
    const prompt = harness.modelRequests[0]?.messages.map(({ content }) => String(content)).join('\n') ?? '';
    assert.doesNotMatch(prompt, /可以发表情包/u);
    assert.deepEqual(service.sent, []);
    const decision = repository.recentDecisions(1)[0];
    assert.deepEqual(decision?.detail && typeof decision.detail === 'object'
      ? (decision.detail as Record<string, unknown>).stickerOffered
      : undefined, null);
  });
});

test('给机会时注入候选，合法编号在正文之后发送并记录使用', async () => {
  await withRepository(async (repository, personaRoot) => {
    const service = fakeStickerService(stickerOffer());
    const harness = createHarness(repository, makeConfig(), personaRoot, {
      replyText: '好呀。\n[表情:2]',
      stickerService: service,
    });

    const result = await harness.pipeline(makeIncoming({ messageId: 'sticker-send' }));

    assert.deepEqual(result, { replied: true, reason: 'replied' });
    const prompt = harness.modelRequests[0]?.messages.map(({ content }) => String(content)).join('\n') ?? '';
    assert.match(prompt, /1 摊手无奈 \/ 2 开心/u);
    assert.equal(harness.adapter.sent.length, 1);
    assert.deepEqual(harness.adapter.sent[0]?.segments, [
      { type: 'reply', messageId: 'sticker-send' },
      { type: 'text', text: '好呀。' },
    ]);
    assert.deepEqual(service.sent, [8]);
    assert.deepEqual(service.uses, [8]);
    const decision = repository.recentDecisions(1)[0]?.detail as Record<string, unknown>;
    assert.deepEqual(decision.stickerOffered, [7, 8]);
    assert.equal(decision.stickerSent, 8);
    assert.equal(decision.stickerOnly, undefined);
    const stored = repository.recentMessages(sessionId(groupSession), 5);
    assert.deepEqual(stored.at(-1)?.segments, [{ type: 'sticker', emojiId: 'emoji-8' }]);
  });
});

test('非法表情标记全部剥离；原生表情发送失败时回退为本地图片', async () => {
  await withRepository(async (repository, personaRoot) => {
    const service = fakeStickerService(stickerOffer(), { sendError: true });
    const harness = createHarness(repository, makeConfig(), personaRoot, {
      replyText: '嗯 [表情:9] 呢 [表情:x]\n[表情:1]',
      stickerService: service,
    });

    await harness.pipeline(makeIncoming({ messageId: 'sticker-fallback' }));

    assert.equal(harness.adapter.sent[0]?.segments.at(-1)?.type, 'text');
    assert.equal(
      harness.adapter.sent[0]?.segments.at(-1)?.type === 'text'
        ? harness.adapter.sent[0]?.segments.at(-1)?.text
        : '',
      '嗯  呢',
    );
    assert.equal(harness.adapter.sent[1]?.segments.length, 1);
    const fallback = harness.adapter.sent[1]?.segments[0];
    assert.equal(fallback?.type, 'image');
    assert.equal(fallback?.type === 'image' ? fallback.url : '', 'base64://AAAA');
    const decision = repository.recentDecisions(1)[0]?.detail as Record<string, unknown>;
    assert.equal(decision.stickerSent, 7);
  });
});

test('只发表情在比例超限时整条丢弃，低于阈值时只发原生表情', async () => {
  await withRepository(async (repository, personaRoot) => {
    const allowedSession = { account: groupSession.account, kind: 'group' as const, peer: 654321 };
    const capped = fakeStickerService(stickerOffer());
    const cappedHarness = createHarness(repository, makeConfig(), personaRoot, {
      replyText: '[表情:2]',
      stickerService: capped,
    });
    const cappedIncoming = makeIncoming({ messageId: 'sticker-capped' });
    for (let index = 0; index < 5; index += 1) {
      repository.recordDecision({
        time: baseTime - index - 1,
        sessionId: sessionId(groupSession),
        messageId: `history-${index}`,
        replied: true,
        reason: 'replied',
        detail: { stickerOnly: true, stickerSent: 7 },
      });
    }

    const cappedResult = await cappedHarness.pipeline(cappedIncoming, { alreadySaved: true });

    assert.deepEqual(cappedResult, { replied: false, reason: 'sticker_only_capped' });
    assert.deepEqual(cappedHarness.adapter.sent, []);
    assert.deepEqual(capped.sent, []);

    const allowed = fakeStickerService(stickerOffer());
    const allowedConfig = makeConfig({
      sessions: { [sessionId(allowedSession)]: { enabled: true, nicknames: ['小鱼'] } },
    });
    const allowedHarness = createHarness(repository, allowedConfig, personaRoot, {
      replyText: '[表情:2]',
      stickerService: allowed,
    });
    const allowedResult = await allowedHarness.pipeline(makeIncoming({
      messageId: 'sticker-only',
      session: allowedSession,
    }));

    assert.deepEqual(allowedResult, { replied: true, reason: 'replied' });
    assert.deepEqual(allowedHarness.adapter.sent, []);
    assert.deepEqual(allowed.sent, [8]);
    const decision = repository.recentDecisions(1)[0];
    assert.equal(decision?.sessionId, sessionId(allowedSession));
    const detail = decision?.detail as Record<string, unknown>;
    assert.equal(detail.stickerOnly, true);
    assert.equal(detail.stickerSent, 8);
  });
});
