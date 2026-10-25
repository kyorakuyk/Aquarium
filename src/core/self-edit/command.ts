import { sessionId, type IncomingMessage } from '../shared/events.ts';

export function plainTextOnly(message: IncomingMessage): boolean {
  return message.segments.every((segment) => segment.type === 'text')
    && message.segments.map((segment) => segment.type === 'text' ? segment.text : '').join('') === message.plainText;
}

export function parseSelfEditCommand(message: IncomingMessage): string | undefined {
  if (!plainTextOnly(message)) return undefined;
  const match = /^\/aq set\s+([\s\S]+)$/u.exec(message.plainText.trim());
  const request = match?.[1]?.trim();
  return request || undefined;
}

export function isSelfEditConfirmation(message: IncomingMessage): boolean {
  if (!plainTextOnly(message)) return false;
  return /^(?:好|可以|确认|嗯)$/u.test(message.plainText.trim());
}

export function selfEditSessionKey(message: IncomingMessage): string {
  return sessionId(message.session);
}

export function isRollbackRequest(value: string): boolean {
  const normalized = value.trim().replace(/[。！!？?]+$/u, '');
  return normalized === '撤回刚才的修改' || normalized === '撤回上次修改';
}
