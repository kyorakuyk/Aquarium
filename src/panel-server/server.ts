import { serve, type ServerType } from '@hono/node-server';
import { createPanelApp, type PanelServerOptions } from './app.ts';

export type { PanelAccountRuntime } from './types.ts';

export interface PanelListenOptions extends PanelServerOptions {
  host: string;
  port: number;
}

export function assertLoopbackHost(host: string): void {
  if (host !== '127.0.0.1' && host !== '::1') {
    throw new Error('管理面板仅允许绑定 loopback 地址 127.0.0.1 或 ::1');
  }
}

export function startPanelServer(options: PanelListenOptions): ServerType {
  assertLoopbackHost(options.host);
  const app = createPanelApp(options);
  return serve({ fetch: app.fetch, hostname: options.host, port: options.port });
}
