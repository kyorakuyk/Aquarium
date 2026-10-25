import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createElement } from 'react';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { buildEmotionLibrary, defaultEmotionEdge, DEFAULT_EMOTION_LIBRARY } from '../src/core/mood/emotions.ts';
import { DEFAULT_PERSONA_MOOD } from '../src/persona/mood.ts';
import { emptyPersonaSections } from '../panel/src/persona-sections.ts';

import {
  addMoodEmotion,
  PERSONA_MOOD_PREVIEW_ERRORS,
  moodCoordinateFromPointer,
  isMoodDragStarted,
  isMoodMatrixHeaderHovered,
  moodMarginColorPercent,
  moodOutgoingTargets,
  nearestMoodPoint,
  placeMoodEmotionLabels,
  removeMoodEmotion,
  restoreMissingMoodEmotions,
  resolveMoodEdge,
  selectMoodEdge,
  selectMoodSource,
  updateMoodCoordinate,
  updateMoodEdgeSetting,
  updateMoodSubSetting,
  withPersonaMoodSettings,
} from '../panel/src/pages/persona-mood-utils.ts';

const source = DEFAULT_PERSONA_MOOD.emotions[4]!;
const target = DEFAULT_PERSONA_MOOD.emotions[0]!;
const emotion = (name: string) => DEFAULT_EMOTION_LIBRARY.find((entry) => entry.name === name)!;

test('persona mood emotion edits add, deduplicate, restore, and prune references', () => {
  const added = addMoodEmotion(DEFAULT_PERSONA_MOOD, '  自定义情绪  ');
  assert.equal(added.emotions.at(-1), '自定义情绪');
  assert.throws(() => addMoodEmotion(added, ' 自定义情绪 '), /已经有了/u);
  const removed = removeMoodEmotion(added, '平静');
  assert.equal(removed.emotions.includes('平静'), false);
  assert.equal(removed.coordinates['平静'], undefined);
  assert.equal(removed.edgeOverrides['平静'], undefined);
  const restored = restoreMissingMoodEmotions(removed);
  assert.equal(restored.emotions.filter((name) => DEFAULT_PERSONA_MOOD.emotions.includes(name)).length, DEFAULT_PERSONA_MOOD.emotions.length);
  assert.equal(restored.emotions.includes('自定义情绪'), true);
});

test('persona mood edge editor stores only differences from the calculated default', () => {
  assert.equal(resolveMoodEdge(DEFAULT_PERSONA_MOOD, source, target).modified, false);
  const changed = updateMoodEdgeSetting(DEFAULT_PERSONA_MOOD, source, target, 'margin', 0.3);
  assert.equal(changed.edgeOverrides[source]?.[target]?.margin, 0.3);
  assert.equal(resolveMoodEdge(changed, source, target).modified, true);
  const reset = updateMoodEdgeSetting(changed, source, target, 'margin', defaultEmotionEdge(emotion(source), emotion(target)).margin);
  assert.equal(reset.edgeOverrides[source]?.[target], undefined);
});

test('mood graph pointer mapping honors the plotted PAD plane bounds', () => {
  const rect = { left: 0, top: 0, width: 600, height: 360 };
  assert.deepEqual(moodCoordinateFromPointer(42, 24, rect), { valence: -1, arousal: 1 });
  assert.deepEqual(moodCoordinateFromPointer(580, 322, rect), { valence: 1, arousal: 0 });
  assert.deepEqual(moodCoordinateFromPointer(311, 173, rect), { valence: 0, arousal: 0.5 });
});

test('coordinate edits remove the override when dragged back to the library default', () => {
  const changed = updateMoodCoordinate(DEFAULT_PERSONA_MOOD, '平静', 'valence', 0.35);
  assert.equal(changed.coordinates['平静']?.valence, 0.35);
  const reset = updateMoodCoordinate(changed, '平静', 'valence', 0);
  assert.equal(reset.coordinates['平静'], undefined);
});

test('removing and re-adding a library emotion restores its default coordinate and edges', () => {
  const moved = updateMoodCoordinate(DEFAULT_PERSONA_MOOD, '开心', 'valence', 0.1);
  const customized = updateMoodEdgeSetting(moved, '开心', '平静', 'margin', 0.4);
  const removed = removeMoodEmotion(customized, '开心');
  assert.equal(removed.coordinates['开心'], undefined);
  assert.equal(removed.edgeOverrides['开心'], undefined);
  const restored = addMoodEmotion(removed, '开心');
  assert.throws(() => addMoodEmotion(restored, '开心'), /已经有了/u);
  const point = buildEmotionLibrary(restored.emotions, restored.coordinates).find((item) => item.name === '开心');
  assert.deepEqual(point, DEFAULT_EMOTION_LIBRARY.find((item) => item.name === '开心'));
  assert.equal(restored.edgeOverrides['开心'], undefined);
});

test('custom mood edges use the distance formula and the three prohibited jumps stay blocked', () => {
  const settings = addMoodEmotion(DEFAULT_PERSONA_MOOD, '自定义情绪');
  const library = buildEmotionLibrary(settings.emotions, settings.coordinates);
  const custom = library.find((item) => item.name === '自定义情绪')!;
  const calm = library.find((item) => item.name === '平静')!;
  const distance = Math.hypot(custom.valence - calm.valence, (custom.arousal - calm.arousal) * 1.5, (custom.dominance - calm.dominance) * 0.6);
  const customEdge = defaultEmotionEdge(custom, calm);
  assert.ok(Math.abs(customEdge.margin - (0.02 + 0.12 * distance)) < 1e-12);
  assert.equal(customEdge.jump, distance < 1.45);
  for (const [from, to] of [['害羞', '生气'], ['满足', '害怕'], ['生气', '害羞']]) {
    assert.equal(defaultEmotionEdge(emotion(from), emotion(to)).jump, false);
  }
});

test('persona mood settings serialize minimally without replacing other metadata', () => {
  const form = emptyPersonaSections();
  form.metadata.energy = { aloneRecovery: 2 };
  const changed = withPersonaMoodSettings(form, { ...DEFAULT_PERSONA_MOOD, subMax: 3 });
  assert.deepEqual(changed.metadata.energy, { aloneRecovery: 2 });
  assert.deepEqual(changed.metadata.mood, { subMax: 3 });
  const reset = withPersonaMoodSettings(changed, DEFAULT_PERSONA_MOOD);
  assert.equal(reset.metadata.mood, undefined);
  assert.deepEqual(reset.metadata.energy, { aloneRecovery: 2 });
});

test('sub-emotion settings stay within their documented bounds', () => {
  assert.equal(updateMoodSubSetting(DEFAULT_PERSONA_MOOD, 'subMax', 4).subMax, 4);
  assert.equal(updateMoodSubSetting(DEFAULT_PERSONA_MOOD, 'subTh', 0.9).subTh, 0.9);
  assert.throws(() => updateMoodSubSetting(DEFAULT_PERSONA_MOOD, 'subMax', 5));
});

test('persona mood editor renders its five planned cards', async () => {
  const form = emptyPersonaSections();
  form.metadata.mood = DEFAULT_PERSONA_MOOD;
  const vite = await createServer({
    configFile: fileURLToPath(new URL('../panel/vite.config.ts', import.meta.url)),
    server: { middlewareMode: true },
    logLevel: 'silent',
  });
  try {
    const { PersonaParametersPanel } = await vite.ssrLoadModule('/src/pages/PersonaParametersPanel.tsx') as {
      PersonaParametersPanel: (props: {
        parameterTab: 'mood';
        onParameterTabChange: (tab: 'mood') => void;
        form: typeof form;
        onChange: (next: typeof form) => void;
        personaId: string;
        previewAccountId: number | null;
        disabled: boolean;
        active: boolean;
      }) => ReactElement;
    };
    const html = renderToStaticMarkup(createElement(PersonaParametersPanel, {
      parameterTab: 'mood',
      onParameterTabChange: () => undefined,
      form,
      onChange: () => undefined,
      personaId: 'default',
      previewAccountId: null,
      disabled: false,
      active: true,
    }));
    const moodStyles = readFileSync(fileURLToPath(new URL('../panel/src/styles/persona-mood.css', import.meta.url)), 'utf8');
    for (const title of ['我的情绪', '切换难度', '全部切换一览', '主情绪与副情绪', '其他']) {
      assert.ok(html.includes(title), `缺少卡片标题：${title}`);
    }
    const matrixCellBodies = [...html.matchAll(/<button class="persona-mood-matrix-cell[^"]*"[^>]*>(.*?)<\/button>/gu)]
      .map((match) => match[1] ?? '');
    assert.equal(matrixCellBodies.length, DEFAULT_PERSONA_MOOD.emotions.length * (DEFAULT_PERSONA_MOOD.emotions.length - 1));
    assert.ok(matrixCellBodies.every((body) => !/\d/u.test(body.replace(/<i[^>]*><\/i>/gu, ''))), '矩阵格子不直接显示数字');
    assert.match(moodStyles, /\.persona-mood-matrix-cell\s*\{[^}]*width:\s*26px/su);
    assert.match(moodStyles, /\.persona-mood-matrix\s*\{[^}]*width:\s*max-content/su);
    assert.match(moodStyles, /\.persona-mood-matrix-scroll\s*\{[^}]*overflow-x:\s*auto[^}]*overflow-y:\s*hidden/su);
    assert.match(moodStyles, /\.persona-mood-matrix thead th:not\(:first-child\)[^{]*\{[^}]*writing-mode:\s*vertical-rl/su);
    assert.match(moodStyles, /\.persona-mood-matrix th\.is-hovered/u);
    assert.match(moodStyles, /\.persona-mood-matrix td\s*\{[^}]*height:\s*26px/su);
    assert.match(moodStyles, /persona-mood-edge-hit\s*\{[^}]*stroke-width:\s*12/su);
    assert.match(html, /易/u);
    assert.match(html, /难/u);
    assert.match(PERSONA_MOOD_PREVIEW_ERRORS.account, /不影响人设配置的编辑和保存/u);
    assert.equal(html.match(/<g class="persona-mood-edge/g)?.length ?? 0, 0);
    assert.match(html, /先点一个情绪/u);

    const { PersonaMoodGraph } = await vite.ssrLoadModule('/src/pages/PersonaMoodGraph.tsx') as {
      PersonaMoodGraph: (props: {
        settings: typeof DEFAULT_PERSONA_MOOD;
        selectedFrom: string;
        selectedTo: string;
        onSelectPoint: (name: string) => void;
        onSelectTo: (name: string) => void;
        onCoordinatesChange: (name: string, valence: number, arousal: number) => void;
        disabled: boolean;
      }) => ReactElement;
    };
    const graph = renderToStaticMarkup(createElement(PersonaMoodGraph, {
      settings: DEFAULT_PERSONA_MOOD,
      selectedFrom: '兴奋',
      selectedTo: '开心',
      onSelectPoint: () => undefined,
      onSelectTo: () => undefined,
      onCoordinatesChange: () => undefined,
      disabled: false,
    }));
    assert.equal(graph.match(/<g class="persona-mood-edge/g)?.length, 15);
    assert.equal(graph.match(/<button class="persona-mood-edge-chip/g)?.length, 15);
    assert.match(graph, /markerWidth="6" markerHeight="6"[^>]*markerUnits="userSpaceOnUse"/u);
    assert.match(graph, /class="persona-mood-edge is-selected/u);
    assert.deepEqual(
      [...graph.matchAll(/<span>→ ([^<]+)<\/span>/gu)].map((match) => match[1]),
      moodOutgoingTargets(DEFAULT_PERSONA_MOOD, '兴奋'),
    );
    assert.match(graph, /愉快 →/u);
    assert.doesNotMatch(graph, /愉悦 V/u);
  } finally {
    await vite.close();
  }
});

test('mood graph selection, hit testing, label placement, and outgoing chips are deterministic', () => {
  const selectedFrom = selectMoodSource({ from: null, to: null }, '平静', DEFAULT_PERSONA_MOOD.emotions);
  assert.deepEqual(selectedFrom, { from: '平静', to: null });
  const selectedEdge = selectMoodSource(selectedFrom, '开心', DEFAULT_PERSONA_MOOD.emotions);
  assert.deepEqual(selectedEdge, { from: '平静', to: '开心' });
  assert.deepEqual(selectMoodSource(selectedEdge, '平静', DEFAULT_PERSONA_MOOD.emotions), { from: null, to: null });
  assert.deepEqual(selectMoodEdge({ from: '平静', to: '开心' }, '害羞', '生气', DEFAULT_PERSONA_MOOD.emotions), {
    from: '害羞',
    to: '生气',
  });
  assert.deepEqual(selectMoodEdge({ from: '兴奋', to: null }, '兴奋', '开心', DEFAULT_PERSONA_MOOD.emotions), {
    from: '兴奋',
    to: '开心',
  });
  const outgoing = moodOutgoingTargets(DEFAULT_PERSONA_MOOD, '平静');
  assert.equal(outgoing.length, 15);
  const margins = outgoing.map((name) => resolveMoodEdge(DEFAULT_PERSONA_MOOD, '平静', name).margin);
  assert.deepEqual(margins, [...margins].sort((left, right) => left - right));

  assert.equal(nearestMoodPoint([
    { name: '较远', x: 10, y: 0 },
    { name: '最近', x: 3, y: 0 },
    { name: '圈外', x: 16, y: 0 },
  ], 0, 0), '最近');
  assert.equal(isMoodDragStarted(0, 0, 4, 0), false);
  assert.equal(isMoodDragStarted(0, 0, 4.01, 0), true);
  const labels = placeMoodEmotionLabels([
    { name: '被挡', x: 100, y: 100 },
    { name: '挡点', x: 118, y: 100 },
    { name: '远点', x: 300, y: 300 },
  ]);
  assert.equal(labels.find(({ name }) => name === '被挡')?.direction, 'left');
  assert.deepEqual(labels.map(({ direction }) => direction).filter((direction) => !['right', 'left', 'up', 'down'].includes(direction)), []);
  const layoutOfCenter = (...blockers: Array<{ name: string; x: number; y: number }>) => placeMoodEmotionLabels([
    { name: '中心', x: 100, y: 100 },
    ...blockers,
  ])[0]?.direction;
  assert.equal(layoutOfCenter(), 'right');
  assert.equal(layoutOfCenter({ name: '右侧', x: 118, y: 100 }), 'left');
  assert.equal(layoutOfCenter(
    { name: '右侧', x: 122, y: 100 },
    { name: '左侧', x: 78, y: 100 },
    { name: '下方', x: 100, y: 118 },
  ), 'up');
  assert.equal(layoutOfCenter(
    { name: '右侧', x: 122, y: 100 },
    { name: '左侧', x: 78, y: 100 },
    { name: '上方', x: 100, y: 82 },
  ), 'down');
  const hovered = { from: '平静', to: '开心' };
  assert.equal(isMoodMatrixHeaderHovered('row', '平静', hovered), true);
  assert.equal(isMoodMatrixHeaderHovered('column', '开心', hovered), true);
  assert.equal(isMoodMatrixHeaderHovered('row', '开心', hovered), false);
  assert.equal(moodMarginColorPercent(0), 10);
  assert.equal(moodMarginColorPercent(0.15), 42.5);
  assert.equal(moodMarginColorPercent(0.3), 75);
  assert.equal(moodMarginColorPercent(0.5), 75);
});
