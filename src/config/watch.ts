import { EventEmitter } from 'node:events';
import { watch, type FSWatcher } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createLogger } from '../core/logger.ts';
import type { AquariumConfig } from './schema.ts';
import { loadConfig, type ConfigLogSink } from './load.ts';

export interface WatchConfigOptions {
  configPath?: string;
  examplePath?: string;
  initialConfig?: AquariumConfig;
  debounceMs?: number;
  logger?: ConfigLogSink;
}

const silentLogger: ConfigLogSink = {
  info: () => undefined,
  error: () => undefined,
};

export class ConfigWatcher extends EventEmitter {
  private readonly configPath: string;
  private readonly examplePath?: string;
  private readonly debounceMs: number;
  private readonly logger: ConfigLogSink;
  private readonly fileWatcher: FSWatcher;
  private currentConfig: AquariumConfig;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(options: WatchConfigOptions = {}) {
    super();
    this.configPath = options.configPath ?? join(process.cwd(), 'data', 'config.yaml');
    this.examplePath = options.examplePath;
    this.debounceMs = options.debounceMs ?? 300;
    this.logger = options.logger ?? createLogger('config');
    this.currentConfig = options.initialConfig ?? loadConfig({
      configPath: this.configPath,
      examplePath: this.examplePath,
      logger: this.logger,
    });

    this.fileWatcher = watch(dirname(this.configPath), (eventType, filename) => {
      if (this.closed) return;
      if (filename !== null && filename.toString() !== basename(this.configPath)) return;
      this.scheduleReload();
    });
    this.fileWatcher.on('error', (error) => {
      this.logger.error('配置文件监听失败；当前配置保持不变。', error);
    });
  }

  getConfig(): AquariumConfig {
    return this.currentConfig;
  }

  replaceConfig(config: AquariumConfig): void {
    if (this.closed) throw new Error('配置监听器已经关闭');
    this.currentConfig = config;
    this.emit('changed', config);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer);
    this.fileWatcher.close();
    this.removeAllListeners();
  }

  private scheduleReload(): void {
    if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.reload();
    }, this.debounceMs);
  }

  private reload(): void {
    if (this.closed) return;
    try {
      const nextConfig = loadConfig({
        configPath: this.configPath,
        examplePath: this.examplePath,
        logger: silentLogger,
      });
      if (JSON.stringify(nextConfig) === JSON.stringify(this.currentConfig)) return;
      this.currentConfig = nextConfig;
      this.emit('changed', nextConfig);
    } catch (error) {
      this.logger.error('配置热重载失败，保留上一份有效配置。', error);
    }
  }
}

export function watchConfig(options: WatchConfigOptions = {}): ConfigWatcher {
  return new ConfigWatcher(options);
}
