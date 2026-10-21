import { Hono } from 'hono';
import { parseSessionId } from '../core/conversation/sessions.ts';
import type { ImpressionsService } from '../core/impressions/service.ts';
import type { PanelAccountRuntime } from './types.ts';

export interface ImpressionsStatusRouteOptions {
  accounts: () => PanelAccountRuntime[];
  impressionsService?: ImpressionsService;
}

export function registerImpressionsStatusRoutes(app: Hono, options: ImpressionsStatusRouteOptions): void {
  function validGroupSession(id: string): boolean {
    const session = parseSessionId(id);
    return session?.kind === 'group'
      && options.accounts().some((account) => account.adapter.account === session.account);
  }

  app.get('/api/impressions/:sessionId/extraction-status', (context) => {
    const id = context.req.param('sessionId');
    if (!validGroupSession(id)) return context.json({ error: '群会话不存在' }, 404);
    return context.json(options.impressionsService?.extractionStatus(id) ?? { running: false, completedAt: null });
  });

  app.get('/api/impressions/:sessionId/events', (context) => {
    const id = context.req.param('sessionId');
    if (!validGroupSession(id)) return context.json({ error: '群会话不存在' }, 404);

    const encoder = new TextEncoder();
    let unsubscribe = (): void => {};
    let cleanup = (): void => {};
    const signal = context.req.raw.signal;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        let onAbort: (() => void) | undefined;
        const close = (): void => {
          if (closed) return;
          closed = true;
          unsubscribe();
          if (onAbort) signal.removeEventListener('abort', onAbort);
          try {
            controller.close();
          } catch {
            // 流关闭后不再执行清理。
          }
        };
        const send = (status: { running: boolean; completedAt: number | null }): void => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(status)}\n\n`));
          } catch {
            close();
          }
        };
        cleanup = close;
        unsubscribe = options.impressionsService?.subscribeRunState((event) => {
          if (event.sessionId === id) send({ running: event.running, completedAt: event.completedAt });
        }) ?? (() => {});
        onAbort = close;
        signal.addEventListener('abort', onAbort, { once: true });
        send(options.impressionsService?.extractionStatus(id) ?? { running: false, completedAt: null });
        if (signal.aborted) close();
      },
      cancel() {
        cleanup();
      },
    });
    return new Response(stream, {
      headers: {
        'cache-control': 'no-cache, no-transform',
        'content-type': 'text/event-stream; charset=utf-8',
        'x-accel-buffering': 'no',
      },
    });
  });
}
