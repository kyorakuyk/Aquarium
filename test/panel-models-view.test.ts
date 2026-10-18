import assert from 'node:assert/strict';
import test from 'node:test';
import { reasoningFieldOptions } from '../panel/src/models-view.ts';

test('provider edit preserves an existing custom reasoning field as a selectable value', () => {
  assert.deepEqual(reasoningFieldOptions('effort'), [
    { value: 'reasoning_effort', label: '支持（reasoning_effort）' },
    { value: 'none', label: '不支持' },
    { value: 'effort', label: '自定义（effort）' },
  ]);
  assert.equal(reasoningFieldOptions('effort').some((option) => option.value === 'effort'), true);
});
