import assert from 'node:assert/strict';
import test from 'node:test';
import { readSessionDisclosure, sessionDisclosureKey, writeSessionDisclosure } from '../panel/src/session-disclosure.ts';

function memoryStorage() {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem(key: string) { return entries.get(key) ?? null; },
    setItem(key: string, value: string) { entries.set(key, value); },
  };
}

test('session disclosure state is saved per session and preserves sibling sections', () => {
  const storage = memoryStorage();
  assert.equal(readSessionDisclosure(storage, 'group:1', 'schedule'), false);
  assert.equal(writeSessionDisclosure(storage, 'group:1', 'schedule', true), true);
  assert.equal(writeSessionDisclosure(storage, 'group:1', 'note', true), true);
  assert.equal(readSessionDisclosure(storage, 'group:1', 'schedule'), true);
  assert.equal(readSessionDisclosure(storage, 'group:1', 'note'), true);
  assert.equal(readSessionDisclosure(storage, 'group:1', 'rhythm'), false);
  assert.equal(readSessionDisclosure(storage, 'group:2', 'schedule'), false);
});

test('session disclosure safely ignores malformed data and storage failures', () => {
  const storage = memoryStorage();
  storage.entries.set(sessionDisclosureKey('group:1'), '{bad json');
  assert.equal(readSessionDisclosure(storage, 'group:1', 'schedule'), false);

  const failingStorage = {
    getItem() { throw new Error('storage denied'); },
    setItem() { throw new Error('storage denied'); },
  };
  assert.equal(readSessionDisclosure(failingStorage, 'group:1', 'schedule'), false);
  assert.equal(writeSessionDisclosure(failingStorage, 'group:1', 'schedule', true), false);
});
