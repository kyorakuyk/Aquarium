export interface ActivitySuggestionCopy {
  description: string;
  applyLabel: string;
  appliedMessage: string;
}

export const ACTIVITY_SUGGESTION_APPLIED_MESSAGE = '已将该时段写入该群的会话时间表。';

export function activitySuggestionCopy(from: string, to: string): ActivitySuggestionCopy {
  return {
    description: `该群 ${from}–${to} 最活跃。确认后会修改该群的会话时间表，将这段设为积极。`,
    applyLabel: '写入会话时间表',
    appliedMessage: ACTIVITY_SUGGESTION_APPLIED_MESSAGE,
  };
}
