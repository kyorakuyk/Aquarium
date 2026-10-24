import assert from 'node:assert/strict';
import test from 'node:test';
import { redactSensitiveText } from '../src/core/impressions/sensitive-text.ts';
import { promptTemplateStore } from '../src/core/prompt/templates.ts';
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
        traits: { order: -2, morality: 1.3, talk: 0, mind: 2, openness: -1.2 },
      }),
    });
    assert.equal(put.status, 200);

    const get = await app.request('/api/personas/custom-traits', { headers: authHeaders() });
    assert.equal(get.status, 200);
    const saved = await get.json() as {
      markdown: string;
      traits: { order: number; morality: number; talk: number; mind: number; humor: number; openness: number; imitation: number };
    };
    assert.equal(saved.markdown, `---\ntraits:\n  order: -2\n  morality: 1.3\n  talk: 0\n  mind: 2\n  humor: 0\n  openness: -1.2\n  imitation: 0\n---\n${bodyText}`);
    assert.deepEqual(saved.traits, { order: -2, morality: 1.3, talk: 0, mind: 2, humor: 0, openness: -1.2, imitation: 0 });

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
    const tooPrecise = await app.request('/api/personas/custom-traits', {
      method: 'PUT',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: saved.markdown, traits: { order: 1.25 } }),
    });
    assert.equal(tooPrecise.status, 400);
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
    assert.deepEqual(repairedDocument.traits, { order: 0, morality: 0, talk: 1, mind: 0, humor: 0, openness: 0, imitation: 0 });
    assert.ok(repairedDocument.markdown.endsWith('可修复正文。'));
  });
});

test('persona preview returns section blocks and the runtime trait renderer output', async () => {
  const content = [
    '---',
    'traits:',
    '  order: 1.3',
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
  const previewName = '小青';
  const expectedPersonaBlocks = personaBlocks.map((block) => ({
    ...block,
    text: block.text.replaceAll('{{name}}', () => previewName),
  }));
  const expectedBlocks = [...expectedPersonaBlocks, ...(traits ? [{ id: 'traits', label: 'traits', text: traits }] : [])]
    .map((block) => ({
      id: block.id,
      label: redactSensitiveText(block.label),
      text: redactSensitiveText(block.text),
    }));
  const rawPersonaText = personaBlocks.map((block) => block.text).join(`${form.lineEnding}${form.lineEnding}`);
  const personaText = rawPersonaText.replaceAll('{{name}}', () => previewName);
  const previewText = personaText + (traits ? `\n\n${traits}` : '');
  const safePreviewText = redactSensitiveText(previewText);

  await withPanel(async ({ app }) => {
    const response = await app.request('/api/personas/preview', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, name: previewName }),
    });
    assert.equal(response.status, 200);
    const preview = await response.json() as {
      blocks: Array<{ id: string; label: string; text: string }>;
      chars: number;
      estTokens: number;
    };
    assert.deepEqual(preview.blocks, expectedBlocks);
    assert.ok(preview.blocks.some((block) => block.label === '我 · 身份'));
    assert.ok(preview.blocks.some((block) => block.id === 'traits'));
    assert.ok(preview.blocks.find((block) => block.id === 'traits')?.text.includes('你略随性'));
    assert.equal(preview.chars, safePreviewText.length);
    assert.equal(preview.estTokens, Math.ceil(preview.chars / 1.3));
    assert.equal(
      rawPersonaText,
      parsePersonaMarkdown(buildSections(form)).text,
    );
  });
});

test('persona preview redacts credential-shaped text from its API response', async () => {
  const credential = ['sk', 'test', 'preview', 'synthetic-value-1234567890'].join('-');
  const content = `# {{name}}\n\n## 身份\n测试凭据 ${credential}`;

  await withPanel(async ({ app }) => {
    const response = await app.request('/api/personas/preview', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, name: '小青' }),
    });
    assert.equal(response.status, 200);
    const responseText = await response.text();
    assert.equal(responseText.includes(credential), false);
    assert.match(responseText, /\[敏感内容已隐藏\]/u);
  });
});

test('persona import uses the extract slot and returns a redacted unsaved draft', async () => {
  const syntheticSecret = ['sk', 'test', 'secret', '123456'].join('-');
  const sourceText = '一段待整理的人设资料。';
  const calls: Array<{ slot: string; messages: unknown[] }> = [];
  const extracted = {
    fields: {
      身份: syntheticSecret,
      年龄: '成年',
      背景: '',
      说话方式: '',
      口头禅: ['你好'],
      常用表情: [],
      对熟人: '',
      对陌生人: '',
      对主人: '',
      底线: [],
    },
    traits: { order: 1.3, morality: 0, talk: -1.2, mind: 0, humor: 1, openness: 0.5, imitation: 2 },
    other: [{ heading: '经历', text: '后来搬到海边。' }, { heading: '', text: '' }],
  };

  await withPanel(async ({ app }) => {
    const response = await app.request('/api/personas/import', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'new-card.md', text: sourceText }),
    });
    assert.equal(response.status, 200);
    const result = await response.json() as { draft: string; mappedCount: number; otherCount: number };
    assert.equal(result.mappedCount, 8);
    assert.equal(result.otherCount, 1);
    assert.ok(!result.draft.includes(syntheticSecret), 'draft must not expose imported credential text');
    assert.ok(result.draft.includes('[敏感内容已隐藏]'));
    const form = parseSections(result.draft);
    assert.equal(form.fields.身份, '[敏感内容已隐藏]');
    assert.deepEqual(form.fields.口头禅, ['你好']);
    assert.deepEqual(form.traits, extracted.traits);
    assert.deepEqual(form.other, [extracted.other[0]]);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.slot, 'extract');
    assert.ok(JSON.stringify(calls[0]?.messages).includes(sourceText));

    const personas = await app.request('/api/personas', { headers: authHeaders() });
    assert.deepEqual((await personas.json() as Array<{ id: string }>).map(({ id }) => id), ['default']);
    assert.equal((await app.request('/api/personas/new-card', { headers: authHeaders() })).status, 404);
  }, undefined, {
    callModel: async (slot, messages) => {
      calls.push({ slot, messages });
      return {
        text: JSON.stringify(extracted),
        provider: 'fake',
        model: 'fake-model',
        usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
      };
    },
  });
});

test('persona import returns 422 with a reason for invalid JSON and schema values', async () => {
  const valid = {
    fields: {
      身份: '', 年龄: '', 背景: '', 说话方式: '', 口头禅: [], 常用表情: [],
      对熟人: '', 对陌生人: '', 对主人: '', 底线: [],
    },
    traits: { order: 0, morality: 0, talk: 0, mind: 0, humor: 0, openness: 0, imitation: 0 },
    other: [],
  };
  const invalidResponses = [
    'not JSON',
    JSON.stringify({ ...valid, fields: { ...valid.fields, 身份: 7 } }),
    JSON.stringify({ ...valid, traits: { ...valid.traits, order: 3 } }),
    JSON.stringify({ ...valid, traits: { ...valid.traits, order: 1.25 } }),
    JSON.stringify({ ...valid, traits: { order: 0, morality: 0, talk: 0 } }),
  ];
  let responseIndex = 0;

  await withPanel(async ({ app }) => {
    for (let index = 0; index < invalidResponses.length; index += 1) {
      const response = await app.request('/api/personas/import', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: 'draft.md', text: '来源文本' }),
      });
      assert.equal(response.status, 422);
      const result = await response.json() as { reason?: string };
      assert.equal(typeof result.reason, 'string');
      assert.ok(result.reason.length > 0);
    }
  }, undefined, {
    callModel: async () => ({
      text: invalidResponses[responseIndex++] ?? '',
      provider: 'fake',
      model: 'fake-model',
      usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
    }),
  });
});

test('persona versions seed on first read and retain only the newest 50 saves', async () => {
  await withPanel(async ({ app }) => {
    const initialResponse = await app.request('/api/personas/default/versions', { headers: authHeaders() });
    assert.equal(initialResponse.status, 200);
    const initialVersions = await initialResponse.json() as Array<{ id: number; summary: string; traits: Record<string, number> }>;
    assert.equal(initialVersions.length, 1);
    assert.equal(initialVersions[0]?.summary, '初始版本');
    assert.deepEqual(initialVersions[0]?.traits, {
      order: 0, morality: 0, talk: 0, mind: 0, humor: 0, openness: 0, imitation: 0,
    });

    const repeatRead = await app.request('/api/personas/default/versions', { headers: authHeaders() });
    assert.equal((await repeatRead.json() as unknown[]).length, 1);
    for (let index = 0; index < 50; index += 1) {
      const saved = await app.request('/api/personas/default', {
        method: 'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ markdown: `# 版本 ${index}\n\n## 身份\n${index}` }),
      });
      assert.equal(saved.status, 200);
    }

    const latestResponse = await app.request('/api/personas/default/versions', { headers: authHeaders() });
    const latest = await latestResponse.json() as Array<{ id: number; markdown?: string }>;
    assert.equal(latest.length, 50);
    assert.equal(latest.some((version) => version.id === initialVersions[0]?.id), false);
    assert.equal(Object.hasOwn(latest[0] ?? {}, 'markdown'), false);
  });
});

test('persona version list summarizes changes and restore loads without saving', async () => {
  await withPanel(async ({ app }) => {
    const original = '---\ntraits:\n  order: -0.1\n---\n# 记录\n\n## 说话方式\n慢慢说。';
    const originalSave = await app.request('/api/personas/default', {
      method: 'PUT',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: original }),
    });
    assert.equal(originalSave.status, 200);
    const originalVersionsResponse = await app.request('/api/personas/default/versions', { headers: authHeaders() });
    const originalVersions = await originalVersionsResponse.json() as Array<{ id: number }>;
    const originalVersionId = originalVersions[0]?.id;
    assert.equal(typeof originalVersionId, 'number');

    const changed = [
      '---',
      'traits:',
      '  order: 0.2',
      '---',
      '# 记录',
      '',
      '## 说话方式',
      '用短句。',
    ].join('\n');
    const changedSave = await app.request('/api/personas/default', {
      method: 'PUT',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: changed }),
    });
    assert.equal(changedSave.status, 200);
    const versionsResponse = await app.request('/api/personas/default/versions', { headers: authHeaders() });
    const versions = await versionsResponse.json() as Array<{
      id: number;
      traitsDelta: { order: number };
      summary: string;
    }>;
    assert.equal(versions.length, 2);
    assert.equal(versions[0]?.traitsDelta.order, 0.3);
    assert.match(versions[0]?.summary ?? '', /规矩 −0\.1→\+0\.2/u);
    assert.match(versions[0]?.summary ?? '', /说话方式/u);

    const latestDetails = await app.request(`/api/personas/default/versions/${versions[0]?.id}`, { headers: authHeaders() });
    assert.equal((await latestDetails.json() as { traits: { order: number } }).traits.order, 0.2);

    const details = await app.request(`/api/personas/default/versions/${originalVersionId}`, { headers: authHeaders() });
    assert.equal((await details.json() as { markdown: string }).markdown, original);
    const restored = await app.request(`/api/personas/default/versions/${originalVersionId}/restore`, {
      method: 'POST',
      headers: authHeaders(),
    });
    assert.equal(restored.status, 200);
    assert.equal((await restored.json() as { markdown: string }).markdown, original);
    const current = await app.request('/api/personas/default', { headers: authHeaders() });
    assert.equal((await current.json() as { markdown: string }).markdown, changed);
    const afterRestore = await app.request('/api/personas/default/versions', { headers: authHeaders() });
    assert.equal((await afterRestore.json() as unknown[]).length, 2);
  });
});
