import type { Host, HostStatus } from './types.ts';

export type TrayMenuAction =
  | 'open-console'
  | 'open-qq'
  | 'mute-all'
  | 'unmute-all'
  | 'restart-snowluma'
  | 'quit';

export interface Tray {
  setState(state: HostStatus, tooltip: string): void;
  onMenu(handler: (action: TrayMenuAction) => void): void;
  notify(text: string): void;
  dispose(): void;
}

export function createLogOnlyTray(log: (message: string) => void): Tray {
  let disposed = false;
  const write = (message: string): void => {
    if (!disposed) log(message);
  };

  return {
    setState(state, tooltip) {
      write(`托盘状态：${state}；${tooltip}`);
    },
    onMenu(handler) {
      if (disposed) return;
      void handler;
      write('托盘菜单回调已注册（空实现）。');
    },
    notify(text) {
      write(`托盘通知（空实现）：${text}`);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      log('托盘空实现已释放。');
    },
  };
}

export function bindHostTray(
  host: Host,
  tray: Tray,
  onMenu: (action: TrayMenuAction) => void,
): () => void {
  tray.onMenu(onMenu);
  let previousStatus: HostStatus | undefined;
  const unsubscribe = host.onStatus((status) => {
    tray.setState(status, tooltipFor(status));
    if (status === 'waiting_qq_login' && previousStatus !== status) {
      tray.notify('请登录小号 QQ');
    }
    previousStatus = status;
  });

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    tray.dispose();
  };
}

function tooltipFor(status: HostStatus): string {
  switch (status) {
    case 'starting': return '水族箱 · 启动中';
    case 'waiting_qq_login': return '水族箱 · 等待小号登录';
    case 'online': return '水族箱 · 在线';
    case 'error': return '水族箱 · 出错';
  }
}
