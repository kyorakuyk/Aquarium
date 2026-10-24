import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSections as buildServerSections,
  parseSections as parseServerSections,
  renderPersonaSectionBlocks as renderServerPersonaSectionBlocks,
} from '../src/persona/sections.ts';
import {
  PERSONA_TRAIT_LABELS,
  buildSections,
  parseSections,
  personaNameFromTitle,
  personaSourceForEditor,
  personaSourceFromEditor,
  personaTitleForDisplay,
  personaTitleFromName,
  renderPersonaSectionBlocks,
  syncPersonaFormEdit,
} from '../panel/src/persona-sections.ts';

test('panel persona sections stay compatible with server parsing and building', () => {
  const source = [
    '---',
    'owner: aquarium',
    'energySource: outer',
    'traits:',
    '  order: 1.3',
    '  morality: -1.2',
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
  assert.deepEqual(panelForm.traits, { order: 1.3, morality: -1.2, talk: 0, mind: 2, humor: 0, openness: 0, imitation: 0 });
  assert.equal(panelForm.metadata.energySource, 'outer');
  assert.deepEqual(
    renderPersonaSectionBlocks(panelForm).map(({ id, label }) => ({ id, label })),
    renderServerPersonaSectionBlocks(serverForm).map(({ id, label }) => ({ id, label })),
  );
  assert.equal(buildSections(panelForm), buildServerSections(serverForm));
  assert.deepEqual(parseSections(buildSections(panelForm)), panelForm);
  assert.equal(buildSections({ ...panelForm, title: '' }), buildServerSections({ ...serverForm, title: '' }));
});

test('panel persona affinity metadata is validated and round-trips', () => {
  const source = [
    '---',
    'affinity:',
    '  mode: independent',
    '  tiers:',
    '    positive: [15, 35, 60, 85]',
    '    negative: [-85, -60, -35, -15]',
    '  curves:',
    '    posGain:',
    '      preset: slow',
    '      points:',
    '        - { x: 0.4, dy: 0.25 }',
    '---',
    '# {{name}}',
  ].join('\n');
  const form = parseSections(source);
  assert.equal((form.metadata.affinity as { mode: string }).mode, 'independent');
  assert.deepEqual(parseSections(buildSections(form)), form);

  assert.throws(() => parseSections([
    '---',
    'affinity:',
    '  mode: unexpected',
    '---',
    '# {{name}}',
  ].join('\n')), /affinity/u);
});

test('editing a form field in source mode serializes the same form before save', () => {
  const form = parseSections('# {{name}}\n\n## 身份\n旧身份。');
  const changed: typeof form = { ...form, fields: { ...form.fields, 身份: '新身份。' } };
  const synchronized = syncPersonaFormEdit(changed, true);

  assert.equal(synchronized.sourceText, buildSections(changed));
  assert.deepEqual(parseSections(synchronized.sourceText), changed);
  assert.equal(syncPersonaFormEdit(changed, false).sourceText, undefined);
});

test('blank and fixed persona names serialize correctly without exposing the template token', () => {
  const form = parseSections('# {{name}}');
  const blank = { ...form, title: personaTitleFromName('') };
  const blankMarkdown = buildSections(blank);
  const blankSource = personaSourceForEditor(blankMarkdown);

  assert.ok(blankMarkdown.endsWith('# {{name}}'));
  assert.ok(buildSections({ ...form, title: '' }).endsWith('# {{name}}'));
  assert.equal(personaNameFromTitle(blank.title), '');
  assert.equal(personaTitleForDisplay(blank.title), '跟随 QQ 昵称');
  assert.equal(blankSource.includes('{{name}}'), false);
  assert.ok(blankSource.endsWith('# [跟随 QQ 昵称]'));
  assert.equal(buildSections(parseSections(personaSourceFromEditor(blankSource))), blankMarkdown);

  const titlelessSource = personaSourceForEditor('开头说明\n\n## 身份\n小鱼');
  assert.equal(titlelessSource.includes('{{name}}'), false);
  assert.ok(titlelessSource.startsWith('# [跟随 QQ 昵称]\n开头说明'));
  assert.ok(personaSourceFromEditor(titlelessSource).startsWith('# {{name}}\n开头说明'));

  const fixed = { ...form, title: personaTitleFromName('小青') };
  assert.ok(buildSections(fixed).endsWith('# 小青'));
  assert.equal(personaNameFromTitle(fixed.title), '小青');
});

test('persona trait endpoint vocabulary stays fixed', () => {
  assert.deepEqual(PERSONA_TRAIT_LABELS, [
    { key: 'order', title: '规矩', low: '守序', high: '混沌' },
    { key: 'morality', title: '善意', low: '善良', high: '邪恶' },
    { key: 'talk', title: '话量', low: '文静', high: '话痨' },
    { key: 'mind', title: '思维', low: '理性', high: '感性' },
    { key: 'humor', title: '脱线', low: '正经', high: '脱线' },
    { key: 'openness', title: '好奇', low: '保守', high: '好奇' },
    { key: 'imitation', title: '模仿', low: '自我', high: '模仿', locked: true },
  ]);
});
