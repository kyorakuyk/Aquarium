import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addModeScheduleEntry,
  changeModeScheduleDraft,
  discardModeScheduleDraft,
  getModeScheduleDraft,
  getModeScheduleRowKeys,
  removeModeScheduleEntry,
  SESSION_MODE_OPTIONS,
  updateModeScheduleEntry,
} from '../panel/src/session-mode.ts';
import type { ModeScheduleEntry } from '../panel/src/api.ts';

const morning: ModeScheduleEntry = { from: '08:30', to: '12:00', mode: 'active' };
const afternoon: ModeScheduleEntry = { from: '12:00', to: '18:00', mode: 'busy' };

test('all four session modes are available without an M2-disabled option', () => {
  assert.deepEqual(SESSION_MODE_OPTIONS.map(({ mode }) => mode), ['mention_only', 'natural', 'active', 'busy']);
  assert.ok(SESSION_MODE_OPTIONS.every((option) => !Object.hasOwn(option, 'disabled')));
  assert.ok(SESSION_MODE_OPTIONS.every(({ note }) => !note.includes('M2')));
});

test('adding a schedule row appends a default row without mutating existing rows', () => {
  const original = [morning];
  const result = addModeScheduleEntry(original);

  assert.deepEqual(result, [morning, { from: '09:00', to: '17:00', mode: 'natural' }]);
  assert.deepEqual(original, [morning]);
});

test('editing a schedule row changes only the requested row', () => {
  const original = [morning, afternoon];
  const result = updateModeScheduleEntry(original, 1, { to: '19:30', mode: 'natural' });

  assert.deepEqual(result, [morning, { from: '12:00', to: '19:30', mode: 'natural' }]);
  assert.deepEqual(original, [morning, afternoon]);
});

test('removing a schedule row preserves remaining order without mutating the input', () => {
  const original = [morning, afternoon];
  const result = removeModeScheduleEntry(original, 0);

  assert.deepEqual(result, [afternoon]);
  assert.deepEqual(original, [morning, afternoon]);
});

test('an unsaved schedule draft survives a session reload after an unrelated setting update', () => {
  const sessionId = 'group:123';
  const drafts = changeModeScheduleDraft(new Map(), sessionId, [morning], (entries) =>
    updateModeScheduleEntry(entries, 0, { to: '13:00' }));
  const reloadedEffectiveSchedule = [{ ...morning }];

  assert.deepEqual(getModeScheduleDraft(drafts, sessionId, reloadedEffectiveSchedule), [
    { from: '08:30', to: '13:00', mode: 'active' },
  ]);
});

test('discarding a saved schedule draft shows the latest effective schedule', () => {
  const sessionId = 'group:123';
  const drafts = changeModeScheduleDraft(new Map(), sessionId, [morning], (entries) =>
    updateModeScheduleEntry(entries, 0, { to: '13:00' }));
  const savedSchedule = [{ from: '08:30', to: '13:00', mode: 'active' } satisfies ModeScheduleEntry];
  const nextDrafts = discardModeScheduleDraft(drafts, sessionId);

  assert.notEqual(nextDrafts, drafts);
  assert.deepEqual(getModeScheduleDraft(nextDrafts, sessionId, savedSchedule), savedSchedule);
});

test('schedule row keys remain stable when editable values change', () => {
  const sessionId = 'group:123';
  const entries = [morning, { ...morning }];
  const rowKeys = getModeScheduleRowKeys(new Map(), sessionId, entries);
  const editedEntries = updateModeScheduleEntry(entries, 0, { from: '09:00', to: '13:00' });

  assert.equal(new Set(rowKeys).size, entries.length);
  assert.deepEqual(getModeScheduleRowKeys(new Map([[sessionId, rowKeys]]), sessionId, editedEntries), rowKeys);
});
