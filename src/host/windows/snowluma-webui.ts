import { createRequire } from 'node:module';

const requireBuiltin = createRequire(import.meta.url);

export interface SnowLumaProcessInfo {
  pid: number;
  name: string;
  path: string;
  injected: boolean;
  connected: boolean;
  loggedIn: boolean;
  uin: string;
  status: string;
  error: string;
  method: string;
}

export interface SnowLumaLoginInfo {
  port: number;
  uin: string;
  uid?: string;
  nickName?: string;
  identityKnown: boolean;
}

export interface SnowLumaLoadResult {
  success: boolean;
  process: SnowLumaProcessInfo;
}

export interface SnowLumaWebUIClientOptions {
  baseUrl: string;
  password: string;
  fetch?: typeof globalThis.fetch;
  log?: (message: string) => void;
  requestTimeoutMs?: number;
}

interface TimedWebUIResponse {
  response: Response;
  readJson(): Promise<unknown>;
  release(): void;
}

export type SnowLumaWebUIErrorCode =
  | 'config'
  | 'http'
  | 'invalid-pid'
  | 'login-rejected'
  | 'network'
  | 'password-change-required'
  | 'protocol'
  | 'proxy-enabled'
  | 'totp-required'
  | 'unsafe-url';

export class SnowLumaWebUIError extends Error {
  readonly status: number | undefined;
  readonly retryable: boolean;
  readonly code: SnowLumaWebUIErrorCode;

  constructor(message: string, status?: number, retryable = false, code: SnowLumaWebUIErrorCode = 'protocol') {
    super(message);
    this.name = 'SnowLumaWebUIError';
    this.status = status;
    this.retryable = retryable;
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProcessInfo(value: unknown): value is SnowLumaProcessInfo {
  if (!isRecord(value)) return false;
  return Number.isSafeInteger(value.pid) && Number(value.pid) > 0
    && typeof value.name === 'string'
    && typeof value.path === 'string'
    && typeof value.injected === 'boolean'
    && typeof value.connected === 'boolean'
    && typeof value.loggedIn === 'boolean'
    && typeof value.uin === 'string'
    && typeof value.status === 'string'
    && typeof value.error === 'string'
    && typeof value.method === 'string';
}

function assertPid(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 4_194_304) {
    throw new SnowLumaWebUIError('SnowLuma WebUI process PID is invalid', undefined, false, 'invalid-pid');
  }
}

function parseJson(value: Response, path: string): Promise<unknown> {
  return value.json().catch(() => {
    throw new SnowLumaWebUIError(`SnowLuma WebUI ${path} returned invalid JSON`);
  });
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SnowLumaWebUIError('SnowLuma WebUI URL must be loopback', undefined, false, 'unsafe-url');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username !== ''
    || url.password !== ''
    || url.search !== ''
    || url.hash !== ''
    || (url.pathname !== '' && url.pathname !== '/')) {
    throw new SnowLumaWebUIError('SnowLuma WebUI URL must be loopback', undefined, false, 'unsafe-url');
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname.toLowerCase())) {
    throw new SnowLumaWebUIError('SnowLuma WebUI URL must be loopback', undefined, false, 'unsafe-url');
  }
  url.pathname = '/';
  return url.href;
}

function hasProxyEnvironment(agent: unknown): boolean {
  if (!isRecord(agent) || !isRecord(agent.options)) return false;
  return agent.options.proxyEnv !== undefined;
}

function hasGlobalProxyEnvironment(): boolean {
  // setGlobalProxyFromEnv() 会替换模块导出的 globalAgent；每次读取当前属性，避免使用旧引用。
  const httpModule = requireBuiltin('node:http') as { globalAgent?: unknown };
  const httpsModule = requireBuiltin('node:https') as { globalAgent?: unknown };
  return hasProxyEnvironment(httpModule.globalAgent) || hasProxyEnvironment(httpsModule.globalAgent);
}

export function isNodeProxySupportEnabled(
  environment: NodeJS.ProcessEnv,
  execArgv: string[],
  globalProxyAgentConfigured = false,
): boolean {
  const proxyFlag = /(?:^|\s)--use-env-proxy(?:=|\s|$)/u;
  const configFileFlag = /(?:^|\s)--experimental-(?:default-)?config-file(?:=|\s|$)/u;
  const nodeOptions = environment.NODE_OPTIONS ?? '';
  const args = `${execArgv.join('\n')}\n${nodeOptions}`;
  const envValue = environment.NODE_USE_ENV_PROXY?.trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(envValue ?? '')
    || proxyFlag.test(args)
    || configFileFlag.test(args)
    || globalProxyAgentConfigured;
}

export function createSnowLumaWebUIClient(options: SnowLumaWebUIClientOptions) {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  function assertNoProxySupport(): void {
    if (!options.fetch && isNodeProxySupportEnabled(
      process.env,
      process.execArgv,
      hasGlobalProxyEnvironment(),
    )) {
      throw new SnowLumaWebUIError(
        'SnowLuma WebUI refuses Node environment-proxy mode for credentialed loopback requests',
        undefined,
        false,
        'proxy-enabled',
      );
    }
  }
  assertNoProxySupport();
  const password = options.password;
  const fetchRequest = options.fetch ?? globalThis.fetch;
  const log = options.log ?? (() => {});
  const requestTimeoutMs = options.requestTimeoutMs ?? 3_000;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new SnowLumaWebUIError('SnowLuma WebUI request timeout is invalid', undefined, false, 'config');
  }
  let token: string | undefined;

  async function send(path: string, method: 'GET' | 'POST', body?: unknown, bearer?: string): Promise<TimedWebUIResponse> {
    assertNoProxySupport();
    const url = new URL(path, baseUrl);
    const headers = new Headers();
    if (body !== undefined) headers.set('content-type', 'application/json');
    if (bearer) headers.set('authorization', `Bearer ${bearer}`);
    const init: RequestInit = { method, headers, redirect: 'error' };
    if (body !== undefined) init.body = JSON.stringify(body);

    let response: Response;
    let responseToCancel: Response | undefined;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    let released = false;
    let bodyConsumed = false;
    const release = (): void => {
      if (released) return;
      released = true;
      clearTimeout(timeout);
      if (responseToCancel?.body && !bodyConsumed) {
        bodyConsumed = true;
        void responseToCancel.body.cancel().catch(() => {});
      }
    };
    try {
      response = await fetchRequest(url, { ...init, signal: controller.signal });
      responseToCancel = response;
    } catch {
      release();
      log(`SnowLuma WebUI ${method} ${url.pathname} network error`);
      throw new SnowLumaWebUIError(`SnowLuma WebUI ${path} network error`, undefined, true, 'network');
    }
    log(`SnowLuma WebUI ${method} ${url.pathname} HTTP ${response.status}`);
    return {
      response,
      release,
      async readJson() {
        bodyConsumed = true;
        try {
          return await parseJson(response, path);
        } catch (error) {
          if (controller.signal.aborted) {
            log(`SnowLuma WebUI ${method} ${url.pathname} body timeout`);
            throw new SnowLumaWebUIError(`SnowLuma WebUI ${path} timed out`, undefined, true, 'network');
          }
          throw error;
        } finally {
          release();
        }
      },
    };
  }

  async function login(): Promise<void> {
    if (token) return;
    if (!password) throw new SnowLumaWebUIError('SNOWLUMA_WEBUI_PASSWORD is not configured', undefined, false, 'config');

    const request = await send('/api/login', 'POST', { password });
    const response = request.response;
    const payload = await request.readJson();
    if (isRecord(payload) && payload.needsTotp === true) {
      throw new SnowLumaWebUIError('SnowLuma WebUI requires TOTP', undefined, false, 'totp-required');
    }
    if (!response.ok) {
      throw new SnowLumaWebUIError(`SnowLuma WebUI login failed with HTTP ${response.status}`, response.status, response.status >= 500, 'http');
    }
    if (!isRecord(payload) || payload.success !== true || typeof payload.token !== 'string' || payload.token.length === 0) {
      throw new SnowLumaWebUIError('SnowLuma WebUI rejected login', undefined, false, 'login-rejected');
    }
    if (payload.mustChangePassword === true) {
      throw new SnowLumaWebUIError('SnowLuma WebUI requires a password change', undefined, false, 'password-change-required');
    }
    token = payload.token;
  }

  async function authenticatedPayload(path: string, method: 'GET' | 'POST'): Promise<unknown> {
    await login();
    let request = await send(path, method, undefined, token);
    if (request.response.status === 401) {
      request.release();
      token = undefined;
      await login();
      request = await send(path, method, undefined, token);
      if (request.response.status === 401) token = undefined;
    }
    if (!request.response.ok) {
      const { status } = request.response;
      request.release();
      throw new SnowLumaWebUIError(`SnowLuma WebUI ${path} failed with HTTP ${status}`, status, status >= 500, 'http');
    }
    return request.readJson();
  }

  async function listProcesses(): Promise<SnowLumaProcessInfo[]> {
    const payload = await authenticatedPayload('/api/processes', 'GET');
    if (!isRecord(payload) || !Array.isArray(payload.list) || !payload.list.every(isProcessInfo)) {
      throw new SnowLumaWebUIError('SnowLuma WebUI returned an invalid process list');
    }
    return payload.list;
  }

  // 路由依据：server.ts 626–660、1464–1508；load 在 1492 行注册。
  async function probeLogin(pid: number): Promise<SnowLumaLoginInfo | null> {
    assertPid(pid);
    const payload = await authenticatedPayload(`/api/processes/${pid}/probe-login`, 'GET');
    if (!isRecord(payload) || !('info' in payload)) {
      throw new SnowLumaWebUIError('SnowLuma WebUI returned an invalid login probe');
    }
    if (payload.info === null) return null;
    if (!isRecord(payload.info)
      || !Number.isSafeInteger(payload.info.port)
      || Number(payload.info.port) < 0
      || (Number(payload.info.port) === 0 && payload.info.identityKnown !== false)
      || typeof payload.info.uin !== 'string'
      || typeof payload.info.identityKnown !== 'boolean'
      || (payload.info.uid !== undefined && typeof payload.info.uid !== 'string')
      || (payload.info.nickName !== undefined && typeof payload.info.nickName !== 'string')) {
      throw new SnowLumaWebUIError('SnowLuma WebUI returned an invalid login probe');
    }
    return {
      port: Number(payload.info.port),
      uin: payload.info.uin,
      identityKnown: payload.info.identityKnown,
      ...(typeof payload.info.uid === 'string' ? { uid: payload.info.uid } : {}),
      ...(typeof payload.info.nickName === 'string' ? { nickName: payload.info.nickName } : {}),
    };
  }

  async function load(pid: number): Promise<SnowLumaLoadResult> {
    assertPid(pid);
    const payload = await authenticatedPayload(`/api/processes/${pid}/load`, 'POST');
    if (!isRecord(payload) || typeof payload.success !== 'boolean' || !isProcessInfo(payload.process)) {
      throw new SnowLumaWebUIError('SnowLuma WebUI returned an invalid load result');
    }
    return { success: payload.success, process: payload.process };
  }

  return { login, listProcesses, probeLogin, load };
}
