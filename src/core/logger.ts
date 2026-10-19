import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { format } from 'node:util';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type LogMethod = (...values: unknown[]) => void;
const MAX_LOG_BYTES = 50 * 1024 * 1024;
const LOG_LIMIT_MARKER = '日志文件已达上限（50MB），停止写入。';

export interface Logger {
  debug: LogMethod;
  info: LogMethod;
  warn: LogMethod;
  error: LogMethod;
}

function datePart(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function timePart(date: Date): string {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

function hasLogLimitMarker(filePath: string, fileSize: number): boolean {
  if (fileSize === 0) return false;
  const descriptor = openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(fileSize, 512));
    const length = readSync(descriptor, buffer, 0, buffer.length, fileSize - buffer.length);
    return buffer.subarray(0, length).toString('utf8').trimEnd().endsWith(LOG_LIMIT_MARKER);
  } finally {
    closeSync(descriptor);
  }
}

function appendBoundedLog(filePath: string, line: string, markerLine: string): void {
  const lineBuffer = Buffer.from(`${line}\n`, 'utf8');
  const markerBuffer = Buffer.from(`${markerLine}\n`, 'utf8');
  const fileSize = existsSync(filePath) ? statSync(filePath).size : 0;
  if (fileSize + lineBuffer.byteLength + markerBuffer.byteLength <= MAX_LOG_BYTES) {
    appendFileSync(filePath, lineBuffer);
    return;
  }
  if (!hasLogLimitMarker(filePath, fileSize)) appendFileSync(filePath, markerBuffer);
}

export function createLogger(scope: string): Logger {
  const write = (level: LogLevel, values: unknown[]): void => {
    const now = new Date();
    const line = `[${timePart(now)}] [${level.toUpperCase()}] [${scope}] ${format(...values)}`;
    const logDirectory = join(process.cwd(), 'data', 'logs');
    mkdirSync(logDirectory, { recursive: true });
    const logPath = join(logDirectory, `aquarium-${datePart(now)}.log`);
    const limitLine = `[${timePart(now)}] [WARN] [${scope}] ${LOG_LIMIT_MARKER}`;
    appendBoundedLog(logPath, line, limitLine);

    const output = level === 'error'
      ? console.error
      : level === 'warn'
        ? console.warn
        : level === 'debug'
          ? console.debug
          : console.info;
    output(line);
  };

  return {
    debug: (...values) => write('debug', values),
    info: (...values) => write('info', values),
    warn: (...values) => write('warn', values),
    error: (...values) => write('error', values),
  };
}
