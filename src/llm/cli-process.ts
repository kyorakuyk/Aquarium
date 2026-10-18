import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AquariumConfig } from '../config/schema.ts';

export type CliProviderConfig = Extract<AquariumConfig['providers'][string], { kind: 'cli' }>;

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

interface CliRunHooks {
  onSpawn?: (pid: number | undefined) => void;
}

export function runCliChild(
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
    let failure: Error | undefined;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    let onSpawn: (() => void) | undefined;
    let onError: (() => void) | undefined;
    let onClose: ((code: number | null) => void) | undefined;
    let onStdoutData: ((chunk: Buffer) => void) | undefined;
    let onStderrData: ((chunk: Buffer) => void) | undefined;
    let onStdinError: (() => void) | undefined;

    const finish = (error: Error | undefined, text?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      if (onSpawn) child.removeListener('spawn', onSpawn);
      if (onError) child.removeListener('error', onError);
      if (onClose) child.removeListener('close', onClose);
      if (onStdoutData) child.stdout.removeListener('data', onStdoutData);
      if (onStderrData) child.stderr.removeListener('data', onStderrData);
      if (onStdinError) child.stdin.removeListener('error', onStdinError);
      child.on('error', () => { /* 收尾后忽略迟到的错误事件。 */ });
      if (error) reject(error);
      else resolve(text ?? '');
    };

    const terminate = (error: Error) => {
      if (failure) return;
      failure = error;
      child.kill();
      forceKillTimer = setTimeout(() => {
        if (settled || child.exitCode !== null || child.signalCode !== null) return;
        try {
          child.kill('SIGKILL');
        } catch {
          child.kill();
        }
      }, 250);
    };

    const timer = setTimeout(() => {
      terminate(new Error('CLI 调用超时'));
    }, timeoutMs);

    onSpawn = () => hooks.onSpawn?.(child.pid);
    onError = () => finish(new Error('CLI 启动失败'));
    onClose = (code) => {
      if (failure) {
        finish(failure);
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
    };
    onStdoutData = (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        terminate(new Error('CLI 输出过大'));
        return;
      }
      stdout.push(chunk);
    };
    onStderrData = (chunk) => {
      if (stderr.length < 16) stderr.push(chunk);
    };
    onStdinError = () => { /* close 事件会给出最终失败原因。 */ };
    child.once('spawn', onSpawn);
    child.once('error', onError);
    child.stdout.on('data', onStdoutData);
    child.stderr.on('data', onStderrData);
    child.once('close', onClose);

    child.stdin.on('error', onStdinError);
    child.stdin.end(input);
  });
}

function childHasExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export function terminateCliChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (childHasExited(child)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      child.removeListener('close', finish);
      resolve();
    };
    child.once('close', finish);
    if (childHasExited(child)) {
      finish();
      return;
    }
    forceKillTimer = setTimeout(() => {
      if (childHasExited(child)) return;
      try {
        child.kill('SIGKILL');
      } catch {
        child.kill();
      }
    }, 250);
    child.kill();
  });
}

export function spawnCliChild(spawnProcess: typeof spawn, provider: CliProviderConfig): ChildProcessWithoutNullStreams {
  return spawnProcess(provider.command, provider.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams;
}
