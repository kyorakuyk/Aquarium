import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const keyPattern = /^[A-Z][A-Z0-9_]*$/;
const assignmentPattern = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/;

function assertKeyName(name: string): void {
  if (!keyPattern.test(name)) throw new TypeError('环境变量名无效');
}

export function envValueFromLine(line: string): string {
  const source = line.slice(line.indexOf('=') + 1).trim();
  const commentIndex = inlineCommentStart(source);
  const raw = (commentIndex >= 0 ? source.slice(0, commentIndex) : source).trim();
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'string') return parsed;
    } catch {
      return raw.slice(1, -1);
    }
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  return raw;
}

export function maskSecret(value: string | undefined): { set: boolean; last4: string } {
  if (!value) return { set: false, last4: '' };
  return { set: true, last4: value.length <= 4 ? '••••' : value.slice(-4) };
}

export function readEnvKey(envPath: string, name: string): string | undefined {
  let source: string;
  try {
    source = readFileSync(envPath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
  for (const line of source.split(/\r?\n/u)) {
    const match = assignmentPattern.exec(line);
    if (match?.[1] === name) return envValueFromLine(line) || undefined;
  }
  return undefined;
}

function formatValue(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/u.test(value)) return value;
  return JSON.stringify(value);
}

function inlineCommentStart(value: string): number {
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\' && quote === '"') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '#' && (index === 0 || /\s/u.test(value[index - 1] ?? ''))) {
      let start = index;
      while (start > 0 && /\s/u.test(value[start - 1] ?? '')) start -= 1;
      return start;
    }
  }
  return -1;
}

function replaceAssignment(line: string, value: string): string {
  const equalsIndex = line.indexOf('=');
  const existingValue = line.slice(equalsIndex + 1);
  const commentIndex = inlineCommentStart(existingValue);
  const comment = commentIndex >= 0 ? existingValue.slice(commentIndex) : '';
  return `${line.slice(0, equalsIndex + 1)}${formatValue(value)}${comment}`;
}

export function setEnvAssignment(source: string, name: string, value: string): string {
  assertKeyName(name);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.length === 0 ? [] : source.split(/\r?\n/u);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  let found = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const match = assignmentPattern.exec(line);
    if (match?.[1] !== name) continue;
    lines[index] = replaceAssignment(line, value);
    found = true;
  }
  if (!found) lines.push(`${name}=${formatValue(value)}`);
  return `${lines.join(newline)}${newline}`;
}

export function writeEnvKey(envPath: string, name: string, value: string): void {
  assertKeyName(name);
  let source = '';
  try {
    source = readFileSync(envPath, 'utf8');
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const next = setEnvAssignment(source, name, value);
  mkdirSync(dirname(envPath), { recursive: true });
  const temporaryPath = `${envPath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, next, { encoding: 'utf8', flag: 'wx' });
    renameSync(temporaryPath, envPath);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // 临时文件可能在写入前就创建失败。
    }
    throw error;
  }
}
