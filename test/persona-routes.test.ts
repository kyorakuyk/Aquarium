import assert from 'node:assert/strict';
import test from 'node:test';
import { promptTemplateStore } from '../src/core/prompt-templates.ts';
import { parsePersonaMarkdown } from '../src/persona/load.ts';
import { buildSections, parseSections, renderPersonaSectionBlocks } from '../src/persona/sections.ts';
import { effectiveTalkLevel, renderTraitsBlock } from '../src/persona/traits.ts';
import { authHeaders, withPanel } from './panel-test-helpers.ts';

test('persona API accepts traits, preserves Markdown body, and reads back the saved header', async () => {
  await withPanel(async ({ app }) => {
    const bodyText = '# 自定义角色\r\n\r\n正文  保持空格。\r\n';
    const put = await app.request('/api/personas/custom-traits', {
      method: 'PUT',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        markdown: bodyText,
        traits: { order: -2, morality: 1, talk: 0, mind: 2 },
      }),
    });
    assert.equal(put.status, 200);

    const get = await app.request('/api/personas/custom-traits', { headers: authHeaders() });
    assert.equal(get.status, 200);
    const saved = await get.json() as {
      markdown: string;
      traits: { order: number; morality: number; talk: number; mind: number };
    };
    assert.equal(saved.markdown, `---\ntraits:\n  order: -2\n  morality: 1\n  talk: 0\n  mind: 2\n---\n${bodyText}`);
    assert.deepEqual(saved.traits, { order: -2, morality: 1, talk: 0, mind: 2 });

    const malformed = await app.request('/api/personas/custom-traits', {
      method: 'PUT',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        markdown: '---\ntraits: [\n---\n正文',
        traits: { order: -2, morality: 1, talk: 0, mind: 2 },
      }),
    });
    assert.equal(malformed.status, 400);
    const afterMalformed = await app.request('/api/personas/custom-traits', { headers: authHeaders() });
    assert.equal((await afterMalformed.json() as { markdown: string }).markdown, saved.markdown);

    const invalid = await app.request('/api/personas/custom-traits', {
      method: 'PUT',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: saved.markdown, traits: { order: 3 } }),
    });
    assert.equal(invalid.status, 400);
    const unchanged = await app.request('/api/personas/custom-traits', { headers: authHeaders() });
    assert.equal((await unchanged.json() as { markdown: string }).markdown, saved.markdown);

    const invalidMarkdown = '---\ntraits:\n  talk: 3\n---\n可修复正文。';
    const invalidHeader = await app.request('/api/personas/broken-traits', {
      method: 'PUT',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: invalidMarkdown }),
    });
    assert.equal(invalidHeader.status, 200);
    const editable = await app.request('/api/personas/broken-traits', { headers: authHeaders() });
    assert.equal((await editable.json() as { traits: unknown }).traits, null);
    const repaired = await app.request('/api/personas/broken-traits', {
      method: 'PUT',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: invalidMarkdown, traits: { talk: 1 } }),
    });
    assert.equal(repaired.status, 200);
    const repairedReadBack = await app.request('/api/personas/broken-traits', { headers: authHeaders() });
    const repairedDocument = await repairedReadBack.json() as { markdown: string; traits: unknown };
    assert.deepEqual(repairedDocument.traits, { order: 0, morality: 0, talk: 1, mind: 0 });
    assert.ok(repairedDocument.markdown.endsWith('可修复正文。'));
  });
});

test('persona preview returns section blocks and the runtime trait renderer output', async () => {
  const content = [
    '---',
    'traits:',
    '  order: 1',
    '  morality: 0',
    '  talk: -1',
    '  mind: 0',
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
    '## 其他小节',
    '保留此段。',
  ].join('\r\n');
  const form = parseSections(content);
  const personaBlocks = renderPersonaSectionBlocks(form);
  const traits = renderTraitsBlock(form.traits, effectiveTalkLevel(form.traits.talk, 0), promptTemplateStore.get().traits);
  const expectedBlocks = [...personaBlocks, ...(traits ? [{ id: 'traits', label: 'traits', text: traits }] : [])];
  const personaText = personaBlocks.map((block) => block.text).join(`${form.lineEnding}${form.lineEnding}`);
  const previewText = personaText + (traits ? `\n\n${traits}` : '');

  await withPanel(async ({ app }) => {
    const response = await app.request('/api/personas/preview', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    assert.equal(response.status, 200);
    const preview = await response.json() as {
      blocks: Array<{ id: string; label: string; text: string }>;
      chars: number;
      estTokens: number;
    };
    assert.deepEqual(preview.blocks, expectedBlocks);
    assert.ok(preview.blocks.some((block) => block.label === 'persona · 身份'));
    assert.ok(preview.blocks.some((block) => block.id === 'traits'));
    assert.equal(preview.chars, previewText.length);
    assert.equal(preview.estTokens, Math.ceil(preview.chars / 1.3));
    assert.equal(
      personaText,
      parsePersonaMarkdown(buildSections(form)).text,
    );
  });
});
