export type HostStatus = 'starting' | 'waiting_qq_login' | 'online' | 'error';

export interface Host {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): HostStatus;
  onStatus(callback: (status: HostStatus, message?: string) => void): () => void;
}
