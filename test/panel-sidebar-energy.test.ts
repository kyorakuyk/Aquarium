import assert from 'node:assert/strict';
import test from 'node:test';
import { sidebarEnergyLabel } from '../panel/src/sidebar-energy.ts';

test('sidebar energy label follows sleep-enabled thresholds', () => {
  assert.equal(sidebarEnergyLabel(false, null), '在线');
  assert.equal(sidebarEnergyLabel(true, 0.6), '精神不错');
  assert.equal(sidebarEnergyLabel(true, 0.35), '有点累');
  assert.equal(sidebarEnergyLabel(true, 0.349), '有点困');
  assert.equal(sidebarEnergyLabel(true, null), '有点困');
});
