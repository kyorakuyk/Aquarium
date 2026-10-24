import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const interactionPanel = read('../panel/src/pages/InteractionSettingsPanel.tsx');
const sessionsPage = read('../panel/src/pages/SessionsPage.tsx');

test('interaction rows show inherited or override status and keep global defaults out', () => {
  assert.match(interactionPanel, /sessionSettingsInheritanceCopy\(session\.kind/u);
  assert.match(interactionPanel, /session\.interactionOverrides\.includes\(key\)/u);
  assert.match(interactionPanel, /inheritance\.statusLabel/u);
  assert.match(interactionPanel, /inheritance\.restoreLabel/u);
  assert.match(interactionPanel, /className="field-inheritance-state"/u);
  assert.match(interactionPanel, /onClick=\{\(\) => restore\(key\)\}/u);
  assert.match(sessionsPage, /\{selectedSession && <InteractionSettingsPanel/u);
});
