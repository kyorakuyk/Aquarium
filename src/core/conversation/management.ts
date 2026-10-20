import { budgetState } from '../../llm/budget.ts';
import { resolveSession } from '../../config/resolve.ts';
import type { AquariumConfig } from '../../config/schema.ts';
import { sessionId, type IncomingMessage, type Segment, type SessionKey } from '../shared/events.ts';
import { listEnabledSessions } from './sessions.ts';
import type { ProtocolAdapter } from '../../adapters/types.ts';
import type { StoreRepository } from '../../store/repository.ts';

const DEFAULT_MUTE_MINUTES = 60;
const MINUTE_MS = 60_000;

type ManagementCommand =
  | { type: 'ping' }
  | { type: 'mute'; minutes: number }
  | { type: 'unmute' }
  | { type: 'recall' }
  | { type: 'status' };

function parseCommand(value: string): ManagementCommand | undefined {
  const text = value.trim();
  if (text === '/aq ping') return { type: 'ping' };
  if (text === '/aq unmute') return { type: 'unmute' };
  if (text === '/aq recall') return { type: 'recall' };
  if (text === '/aq status') return { type: 'status' };

  const mute = /^\/aq mute(?: ([0-9]+))?$/u.exec(text);
  if (!mute) return undefined;
  const minutes = mute[1] === undefined ? DEFAULT_MUTE_MINUTES : Number(mute[1]);
  if (!Number.isSafeInteger(minutes) || minutes <= 0 || !Number.isSafeInteger(minutes * MINUTE_MS)) {
    return undefined;
  }
  return { type: 'mute', minutes };
}

function parseOwnerCommand(message: IncomingMessage, ownerId: number): ManagementCommand | undefined {
  if (ownerId === 0 || message.senderId !== ownerId) return undefined;
  return parseCommand(message.plainText);
}

function isStickerCollectionRequest(message: IncomingMessage): boolean {
  const text = message.plainText.replace(/\s/gu, '');
  return (text === '收藏' || text === '收藏这个')
    && message.segments.some((segment) => segment.type === 'reply');
}

function repliedMessageHasImage(message: IncomingMessage, repository: StoreRepository): boolean {
  const reply = message.segments.find((segment) => segment.type === 'reply');
  if (!reply || reply.type !== 'reply') return false;
  const stored = repository.messageBySessionAndId(sessionId(message.session), reply.messageId);
  return stored?.segments.some((segment) => (
    typeof segment === 'object' && segment !== null && !Array.isArray(segment)
    && (segment as Record<string, unknown>).type === 'image'
  )) ?? false;
}

export function isManagementCommand(message: IncomingMessage, ownerId: number): boolean {
  return isStickerCollectionRequest(message) || parseOwnerCommand(message, ownerId) !== undefined;
}

function budgetLabel(state: ReturnType<typeof budgetState>): string {
  switch (state) {
    case 'ok': return '正常';
    case 'warn': return '提醒';
    case 'exceeded': return '已超限';
  }
}

export interface ManagementCommands {
  handle(message: IncomingMessage): Promise<boolean>;
  isMuted(session: SessionKey): boolean;
  isAllMuted(): boolean;
  muteAll(): void;
  unmuteAll(): void;
}

export function createManagementCommands(options: {
  getConfig: () => AquariumConfig;
  repository: StoreRepository;
  adapter: ProtocolAdapter;
  getAdapters?: () => ProtocolAdapter[];
  getNickname?: () => string;
  now?: () => number;
  onError?: (error: unknown, message: IncomingMessage) => void;
  collectSticker?: (message: IncomingMessage) => Promise<{ ok: boolean; reason?: string }>;
}): ManagementCommands {
  const now = options.now ?? Date.now;
  const mutedUntil = new Map<string, number>();
  let allMuted = false;

  const isMuted = (session: SessionKey): boolean => {
    if (allMuted) return true;
    const key = sessionId(session);
    const until = mutedUntil.get(key);
    if (until === undefined) return false;
    if (now() >= until) {
      mutedUntil.delete(key);
      return false;
    }
    return true;
  };

  function recordDecision(
    message: IncomingMessage,
    reason: string,
    detail: unknown = {},
    replied = false,
  ): void {
    options.repository.recordDecision({
      time: now(),
      sessionId: sessionId(message.session),
      messageId: message.messageId,
      replied,
      reason,
      detail,
    });
  }

  async function sendDirect(message: IncomingMessage, text: string): Promise<boolean> {
    const segments: Segment[] = [{ type: 'text', text }];
    try {
      const sent = await options.adapter.send(message.session, segments);
      options.repository.saveMessage({
        sessionId: sessionId(message.session),
        messageId: sent.messageId,
        senderId: message.session.account,
        senderName: options.getNickname?.() || String(message.session.account),
        isSelf: true,
        plainText: text,
        segments,
        time: now(),
      });
      return true;
    } catch (error) {
      options.onError?.(error, message);
      return false;
    }
  }

  async function handle(message: IncomingMessage): Promise<boolean> {
    const config = options.getConfig();
    if (isStickerCollectionRequest(message)) {
      if (config.owner === 0 || message.senderId !== config.owner) return true;
      if (!options.collectSticker || !repliedMessageHasImage(message, options.repository)) return false;

      const inserted = options.repository.saveMessage({
        sessionId: sessionId(message.session),
        messageId: message.messageId,
        senderId: message.senderId,
        senderName: message.senderName,
        isSelf: false,
        plainText: message.plainText,
        segments: message.segments,
        time: message.time,
      });
      if (!inserted) {
        recordDecision(message, 'duplicate', { command: 'sticker_collect' });
        return true;
      }

      let result: { ok: boolean; reason?: string };
      try {
        result = await options.collectSticker(message);
      } catch (error) {
        options.onError?.(error, message);
        result = { ok: false, reason: '收藏操作失败' };
      }
      const sent = await sendDirect(
        message,
        result.ok ? '收好了' : result.reason === 'already_collected'
          ? '这个已经收藏过啦'
          : `没收藏上：${result.reason || '收藏操作失败'}`,
      );
      recordDecision(message, result.ok && sent ? 'command_sticker_collect' : 'command_sticker_collect_error', {
        command: 'sticker_collect',
      }, sent);
      return true;
    }

    const command = parseOwnerCommand(message, config.owner);
    if (!command) return false;

    const inserted = options.repository.saveMessage({
      sessionId: sessionId(message.session),
      messageId: message.messageId,
      senderId: message.senderId,
      senderName: message.senderName,
      isSelf: false,
      plainText: message.plainText,
      segments: message.segments,
      time: message.time,
    });
    if (!inserted) {
      recordDecision(message, 'duplicate', { command: command.type });
      return true;
    }

    const ownerPrivate = message.session.kind === 'private' && message.session.peer === config.owner;
    if (!ownerPrivate && !resolveSession(config, message.session).enabled) {
      recordDecision(message, 'command_ignored', { command: command.type });
      return true;
    }

    switch (command.type) {
      case 'ping': {
        const sent = await sendDirect(message, 'pong 🐟');
        recordDecision(message, sent ? 'command_ping' : 'command_error', { command: command.type }, sent);
        return true;
      }
      case 'mute': {
        const expiresAt = now() + command.minutes * MINUTE_MS;
        if (!Number.isSafeInteger(expiresAt)) {
          recordDecision(message, 'command_error', { command: command.type, reason: 'invalid_expiry' });
          return true;
        }
        mutedUntil.set(sessionId(message.session), expiresAt);
        const sent = await sendDirect(message, `好，我先不说话了（${command.minutes} 分钟）`);
        recordDecision(message, sent ? 'command_mute' : 'command_error', {
          command: command.type,
          minutes: command.minutes,
        }, sent);
        return true;
      }
      case 'unmute': {
        mutedUntil.delete(sessionId(message.session));
        const sent = await sendDirect(message, '我回来了');
        recordDecision(message, sent ? 'command_unmute' : 'command_error', { command: command.type }, sent);
        return true;
      }
      case 'recall': {
        const latest = options.repository.lastSelfMessage(sessionId(message.session));
        if (!latest) {
          const sent = await sendDirect(message, '没有可以撤回的消息');
          recordDecision(message, sent ? 'command_recall_empty' : 'command_error', { command: command.type }, sent);
          return true;
        }
        try {
          await options.adapter.recall(latest.messageId);
          recordDecision(message, 'command_recall', { command: command.type, messageId: latest.messageId });
        } catch (error) {
          options.onError?.(error, message);
          recordDecision(message, 'command_error', { command: command.type });
        }
        return true;
      }
      case 'status': {
        const enabledSessionIds = new Set<string>();
        for (const adapter of options.getAdapters?.() ?? [options.adapter]) {
          const sessions = await listEnabledSessions(
            adapter,
            config,
            (error) => options.onError?.(error, message),
          );
          for (const session of sessions) enabledSessionIds.add(sessionId(session));
        }
        const costToday = options.repository.costToday();
        const status = budgetLabel(budgetState(config, costToday));
        const text = `今日花费 ¥${costToday.toFixed(4)}，预算${status}，已启用会话 ${enabledSessionIds.size} 个`;
        const sent = await sendDirect(message, text);
        recordDecision(message, sent ? 'command_status' : 'command_error', { command: command.type }, sent);
        return true;
      }
    }
  }

  return {
    handle,
    isMuted,
    isAllMuted: () => allMuted,
    muteAll() {
      allMuted = true;
    },
    unmuteAll() {
      allMuted = false;
      mutedUntil.clear();
    },
  };
}
