import { clearAuthentication, PASSWORD_KEY, UNAUTHORIZED_EVENT } from './api.ts';

export interface ImpressionsRunWatchOptions {
  fetcher?: typeof fetch;
  password?: string | null;
  retryDelayMs?: number;
}

export interface ImpressionsRunStatus {
  running: boolean;
  completedAt: number | null;
}

export async function watchImpressionsRunState(
  sessionId: string,
  signal: AbortSignal,
  onStatus: (status: ImpressionsRunStatus) => void,
  options: ImpressionsRunWatchOptions = {},
): Promise<void> {
  const fetcher = options.fetcher ?? fetch;
  const password = Object.hasOwn(options, 'password')
    ? options.password
    : sessionStorage.getItem(PASSWORD_KEY);
  const retryDelayMs = options.retryDelayMs ?? 1_000;

  while (!signal.aborted) {
    try {
      const headers = new Headers();
      if (password) headers.set('Authorization', `Bearer ${password}`);
      const response = await fetcher(
        `/api/impressions/${encodeURIComponent(sessionId)}/events`,
        { headers, signal, cache: 'no-store' },
      );
      if (response.status === 401) {
        clearAuthentication();
        window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
        return;
      }
      if (response.status >= 400 && response.status < 500) return;
      if (!response.ok || !response.body) throw new Error('读取印象任务状态失败');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (!signal.aborted) {
          const chunk = await reader.read();
          if (chunk.done) {
            buffer += decoder.decode();
          } else {
            buffer += decoder.decode(chunk.value, { stream: true });
          }
          let boundary = /\r?\n\r?\n/u.exec(buffer);
          while (boundary?.index !== undefined) {
            const frame = buffer.slice(0, boundary.index);
            buffer = buffer.slice(boundary.index + boundary[0].length);
            const data = frame.split(/\r?\n/u)
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trimStart())
              .join('\n');
            try {
              const parsed: unknown = JSON.parse(data);
              if (typeof parsed === 'object' && parsed !== null) {
                const status = parsed as { running?: unknown; completedAt?: unknown };
                if (typeof status.running === 'boolean'
                  && (status.completedAt === null || typeof status.completedAt === 'number')) {
                  onStatus({ running: status.running, completedAt: status.completedAt });
                }
              }
            } catch {
              // 忽略不完整或无效事件，等待后续完整帧。
            }
            boundary = /\r?\n\r?\n/u.exec(buffer);
          }
          if (chunk.done) break;
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    } catch {
      if (signal.aborted) return;
    }

    if (signal.aborted) return;
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, retryDelayMs));
  }
}
