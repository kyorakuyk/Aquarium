import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePersonaTraits, updatePersonaMarkdownTraits } from '../panel/src/persona-traits.ts';

const traits = { order: -2, morality: 1, talk: 0, mind: 2 };

test('persona UI trait edits add or update YAML and preserve Markdown body exactly', () => {
  const body = '\r\n# 标题  \r\n\r\n正文末尾空格  \r\n';
  const first = updatePersonaMarkdownTraits(body, traits);
  const read = parsePersonaTraits(first);
  assert.deepEqual(read, traits);
  assert.ok(first.endsWith(body));

  const second = updatePersonaMarkdownTraits(first, { ...traits, talk: -1 });
  assert.deepEqual(parsePersonaTraits(second), { ...traits, talk: -1 });
  assert.ok(second.endsWith(body));
});

test('persona UI parser returns null for invalid trait values without changing the text', () => {
  const markdown = '---\ntraits:\n  talk: 3\n---\nbody';
  assert.equal(parsePersonaTraits(markdown), null);
  assert.equal(parsePersonaTraits('---\ntraits:\n---\nbody'), null);
  assert.equal(updatePersonaMarkdownTraits(markdown, traits).endsWith('\nbody'), true);
});
