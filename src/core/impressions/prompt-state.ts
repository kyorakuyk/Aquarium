import type { StoreRepository } from '../../store/repository.ts';
import type { TagPromptStateUpdate } from './tags.ts';

export function persistTagPromptStates(
  repository: Pick<StoreRepository, 'transaction' | 'updateTag' | 'updateKinTagPromptStateById'>,
  updates: readonly TagPromptStateUpdate[],
): void {
  if (updates.length === 0) return;
  repository.transaction(() => {
    for (const { id, inPrompt } of updates) {
      if (id < 0) repository.updateKinTagPromptStateById(-id, inPrompt);
      else repository.updateTag(id, { inPrompt });
    }
  });
}
