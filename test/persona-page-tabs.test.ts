import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createElement } from 'react';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { emptyPersonaSections } from '../panel/src/persona-sections.ts';
import {
  PERSONA_EDITOR_TABS,
  PERSONA_PARAMETER_TABS,
  PERSONA_PARAMETER_PLACEHOLDERS,
  PERSONA_PREVIEW_TABS,
  PERSONA_PAGE_TABS_STORAGE_KEY,
  readPersonaPageTabs,
  writePersonaPageTabs,
  type PersonaTabStorage,
} from '../panel/src/persona-page-tabs.ts';

const pageSource = readFileSync(new URL('../panel/src/pages/PersonasPage.tsx', import.meta.url), 'utf8');
const editorToolbarSource = readFileSync(new URL('../panel/src/pages/PersonaEditorToolbar.tsx', import.meta.url), 'utf8');
const fieldsSource = readFileSync(new URL('../panel/src/pages/PersonaFields.tsx', import.meta.url), 'utf8');
const parameterPanelSource = readFileSync(new URL('../panel/src/pages/PersonaParametersPanel.tsx', import.meta.url), 'utf8');
const energyEditorSource = readFileSync(new URL('../panel/src/pages/PersonaEnergyEditor.tsx', import.meta.url), 'utf8');
const libraryToolbarSource = readFileSync(new URL('../panel/src/pages/PersonaLibraryToolbar.tsx', import.meta.url), 'utf8');
const counterpartEditorSource = readFileSync(new URL('../panel/src/pages/PersonaCounterpartEditor.tsx', import.meta.url), 'utf8');
const memberProfileCardSource = readFileSync(new URL('../panel/src/components/MemberProfileCard.tsx', import.meta.url), 'utf8');
const previewSource = readFileSync(new URL('../panel/src/pages/PersonaPreview.tsx', import.meta.url), 'utf8');
const personaStyles = readFileSync(new URL('../panel/src/styles/personas.css', import.meta.url), 'utf8');

class MemoryStorage implements PersonaTabStorage {
  private readonly entries = new Map<string, string>();

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.entries.set(key, value);
  }
}

test('persona editor tabs persist valid selections and recover from invalid storage', () => {
  const storage = new MemoryStorage();
  assert.deepEqual(readPersonaPageTabs(storage), { page: 'who', parameter: 'affinity' });

  writePersonaPageTabs({ page: 'parameters', parameter: 'mood' }, storage);
  assert.deepEqual(readPersonaPageTabs(storage), { page: 'parameters', parameter: 'mood' });

  storage.setItem(PERSONA_PAGE_TABS_STORAGE_KEY, JSON.stringify({ page: 'missing', parameter: 'missing' }));
  assert.deepEqual(readPersonaPageTabs(storage), { page: 'who', parameter: 'affinity' });

  const unavailableStorage: PersonaTabStorage = {
    getItem: () => { throw new Error('storage blocked'); },
    setItem: () => { throw new Error('storage blocked'); },
  };
  assert.deepEqual(readPersonaPageTabs(unavailableStorage), { page: 'who', parameter: 'affinity' });
  assert.doesNotThrow(() => writePersonaPageTabs({ page: 'deal', parameter: 'energy' }, unavailableStorage));
});

test('persona page tab shells and future-phase cards match the design plan', async () => {
  assert.deepEqual(PERSONA_EDITOR_TABS.map(({ label }) => label), ['我是谁', '待人接物', '参数', '其他小节']);
  assert.deepEqual(PERSONA_PARAMETER_TABS.map(({ label }) => label), ['好感', '心灵能量', '心情', '作息', '主动性', '记忆']);
  assert.deepEqual(PERSONA_PREVIEW_TABS.map(({ label }) => label), ['实际注入', '性格的变化', '版本']);
  assert.deepEqual(Object.keys(PERSONA_PARAMETER_PLACEHOLDERS), ['sleep', 'initiative', 'memory']);
  assert.ok(pageSource.includes('readPersonaPageTabs'), 'page restores the selected tabs');
  assert.ok(pageSource.includes('writePersonaPageTabs'), 'page persists the selected tabs');
  assert.ok(pageSource.includes('PersonaEditorToolbar'), 'page delegates the sticky save/tab bar');
  assert.ok(editorToolbarSource.includes('PERSONA_EDITOR_TABS'), 'sticky toolbar renders the main tab options');
  assert.ok(pageSource.includes('PersonaLibraryToolbar'), 'page delegates the compact persona library row');
  assert.ok(libraryToolbarSource.includes('persona-library-row'), 'library toolbar renders persona chips');
  assert.ok(fieldsSource.includes('PersonaCounterpartEditor'), 'deal tab includes the frontmatter-backed original counterpart editor');
  assert.ok(counterpartEditorSource.includes('/counterparts'), 'counterpart editor reads and mutates the counterpart API');
  assert.ok(libraryToolbarSource.includes('persona-counterpart-count'), 'persona navigation shows pending-claim counts');
  assert.ok(memberProfileCardSource.includes('member.counterpartClaims'), 'member profile card renders exact-user pending claims');
  assert.ok(memberProfileCardSource.includes('/dismiss'), 'member profile card can dismiss a claim');
  assert.ok(memberProfileCardSource.includes('可能是「{claim.counterpartName}」'), 'member profile does not mislabel nickname matches as self-claims');
  assert.ok(fieldsSource.includes('PersonaParametersPanel'), 'fields delegate their parameter page');
  assert.ok(parameterPanelSource.includes('PERSONA_PARAMETER_TABS'), 'parameter panel renders the sub-tabs');
  assert.ok(parameterPanelSource.includes('PersonaAffinityEditor'), 'affinity tab mounts its persisted curve editor');
  assert.ok(parameterPanelSource.includes('PersonaEnergyEditor'), 'energy tab mounts its persisted multiplier editor');
  assert.ok(energyEditorSource.includes('/api/mood?account='), 'energy estimate reads the selected preview account');
  assert.ok(fieldsSource.includes('scrollHeight'), 'long form textareas grow with their content');
  assert.ok(previewSource.includes('PERSONA_PREVIEW_TABS'), 'preview rail renders its three tabs');
  assert.ok(previewSource.includes('scrollIntoView'), 'preview follows the focused form section');
  assert.ok(pageSource.includes('onDragEnter'), 'the full page accepts Markdown file drops');
  assert.ok(personaStyles.includes('persona-page-drop-overlay'), 'file drops show a page-wide overlay');
  assert.ok(personaStyles.includes('scrollbar-width: none'), 'the preview rail hides its inner scrollbar');
  assert.ok(!/它是谁|它怎么说话|它怎么对人|用它试聊/u.test(`${fieldsSource}${previewSource}`), 'persona copy uses first person');

  assert.equal(PERSONA_PARAMETER_PLACEHOLDERS.sleep.items[0]?.current, '总览「作息」卡片里的值');
  assert.match(PERSONA_PARAMETER_PLACEHOLDERS.initiative.dependency, /src\/config\/schema\.ts/u);
  assert.match(PERSONA_PARAMETER_PLACEHOLDERS.memory.dependency, /KNOWLEDGE-IMPRESSION-SPLIT/u);

  const form = emptyPersonaSections();
  form.metadata = {
    ...form.metadata,
    counterparts: [{ name: '岛村抱月', aliases: ['岛村'], label: '恋人', matchByName: 'prompt' }],
  };
  const vite = await createServer({
    configFile: fileURLToPath(new URL('../panel/vite.config.ts', import.meta.url)),
    server: { middlewareMode: true },
    logLevel: 'silent',
  });
  try {
    const { PersonaFields } = await vite.ssrLoadModule('/src/pages/PersonaFields.tsx') as {
      PersonaFields: (props: {
        form: typeof form;
        onChange: (next: typeof form) => void;
        onFocus: (blockId: string) => void;
        disabled: boolean;
        activeTab: 'deal';
        parameterTab: 'affinity';
        onParameterTabChange: (tab: 'affinity') => void;
        personaId: string;
        previewAccountId: number | null;
      }) => ReactElement;
    };
    const html = renderToStaticMarkup(createElement(PersonaFields, {
      form,
      onChange: () => undefined,
      onFocus: () => undefined,
      disabled: false,
      activeTab: 'deal',
      parameterTab: 'affinity',
      onParameterTabChange: () => undefined,
      personaId: 'default',
      previewAccountId: 1040023878,
    }));
    const editorStart = html.indexOf('<section class="persona-form-card persona-counterpart-editor"');
    assert.notEqual(editorStart, -1, 'the actual deal tab renders the counterpart editor');
    const editorEnd = html.indexOf('</section>', editorStart);
    const counterpartMarkup = html.slice(editorStart, editorEnd);
    assert.match(counterpartMarkup, /aria-label="原作对象"/u);
    assert.match(counterpartMarkup, /岛村抱月/u);
    assert.match(counterpartMarkup, /别名（用顿号分隔）/u);
    assert.match(counterpartMarkup, /名字匹配/u);
    assert.match(counterpartMarkup, /添加 QQ/u);
    assert.match(counterpartMarkup, /待认领/u);
    assert.equal(counterpartMarkup.match(/<button class="button [^"]*"/gu)?.length, 4);
  } finally {
    await vite.close();
  }
});
