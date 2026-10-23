import type { SessionKey } from '../../core/shared/events.ts';
import { numericMessageId, type OneBotClient } from './client.ts';

export interface OneBotMessageActions {
  markRead(session: SessionKey): Promise<void>;
  setTyping(session: SessionKey): Promise<void>;
  recall(messageId: string): Promise<void>;
  react(session: SessionKey, messageId: string, emojiId: string, remove?: boolean): Promise<void>;
}

export function createOneBotMessageActions(options: {
  account: number;
  getClient: () => OneBotClient;
  assertOnline: () => void;
  loadHistory: (session: SessionKey, count: number) => Promise<Array<{ messageId: string }>>;
  withActionTimeout: <T>(action: string, run: () => Promise<T>) => Promise<T>;
}): OneBotMessageActions {
  function assertSessionAccount(session: SessionKey): void {
    if (session.account !== options.account) throw new Error('SessionKey account 与适配器账号不一致');
  }

  return {
    async markRead(session) {
      assertSessionAccount(session);
      options.assertOnline();
      await options.withActionTimeout('mark_read', async () => {
        const latest = await options.loadHistory(session, 1);
        const lastMessage = latest.at(-1);
        if (!lastMessage) return;
        const messageId = numericMessageId(lastMessage.messageId);
        if (session.kind === 'group') {
          await options.getClient().markGroupMessageAsRead(messageId, session.peer);
        } else {
          await options.getClient().markPrivateMessageAsRead(messageId, session.peer);
        }
      });
    },

    async setTyping(session) {
      assertSessionAccount(session);
      options.assertOnline();
      if (session.kind === 'group') return;
      await options.withActionTimeout('set_input_status', () => options.getClient().raw('set_input_status', {
        user_id: session.peer,
        event_type: 1,
      }));
    },

    async recall(messageId) {
      options.assertOnline();
      await options.withActionTimeout('delete_message', () => options.getClient().deleteMessage(numericMessageId(messageId)));
    },

    async react(session, messageId, emojiId, remove = false) {
      assertSessionAccount(session);
      options.assertOnline();
      await options.withActionTimeout('set_msg_emoji_like', () => options.getClient().raw('set_msg_emoji_like', {
        message_id: numericMessageId(messageId),
        emoji_id: emojiId,
        set: !remove,
      }));
    },
  };
}
