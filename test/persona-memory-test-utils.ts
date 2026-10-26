import type { PersonaMemoryService } from '../src/core/persona-memory.ts';
import { messageRecord } from '../src/core/conversation/steps/types.ts';
import { sessionId, type IncomingMessage } from '../src/core/shared/events.ts';
import type { StoreRepository } from '../src/store/repository.ts';

export function saveAndObserveMessage(
  repository: Pick<StoreRepository, 'saveMessage'>,
  service: Pick<PersonaMemoryService, 'observeMessage'>,
  message: IncomingMessage,
): boolean {
  if (!repository.saveMessage(messageRecord(message, sessionId(message.session)))) return false;
  return service.observeMessage(message);
}
