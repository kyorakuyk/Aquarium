import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import yaml from 'yaml';
import { AquariumConfigSchema, type AquariumConfig } from './schema.ts';

let configWriteTail: Promise<void> = Promise.resolve();

export function serializeConfigWrite<T>(task: () => Promise<T>): Promise<T> {
  const result = configWriteTail.then(task, task);
  configWriteTail = result.then(() => undefined, () => undefined);
  return result;
}

export function writeConfig(config: AquariumConfig, configPath = 'data/config.yaml'): void {
  const result = AquariumConfigSchema.safeParse(config);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new Error(`配置校验失败：${details}`);
  }

  mkdirSync(dirname(configPath), { recursive: true });
  const temporaryPath = `${configPath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, yaml.stringify(result.data), { encoding: 'utf8', flag: 'wx' });
    renameSync(temporaryPath, configPath);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // 写入在创建临时文件之前失败时，无需清理。
    }
    throw error;
  }
}
