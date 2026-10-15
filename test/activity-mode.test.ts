import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveMode } from '../src/core/activity/mode.ts';

function at(hour: number, minute: number): number {
  return new Date(2026, 9, 15, hour, minute).getTime();
}

test('resolveMode selects the first matching local-time schedule entry', () => {
  const settings = {
    mode: 'natural' as const,
    modeSchedule: [
      { from: '09:00', to: '12:00', mode: 'active' as const },
      { from: '10:00', to: '13:00', mode: 'busy' as const },
    ],
  };

  assert.equal(resolveMode(settings, at(9, 0)), 'active');
  assert.equal(resolveMode(settings, at(11, 30)), 'active');
  assert.equal(resolveMode(settings, at(12, 0)), 'busy');
});

test('resolveMode supports schedules that cross midnight', () => {
  const settings = {
    mode: 'mention_only' as const,
    modeSchedule: [{ from: '23:00', to: '07:00', mode: 'busy' as const }],
  };

  assert.equal(resolveMode(settings, at(23, 0)), 'busy');
  assert.equal(resolveMode(settings, at(0, 30)), 'busy');
  assert.equal(resolveMode(settings, at(6, 59)), 'busy');
  assert.equal(resolveMode(settings, at(7, 0)), 'mention_only');
});

test('resolveMode falls back to the configured mode when no schedule matches', () => {
  const settings = {
    mode: 'natural' as const,
    modeSchedule: [{ from: '09:00', to: '12:00', mode: 'active' as const }],
  };

  assert.equal(resolveMode(settings, at(8, 59)), 'natural');
  assert.equal(resolveMode({ mode: 'active' }, at(12, 0)), 'active');
});
