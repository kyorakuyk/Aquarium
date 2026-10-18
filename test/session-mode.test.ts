import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addModeScheduleEntry,
  changeModeScheduleDraft,
  createModeScheduleEntryChangeFromInput,
  discardModeScheduleDraft,
  getModeScheduleDraft,
  getModeScheduleRowKeys,
  MODE_SCHEDULE_DRAFTS_STORAGE_KEY,
  readModeScheduleDrafts,
  removeModeScheduleEntry,
  saveModeScheduleDraft,
  SESSION_MODE_OPTIONS,
  updateModeScheduleEntry,
  writeModeScheduleDrafts,
} from '../panel/src/session-mode.ts';
import type { ModeScheduleEntry } from '../panel/src/api.ts';

const morning: ModeScheduleEntry = { from: '08:30', to: '12:00', mode: 'active' };
const afternoon: ModeScheduleEntry = { from: '12:00', to: '18:00', mode: 'busy' };

function createMemoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { values.set(key, value); },
    removeItem(key: string) { values.delete(key); },
  };
}

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

test('schedule input change captures currentTarget before a deferred updater runs', () => {
  let currentTarget: { value: string } | null = { value: '09:45' };
  const event = {
    get currentTarget() {
      if (!currentTarget) throw new Error('currentTarget was read after event dispatch');
      return currentTarget;
    },
  };
  const change = createModeScheduleEntryChangeFromInput(event, 0, 'from');
  currentTarget = null;
  assert.deepEqual(change([morning]), [{ ...morning, from: '09:45' }]);
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

test('schedule draft is cleared after PATCH even when refreshing sessions fails', async () => {
  const calls: string[] = [];

  await assert.rejects(saveModeScheduleDraft(
    async () => { calls.push('patch'); },
    () => { calls.push('discard'); },
    async () => {
      calls.push('refresh');
      throw new Error('refresh failed');
    },
  ), /refresh failed/);
  assert.deepEqual(calls, ['patch', 'discard', 'refresh']);
});

test('schedule draft remains when PATCH fails', async () => {
  const calls: string[] = [];

  await assert.rejects(saveModeScheduleDraft(
    async () => {
      calls.push('patch');
      throw new Error('patch failed');
    },
    () => { calls.push('discard'); },
    async () => { calls.push('refresh'); },
  ), /patch failed/);
  assert.deepEqual(calls, ['patch']);
});

test('schedule row keys remain stable when editable values change', () => {
  const sessionId = 'group:123';
  const entries = [morning, { ...morning }];
  const rowKeys = getModeScheduleRowKeys(new Map(), sessionId, entries);
  const editedEntries = updateModeScheduleEntry(entries, 0, { from: '09:00', to: '13:00' });

  assert.equal(new Set(rowKeys).size, entries.length);
  assert.deepEqual(getModeScheduleRowKeys(new Map([[sessionId, rowKeys]]), sessionId, editedEntries), rowKeys);
});

test('unsaved schedule drafts survive refresh through session storage', () => {
  const storage = createMemoryStorage();
  const sessionId = 'group:123';
  const drafts = changeModeScheduleDraft(new Map(), sessionId, [morning], (entries) =>
    updateModeScheduleEntry(addModeScheduleEntry(entries), 1, { from: '' }));

  assert.equal(writeModeScheduleDrafts(storage, drafts), true);
  const restored = readModeScheduleDrafts(storage);

  assert.equal(storage.values.has(MODE_SCHEDULE_DRAFTS_STORAGE_KEY), true);
  assert.deepEqual(getModeScheduleDraft(restored, sessionId, [morning]), [
    morning,
    { from: '', to: '17:00', mode: 'natural' },
  ]);
});

test('reading invalid saved drafts ignores only invalid session entries', () => {
  const storage = createMemoryStorage();
  storage.setItem(MODE_SCHEDULE_DRAFTS_STORAGE_KEY, JSON.stringify({
    'group:123': [morning],
    'group:bad': [{ from: 900, to: '17:00', mode: 'natural' }],
    'group:bad-format': [{ from: '9:00', to: '17:00', mode: 'natural' }],
    'group:out-of-range': [{ from: '24:00', to: '17:00', mode: 'natural' }],
    'group:extra-field': [{ from: '09:00', to: '17:00', mode: 'natural', extra: true }],
    'group:in-progress': [{ from: '', to: '17:00', mode: 'natural' }],
  }));

  assert.deepEqual([...readModeScheduleDrafts(storage)], [
    ['group:123', [morning]],
    ['group:in-progress', [{ from: '', to: '17:00', mode: 'natural' }]],
  ]);
});

test('clearing schedule drafts removes the refresh snapshot', () => {
  const storage = createMemoryStorage();
  const drafts = new Map([['group:123', [morning] as const]]);

  assert.equal(writeModeScheduleDrafts(storage, drafts), true);
  assert.equal(writeModeScheduleDrafts(storage, new Map()), true);
  assert.equal(storage.values.has(MODE_SCHEDULE_DRAFTS_STORAGE_KEY), false);
  assert.equal(readModeScheduleDrafts(storage).size, 0);
});
