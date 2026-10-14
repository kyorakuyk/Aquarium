import assert from 'node:assert/strict';
import test from 'node:test';

type StartPanelWhileAccountStartupRuns = (
  accountStartup: Promise<void>,
  startPanel: () => void,
) => Promise<void>;

async function loadStartPanelWhileAccountStartupRuns(): Promise<StartPanelWhileAccountStartupRuns | undefined> {
  let module: Record<string, unknown>;
  try {
    module = await import(new URL('../src/app/startup-order.ts', import.meta.url).href) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ERR_MODULE_NOT_FOUND') return undefined;
    throw error;
  }
  return module.startPanelWhileAccountStartupRuns as StartPanelWhileAccountStartupRuns | undefined;
}

test('management panel starts while account startup waits for an offline QQ connection', async () => {
  const startPanelWhileAccountStartupRuns = await loadStartPanelWhileAccountStartupRuns();
  assert.equal(typeof startPanelWhileAccountStartupRuns, 'function');
  if (!startPanelWhileAccountStartupRuns) return;

  let releaseConnection: (() => void) | undefined;
  let panelStarted = false;
  let accountStartupSettled = false;
  const accountStartup = new Promise<void>((resolve) => { releaseConnection = resolve; });
  const startup = startPanelWhileAccountStartupRuns(
    accountStartup,
    () => { panelStarted = true; },
  );
  void startup.then(() => { accountStartupSettled = true; });

  assert.equal(panelStarted, true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(accountStartupSettled, false);

  releaseConnection?.();
  await startup;
  assert.equal(accountStartupSettled, true);
});
