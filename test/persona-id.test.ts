import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validPersonaId as validPathPersonaId } from '../src/panel-server/persona-paths.ts';
import { loadPersona } from '../src/persona/load.ts';
import { hasPersonaIdCollision, normalizePersonaId, validPersonaId } from '../src/persona/persona-id.ts';

test('persona ID normalization trims and lowercases before validation', () => {
  const id = normalizePersonaId(' Adachi_Sakura ');

  assert.equal(id, 'adachi_sakura');
  assert.equal(validPersonaId(id), true);
});

test('persona ID rules accept Chinese names and reject whitespace, separators, and overlong values', () => {
  assert.equal(validPersonaId('腹黑鲸鱼'), true);
  assert.equal(validPathPersonaId('腹黑鲸鱼'), true);
  assert.equal(validPersonaId('bad id'), false);
  assert.equal(validPersonaId('bad/id'), false);
  assert.equal(validPersonaId('a'.repeat(41)), false);
});

test('persona creation detects IDs that differ only by letter case', () => {
  assert.equal(hasPersonaIdCollision(['Adachi_Sakura'], 'adachi_sakura'), true);
  assert.equal(hasPersonaIdCollision(['腹黑鲸鱼'], '其他人设'), false);
});

test('loadPersona reads a Chinese-named persona file', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-persona-id-'));
  fs.mkdirSync(path.join(root, 'personas'), { recursive: true });
  fs.writeFileSync(path.join(root, 'personas', '腹黑鲸鱼.md'), '中文角色正文', 'utf8');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.equal(loadPersona('腹黑鲸鱼', '测试昵称', { root }).text, '中文角色正文');
});
