import type { StoreRepository } from '../../store/repository.ts';
import type { TagPromptStateUpdate } from './tags.ts';

export function persistTagPromptStates(
  repository: Pick<StoreRepository, 'transaction' | 'updateTag'>,
  updates: readonly TagPromptStateUpdate[],
): void {
  if (updates.length === 0) return;
  repository.transaction(() => {
    for (const { id, inPrompt } of updates) repository.updateTag(id, { inPrompt });
  });
}
