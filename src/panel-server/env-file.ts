import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const keyPattern = /^[A-Z][A-Z0-9_]*$/;
const assignmentPattern = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/;

function assertKeyName(name: string): void {
  if (!keyPattern.test(name)) throw new TypeError('环境变量名无效');
}

export function envValueFromLine(line: string): string {
  const raw = line.slice(line.indexOf('=') + 1).trim();
  if (raw.length >= 2 && (raw.startsWith('"') && raw.endsWith('"') || raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  const commentIndex = raw.search(/\s#/u);
  return (commentIndex >= 0 ? raw.slice(0, commentIndex) : raw).trim();
}

export function maskSecret(value: string | undefined): { set: boolean; last4: string } {
  if (!value) return { set: false, last4: '' };
  return { set: true, last4: value.slice(-4) };
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

export function setEnvAssignment(source: string, name: string, value: string): string {
  assertKeyName(name);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.length === 0 ? [] : source.split(/\r?\n/u);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const assignment = `${name}=${formatValue(value)}`;
  const target = lines.findIndex((line) => {
    const match = assignmentPattern.exec(line);
    return match?.[1] === name;
  });
  if (target >= 0) {
    const previous = lines[target] ?? '';
    const indent = /^\s*/u.exec(previous)?.[0] ?? '';
    const exported = /^\s*export\s+/u.test(previous) ? 'export ' : '';
    lines[target] = `${indent}${exported}${assignment}`;
  } else {
    lines.push(assignment);
  }
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
