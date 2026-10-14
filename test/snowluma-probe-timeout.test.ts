import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createWindowsHost } from '../src/host/windows/host.ts';

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  kill(): boolean {
    queueMicrotask(() => {
      this.emit('exit', 0, null);
      this.emit('close', 0, null);
    });
    return true;
  }
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function delayedResponse(value: unknown, delayMs: number, signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(jsonResponse(value));
    }, delayMs);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

test('慢速 probe-login 响应在请求超时窗口内到达后仍能加载匹配账号', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'aquarium-probe-timeout-'));
  const snowlumaDir = path.join(root, 'SnowLuma');
  mkdirSync(path.join(snowlumaDir, 'config'), { recursive: true });
  writeFileSync(path.join(snowlumaDir, 'index.mjs'), '', 'utf8');
  writeFileSync(path.join(snowlumaDir, 'config', 'runtime.json'), JSON.stringify({ hookAutoLoad: false }), 'utf8');

  const child = new FakeChild();
  const processInfo = {
    pid: 123,
    name: 'QQ.exe',
    path: '',
    injected: false,
    connected: false,
    loggedIn: false,
    uin: '0',
    status: 'available',
    error: '',
    method: '',
  };
  let loadCalls = 0;
  const host = createWindowsHost({
    accounts: [{ uin: 10001, snowlumaDir }],
    settings: { startSnowLuma: true, scanIntervalSec: 5 },
    password: 'test-only-password',
    logDirectory: path.join(root, 'logs'),
    getAdapterStatus: () => 'online',
    spawnProcess: (() => child) as never,
    setInterval: (() => 1) as never,
    clearInterval: (() => {}) as never,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString());
      if (url.pathname === '/api/login') {
        return jsonResponse({ success: true, token: 'test-only-token', mustChangePassword: false });
      }
      if (url.pathname === '/api/processes') return jsonResponse({ list: [processInfo] });
      if (url.pathname === '/api/processes/123/probe-login') {
        return delayedResponse({ info: { port: 4301, uin: '10001', identityKnown: true } }, 5_100, init?.signal);
      }
      if (url.pathname === '/api/processes/123/load') {
        loadCalls += 1;
        return jsonResponse({
          success: true,
          process: { ...processInfo, injected: true, uin: '10001', status: 'loaded', method: 'loadModuleManual' },
        });
      }
      throw new Error(`unexpected request ${url.pathname}`);
    }) as typeof fetch,
  });

  try {
    await host.start();
    assert.equal(loadCalls, 1);
    assert.equal(host.status(), 'online');
  } finally {
    await host.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
