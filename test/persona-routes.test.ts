import assert from 'node:assert/strict';
import test from 'node:test';
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
