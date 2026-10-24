import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync(new URL('../panel/src/App.tsx', import.meta.url), 'utf8');

const routedPages = [
  'LoginPage',
  'OverviewPage',
  'SessionsPage',
  'PersonasPage',
  'DecisionsPage',
  'UsagePage',
  'ImpressionsPage',
  'PersonalImpressionsPage',
  'ModelsPage',
  'StickersPage',
  'EventBookPage',
];

test('App loads each page route lazily with a Suspense loading state', () => {
  for (const page of routedPages) {
    assert.match(app, new RegExp(`const ${page} = lazy\\(\\(\\) => import\\('./pages/${page}\\.tsx'\\)`, 'u'));
    assert.doesNotMatch(app, new RegExp(`import \\{ ${page} \\} from './pages/${page}\\.tsx'`, 'u'));
  }
  assert.match(app, /<Suspense fallback=\{<PageLoading \/>\}>/u);
  assert.match(app, /正在加载页面…/u);
});
