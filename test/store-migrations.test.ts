import assert from 'node:assert/strict';
import test from 'node:test';
import { migrations } from '../src/store/migrations/index.ts';

test('migration versions start at one and are continuous and unique', () => {
  const versions = migrations.map(({ version }) => version);
  assert.deepEqual(versions, Array.from({ length: 16 }, (_, index) => index + 1));
  assert.equal(new Set(versions).size, versions.length);
  assert.ok(migrations.every(({ up }) => typeof up === 'function'));
});
