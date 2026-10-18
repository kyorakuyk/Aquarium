export interface AdapterStartControl {
  start(): void;
  waitForLogin(): void;
  retryNow(): void;
}

export function startAdapterForHost(
  adapter: AdapterStartControl,
  options: { managed: boolean; ready: boolean },
): void {
  if (!options.managed) {
    adapter.start();
    return;
  }

  adapter.waitForLogin();
  if (options.ready) adapter.retryNow();
}
