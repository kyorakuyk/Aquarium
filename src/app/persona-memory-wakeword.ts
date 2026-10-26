import type { StoreRepository } from '../store/repository.ts';
import type { PersonaMemoryService } from '../core/persona-memory.ts';
import { parseSessionId } from '../core/conversation/sessions.ts';

const QUIET_MS = 10 * 60_000;
const RETRY_MS = 60_000;
const JOB_LIMIT = 50;

export interface PersonaMemoryWakeWordJobProcessorInput {
  repository: StoreRepository;
  service: Pick<PersonaMemoryService, 'organizeAtSleep'>;
  account: number;
  now: number;
  awake: boolean;
}

export interface PersonaMemoryWakeWordJobProcessorResult {
  scheduled: number;
  deferred: number;
  skipped: number;
  expired: number;
}

function deferOrSkip(
  input: PersonaMemoryWakeWordJobProcessorInput,
  job: ReturnType<StoreRepository['listPendingPersonaMemoryWakeWordJobs']>[number],
  reason: string,
  nextAttemptAt = input.now + RETRY_MS,
): 'deferred' | 'skipped' {
  if (nextAttemptAt >= job.expiresAt) {
    input.repository.skipPersonaMemoryWakeWordJob(input.account, job.id, input.now, reason);
    return 'skipped';
  }
  input.repository.deferPersonaMemoryWakeWordJob(input.account, job.id, input.now, nextAttemptAt, reason);
  return 'deferred';
}

export async function processPersonaMemoryWakeWordJobs(
  input: PersonaMemoryWakeWordJobProcessorInput,
): Promise<PersonaMemoryWakeWordJobProcessorResult> {
  const result: PersonaMemoryWakeWordJobProcessorResult = { scheduled: 0, deferred: 0, skipped: 0, expired: 0 };
  if (!Number.isSafeInteger(input.account) || input.account <= 0
    || !Number.isSafeInteger(input.now) || input.now < 0) return result;

  result.expired = input.repository.expirePersonaMemoryWakeWordJobs(input.account, input.now);
  if (!input.awake) return result;

  const jobs = input.repository.listPendingPersonaMemoryWakeWordJobs(input.account, input.now, JOB_LIMIT);
  for (const job of jobs) {
    if (!input.repository.claimPersonaMemoryWakeWordJob(input.account, job.id, input.now)) continue;
    const session = parseSessionId(job.sessionId);
    if (!session || session.account !== input.account || job.expiresAt <= input.now) {
      input.repository.skipPersonaMemoryWakeWordJob(input.account, job.id, input.now, 'invalid-scope');
      result.skipped += 1;
      continue;
    }

    const lastMessageAt = input.repository.lastMessageTime(job.sessionId);
    if (lastMessageAt !== null && lastMessageAt + QUIET_MS > input.now) {
      const nextAttemptAt = lastMessageAt + QUIET_MS;
      const status = deferOrSkip(input, job, 'session-not-quiet', nextAttemptAt);
      result[status] += 1;
      continue;
    }

    let organized;
    try {
      organized = await input.service.organizeAtSleep({
        account: input.account,
        cycleKey: job.cycleKey,
        now: input.now,
        skipDiary: true,
      });
    } catch {
      const status = deferOrSkip(input, job, 'organize-failed');
      result[status] += 1;
      continue;
    }
    if (organized.status === 'budget' || organized.status === 'partial' || organized.status === 'failed') {
      const status = deferOrSkip(input, job, `organize-${organized.status}`);
      result[status] += 1;
      continue;
    }

    const pendingIds = new Set(input.repository.listPersonaMemoryPendingMessages(input.account, job.sessionId)
      .map(({ messageId }) => messageId));
    if (job.messageIds.some((messageId) => pendingIds.has(messageId))) {
      const status = deferOrSkip(input, job, 'source-not-organized');
      result[status] += 1;
      continue;
    }

    const messages = job.messageIds.flatMap((messageId) => {
      const message = input.repository.messageBySessionAndId(job.sessionId, messageId);
      if (!message || message.sessionId !== job.sessionId || message.isSelf
        || message.senderId === input.account || message.time > input.now) return [];
      return [{ messageId, senderId: message.senderId }];
    });
    if (messages.length === 0) {
      input.repository.skipPersonaMemoryWakeWordJob(input.account, job.id, input.now, 'source-unavailable');
      result.skipped += 1;
      continue;
    }

    const senderIds = [...new Set(messages.map(({ senderId }) => senderId))];
    try {
      input.repository.enqueuePersonaMemoryWakeFollowup({
        account: input.account,
        sessionId: job.sessionId,
        cycleKey: job.cycleKey,
        jobKey: `wakeword:${job.id}`,
        messageIds: messages.map(({ messageId }) => messageId),
        mentionIds: session.kind === 'group' ? senderIds : [],
        createdAt: input.now,
        nextAttemptAt: input.now,
        expiresAt: job.expiresAt,
      });
      input.repository.finishPersonaMemoryWakeWordJob(input.account, job.id, input.now);
      result.scheduled += 1;
    } catch {
      const status = deferOrSkip(input, job, 'followup-enqueue-failed');
      result[status] += 1;
    }
  }
  return result;
}
