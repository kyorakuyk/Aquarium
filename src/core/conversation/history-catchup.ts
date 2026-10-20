import type { ProtocolAdapter } from '../../adapters/types.ts';
import { resolveSession } from '../../config/resolve.ts';
import type { AquariumConfig } from '../../config/schema.ts';
import { sessionId, type IncomingMessage, type SessionKey } from '../shared/events.ts';
import { listEnabledSessions } from './sessions.ts';
import type { StoreRepository } from '../../store/repository.ts';

const HISTORY_LIMIT = 50;
const RECENT_REPLY_WINDOW_MS = 10 * 60 * 1000;

export interface StoredMessageProcessingOptions {
  alreadySaved?: boolean;
}

type MessageProcessor = (
  message: IncomingMessage,
  options: StoredMessageProcessingOptions,
) => Promise<unknown>;

type QueueTask = (sessionId: string, task: () => Promise<unknown>) => Promise<unknown>;

function isReplyTrigger(message: IncomingMessage, config: AquariumConfig): boolean {
  if (message.senderId === message.session.account) return false;
  if (message.session.kind === 'private') return true;
  if (message.mentionsSelf) return true;
  const nicknames = resolveSession(config, message.session).nicknames;
  return nicknames.some((nickname) => {
    const normalized = nickname.trim();
    return normalized !== '' && message.plainText.includes(normalized);
  });
}

export function createHistoryCatchUp(options: {
  adapter: ProtocolAdapter;
  getConfig: () => AquariumConfig;
  repository: StoreRepository;
  processMessage: MessageProcessor;
  enqueue: QueueTask;
  now?: () => number;
  onError?: (error: unknown, session?: SessionKey) => void;
}): () => Promise<void> {
  const now = options.now ?? Date.now;

  return async function catchUpHistory(): Promise<void> {
    const config = options.getConfig();
    const sessions = await listEnabledSessions(
      options.adapter,
      config,
      (error) => options.onError?.(error),
    );

    for (const session of sessions) {
      try {
        const messages = await options.adapter.history(session, HISTORY_LIMIT);
        const insertedMessages: IncomingMessage[] = [];
        for (const message of messages) {
          const inserted = options.repository.saveMessage({
            sessionId: sessionId(message.session),
            messageId: message.messageId,
            senderId: message.senderId,
            senderName: message.senderName,
            isSelf: message.senderId === message.session.account,
            plainText: message.plainText,
            segments: message.segments,
            time: message.time,
          });
          if (inserted) insertedMessages.push(message);
        }

        let latestTrigger: IncomingMessage | undefined;
        for (const message of insertedMessages) {
          if (!isReplyTrigger(message, config)) continue;
          if (!latestTrigger || message.time >= latestTrigger.time) latestTrigger = message;
        }
        if (!latestTrigger || Math.abs(now() - latestTrigger.time) > RECENT_REPLY_WINDOW_MS) continue;

        await options.enqueue(sessionId(session), () => options.processMessage(latestTrigger, {
          alreadySaved: true,
        }));
      } catch (error) {
        options.onError?.(error, session);
      }
    }
  };
}
