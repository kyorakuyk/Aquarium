import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function timestamp(value: number): string {
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function writeImpressionsBackup(root: string, sessionId: string, at: number, document: unknown): string {
  const directory = path.join(root, 'data', 'backups');
  mkdirSync(directory, { recursive: true });
  const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/gu, '-');
  let candidateTime = at;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const name = `impressions-${safeSessionId}-${timestamp(candidateTime)}.json`;
    const target = path.join(directory, name);
    try {
      writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      return target;
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') {
        candidateTime += 1_000;
        continue;
      }
      throw error;
    }
  }
  throw new Error('Could not allocate a unique impressions backup name');
}
