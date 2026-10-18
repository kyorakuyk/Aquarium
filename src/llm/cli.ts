import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AquariumConfig } from '../config/schema.ts';

type ProviderConfig = AquariumConfig['providers'][string];
export type CliProviderConfig = Extract<ProviderConfig, { kind: 'cli' }>;

export type CliRuntimeState = 'stopped' | 'starting' | 'ready' | 'busy' | 'restarting';

export interface CliRuntimeStatus {
  state: CliRuntimeState;
  pid: number | null;
  served: number;
}

export interface CliRuntime {
  call(id: string, provider: CliProviderConfig, input: string): Promise<string>;
  status(id: string): CliRuntimeStatus;
  restart(id: string, provider: CliProviderConfig): void;
  sync(providers: Record<string, ProviderConfig>): void;
  stopAll(): Promise<void>;
}

export interface CliRuntimeOptions {
  spawnProcess?: typeof spawn;
  restartBaseMs?: number;
  restartMaxMs?: number;
  log?: (message: string) => void;
}

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export function buildCliInput(messages: Array<{ role?: string; content?: unknown }>): string {
  return messages.map((message) => {
    const prefix = message.role === 'system' ? '[系统]' : '[对话]';
    const text = typeof message.content === 'string' ? message.content : '';
    return `${prefix} ${text}`;
  }).join('\n\n');
}

interface CliRunHooks {
  onSpawn?: (pid: number | undefined) => void;
}

function runChild(
  child: ChildProcessWithoutNullStreams,
  input: string,
  timeoutMs: number,
  hooks: CliRunHooks = {},
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let timedOut = false;

    const finish = (error: Error | undefined, text?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeAllListeners();
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      child.removeAllListeners('exit');
      child.on('error', () => { /* 收尾后忽略迟到的错误事件。 */ });
      if (error) reject(error);
      else resolve(text ?? '');
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.once('spawn', () => hooks.onSpawn?.(child.pid));
    child.once('error', () => finish(new Error('CLI 启动失败')));
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill();
        finish(new Error('CLI 输出过大'));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 16) stderr.push(chunk);
    });
    child.once('close', (code) => {
      if (timedOut) {
        finish(new Error('CLI 调用超时'));
        return;
      }
      if (code !== 0) {
        finish(new Error(`CLI 退出码 ${code ?? '未知'}`));
        return;
      }
      const text = Buffer.concat(stdout).toString('utf8').trim();
      if (!text) {
        finish(new Error('CLI 没有输出'));
        return;
      }
      finish(undefined, text);
    });

    child.stdin.on('error', () => { /* close 事件会给出最终失败原因。 */ });
    child.stdin.end(input);
  });
}

function spawnChild(spawnProcess: typeof spawn, provider: CliProviderConfig): ChildProcessWithoutNullStreams {
  return spawnProcess(provider.command, provider.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams;
}

class PrewarmSlot {
  private readonly provider: CliProviderConfig;
  private readonly options: Required<Pick<CliRuntimeOptions, 'spawnProcess' | 'restartBaseMs' | 'restartMaxMs'>>;
  private readonly log: (message: string) => void;
  private child: ChildProcessWithoutNullStreams | undefined;
  private state: CliRuntimeState = 'stopped';
  private served = 0;
  private stopped = false;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private backoffMs: number;
  private idleExitHandler: ((code: number | null) => void) | undefined;

  constructor(
    provider: CliProviderConfig,
    options: Required<Pick<CliRuntimeOptions, 'spawnProcess' | 'restartBaseMs' | 'restartMaxMs'>>,
    log: (message: string) => void,
  ) {
    this.provider = provider;
    this.options = options;
    this.log = log;
    this.backoffMs = options.restartBaseMs;
  }

  status(): CliRuntimeStatus {
    return { state: this.state, pid: this.child?.pid ?? null, served: this.served };
  }

  start(): void {
    if (this.stopped || this.child) return;
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    this.state = 'starting';
    const child = spawnChild(this.options.spawnProcess, this.provider);
    this.child = child;
    child.stdout.resume();
    child.stderr.resume();
    child.once('spawn', () => {
      if (this.child !== child) return;
      this.state = 'ready';
      this.backoffMs = this.options.restartBaseMs;
    });
    const idleExit = (code: number | null) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.idleExitHandler = undefined;
      if (this.stopped) return;
      this.state = 'restarting';
      this.log(`CLI 预热进程提前退出（${code ?? '未知'}），准备重启。`);
      this.scheduleRestart();
    };
    this.idleExitHandler = idleExit;
    child.once('exit', idleExit);
    child.once('error', () => {
      if (this.child !== child) return;
      this.child = undefined;
      if (this.stopped) return;
      this.state = 'restarting';
      this.scheduleRestart();
    });
    child.stdin.on('error', () => { /* 空闲进程退出时忽略 EPIPE。 */ });
  }

  async call(input: string): Promise<string> {
    if (this.stopped) throw new Error('CLI 预热已停止');
    let child = this.child;
    if (child) {
      this.child = undefined;
      if (this.idleExitHandler) {
        child.removeListener('exit', this.idleExitHandler);
        this.idleExitHandler = undefined;
      }
    } else {
      child = spawnChild(this.options.spawnProcess, this.provider);
    }
    this.state = 'busy';
    try {
      const text = await runChild(child, input, this.provider.timeoutSec * 1_000);
      this.served += 1;
      return text;
    } finally {
      if (!this.stopped) {
        this.state = 'starting';
        this.start();
      }
    }
  }

  restart(): void {
    this.stopped = false;
    this.backoffMs = this.options.restartBaseMs;
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    this.child?.kill();
    this.child = undefined;
    this.state = 'stopped';
    this.start();
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    this.child?.kill();
    this.child = undefined;
    this.state = 'stopped';
  }

  private scheduleRestart(): void {
    if (this.stopped || this.restartTimer !== undefined) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.options.restartMaxMs);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.start();
    }, delay);
    this.restartTimer.unref?.();
  }
}

class Runtime implements CliRuntime {
  private readonly slots = new Map<string, PrewarmSlot>();
  private readonly providers = new Map<string, CliProviderConfig>();
  private readonly signatures = new Map<string, string>();
  private readonly options: {
    spawnProcess: typeof spawn;
    restartBaseMs: number;
    restartMaxMs: number;
    log: (message: string) => void;
  };

  constructor(options: CliRuntimeOptions = {}) {
    this.options = {
      spawnProcess: options.spawnProcess ?? spawn,
      restartBaseMs: options.restartBaseMs ?? 2_000,
      restartMaxMs: options.restartMaxMs ?? 30_000,
      log: options.log ?? (() => undefined),
    };
  }

  sync(providers: Record<string, ProviderConfig>): void {
    for (const [id, provider] of Object.entries(providers)) {
      if (provider.kind !== 'cli') {
        this.slots.get(id)?.stop();
        this.slots.delete(id);
        this.providers.delete(id);
        this.signatures.delete(id);
        continue;
      }
      this.providers.set(id, provider);
      const signature = JSON.stringify(provider);
      if (!provider.prewarm) {
        this.slots.get(id)?.stop();
        this.slots.delete(id);
        this.signatures.delete(id);
        continue;
      }
      if (this.slots.has(id) && this.signatures.get(id) !== signature) {
        this.slots.get(id)?.stop();
        this.slots.delete(id);
      }
      if (!this.slots.has(id)) {
        const slot = new PrewarmSlot(provider, this.options, this.options.log);
        this.slots.set(id, slot);
        this.signatures.set(id, signature);
        slot.start();
      }
    }
    for (const [id, slot] of this.slots) {
      if (!providers[id]) {
        slot.stop();
        this.slots.delete(id);
        this.providers.delete(id);
        this.signatures.delete(id);
      }
    }
  }

  status(id: string): CliRuntimeStatus {
    return this.slots.get(id)?.status() ?? { state: 'stopped', pid: null, served: 0 };
  }

  restart(id: string, provider: CliProviderConfig): void {
    const slot = this.slots.get(id);
    if (slot) {
      slot.restart();
      return;
    }
    this.providers.set(id, provider);
    this.signatures.set(id, JSON.stringify(provider));
    const next = new PrewarmSlot(provider, this.options, this.options.log);
    this.slots.set(id, next);
    next.start();
  }

  async call(id: string, provider: CliProviderConfig, input: string): Promise<string> {
    if (!provider.prewarm) {
      return runChild(spawnChild(this.options.spawnProcess, provider), input, provider.timeoutSec * 1_000);
    }
    let slot = this.slots.get(id);
    if (!slot) {
      this.providers.set(id, provider);
      this.signatures.set(id, JSON.stringify(provider));
      slot = new PrewarmSlot(provider, this.options, this.options.log);
      this.slots.set(id, slot);
      slot.start();
    }
    return slot.call(input);
  }

  async stopAll(): Promise<void> {
    for (const slot of this.slots.values()) slot.stop();
    this.slots.clear();
    this.providers.clear();
    this.signatures.clear();
  }
}

export function createCliRuntime(options: CliRuntimeOptions = {}): CliRuntime {
  return new Runtime(options);
}

let sharedRuntime: CliRuntime | undefined;

export function getCliRuntime(): CliRuntime {
  sharedRuntime ??= createCliRuntime();
  return sharedRuntime;
}

export async function runCliOnce(provider: CliProviderConfig, input: string): Promise<string> {
  return runChild(spawnChild(spawn, provider), input, provider.timeoutSec * 1_000);
}
