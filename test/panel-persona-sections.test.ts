import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSections as buildServerSections,
  parseSections as parseServerSections,
} from '../src/persona/sections.ts';
import { buildSections, parseSections } from '../panel/src/persona-sections.ts';

test('panel persona sections stay compatible with server parsing and building', () => {
  const source = [
    '---',
    'owner: aquarium',
    'traits:',
    '  order: 1',
    '  morality: -1',
    '  talk: 0',
    '  mind: 2',
    '---',
    '# {{name}}',
    '',
    'Opening note.',
    '',
    '## 年龄',
    '成年。',
    '',
    '## 身份',
    '一条小鱼。',
    '',
    '## 口头禅',
    '- 你好。',
    '- 再见。',
    '',
    '## 自定义段落',
    '第一段。',
    '',
    '## 另一段',
    '第二段。',
  ].join('\r\n');

  const panelForm = parseSections(source);
  const serverForm = parseServerSections(source);
  assert.deepEqual(panelForm, serverForm);
  assert.equal(buildSections(panelForm), buildServerSections(serverForm));
  assert.deepEqual(parseSections(buildSections(panelForm)), panelForm);
});
