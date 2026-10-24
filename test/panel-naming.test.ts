import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const affinity = read('../panel/src/components/AffinityPanel.tsx');
const eventBook = read('../panel/src/pages/EventBookPage.tsx');
const groupProfile = read('../panel/src/components/GroupProfileCard.tsx');
const kinGroups = read('../panel/src/components/KinGroupsPanel.tsx');
const overview = read('../panel/src/pages/OverviewPage.tsx');
const personas = read('../panel/src/pages/PersonasPage.tsx');
const personaMemory = read('../panel/src/components/PersonaMemoryPanel.tsx');
const personaPreview = read('../panel/src/pages/PersonaPreview.tsx');
const personalImpressions = read('../panel/src/pages/PersonalImpressionsPage.tsx');
const privateFacts = read('../panel/src/components/PrivateFactsPanel.tsx');
const stickers = read('../panel/src/pages/StickersPage.tsx');
const usageView = read('../panel/src/usage-view.ts');
const impressionsModel = read('../panel/src/impressions-model.ts');
const decisions = read('../panel/src/pages/DecisionsPage.tsx');

test('panel uses 人设, 眷属, and 决策记录 consistently for these surfaces', () => {
  assert.match(personas, /切换为此人设/u);
  assert.doesNotMatch(personas, /切换为此人格/u);
  assert.match(overview, /位眷属/u);
  assert.match(overview, /查看全部决策记录/u);
  assert.match(kinGroups, /眷属才会共享/u);
  assert.match(eventBook, /选择眷属/u);
  assert.match(personalImpressions, /眷属自己的看法/u);
  assert.match(personaPreview, /当前眷属/u);
  assert.match(personaMemory, /按眷属隔离/u);
  assert.match(stickers, /眷属/u);
  assert.match(usageView, /眷属信息不可用/u);
  assert.match(affinity, /同一眷属/u);
  assert.match(groupProfile, /转述 · 眷属/u);
  assert.match(privateFacts, /眷属 \{friend\.account\}/u);
  assert.match(impressionsModel, /转述 · 眷属/u);
  assert.match(decisions, /决策记录/u);
  assert.doesNotMatch(decisions, /<h2>决策追踪<\/h2>/u);
});
