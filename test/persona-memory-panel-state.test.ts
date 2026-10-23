import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryForAccount } from '../panel/src/components/persona-memory-state.ts';

test('persona memory panels expose records only for the currently selected account', () => {
  const memory = { account: 7101, memos: [], diaries: [] };
  assert.strictEqual(memoryForAccount(memory, 7101), memory);
  assert.equal(memoryForAccount(memory, 7102), undefined);
  assert.equal(memoryForAccount(memory, undefined), undefined);
});
