import { createConnection } from 'node:net';

export interface PanelPortSocket {
  once(event: 'connect', listener: () => void): this;
  once(event: 'error', listener: (error: NodeJS.ErrnoException) => void): this;
  setTimeout(timeoutMs: number, listener: () => void): this;
  destroy(): void;
}

export type PanelPortConnector = (options: { host: string; port: number }) => PanelPortSocket;

function connectToPanelPort(options: { host: string; port: number }): PanelPortSocket {
  return createConnection(options);
}

export function isPanelPortOccupied(
  host: string,
  port: number,
  connector: PanelPortConnector = connectToPanelPort,
  timeoutMs = 500,
): Promise<boolean> {
  if (host !== '127.0.0.1' && host !== '::1') return Promise.resolve(false);
  return new Promise((resolve) => {
    let socket: PanelPortSocket;
    try {
      socket = connector({ host, port });
    } catch {
      resolve(true);
      return;
    }

    let settled = false;
    const finish = (occupied: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(occupied);
    };

    socket.once('connect', () => finish(true));
    socket.once('error', (error) => finish(error.code !== 'ECONNREFUSED'));
    socket.setTimeout(timeoutMs, () => finish(true));
  });
}
