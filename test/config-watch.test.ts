import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config/load.ts';
import { watchConfig } from '../src/config/watch.ts';
import { writeConfig } from '../src/config/write.ts';

const examplePath = path.resolve('config.example.yaml');

function createConfigFixture(t: { after(callback: () => void): void }) {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.tmp-config-watch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'config.yaml');
  fs.copyFileSync(examplePath, configPath);
  return { root, configPath };
}

test('非法热重载记录错误并保留上一份有效配置', async (t) => {
  const { configPath } = createConfigFixture(t);
  const errors: unknown[][] = [];
  const logger = { info: () => undefined, error: (...values: unknown[]) => errors.push(values) };
  const watcher = watchConfig({ configPath, examplePath, debounceMs: 30, logger });
  t.after(() => watcher.close());
  const previous = watcher.getConfig();

  fs.writeFileSync(configPath, 'owner: -1\n', 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.equal(watcher.getConfig(), previous);
  assert.ok(errors.length > 0);
});

test('有效热重载发出 changed 事件并更新当前配置', async (t) => {
  const { configPath } = createConfigFixture(t);
  const logger = { info: () => undefined, error: () => undefined };
  const watcher = watchConfig({ configPath, examplePath, debounceMs: 30, logger });
  t.after(() => watcher.close());
  const changed = new Promise<{ defaults: { enabled: boolean } }>((resolve) => {
    watcher.once('changed', resolve);
  });
  const updated = loadConfig({ configPath, examplePath, logger });

  writeConfig({
    ...updated,
    defaults: { ...updated.defaults, enabled: true },
  }, configPath);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error('配置监听没有发出 changed 事件')), 1500);
  });
  let next: { defaults: { enabled: boolean } };
  try {
    next = await Promise.race([changed, timedOut]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }

  assert.equal(next.defaults.enabled, true);
  assert.equal(watcher.getConfig().defaults.enabled, true);
});
