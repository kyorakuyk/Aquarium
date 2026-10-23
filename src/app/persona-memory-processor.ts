import { createSessionQueue } from '../core/conversation/session-queue.ts';
import type { PersonaMemoryProcessStatus } from '../core/persona-memory.ts';
import { sessionId, type SessionKey } from '../core/shared/events.ts';
import type { MessageStorageRecord } from '../store/repository.ts';

export type PersonaMemorySessionProcessor = (
  session: SessionKey,
  records: MessageStorageRecord[],
  now: number,
) => Promise<PersonaMemoryProcessStatus>;

export function createQueuedPersonaMemoryProcessor(options: {
  isSessionEnabled: (session: SessionKey) => boolean;
  process: PersonaMemorySessionProcessor;
}): PersonaMemorySessionProcessor {
  const queue = createSessionQueue();
  return (session, records, now) => queue.run(sessionId(session), async () => {
    if (!options.isSessionEnabled(session)) return 'failed';
    return options.process(session, records, now);
  });
}
