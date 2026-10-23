import assert from 'node:assert/strict';
import test from 'node:test';
import type { EmojiLikeNotice } from '../src/adapters/types.ts';
import { OneBotAdapter } from '../src/adapters/onebot/adapter.ts';
import { createAffinityService } from '../src/core/affinity/service.ts';
import { createEmojiLikeFeedbackHandler } from '../src/app/interactions.ts';
import { sessionId } from '../src/core/shared/events.ts';
import {
  baseTime,
  groupSession,
  makeConfig,
  withRepository,
} from './pipeline-test-helpers.ts';
import {
  account,
  createFakeClient,
  createFixture,
} from './onebot-adapter-test-helpers.ts';

const adapterGroupSession = { account, kind: 'group' as const, peer: 123456 };

test('OneBot reaction action and emoji-like notices produce only eligible affinity feedback', async (t) => {
  await withRepository(async (repository) => {
    const currentSessionId = sessionId(groupSession);
    repository.saveMessage({
      sessionId: currentSessionId,
      messageId: '91',
      senderId: groupSession.account,
      senderName: 'Aquarium',
      isSelf: true,
      plainText: 'hello',
      segments: [{ type: 'text', text: 'hello' }],
      time: baseTime,
    });
    repository.saveMessage({
      sessionId: currentSessionId,
      messageId: '92',
      senderId: 42,
      senderName: 'Peer',
      isSelf: false,
      plainText: 'hello',
      segments: [{ type: 'text', text: 'hello' }],
      time: baseTime,
    });
    repository.linkAltAccount({
      account: groupSession.account,
      aUserId: groupSession.account,
      bUserId: 44,
      createdAt: baseTime,
    });
    const kinGroupId = repository.createKinGroup('feedback-test');
    repository.setKinGroupMembers(kinGroupId, [groupSession.account, 45]);

    const affinityService = createAffinityService({ repository, getConfig: () => makeConfig() });
    let logged = 0;
    const handle = createEmojiLikeFeedbackHandler({
      account,
      repository,
      affinityService,
      now: () => baseTime + 1,
      onFeedback: () => { logged += 1; },
    });
    const notices: EmojiLikeNotice[] = [];
    const root = createFixture(t, [{ host: '127.0.0.1', port: 3001 }]);
    const fake = createFakeClient(account);
    const adapter = new OneBotAdapter({
      account,
      snowlumaDir: root,
      onInteractionNotice: (notice) => {
        notices.push(notice);
        handle(notice);
      },
    }, () => fake.client);
    adapter.start();
    await new Promise<void>((resolve) => setImmediate(resolve));

    try {
      await adapter.react(adapterGroupSession, '42', 'emoji-a');
      await adapter.react(adapterGroupSession, '43', 'emoji-b', true);
      assert.deepEqual(fake.state.rawCalls, [
        ['set_msg_emoji_like', { message_id: 42, emoji_id: 'emoji-a', set: true }],
        ['set_msg_emoji_like', { message_id: 43, emoji_id: 'emoji-b', set: false }],
      ]);
      await assert.rejects(adapter.react(adapterGroupSession, 'not-a-number', 'emoji-c'));
      assert.equal(fake.state.rawCalls.length, 2);

      const emitNotice = (options: {
        selfId?: unknown;
        messageId?: unknown;
        userId?: number;
        subType?: 'add' | 'remove';
        likes?: Array<{ emoji_id: string; count: number }>;
      } = {}) => fake.emitEvent({
        time: 1_800_000_000,
        self_id: options.selfId ?? account,
        post_type: 'notice',
        notice_type: 'group_msg_emoji_like',
        sub_type: options.subType ?? 'add',
        group_id: 123456,
        user_id: options.userId ?? 42,
        message_id: options.messageId ?? '91',
        likes: options.likes ?? [{ emoji_id: 'emoji-a', count: 1 }],
      });

      emitNotice();
      emitNotice({ subType: 'remove' });
      emitNotice({ messageId: '92', userId: 43 });
      emitNotice({ userId: account });
      emitNotice({ userId: 44 });
      emitNotice({ userId: 45 });
      emitNotice({ selfId: 'invalid-account', messageId: 'ignored-invalid-account' });
      emitNotice({ messageId: 'bad-id' });
      emitNotice({ likes: [] });

      assert.equal(notices.length, 6);
      assert.deepEqual(notices[0], {
        type: 'emoji_like',
        session: adapterGroupSession,
        messageId: '91',
        userId: 42,
        subType: 'add',
        likes: [{ emojiId: 'emoji-a', count: 1 }],
      });
      assert.equal(repository.getAffinityState(account, 42)?.value, 51);
      assert.equal(repository.recentAffinityEvents(account, 42, 1)[0]?.reason, 'emoji_like_received');
      assert.equal(logged, 1);
    } finally {
      adapter.close();
    }

    const errorFake = createFakeClient(account);
    let interactionError: unknown;
    const errorAdapter = new OneBotAdapter({
      account,
      snowlumaDir: root,
      onInteractionNotice: () => { throw new Error('notice processing failed'); },
      onInteractionError: (error) => { interactionError = error; },
    }, () => errorFake.client);
    errorAdapter.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      errorFake.emitEvent({
        time: 1_800_000_000,
        self_id: account,
        post_type: 'notice',
        notice_type: 'group_msg_emoji_like',
        sub_type: 'add',
        group_id: 123456,
        user_id: 42,
        message_id: 91,
        likes: [{ emoji_id: 'emoji-a', count: 1 }],
      });
      assert.equal((interactionError as Error | undefined)?.message, 'notice processing failed');
    } finally {
      errorAdapter.close();
    }
  });
});
