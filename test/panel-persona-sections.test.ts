import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSections as buildServerSections,
  parseSections as parseServerSections,
  renderPersonaSectionBlocks as renderServerPersonaSectionBlocks,
} from '../src/persona/sections.ts';
import {
  buildSections,
  parseSections,
  renderPersonaSectionBlocks,
  syncPersonaFormEdit,
} from '../panel/src/persona-sections.ts';

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
    '## 自定义段落',
    '第二段。',
  ].join('\r\n');

  const panelForm = parseSections(source);
  const serverForm = parseServerSections(source);
  assert.deepEqual(panelForm, serverForm);
  assert.deepEqual(
    renderPersonaSectionBlocks(panelForm).map(({ id, label }) => ({ id, label })),
    renderServerPersonaSectionBlocks(serverForm).map(({ id, label }) => ({ id, label })),
  );
  assert.equal(buildSections(panelForm), buildServerSections(serverForm));
  assert.deepEqual(parseSections(buildSections(panelForm)), panelForm);
});

test('editing a form field in source mode serializes the same form before save', () => {
  const form = parseSections('# {{name}}\n\n## 身份\n旧身份。');
  const changed: typeof form = { ...form, fields: { ...form.fields, 身份: '新身份。' } };
  const synchronized = syncPersonaFormEdit(changed, true);

  assert.equal(synchronized.sourceText, buildSections(changed));
  assert.deepEqual(parseSections(synchronized.sourceText), changed);
  assert.equal(syncPersonaFormEdit(changed, false).sourceText, undefined);
});
