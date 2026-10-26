import type { PipelineResult, ProcessMessageOptions } from '../core/conversation/steps/types.ts';
import { parseSessionId } from '../core/conversation/sessions.ts';
import type { IncomingMessage } from '../core/shared/events.ts';
import type { StoreRepository } from '../store/repository.ts';

export interface PersonaMemoryWakeFollowupProcessorInput {
  repository: StoreRepository;
  account: number;
  now: number;
  dispatch: (message: IncomingMessage, options: ProcessMessageOptions) => Promise<PipelineResult>;
  onNeedsReview?: (sessionId: string, reason: string) => void;
}

export interface PersonaMemoryWakeFollowupProcessorResult {
  sent: number;
  deferred: number;
  skipped: number;
  needsReview: number;
}

function deferReason(reason: string): boolean {
  return ['budget', 'rate_limited', 'asleep', 'offline', 'llm_error'].includes(reason);
}

function sourceEntries(
  repository: StoreRepository,
  sessionId: string,
  messageIds: readonly string[],
  account: number,
  now: number,
): Array<{ messageId: string; senderId: number; senderName: string; plainText: string; time: number }> {
  return messageIds.flatMap((messageId) => {
    const message = repository.messageBySessionAndId(sessionId, messageId);
    if (!message || message.sessionId !== sessionId || message.isSelf
      || !Number.isSafeInteger(message.senderId) || message.senderId <= 0
      || !Number.isSafeInteger(message.time) || message.time > now
      || typeof message.senderName !== 'string' || typeof message.plainText !== 'string') return [];
    return [{
      messageId,
      senderId: message.senderId,
      senderName: message.senderName,
      plainText: message.plainText,
      time: message.time,
    }];
  }).filter((message) => message.senderId !== account);
}

export async function processPersonaMemoryWakeFollowups(
  input: PersonaMemoryWakeFollowupProcessorInput,
): Promise<PersonaMemoryWakeFollowupProcessorResult> {
  const result: PersonaMemoryWakeFollowupProcessorResult = {
    sent: 0,
    deferred: 0,
    skipped: 0,
    needsReview: 0,
  };
  if (!Number.isSafeInteger(input.account) || input.account <= 0
    || !Number.isSafeInteger(input.now) || input.now < 0) return result;

  input.repository.expirePersonaMemoryWakeFollowups(input.account, input.now);
  const pending = input.repository.listPendingPersonaMemoryWakeFollowups(input.account, input.now, 50);
  for (const followup of pending) {
    if (!input.repository.claimPersonaMemoryWakeFollowup(input.account, followup.id, input.now)) continue;
    const session = parseSessionId(followup.sessionId);
    if (!session || session.account !== input.account) {
      input.repository.skipPersonaMemoryWakeFollowup(input.account, followup.id, input.now, 'invalid-session');
      result.skipped += 1;
      continue;
    }
    const storedMessages = sourceEntries(
      input.repository,
      followup.sessionId,
      followup.messageIds,
      input.account,
      input.now,
    );
    if (storedMessages.length === 0) {
      input.repository.skipPersonaMemoryWakeFollowup(input.account, followup.id, input.now, 'source-unavailable');
      result.skipped += 1;
      continue;
    }
    const replies = input.repository.decisionsInRange(followup.sessionId, storedMessages[0]!.time, input.now);
    const repliedIds = new Set(replies.filter((decision) => decision.replied).map((decision) => decision.messageId));
    const messages = storedMessages.filter(({ messageId }) => !repliedIds.has(messageId));
    if (messages.length === 0) {
      input.repository.skipPersonaMemoryWakeFollowup(input.account, followup.id, input.now, 'already-replied');
      result.skipped += 1;
      continue;
    }

    const latest = messages.at(-1)!;
    const incoming: IncomingMessage = {
      session,
      messageId: `sleep-followup-${followup.cycleKey}-${session.kind}-${session.peer}`,
      senderId: latest.senderId,
      senderName: latest.senderName,
      segments: [{ type: 'text', text: latest.plainText }],
      plainText: latest.plainText,
      mentionsSelf: session.kind === 'group',
      replyToSelf: false,
      time: input.now,
    };
    const senderIds = new Set(messages.map(({ senderId }) => senderId));
    const options: ProcessMessageOptions = {
      alreadySaved: true,
      quoteReplyTo: false,
      sleepFollowup: {
        cycleKey: followup.cycleKey,
        mentionIds: session.kind === 'group'
          ? followup.mentionIds.filter((senderId) => senderId !== input.account && senderIds.has(senderId))
          : [],
        messages: messages.map(({ senderName, plainText, time }) => ({ senderName, plainText, time })),
      },
    };

    let sent: PipelineResult;
    try {
      sent = await input.dispatch(incoming, options);
    } catch {
      input.repository.reviewPersonaMemoryWakeFollowup(input.account, followup.id, input.now, 'dispatch-error');
      try { input.onNeedsReview?.(followup.sessionId, 'dispatch-error'); } catch { /* 日志回调不能改变队列结果。 */ }
      result.needsReview += 1;
      continue;
    }
    if (sent.replied) {
      input.repository.finishPersonaMemoryWakeFollowup(input.account, followup.id, input.now);
      result.sent += 1;
    } else if (sent.reason === 'send_error') {
      input.repository.reviewPersonaMemoryWakeFollowup(input.account, followup.id, input.now, 'send-uncertain');
      try { input.onNeedsReview?.(followup.sessionId, 'send-uncertain'); } catch { /* 日志回调不能改变队列结果。 */ }
      result.needsReview += 1;
    } else if (deferReason(sent.reason)) {
      input.repository.deferPersonaMemoryWakeFollowup(
        input.account,
        followup.id,
        input.now,
        input.now + 60_000,
        sent.reason,
      );
      result.deferred += 1;
    } else {
      input.repository.skipPersonaMemoryWakeFollowup(input.account, followup.id, input.now, sent.reason.slice(0, 120));
      result.skipped += 1;
    }
  }
  return result;
}
