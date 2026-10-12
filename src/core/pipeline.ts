import type OpenAI from 'openai';
import type { ProtocolAdapter } from '../adapters/types.ts';
import { isDebugEnabled } from '../config/debug.ts';
import { resolveSession } from '../config/resolve.ts';
import type { AquariumConfig } from '../config/schema.ts';
import { buildPromptMessages } from './prompt.ts';
import { createRateLimiter } from './rate-limit.ts';
import { replyDelayMs } from './pacing.ts';
import { cleanReply } from './text.ts';
import { splitReply } from './split.ts';
import { loadPersona } from '../persona/load.ts';
import { sessionId, type IncomingMessage, type Segment, type SessionKey } from './events.ts';
import { captionIncomingImages, messageTextWithImageCaptions } from './images.ts';
import { callSlot, type SlotCallOptions, type SlotResult } from '../llm/slots.ts';
import type { StoreRepository } from '../store/repository.ts';

export interface PipelineResult {
  replied: boolean;
  reason: string;
}

export interface ProcessMessageOptions {
  alreadySaved?: boolean;
}

export type PipelineModelCall = (
  slot: string,
  messages: OpenAI.ChatCompletionMessageParam[],
  options: SlotCallOptions,
) => Promise<SlotResult>;

export interface MessagePipelineOptions {
  getConfig: () => AquariumConfig;
  repository: StoreRepository;
  adapter: ProtocolAdapter;
  getNickname: () => string;
  callModel?: PipelineModelCall;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  personaRoot?: string;
  isMuted?: (session: SessionKey) => boolean;
  onError?: (error: unknown, message: IncomingMessage) => void;
}

function errorDetails(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== 'object') return { errorName: 'UnknownError' };
  const details = error as { name?: unknown; status?: unknown; code?: unknown };
  return {
    errorName: typeof details.name === 'string' ? details.name : 'Error',
    ...(typeof details.status === 'number' ? { status: details.status } : {}),
    ...(typeof details.code === 'string' ? { code: details.code } : {}),
  };
}

export function createMessagePipeline(options: MessagePipelineOptions) {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  }));
  const random = options.random ?? Math.random;
  const modelCall = options.callModel ?? callSlot;
  const rateLimiter = createRateLimiter(now);

  return async function processMessage(
    message: IncomingMessage,
    processOptions: ProcessMessageOptions = {},
  ): Promise<PipelineResult> {
    const currentSessionId = sessionId(message.session);
    let promptHash: string | undefined;
    const withPromptHash = (detail: unknown): unknown => {
      if (!promptHash) return detail;
      if (typeof detail === 'object' && detail !== null && !Array.isArray(detail)) {
        return { ...detail, promptHash };
      }
      return { detail, promptHash };
    };
    const recordDecision = (
      reason: string,
      detail: unknown = {},
      replied = false,
    ): PipelineResult => {
      options.repository.recordDecision({
        time: now(),
        sessionId: currentSessionId,
        messageId: message.messageId,
        replied,
        reason,
        detail: withPromptHash(detail),
      });
      return { replied, reason };
    };

    const inserted = processOptions.alreadySaved === true || options.repository.saveMessage({
      sessionId: currentSessionId,
      messageId: message.messageId,
      senderId: message.senderId,
      senderName: message.senderName,
      isSelf: false,
      plainText: message.plainText,
      segments: message.segments,
      time: message.time,
    });
    if (!inserted) return recordDecision('duplicate');

    const config = options.getConfig();
    const settings = resolveSession(config, message.session);

    if (options.isMuted?.(message.session)) return recordDecision('muted');
    if (!settings.enabled) return recordDecision('disabled', { enabled: false });

    const calledByNickname = settings.nicknames.some((nickname) => {
      const normalized = nickname.trim();
      return normalized !== '' && message.plainText.includes(normalized);
    });
    const isCalled = message.session.kind === 'private' || message.mentionsSelf || calledByNickname;
    if (!isCalled) return recordDecision('not_mentioned', { trigger: 'none' });

    const rate = rateLimiter.check(message.session, message.senderId, settings.rate);
    if (!rate.allowed) return recordDecision('rate_limited', { limit: rate.reason });

    const account = config.accounts.find((entry) => entry.uin === message.session.account);
    const nickname = options.getNickname().trim() || String(message.session.account);
    let persona: string;
    try {
      persona = loadPersona(account?.persona ?? 'default', nickname, {
        ...(options.personaRoot === undefined ? {} : { root: options.personaRoot }),
      });
    } catch (error) {
      options.onError?.(error, message);
      return recordDecision('persona_error', errorDetails(error));
    }

    const debugEnabled = isDebugEnabled(config, currentSessionId);
    const callOptions: SlotCallOptions = {
      config,
      costToday: () => options.repository.costToday(),
      recordUsage: (usage) => options.repository.recordUsage(usage),
      ...(debugEnabled ? {
        debugTrace: {
          sessionId: currentSessionId,
          messageId: message.messageId,
          record: (trace) => options.repository.recordDebugTrace(trace),
          onPromptHash: (hash: string) => { promptHash = hash; },
          onError: (error: unknown) => options.onError?.(error, message),
        },
      } : {}),
    };
    // TODO(M2): 引入私密信息分级后，调试记录必须对 L0 内容脱敏（DESIGN §10.1）
    await captionIncomingImages({
      message,
      repository: options.repository,
      callVision: (messages) => modelCall('vision', messages, callOptions),
      ...(options.onError === undefined ? {} : { onError: options.onError }),
      now,
    });

    const context = options.repository
      .recentMessages(currentSessionId, settings.contextMessages)
      .map((record) => ({
        ...record,
        plainText: messageTextWithImageCaptions(record, options.repository),
      }));
    const prompt = buildPromptMessages({
      persona,
      ownerId: config.owner,
      groupNote: settings.groupNote,
      context,
    });

    let result: SlotResult;
    try {
      result = await modelCall('reply', prompt, callOptions);
    } catch (error) {
      options.onError?.(error, message);
      return recordDecision('llm_error', errorDetails(error));
    }

    const replyText = cleanReply(result.text, [nickname, ...settings.nicknames]);
    if (!replyText) return recordDecision('empty_reply', { model: result.model });
    const parts = splitReply(replyText);

    try {
      await options.adapter.markRead(message.session);
    } catch (error) {
      options.onError?.(error, message);
    }
    if (message.session.kind === 'private') {
      try {
        await options.adapter.setTyping(message.session);
      } catch (error) {
        options.onError?.(error, message);
      }
    }

    const sentMessageIds: string[] = [];
    for (const [index, text] of parts.entries()) {
      await wait(replyDelayMs(text, random));
      const segments: Segment[] = message.session.kind === 'group' && index === 0
        ? [{ type: 'reply', messageId: message.messageId }, { type: 'text', text }]
        : [{ type: 'text', text }];
      let sent: { messageId: string };
      try {
        sent = await options.adapter.send(message.session, segments);
      } catch (error) {
        options.onError?.(error, message);
        return recordDecision('send_error', {
          ...errorDetails(error),
          sentParts: sentMessageIds.length,
        }, sentMessageIds.length > 0);
      }

      sentMessageIds.push(sent.messageId);
      options.repository.saveMessage({
        sessionId: currentSessionId,
        messageId: sent.messageId,
        senderId: message.session.account,
        senderName: nickname,
        isSelf: true,
        plainText: text,
        segments,
        time: now(),
      });
    }

    return recordDecision('replied', {
      model: result.model,
      provider: result.provider,
      sentMessageIds,
      parts: parts.length,
    }, true);
  };
}
