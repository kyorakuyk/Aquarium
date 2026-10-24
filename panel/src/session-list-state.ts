export type SessionListLoadState = 'loading' | 'ready' | 'error';

export function sessionListMessage(
  state: SessionListLoadState,
  visibleCount: number,
): string | undefined {
  if (state === 'loading') return '正在读取会话…';
  if (state === 'error') return '会话列表暂不可用；请查看上方提示。';
  return visibleCount === 0 ? '没有找到会话。' : undefined;
}
