import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const loggerUrl = pathToFileURL(path.join(repoRoot, 'src', 'core', 'logger.ts')).href;

test('logger 输出统一格式并追加写入每日文件', (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-logger-'));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

  const source = [
    `import { createLogger } from ${JSON.stringify(loggerUrl)};`,
    "const log = createLogger('unit');",
    "log.debug('debug');",
    "log.info('hello', 2);",
    "log.warn('warning');",
    "log.error('failure');",
    "log.info('again');",
  ].join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: fixtureRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const logDirectory = path.join(fixtureRoot, 'data', 'logs');
  const files = fs.readdirSync(logDirectory);
  assert.equal(files.length, 1);
  assert.match(files[0], /^aquarium-\d{4}-\d{2}-\d{2}\.log$/);

  const lines = fs.readFileSync(path.join(logDirectory, files[0]), 'utf8').trimEnd().split('\n');
  assert.equal(lines.length, 5);
  assert.match(lines[0], /^\[\d{2}:\d{2}:\d{2}\] \[DEBUG\] \[unit\] debug$/);
  assert.match(lines[1], /^\[\d{2}:\d{2}:\d{2}\] \[INFO\] \[unit\] hello 2$/);
  assert.match(lines[2], /^\[\d{2}:\d{2}:\d{2}\] \[WARN\] \[unit\] warning$/);
  assert.match(lines[3], /^\[\d{2}:\d{2}:\d{2}\] \[ERROR\] \[unit\] failure$/);
  assert.match(lines[4], /^\[\d{2}:\d{2}:\d{2}\] \[INFO\] \[unit\] again$/);
});

test('单日日志达到 50MB 后写入上限标记，次日使用新文件', (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-logger-limit-'));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  const logDirectory = path.join(fixtureRoot, 'data', 'logs');
  fs.mkdirSync(logDirectory, { recursive: true });
  const maxBytes = 50 * 1024 * 1024;
  const firstDayFile = path.join(logDirectory, 'aquarium-2030-01-01.log');
  fs.writeFileSync(firstDayFile, '');
  fs.truncateSync(firstDayFile, maxBytes - 100);

  const source = [
    `import { createLogger } from ${JSON.stringify(loggerUrl)};`,
    'const RealDate = Date;',
    "let current = '2030-01-01T12:00:00.000Z';",
    'globalThis.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [current])); } static now() { return new RealDate(current).getTime(); } };',
    "const log = createLogger('limit');",
    "log.info('trigger same day');",
    "log.info('after limit same day');",
    "current = '2030-01-02T12:00:00.000Z';",
    "log.info('next day');",
  ].join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: fixtureRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const descriptor = fs.openSync(firstDayFile, 'r');
  let tail: string;
  try {
    const info = fs.fstatSync(descriptor);
    const buffer = Buffer.alloc(256);
    const length = fs.readSync(descriptor, buffer, 0, buffer.length, info.size - buffer.length);
    tail = buffer.subarray(0, length).toString('utf8');
    assert.ok(info.size <= maxBytes);
  } finally {
    fs.closeSync(descriptor);
  }
  assert.match(tail, /已达上限/u);
  assert.doesNotMatch(tail, /trigger same day/u);
  assert.doesNotMatch(tail, /after limit same day/u);
  assert.match(fs.readFileSync(path.join(logDirectory, 'aquarium-2030-01-02.log'), 'utf8'), /next day/u);
});
