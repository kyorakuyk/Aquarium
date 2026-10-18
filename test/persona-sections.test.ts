import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSections, parseSections, renderPersonaSectionBlocks } from '../src/persona/sections.ts';

test('parseSections and buildSections preserve fields, opening text, traits, and other-section order', () => {
  const source = [
    '---',
    'traits:',
    '  order: -2',
    '  morality: 1',
    '  talk: 0',
    '  mind: 2',
    'custom: keep',
    '---',
    '# {{name}}',
    '',
    '  开头说明保持原样  ',
    '',
    '## 对主人',
    '只给主人看的内容。',
    '',
    '## 口头禅',
    '- 嗯',
    '- 呀',
    '',
    '## 身份',
    '住在水族箱里的鱼。',
    '',
    '## 其他A',
    '第一段自定义内容。',
    '',
    '## 其他B',
    '第二段自定义内容。',
  ].join('\r\n');

  const form = parseSections(source);
  const built = buildSections(form);
  assert.equal(form.title, '# {{name}}');
  assert.equal(form.introduction, '\r\n  开头说明保持原样  ');
  assert.deepEqual(form.fields['口头禅'], ['嗯', '呀']);
  assert.deepEqual(form.other.map((section) => section.heading), ['其他A', '其他B']);
  assert.ok(built.indexOf('## 身份') < built.indexOf('## 口头禅'));
  assert.ok(built.indexOf('## 口头禅') < built.indexOf('## 对主人'));
  assert.ok(built.indexOf('## 对主人') < built.indexOf('## 其他A'));
  assert.ok(built.indexOf('## 其他A') < built.indexOf('## 其他B'));
  assert.match(built, /custom: keep/u);
  assert.deepEqual(parseSections(built), form);
});

test('repeated other-section headings receive unique preview block IDs', () => {
  const form = parseSections([
    '# {{name}}',
    '',
    '## 记录',
    '第一条。',
    '',
    '## 记录',
    '第二条。',
  ].join('\n'));
  const ids = renderPersonaSectionBlocks(form)
    .filter((block) => block.label === 'persona · 记录')
    .map((block) => block.id);
  assert.equal(new Set(ids).size, 2);
});
