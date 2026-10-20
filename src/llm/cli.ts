import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AquariumConfig } from '../config/schema.ts';
import {
  runCliChild,
  spawnCliChild,
  terminateCliChild,
  type CliProviderConfig,
} from './cli-process.ts';

type ProviderConfig = AquariumConfig['providers'][string];
export type { CliProviderConfig } from './cli-process.ts';

export type CliRuntimeState = 'stopped' | 'starting' | 'ready' | 'busy' | 'restarting';

export interface CliRuntimeStatus {
  state: CliRuntimeState;
  pid: number | null;
  served: number;
}

export interface CliRuntime {
  call(id: string, provider: CliProviderConfig, input: string, timeoutMs?: number): Promise<string>;
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

export function buildCliInput(messages: Array<{ role?: string; content?: unknown }>): string {
  return messages.map((message) => {
    const prefix = message.role === 'system' ? '[系统]' : '[对话]';
    const text = typeof message.content === 'string' ? message.content : '';
    return `${prefix} ${text}`;
  }).join('\n\n');
}

class PrewarmSlot {
  private readonly provider: CliProviderConfig;
  private readonly options: Required<Pick<CliRuntimeOptions, 'spawnProcess' | 'restartBaseMs' | 'restartMaxMs'>>;
  private readonly log: (message: string) => void;
  private readonly activeChildren = new Set<ChildProcessWithoutNullStreams>();
  private child: ChildProcessWithoutNullStreams | undefined;
  private idleReady = false;
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
    const activePid = [...this.activeChildren].find((child) => child.pid)?.pid;
    return { state: this.state, pid: this.child?.pid ?? activePid ?? null, served: this.served };
  }

  start(): void {
    if (this.stopped || this.child) return;
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    this.state = 'starting';
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnCliChild(this.options.spawnProcess, this.provider);
    } catch {
      this.state = 'restarting';
      this.scheduleRestart();
      return;
    }
    this.child = child;
    this.idleReady = false;
    child.stdout.resume();
    child.stderr.resume();
    child.once('spawn', () => {
      if (this.child !== child) return;
      this.idleReady = true;
      this.state = this.activeChildren.size > 0 ? 'busy' : 'ready';
    });
    const idleExit = (code: number | null) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.idleReady = false;
      this.idleExitHandler = undefined;
      if (this.stopped) return;
      this.state = this.activeChildren.size > 0 ? 'busy' : 'restarting';
      this.log(`CLI 预热进程提前退出（${code ?? '未知'}），准备重启。`);
      this.scheduleRestart();
    };
    this.idleExitHandler = idleExit;
    child.once('exit', idleExit);
    child.once('error', () => {
      if (this.child !== child) return;
      this.child = undefined;
      this.idleReady = false;
      if (this.stopped) return;
      this.state = this.activeChildren.size > 0 ? 'busy' : 'restarting';
      this.scheduleRestart();
    });
    child.stdin.on('error', () => { /* 空闲进程退出时忽略 EPIPE。 */ });
  }

  async call(input: string, timeoutMs = this.provider.timeoutSec * 1_000): Promise<string> {
    if (this.stopped) throw new Error('CLI 预热已停止');
    let child = this.child;
    if (child) {
      this.child = undefined;
      this.idleReady = false;
      if (this.idleExitHandler) {
        child.removeListener('exit', this.idleExitHandler);
        this.idleExitHandler = undefined;
      }
    } else {
      try {
        child = spawnCliChild(this.options.spawnProcess, this.provider);
      } catch {
        if (!this.stopped && this.restartTimer === undefined) {
          this.state = 'restarting';
          this.scheduleRestart();
        }
        throw new Error('CLI 启动失败');
      }
    }
    this.activeChildren.add(child);
    this.state = 'busy';
    if (!this.child && this.restartTimer === undefined) this.start();
    try {
      const text = await runCliChild(child, input, timeoutMs);
      this.served += 1;
      this.backoffMs = this.options.restartBaseMs;
      return text;
    } finally {
      this.activeChildren.delete(child);
      if (!this.stopped) {
        if (this.restartTimer !== undefined && !this.child) {
          this.state = 'restarting';
        } else if (this.child) {
          this.state = this.activeChildren.size > 0 ? 'busy' : this.idleReady ? 'ready' : 'starting';
        } else {
          this.state = 'restarting';
          this.scheduleRestart();
        }
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
    if (this.child) void terminateCliChild(this.child);
    this.child = undefined;
    this.idleReady = false;
    for (const child of this.activeChildren) void terminateCliChild(child);
    this.state = 'stopped';
    this.start();
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    if (this.child) void terminateCliChild(this.child);
    this.child = undefined;
    this.idleReady = false;
    for (const child of this.activeChildren) void terminateCliChild(child);
    this.state = 'stopped';
  }

  async stopAndWait(): Promise<void> {
    const children = [...this.activeChildren];
    if (this.child) children.push(this.child);
    this.stopped = true;
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    this.child = undefined;
    this.idleReady = false;
    this.idleExitHandler = undefined;
    this.state = 'stopped';
    await Promise.all(children.map((child) => terminateCliChild(child)));
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
  private readonly activeChildren = new Map<string, Set<ChildProcessWithoutNullStreams>>();
  private readonly servedCounts = new Map<string, number>();
  private readonly options: {
    spawnProcess: typeof spawn;
    restartBaseMs: number;
    restartMaxMs: number;
    log: (message: string) => void;
  };

  private stopActiveChildren(id: string): void {
    for (const child of this.activeChildren.get(id) ?? []) void terminateCliChild(child);
  }

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
        this.stopActiveChildren(id);
        this.slots.delete(id);
        this.providers.delete(id);
        this.signatures.delete(id);
        this.servedCounts.delete(id);
        continue;
      }
      this.providers.set(id, provider);
      const signature = JSON.stringify(provider);
      const previousSignature = this.signatures.get(id);
      if (previousSignature !== undefined && previousSignature !== signature) this.stopActiveChildren(id);
      this.signatures.set(id, signature);
      if (!provider.prewarm) {
        this.slots.get(id)?.stop();
        this.slots.delete(id);
        continue;
      }
      if (this.slots.has(id) && previousSignature !== signature) {
        this.slots.get(id)?.stop();
        this.slots.delete(id);
      }
      if (!this.slots.has(id)) {
        const slot = new PrewarmSlot(provider, this.options, this.options.log);
        this.slots.set(id, slot);
        slot.start();
      }
    }
    for (const id of this.providers.keys()) {
      if (providers[id]) continue;
      this.slots.get(id)?.stop();
      this.stopActiveChildren(id);
      this.slots.delete(id);
      this.providers.delete(id);
      this.signatures.delete(id);
      this.servedCounts.delete(id);
    }
    for (const id of this.activeChildren.keys()) {
      if (!providers[id]) this.stopActiveChildren(id);
    }
  }

  status(id: string): CliRuntimeStatus {
    const status = this.slots.get(id)?.status();
    const activePid = [...(this.activeChildren.get(id) ?? [])].find((child) => child.pid)?.pid;
    return status
      ? { ...status, pid: status.pid ?? activePid ?? null, served: this.servedCounts.get(id) ?? status.served }
      : {
        state: (this.activeChildren.get(id)?.size ?? 0) > 0 ? 'busy' : 'stopped',
        pid: activePid ?? null,
        served: this.servedCounts.get(id) ?? 0,
      };
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

  async call(id: string, provider: CliProviderConfig, input: string, timeoutMs?: number): Promise<string> {
    const effectiveProvider = this.providers.get(id) ?? provider;
    if (!effectiveProvider.prewarm) {
      const child = spawnCliChild(this.options.spawnProcess, provider);
      const children = this.activeChildren.get(id) ?? new Set<ChildProcessWithoutNullStreams>();
      children.add(child);
      this.activeChildren.set(id, children);
      try {
        const text = await runCliChild(child, input, timeoutMs ?? effectiveProvider.timeoutSec * 1_000);
        this.servedCounts.set(id, (this.servedCounts.get(id) ?? 0) + 1);
        return text;
      } finally {
        children.delete(child);
        if (children.size === 0) this.activeChildren.delete(id);
      }
    }
    let slot = this.slots.get(id);
    if (!slot) {
      this.providers.set(id, provider);
      this.signatures.set(id, JSON.stringify(provider));
      slot = new PrewarmSlot(provider, this.options, this.options.log);
      this.slots.set(id, slot);
      slot.start();
    }
    const text = await slot.call(input, timeoutMs ?? effectiveProvider.timeoutSec * 1_000);
    this.servedCounts.set(id, (this.servedCounts.get(id) ?? 0) + 1);
    return text;
  }

  async stopAll(): Promise<void> {
    const slotStops = [...this.slots.values()].map((slot) => slot.stopAndWait());
    const oneShotStops = [...this.activeChildren.values()].flatMap((children) =>
      [...children].map((child) => terminateCliChild(child)));
    await Promise.all([...slotStops, ...oneShotStops]);
    this.slots.clear();
    this.providers.clear();
    this.signatures.clear();
    this.activeChildren.clear();
    this.servedCounts.clear();
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
  return getCliRuntime().call(`__run_once__:${provider.command}`, { ...provider, prewarm: false }, input);
}
