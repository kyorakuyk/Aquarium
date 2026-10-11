import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { format } from 'node:util';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type LogMethod = (...values: unknown[]) => void;

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

export function createLogger(scope: string): Logger {
  const write = (level: LogLevel, values: unknown[]): void => {
    const now = new Date();
    const line = `[${timePart(now)}] [${level.toUpperCase()}] [${scope}] ${format(...values)}`;
    const logDirectory = join(process.cwd(), 'data', 'logs');
    mkdirSync(logDirectory, { recursive: true });
    appendFileSync(join(logDirectory, `aquarium-${datePart(now)}.log`), `${line}\n`, 'utf8');

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
