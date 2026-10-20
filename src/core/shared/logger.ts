import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { format } from 'node:util';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type LogMethod = (...values: unknown[]) => void;
const MAX_LOG_BYTES = 50 * 1024 * 1024;
const LOG_LIMIT_MARKER = '日志文件已达上限（50MB），停止写入。';

export interface ConsoleLogEntry {
  time: string;
  level: string;
  source: string;
  body: string;
}

export interface ConsoleSink {
  write(entry: ConsoleLogEntry): void;
  flush(): void;
}

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

function characterWidth(character: string): number {
  return /^[\u1100-\u11ff\u2e80-\ua4cf\uac00-\ud7af\uf900-\ufaff\ufe10-\ufe6f\uff00-\uff60\uffe0-\uffe6]$/u.test(character)
    ? 2
    : 1;
}

function truncateLine(line: string, columns: number): string {
  if ([...line].reduce((width, character) => width + characterWidth(character), 0) <= columns) return line;
  const limit = Math.max(0, columns - 1);
  let width = 0;
  let result = '';
  for (const character of line) {
    const nextWidth = characterWidth(character);
    if (width + nextWidth > limit) break;
    result += character;
    width += nextWidth;
  }
  return `${result}…`;
}

export function createConsoleSink(stream: NodeJS.WriteStream = process.stdout): ConsoleSink {
  let previous: { key: string; count: number; startTime: string } | undefined;
  let rewritten = false;
  const isTty = stream.isTTY === true;

  function flush(): void {
    if (rewritten) stream.write('\n');
    previous = undefined;
    rewritten = false;
  }

  return {
    write(entry) {
      const line = `[${entry.time}] [${entry.level}] [${entry.source}] ${entry.body}`;
      if (!isTty) {
        stream.write(`${line}\n`);
        return;
      }
      const columns = stream.columns;
      const canRewrite = Number.isSafeInteger(columns) && (columns ?? 0) > 0;
      if (!canRewrite) {
        if (previous) stream.write('\n');
        stream.write(`${line}\n`);
        previous = undefined;
        rewritten = false;
        return;
      }

      const key = JSON.stringify([entry.level, entry.source, entry.body]);
      if (previous?.key === key) {
        previous.count += 1;
        const repeated = `[${entry.time}] [${entry.level}] [${entry.source}] ${entry.body}（×${previous.count}，自 ${previous.startTime}）`;
        stream.write(`\r\x1b[2K${truncateLine(repeated, columns!)}`);
        rewritten = true;
        return;
      }

      if (previous) stream.write('\n');
      stream.write(line);
      previous = { key, count: 1, startTime: entry.time };
      rewritten = false;
    },
    flush,
  };
}

const consoleSink = createConsoleSink();
export function flushConsoleSink(): void {
  consoleSink.flush();
}
process.once('exit', flushConsoleSink);

export function createLogger(scope: string): Logger {
  const write = (level: LogLevel, values: unknown[]): void => {
    const now = new Date();
    const time = timePart(now);
    const body = format(...values);
    const line = `[${time}] [${level.toUpperCase()}] [${scope}] ${body}`;
    const logDirectory = join(process.cwd(), 'data', 'logs');
    mkdirSync(logDirectory, { recursive: true });
    const logPath = join(logDirectory, `aquarium-${datePart(now)}.log`);
    const limitLine = `[${timePart(now)}] [WARN] [${scope}] ${LOG_LIMIT_MARKER}`;
    appendBoundedLog(logPath, line, limitLine);

    if (process.stdout.isTTY === true) {
      consoleSink.write({ time, level: level.toUpperCase(), source: scope, body });
    } else {
      const output = level === 'error'
        ? console.error
        : level === 'warn'
          ? console.warn
          : level === 'debug'
            ? console.debug
            : console.info;
      output(line);
    }
  };

  return {
    debug: (...values) => write('debug', values),
    info: (...values) => write('info', values),
    warn: (...values) => write('warn', values),
    error: (...values) => write('error', values),
  };
}
