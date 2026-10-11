import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface LoadPersonaOptions {
  root?: string;
}

export function loadPersona(
  id: string,
  nickname: string,
  options: LoadPersonaOptions = {},
): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`无效的人设 ID：${id}`);
  const root = options.root ?? process.cwd();
  const candidates = [
    join(root, 'data', 'personas', `${id}.md`),
    join(root, 'personas', `${id}.md`),
  ];
  const personaPath = candidates.find(existsSync);
  if (!personaPath) throw new Error(`找不到人设文件：${id}.md`);

  const displayName = nickname.trim() || '水族箱';
  return readFileSync(personaPath, 'utf8').replaceAll('{{name}}', () => displayName);
}
