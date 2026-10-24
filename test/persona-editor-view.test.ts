import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { personaEditorViewClass } from '../panel/src/persona-editor-view.ts';

const personaStyles = readFileSync(new URL('../panel/src/styles/personas.css', import.meta.url), 'utf8');

test('persona editor keeps save actions visible and limits Markdown hints to source view', () => {
  assert.equal(personaEditorViewClass('preview'), '');
  assert.equal(personaEditorViewClass('source'), 'is-source-view');
  assert.ok(/\.persona-editor-sticky\s*\{[^}]*position:\s*sticky/u.test(personaStyles), 'save bar and tabs remain sticky');
  assert.match(personaStyles, /\.personas-page:not\(\.is-source-view\)\s+\.persona-reference\s*\{[^}]*display:\s*none/);
});
