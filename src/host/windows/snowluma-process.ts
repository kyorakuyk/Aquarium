import { spawn as spawnNode, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createSnowLumaWebUIClient, SnowLumaWebUIError } from './snowluma-webui.ts';

export type SnowLumaProcessStatus = 'stopped' | 'starting' | 'ready' | 'error';
export type SnowLumaProcessErrorCode =
  | 'hook-autoload-enabled'
  | 'runtime-config-invalid'
  | 'startup-failed'
  | 'webui-config-missing'
  | 'readiness-timeout'
  | 'process-exited'
  | 'unmanaged-environment-unsafe'
  | 'stopped';

export class SnowLumaProcessError extends Error {
  readonly code: SnowLumaProcessErrorCode;

  constructor(code: SnowLumaProcessErrorCode, message: string) {
    super(message);
    this.name = 'SnowLumaProcessError';
    this.code = code;
  }
}

export interface SnowLumaProcessOptions {
  snowlumaDir: string;
  logDirectory: string;
  password: string;
  startSnowLuma?: boolean;
  parentEnvironment?: NodeJS.ProcessEnv;
  spawnProcess?: typeof spawnNode;
  fetch?: typeof globalThis.fetch;
  log?: (message: string) => void;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  readinessTimeoutMs?: number;
  retryIntervalMs?: number;
  requestTimeoutMs?: number;
  setTimer?: typeof globalThis.setTimeout;
  clearTimer?: typeof globalThis.clearTimeout;
}

interface RuntimeConfig {
  hookAutoLoad?: boolean;
  webuiHost?: string;
  webuiPort?: number;
  webuiTls?: { enabled?: boolean };
}

type ChildEnd =
  | { kind: 'exit'; code: number | null; signal: NodeJS.Signals | null }
  | { kind: 'error'; error: Error };

export function createSnowLumaProcess(options: SnowLumaProcessOptions) {
  let currentStatus: SnowLumaProcessStatus = 'stopped';
  const listeners = new Set<(status: SnowLumaProcessStatus, message?: string) => void>();
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const readinessTimeoutMs = options.readinessTimeoutMs ?? 60_000;
  const retryIntervalMs = options.retryIntervalMs ?? 1_000;
  // SnowLuma's QQ login probe can take up to 5 seconds; leave transport margin.
  const requestTimeoutMs = options.requestTimeoutMs ?? 7_000;
  const setTimer = options.setTimer ?? globalThis.setTimeout;
  const clearTimer = options.clearTimer ?? globalThis.clearTimeout;
  const backoff = createRestartBackoff();
  let child: ChildProcess | undefined;
  let client: ReturnType<typeof createSnowLumaWebUIClient> | undefined;
  let startedAt: number | undefined;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let stopping = false;
  let startInFlight: Promise<void> | undefined;

  function setStatus(status: SnowLumaProcessStatus, message?: string): void {
    currentStatus = status;
    for (const listener of listeners) {
      try {
        listener(status, message);
      } catch {
        options.log?.('SnowLuma 状态回调失败。');
      }
    }
  }

  function readRuntimeConfig(): RuntimeConfig {
    const configPath = path.join(options.snowlumaDir, 'config', 'runtime.json');
    let source: string;
    try {
      source = readFileSync(configPath, 'utf8');
    } catch (error) {
      if (isMissingFile(error)) return {};
      throw new SnowLumaProcessError('runtime-config-invalid', 'SnowLuma runtime.json is not readable');
    }
    try {
      const parsed: unknown = JSON.parse(source);
      if (!isRecord(parsed)) throw new Error('invalid config');
      if (parsed.hookAutoLoad !== undefined && typeof parsed.hookAutoLoad !== 'boolean') throw new Error('invalid hookAutoLoad');
      if (parsed.webuiHost !== undefined && (typeof parsed.webuiHost !== 'string' || parsed.webuiHost.trim() === '')) throw new Error('invalid webuiHost');
      if (parsed.webuiPort !== undefined && (!Number.isInteger(parsed.webuiPort) || Number(parsed.webuiPort) < 1 || Number(parsed.webuiPort) > 65_535)) throw new Error('invalid webuiPort');
      if (parsed.webuiTls !== undefined && !isRecord(parsed.webuiTls)) throw new Error('invalid webuiTls');
      const tlsEnabled = isRecord(parsed.webuiTls) ? parsed.webuiTls.enabled : undefined;
      if (tlsEnabled !== undefined && typeof tlsEnabled !== 'boolean') throw new Error('invalid webuiTls.enabled');
      return {
        ...(typeof parsed.hookAutoLoad === 'boolean' ? { hookAutoLoad: parsed.hookAutoLoad } : {}),
        ...(typeof parsed.webuiHost === 'string' ? { webuiHost: parsed.webuiHost } : {}),
        ...(typeof parsed.webuiPort === 'number' ? { webuiPort: parsed.webuiPort } : {}),
        ...(isRecord(parsed.webuiTls) && typeof parsed.webuiTls.enabled === 'boolean'
          ? { webuiTls: { enabled: parsed.webuiTls.enabled } }
          : {}),
      };
    } catch {
      throw new SnowLumaProcessError('runtime-config-invalid', 'SnowLuma runtime.json is invalid JSON');
    }
  }

  function webuiUrl(runtime: RuntimeConfig): string {
    const host = runtime.webuiHost ?? '127.0.0.1';
    const port = runtime.webuiPort ?? 5099;
    const formattedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    const protocol = runtime.webuiTls?.enabled === true ? 'https' : 'http';
    return `${protocol}://${formattedHost}:${port}`;
  }

  function createSnowLumaChildEnvironment(parentEnvironment: NodeJS.ProcessEnv, runtime: RuntimeConfig): NodeJS.ProcessEnv {
    // SnowLuma env overrides beat runtime.json; pin the validated listener and keep Aquarium's client password private.
    const overriddenNames = new Set([
      'SNOWLUMA_HOOK_AUTOLOAD',
      'SNOWLUMA_HOOK_AUTOLOAD_ALL',
      'SNOWLUMA_WEBUI_HOST',
      'SNOWLUMA_WEBUI_PORT',
      'SNOWLUMA_WEBUI_TLS',
      'SNOWLUMA_WEBUI_PASSWORD',
    ]);
    const childEnvironment: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(parentEnvironment)) {
      if (!overriddenNames.has(name.toUpperCase())) childEnvironment[name] = value;
    }
    childEnvironment.SNOWLUMA_HOOK_AUTOLOAD = 'false';
    childEnvironment.SNOWLUMA_WEBUI_HOST = runtime.webuiHost ?? '127.0.0.1';
    childEnvironment.SNOWLUMA_WEBUI_PORT = String(runtime.webuiPort ?? 5099);
    childEnvironment.SNOWLUMA_WEBUI_TLS = runtime.webuiTls?.enabled === true ? 'true' : 'false';
    return childEnvironment;
  }

  function environmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
    const entry = Object.entries(environment).find(([key]) => key.toUpperCase() === name.toUpperCase());
    return typeof entry?.[1] === 'string' ? entry[1].trim() : undefined;
  }

  function isTruthyEnvironmentValue(value: string | undefined): boolean {
    return value !== undefined && ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
  }

  function assertSafeUnmanagedEnvironment(environment: NodeJS.ProcessEnv): void {
    if (isTruthyEnvironmentValue(environmentValue(environment, 'SNOWLUMA_HOOK_AUTOLOAD'))
      || environmentValue(environment, 'SNOWLUMA_HOOK_AUTOLOAD_ALL') === '1') {
      throw new SnowLumaProcessError(
        'unmanaged-environment-unsafe',
        'Refusing unmanaged SnowLuma attach while inherited auto-load overrides are enabled',
      );
    }
    const host = environmentValue(environment, 'SNOWLUMA_WEBUI_HOST')?.toLowerCase().replace(/^\[|\]$/gu, '');
    if (host && !['127.0.0.1', 'localhost', '::1'].includes(host)) {
      throw new SnowLumaProcessError(
        'unmanaged-environment-unsafe',
        'Refusing unmanaged SnowLuma attach while inherited WebUI host is not loopback',
      );
    }
  }

  function appendOutput(stream: 'stdout' | 'stderr', chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (text.length === 0) return;
    const date = new Date(now());
    const datePart = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    try {
      mkdirSync(options.logDirectory, { recursive: true });
      appendFileSync(path.join(options.logDirectory, `snowluma-${datePart}.log`), `[${stream}] ${text}`, 'utf8');
    } catch {
      options.log?.(`SnowLuma ${stream} 日志写入失败。`);
    }
  }

  function watchChild(target: ChildProcess): Promise<ChildEnd> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: ChildEnd): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      target.once('error', (error) => finish({ kind: 'error', error }));
      target.once('exit', (code, signal) => finish({ kind: 'exit', code, signal }));
    });
  }

  async function waitUntilReady(webui: ReturnType<typeof createSnowLumaWebUIClient>, childEnd?: Promise<ChildEnd>): Promise<void> {
    const deadline = now() + readinessTimeoutMs;
    while (now() < deadline) {
      if (stopping) throw new SnowLumaProcessError('stopped', 'SnowLuma startup was stopped');
      const attemptStarted = now();
      const loginAttempt = webui.login().then(
        () => ({ kind: 'ready' as const }),
        (error: unknown) => ({ kind: 'login-error' as const, error }),
      );
      const result = childEnd
        ? await Promise.race([
          loginAttempt,
          childEnd.then((end) => ({ kind: 'process-end' as const, end })),
        ])
        : await loginAttempt;
      if (result.kind === 'ready') return;
      if (result.kind === 'process-end') {
        const reason = result.end.kind === 'exit'
          ? `SnowLuma exited before WebUI readiness (code=${result.end.code ?? 'null'})`
          : 'SnowLuma process failed before WebUI readiness';
        throw new SnowLumaProcessError('process-exited', reason);
      }
      if (!(result.error instanceof SnowLumaWebUIError) || !result.error.retryable) throw result.error;
      const remaining = deadline - now();
      if (remaining <= 0) break;
      const elapsed = now() - attemptStarted;
      await sleep(Math.min(remaining, Math.max(0, retryIntervalMs - elapsed)));
    }
    throw new SnowLumaProcessError('readiness-timeout', 'SnowLuma WebUI did not become ready within 60 seconds');
  }

  async function waitForClose(target: ChildProcess, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const onClose = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        target.off('close', onClose);
        resolve(false);
      }, timeoutMs);
      target.once('close', onClose);
    });
  }

  async function terminate(target: ChildProcess): Promise<void> {
    if ((target.exitCode !== null && target.exitCode !== undefined)
      || (target.signalCode !== null && target.signalCode !== undefined)) return;
    const closed = waitForClose(target, 3_000);
    target.kill('SIGTERM');
    if (await closed) return;
    const forceClosed = waitForClose(target, 1_000);
    target.kill('SIGKILL');
    await forceClosed;
  }

  function scheduleRestart(stableDurationMs: number, reason: string): void {
    if (stopping || restartTimer !== undefined) return;
    const delay = backoff.nextDelay(stableDurationMs);
    options.log?.(`${reason}；${delay} 毫秒后重启 SnowLuma。`);
    setStatus('starting', `${reason}；等待 SnowLuma 重启。`);
    restartTimer = setTimer(() => {
      restartTimer = undefined;
      if (stopping) return;
      void start().catch((error: unknown) => {
        options.log?.(`SnowLuma 自动重启失败：${safeErrorCode(error)}`);
      });
    }, delay);
  }

  async function startInternal(): Promise<void> {
    setStatus('starting');
    try {
      const runtime = readRuntimeConfig();
      if (runtime.hookAutoLoad === true) {
        const message = '请在 SnowLuma 中关闭自动注入；拒绝启动托管。';
        options.log?.(message);
        throw new SnowLumaProcessError('hook-autoload-enabled', message);
      }
      if (options.startSnowLuma === false) {
        assertSafeUnmanagedEnvironment(options.parentEnvironment ?? process.env);
        options.log?.('警告：startSnowLuma=false 连接外部管理的 SnowLuma；host 无法验证该进程实际环境，必须确认其 auto-load 已关闭且 WebUI 仅绑定 loopback。');
      }
      if (!options.password) throw new SnowLumaProcessError('webui-config-missing', 'SNOWLUMA_WEBUI_PASSWORD is not configured');
      const entryPath = path.join(options.snowlumaDir, 'index.mjs');
      if (!existsSync(entryPath)) throw new SnowLumaProcessError('startup-failed', 'SnowLuma index.mjs does not exist');
      const webui = createSnowLumaWebUIClient({
        baseUrl: webuiUrl(runtime),
        password: options.password,
        fetch: options.fetch,
        log: options.log,
        requestTimeoutMs,
      });
      client = webui;
      const target = options.startSnowLuma === false
        ? undefined
        : (options.spawnProcess ?? spawnNode)(process.execPath, [entryPath], {
          cwd: options.snowlumaDir,
          env: createSnowLumaChildEnvironment(options.parentEnvironment ?? process.env, runtime),
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      if (target) {
        child = target;
        target.stdout?.on('data', (chunk: Buffer | string) => appendOutput('stdout', chunk));
        target.stderr?.on('data', (chunk: Buffer | string) => appendOutput('stderr', chunk));
      }
      const childEnd = target ? watchChild(target) : undefined;
      await waitUntilReady(webui, childEnd);
      if (stopping || (target !== undefined && child !== target)) {
        throw new SnowLumaProcessError('stopped', 'SnowLuma startup was stopped');
      }
      startedAt = target ? now() : undefined;
      setStatus('ready');
      if (target && childEnd) {
        void childEnd.then((end) => {
          if (child !== target || stopping) return;
          child = undefined;
          client = undefined;
          const stableDurationMs = startedAt === undefined ? 0 : now() - startedAt;
          startedAt = undefined;
          const message = end.kind === 'exit'
            ? `SnowLuma process exited (code=${end.code ?? 'null'})`
            : 'SnowLuma process failed unexpectedly';
          scheduleRestart(stableDurationMs, message);
        });
      }
    } catch (error) {
      const target = child;
      child = undefined;
      client = undefined;
      if (target) await terminate(target);
      const message = error instanceof Error ? error.message : 'SnowLuma startup failed';
      if (error instanceof SnowLumaProcessError && error.code === 'process-exited' && !stopping) {
        scheduleRestart(0, message);
      } else {
        setStatus(stopping ? 'stopped' : 'error', message);
      }
      throw error;
    }
  }

  function start(): Promise<void> {
    if (currentStatus === 'ready') return Promise.resolve();
    if (startInFlight) return startInFlight;
    stopping = false;
    startInFlight = startInternal().finally(() => { startInFlight = undefined; });
    return startInFlight;
  }

  async function stop(): Promise<void> {
    stopping = true;
    if (restartTimer !== undefined) {
      clearTimer(restartTimer);
      restartTimer = undefined;
    }
    startedAt = undefined;
    const target = child;
    child = undefined;
    if (target) await terminate(target);
    if (startInFlight) {
      try {
        await startInFlight;
      } catch (error) {
        if (!(error instanceof SnowLumaProcessError && error.code === 'stopped')) {
          options.log?.(`SnowLuma 关闭时启动过程失败：${safeErrorCode(error)}`);
        }
      }
    }
    client = undefined;
    setStatus('stopped');
  }

  async function restart(): Promise<void> {
    await stop();
    await start();
  }

  return {
    start,
    stop,
    restart,
    status: () => currentStatus,
    webuiClient: () => client,
    onStatus(callback: (status: SnowLumaProcessStatus, message?: string) => void): () => void {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  };
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeErrorCode(error: unknown): string {
  if (error instanceof SnowLumaProcessError) return error.code;
  if (error instanceof SnowLumaWebUIError) return error.code;
  return error instanceof Error ? error.name : 'unknown';
}

export function createRestartBackoff() {
  let attempt = 0;
  return {
    nextDelay(stableDurationMs = 0): number {
      if (stableDurationMs >= 5 * 60 * 1_000) attempt = 0;
      const delay = Math.min(1_000 * (2 ** attempt), 30_000);
      attempt = Math.min(attempt + 1, 6);
      return delay;
    },
  };
}
