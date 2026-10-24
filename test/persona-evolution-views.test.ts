import assert from 'node:assert/strict';
import test from 'node:test';
import { PERSONA_EVOLUTION_VIEW_OPTIONS } from '../panel/src/persona-evolution-views.ts';

test('persona evolution lists only currently supported views', () => {
  assert.deepEqual(PERSONA_EVOLUTION_VIEW_OPTIONS, [
    { key: 'increment', label: '增量' },
    { key: 'trajectory', label: '轨迹' },
    { key: 'radar', label: '雷达' },
  ]);
});
