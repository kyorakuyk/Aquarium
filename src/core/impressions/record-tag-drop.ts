import type { StoreRepository } from '../../store/repository.ts';
import type { TagCategory } from './tag-model.ts';
import { redactSensitiveText } from './sensitive-text.ts';

export function recordScheduleTagDrop(
  repository: Pick<StoreRepository, 'recordTagDrop'>,
  input: {
    account: number;
    sessionId: string;
    userId: number | null;
    category: TagCategory;
    text: string;
    time: number;
  },
  onError?: (error: unknown) => void,
): void {
  try {
    repository.recordTagDrop({ ...input, text: redactSensitiveText(input.text), reason: 'schedule_by_stats' });
  } catch (error) {
    try { onError?.(error); } catch { /* 统计提示记录失败不影响印象整理。 */ }
  }
}
