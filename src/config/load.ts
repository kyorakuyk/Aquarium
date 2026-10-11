import { constants, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';
import { createLogger } from '../core/logger.ts';
import { AquariumConfigSchema, type AquariumConfig } from './schema.ts';

export interface ConfigLogSink {
  info(...values: unknown[]): void;
  error(...values: unknown[]): void;
}

export interface LoadConfigOptions {
  configPath?: string;
  examplePath?: string;
  logger?: ConfigLogSink;
}

const defaultExamplePath = fileURLToPath(new URL('../../config.example.yaml', import.meta.url));

export function loadConfig(options: LoadConfigOptions = {}): AquariumConfig {
  const configPath = options.configPath ?? join(process.cwd(), 'data', 'config.yaml');
  const examplePath = options.examplePath ?? defaultExamplePath;
  const logger = options.logger ?? createLogger('config');

  if (!existsSync(configPath)) {
    mkdirSync(dirname(configPath), { recursive: true });
    try {
      copyFileSync(examplePath, configPath, constants.COPYFILE_EXCL);
      logger.info(`配置文件不存在，已复制示例到 ${configPath}；请先编辑配置再启动。`);
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
    }
  }

  const source = readFileSync(configPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = yaml.parse(source);
  } catch {
    logger.error(`配置 YAML 无法解析：${configPath}`);
    throw new Error(`配置 YAML 无法解析：${configPath}`);
  }

  const result = AquariumConfigSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    logger.error(`配置校验失败：${details}`);
    throw new Error(`配置校验失败：${details}`);
  }

  return result.data;
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'EEXIST';
}
