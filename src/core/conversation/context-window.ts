import type { MessageStorageRecord } from '../../store/repository.ts';

export interface AnchoredContextWindow {
  select(sessionId: string, count: number, recentMessages: MessageStorageRecord[]): MessageStorageRecord[];
}

export function createAnchoredContextWindow(): AnchoredContextWindow {
  const anchors = new Map<string, Map<number, string>>();

  function setAnchor(sessionId: string, count: number, messageId: string | undefined): void {
    const windows = anchors.get(sessionId);
    if (messageId === undefined) {
      windows?.delete(count);
      if (windows?.size === 0) anchors.delete(sessionId);
      return;
    }
    const nextWindows = windows ?? new Map<number, string>();
    nextWindows.set(count, messageId);
    anchors.set(sessionId, nextWindows);
  }

  return {
    select(sessionId, count, recentMessages) {
      if (!Number.isSafeInteger(count) || count <= 0) throw new RangeError('上下文窗口数量无效');
      const recent = recentMessages.slice(-count * 2);
      const anchor = anchors.get(sessionId)?.get(count);
      const anchorIndex = anchor === undefined
        ? -1
        : recent.findIndex(({ messageId }) => messageId === anchor);

      if (anchorIndex < 0) {
        const nextWindow = recent.slice(-count);
        setAnchor(sessionId, count, nextWindow[0]?.messageId);
        return nextWindow;
      }

      const anchoredWindow = recent.slice(anchorIndex);
      if (anchoredWindow.length > Math.ceil(count * 1.5)) {
        const nextWindow = anchoredWindow.slice(-count);
        setAnchor(sessionId, count, nextWindow[0]?.messageId);
        return nextWindow;
      }
      return anchoredWindow;
    },
  };
}
