import assert from 'node:assert/strict';
import test from 'node:test';
import { createSnowLumaWebUIClient } from '../src/host/windows/snowluma-webui.ts';

const fakePassword = 'unit-test-password-only';
const firstToken = 'unit-test-session-1';
const secondToken = 'unit-test-session-2';

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof Request) return new URL(input.url);
  return new URL(input.toString());
}

function authHeader(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get('authorization');
}

test('识别 Node env-proxy 启用方式，并拒绝使用全局代理发送认证请求', async () => {
  const module = await import('../src/host/windows/snowluma-webui.ts');
  const checkProxyMode = (module as unknown as { isNodeProxySupportEnabled?: unknown }).isNodeProxySupportEnabled;
  assert.equal(typeof checkProxyMode, 'function');
  const isNodeProxySupportEnabled = checkProxyMode as (environment: NodeJS.ProcessEnv, execArgv: string[]) => boolean;
  assert.equal(isNodeProxySupportEnabled({ NODE_USE_ENV_PROXY: '1' }, []), true);
  assert.equal(isNodeProxySupportEnabled({}, ['--use-env-proxy']), true);
  assert.equal(isNodeProxySupportEnabled({ NODE_OPTIONS: '--use-env-proxy' }, []), true);
  assert.equal(isNodeProxySupportEnabled({ NODE_OPTIONS: '--experimental-config-file=node.config.json' }, []), true);
  assert.equal(isNodeProxySupportEnabled({}, [], true), true);
  assert.equal(isNodeProxySupportEnabled({}, []), false);

  const original = process.env.NODE_USE_ENV_PROXY;
  process.env.NODE_USE_ENV_PROXY = '1';
  try {
    assert.throws(() => createSnowLumaWebUIClient({
      baseUrl: 'http://127.0.0.1:5099',
      password: fakePassword,
    }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'proxy-enabled');
      return true;
    });
  } finally {
    if (original === undefined) delete process.env.NODE_USE_ENV_PROXY;
    else process.env.NODE_USE_ENV_PROXY = original;
  }
});

test('client 构造后动态启用 Node 全局代理时拒绝发送登录凭据', async (context) => {
  const nodeHttp = await import('node:http') as unknown as {
    globalAgent?: { options?: { proxyEnv?: unknown } };
    setGlobalProxyFromEnv?: (proxyEnv: NodeJS.ProcessEnv) => () => void;
  };
  if (!nodeHttp.setGlobalProxyFromEnv) {
    context.skip('当前 Node 不支持 setGlobalProxyFromEnv');
    return;
  }
  const launchOptions = `${process.execArgv.join(' ')} ${process.env.NODE_OPTIONS ?? ''}`;
  if (process.env.NODE_USE_ENV_PROXY === '1'
    || /(?:^|\s)--use-env-proxy(?:=|\s|$)/u.test(launchOptions)
    || /(?:^|\s)--experimental-(?:default-)?config-file(?:=|\s|$)/u.test(launchOptions)
    || nodeHttp.globalAgent?.options?.proxyEnv !== undefined) {
    context.skip('Node 环境代理已在测试进程启动时启用');
    return;
  }

  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return jsonResponse({ success: true, token: firstToken, mustChangePassword: false });
  }) as typeof fetch;
  const client = createSnowLumaWebUIClient({
    baseUrl: 'http://127.0.0.1:5099',
    password: fakePassword,
  });
  let restoreProxy: (() => void) | undefined;
  try {
    restoreProxy = nodeHttp.setGlobalProxyFromEnv({
      HTTP_PROXY: 'http://127.0.0.1:1',
      HTTPS_PROXY: 'http://127.0.0.1:1',
    });
    await assert.rejects(client.login(), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'proxy-enabled');
      return true;
    });
    assert.equal(fetchCalls, 0);
  } finally {
    restoreProxy?.();
    globalThis.fetch = originalFetch;
  }
});

test('客户端登录后使用内存 Bearer token 读取进程，日志不含密码或 token', async () => {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const logs: string[] = [];
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    calls.push({ url, init });
    if (url.pathname === '/api/login') {
      assert.deepEqual(JSON.parse(String(init?.body)), { password: fakePassword });
      return jsonResponse({ success: true, token: firstToken, mustChangePassword: false });
    }
    if (url.pathname === '/api/processes') {
      assert.equal(authHeader(init), `Bearer ${firstToken}`);
      return jsonResponse({ list: [{
        pid: 456,
        name: 'QQ.exe',
        path: '',
        injected: false,
        connected: false,
        loggedIn: true,
        uin: 10001,
        account: { uin: 10001, nickname: 'fixture' },
        status: 'available',
        error: '',
        method: '',
      }] });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;
  const client = createSnowLumaWebUIClient({
    baseUrl: 'http://127.0.0.1:5099',
    password: fakePassword,
    fetch: fakeFetch,
    log: (message) => logs.push(message),
  });

  const processes = await client.listProcesses();

  assert.deepEqual(processes.map((process) => process.pid), [456]);
  assert.equal(calls.length, 2);
  assert.ok(logs.every((message) => !message.includes(fakePassword)));
  assert.ok(logs.every((message) => !message.includes(firstToken)));
});

test('API 返回 401 时只重新登录一次再重试请求', async () => {
  let loginCount = 0;
  let processRequestCount = 0;
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    if (url.pathname === '/api/login') {
      loginCount += 1;
      return jsonResponse({
        success: true,
        token: loginCount === 1 ? firstToken : secondToken,
        mustChangePassword: false,
      });
    }
    processRequestCount += 1;
    if (processRequestCount === 1) return jsonResponse({ status: 'failed' }, 401);
    assert.equal(authHeader(init), `Bearer ${secondToken}`);
    return jsonResponse({ list: [] });
  }) as typeof fetch;
  const client = createSnowLumaWebUIClient({ baseUrl: 'http://127.0.0.1:5099', password: fakePassword, fetch: fakeFetch });

  assert.deepEqual(await client.listProcesses(), []);
  assert.equal(loginCount, 2);
  assert.equal(processRequestCount, 2);
});

test('401 重登与非 2xx 结束时取消未读取的响应 body', async () => {
  let loginCount = 0;
  let processRequestCount = 0;
  const canceledStatuses: number[] = [];
  const errorResponse = (status: number) => ({
    ok: false,
    status,
    body: new ReadableStream<Uint8Array>({
      cancel() { canceledStatuses.push(status); },
    }),
    json: async () => ({}),
  }) as Response;
  const fakeFetch = (async (input: RequestInfo | URL) => {
    const url = requestUrl(input);
    if (url.pathname === '/api/login') {
      loginCount += 1;
      return jsonResponse({ success: true, token: `unit-test-session-${loginCount}`, mustChangePassword: false });
    }
    processRequestCount += 1;
    return errorResponse(processRequestCount === 1 ? 401 : 403);
  }) as typeof fetch;
  const client = createSnowLumaWebUIClient({ baseUrl: 'http://127.0.0.1:5099', password: fakePassword, fetch: fakeFetch });

  await assert.rejects(client.listProcesses(), (error: unknown) => {
    assert.equal((error as { status?: number }).status, 403);
    return true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(canceledStatuses, [401, 403]);
});

test('登录要求 TOTP 时返回可供宿主 fail-closed 处理的错误码', async () => {
  let calls = 0;
  const logs: string[] = [];
  const fakeFetch = (async () => {
    calls += 1;
    return jsonResponse({ success: false, needsTotp: true });
  }) as typeof fetch;
  const client = createSnowLumaWebUIClient({
    baseUrl: 'http://127.0.0.1:5099',
    password: fakePassword,
    fetch: fakeFetch,
    log: (message) => logs.push(message),
  });

  await assert.rejects(client.login(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /TOTP/);
    assert.equal((error as Error & { code?: string }).code, 'totp-required');
    return true;
  });
  assert.equal(calls, 1);
  assert.ok(logs.every((message) => !message.includes(fakePassword)));
});

test('拒绝把控制台密码发送到非 loopback 或通配监听地址', async () => {
  let fetchCalls = 0;
  const requestedHosts: string[] = [];
  const fakeFetch = (async (input: RequestInfo | URL) => {
    fetchCalls += 1;
    requestedHosts.push(requestUrl(input).hostname);
    return jsonResponse({ success: true, token: firstToken, mustChangePassword: false });
  }) as typeof fetch;

  assert.throws(() => createSnowLumaWebUIClient({
    baseUrl: 'http://192.0.2.10:5099',
    password: fakePassword,
    fetch: fakeFetch,
  }), /loopback/i);
  assert.equal(fetchCalls, 0);

  assert.throws(() => createSnowLumaWebUIClient({
    baseUrl: 'http://0.0.0.0:5099',
    password: fakePassword,
    fetch: fakeFetch,
  }), /loopback/i);
  assert.deepEqual(requestedHosts, []);
});

test('WebUI 请求在超时后中止并标为可重试', async () => {
  let signal: AbortSignal | undefined;
  const fakeFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    signal = init?.signal as AbortSignal | undefined;
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  }) as typeof fetch;
  const client = createSnowLumaWebUIClient({
    baseUrl: 'http://127.0.0.1:5099',
    password: fakePassword,
    fetch: fakeFetch,
    requestTimeoutMs: 10,
  });
  const outcome = await Promise.race([
    client.login().then(
      () => ({ kind: 'resolved' as const }),
      (error: unknown) => ({ kind: 'error' as const, error }),
    ),
    new Promise<{ kind: 'timeout' }>((resolve) => setTimeout(() => resolve({ kind: 'timeout' }), 100)),
  ]);

  assert.notEqual(outcome.kind, 'timeout');
  assert.equal(signal?.aborted, true);
  if (outcome.kind === 'error') {
    assert.equal((outcome.error as { retryable?: boolean }).retryable, true);
  }
});

test('WebUI 响应 body 读取也受请求超时约束', async () => {
  let signal: AbortSignal | undefined;
  const fakeFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    signal = init?.signal as AbortSignal | undefined;
    return {
      ok: true,
      status: 200,
      json: () => new Promise<unknown>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('body read aborted')), { once: true });
      }),
    } as Response;
  }) as typeof fetch;
  const client = createSnowLumaWebUIClient({
    baseUrl: 'http://127.0.0.1:5099',
    password: fakePassword,
    fetch: fakeFetch,
    requestTimeoutMs: 10,
  });
  const outcome = await Promise.race([
    client.login().then(
      () => ({ kind: 'resolved' as const }),
      (error: unknown) => ({ kind: 'error' as const, error }),
    ),
    new Promise<{ kind: 'timeout' }>((resolve) => setTimeout(() => resolve({ kind: 'timeout' }), 100)),
  ]);

  assert.notEqual(outcome.kind, 'timeout');
  assert.equal(signal?.aborted, true);
  if (outcome.kind === 'error') {
    assert.equal((outcome.error as { retryable?: boolean }).retryable, true);
  }
});

test('v2.0.3 process list 与 load 使用约定路径；load 不发送 body', async () => {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    calls.push({ url, init });
    if (url.pathname === '/api/login') {
      return jsonResponse({ success: true, token: firstToken, mustChangePassword: false });
    }
    if (url.pathname === '/api/processes') {
      return jsonResponse({ list: [{
        pid: 456,
        name: 'QQ.exe',
        status: 'available',
        loggedIn: true,
        uin: 10001,
        account: { uin: 10001, nickname: 'fixture' },
      }] });
    }
    if (url.pathname === '/api/processes/456/load') {
      return jsonResponse({ success: true, process: {
        pid: 456,
        name: 'QQ.exe',
        path: '',
        injected: true,
        connected: false,
        loggedIn: false,
        uin: '0',
        status: 'loaded',
        error: '',
        method: 'loadModuleManual',
      } });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;
  const client = createSnowLumaWebUIClient({ baseUrl: 'http://127.0.0.1:5099', password: fakePassword, fetch: fakeFetch });

  assert.deepEqual(await client.listProcesses(), [{
    pid: 456,
    name: 'QQ.exe',
    status: 'available',
    loggedIn: true,
    uin: 10001,
    account: { uin: 10001, nickname: 'fixture' },
  }]);
  assert.deepEqual(await client.load(456), { success: true, process: {
    pid: 456,
    name: 'QQ.exe',
    path: '',
    injected: true,
    connected: false,
    loggedIn: false,
    uin: '0',
    status: 'loaded',
    error: '',
    method: 'loadModuleManual',
  } });
  const processListCall = calls.find((call) => call.url.pathname === '/api/processes');
  const loadCall = calls.find((call) => call.url.pathname.endsWith('/load'));
  assert.equal(processListCall?.init?.method, 'GET');
  assert.equal(loadCall?.init?.method, 'POST');
  assert.equal(loadCall?.init?.body, undefined);
  assert.equal(authHeader(loadCall?.init), `Bearer ${firstToken}`);
});

test('WebUI fetch 禁止 redirect，阻止登录密码被 307/308 重放到外部主机', async () => {
  const requestedUrls: string[] = [];
  let externalReplayCount = 0;
  const redirectResponse = new Response(null, {
    status: 307,
    headers: { location: 'https://evil.example/collect' },
  });
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    requestedUrls.push(url.href);
    if (init?.redirect === 'error') throw new TypeError(`redirect blocked: ${redirectResponse.status}`);
    if (url.pathname === '/api/login' && redirectResponse.status === 307) {
      externalReplayCount += 1;
      requestedUrls.push(redirectResponse.headers.get('location') ?? '');
      return jsonResponse({ success: true, token: firstToken, mustChangePassword: false });
    }
    if (url.hostname !== '127.0.0.1') externalReplayCount += 1;
    return jsonResponse({ success: true, token: firstToken, mustChangePassword: false });
  }) as typeof fetch;
  const client = createSnowLumaWebUIClient({
    baseUrl: 'http://127.0.0.1:5099',
    password: fakePassword,
    fetch: fakeFetch,
  });

  await assert.rejects(client.login(), /network error/);
  assert.deepEqual(requestedUrls, ['http://127.0.0.1:5099/api/login']);
  assert.equal(externalReplayCount, 0);
});
