import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWindowsHost } from '../src/host/windows/host.ts';

test('Windows host forwards successful QQ injection to the adapter retry hook', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'aquarium-host-injected-'));
  const snowlumaDir = path.join(root, 'SnowLuma');
  mkdirSync(path.join(snowlumaDir, 'config'), { recursive: true });
  writeFileSync(path.join(snowlumaDir, 'index.mjs'), '', 'utf8');
  writeFileSync(path.join(snowlumaDir, 'config', 'runtime.json'), JSON.stringify({ hookAutoLoad: false }), 'utf8');
  const injectedUins: number[] = [];
  const requests: string[] = [];
  const logs: string[] = [];
  const processInfo = { pid: 123, name: 'QQ.exe', path: '', injected: false, connected: false, loggedIn: true, uin: '10001', status: 'available', error: '', method: '' };
  const host = createWindowsHost({
    accounts: [{ uin: 10001, snowlumaDir }],
    settings: { startSnowLuma: false, scanIntervalSec: 5 },
    password: '[REDACTED]',
    logDirectory: path.join(root, 'logs'),
    getAdapterStatus: () => 'connecting',
    onAdapterInjected: (uin) => injectedUins.push(uin),
    fetch: (async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      requests.push(url.pathname);
      if (url.pathname === '/api/login') {
        return new Response(JSON.stringify({ success: true, token: '[REDACTED]', mustChangePassword: false }));
      }
      if (url.pathname === '/api/processes') return new Response(JSON.stringify({ list: [processInfo] }));
      if (url.pathname === '/api/processes/123/load') {
        return new Response(JSON.stringify({ success: true, process: { ...processInfo, injected: true, uin: '10001', status: 'loaded' } }));
      }
      throw new Error(`unexpected request ${url.pathname}`);
    }) as typeof fetch,
    log: (level, message) => logs.push(`${level}: ${message}`),
  });

  try {
    await host.start();
    assert.deepEqual(injectedUins, [10001], JSON.stringify({ status: host.status(), requests, logs }));
  } finally {
    await host.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
