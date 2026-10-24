import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as stickerRatioCopy from '../panel/src/sticker-settings-copy.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const settingsCard = read('../panel/src/components/StickerSettingsCard.tsx');
const stickersCss = read('../panel/src/styles/stickers.css');

test('sticker ratio settings show percentages and describe the two-hour caps accurately', () => {
  const ratioToPercent = Reflect.get(stickerRatioCopy, 'ratioToPercent') as ((value: number) => number) | undefined;
  const percentToRatio = Reflect.get(stickerRatioCopy, 'percentToRatio') as ((value: number) => number) | undefined;
  const copy = Reflect.get(stickerRatioCopy, 'stickerRatioCopy') as
    Record<string, { label: string; description: string }> | undefined;

  assert.equal(ratioToPercent?.(0.3), 30);
  assert.equal(ratioToPercent?.(0.1), 10);
  assert.equal(percentToRatio?.(30), 0.3);
  assert.equal(percentToRatio?.(10), 0.1);
  assert.equal(copy?.maxRatio?.label, '带表情回复占比上限');
  assert.equal(copy?.onlyStickerRatio?.label, '纯表情回复占比上限');
  assert.match(copy?.maxRatio?.description ?? '', /过去 2 小时内/u);
  assert.match(copy?.onlyStickerRatio?.description ?? '', /纯表情回复占比/u);
});

test('sticker settings convert percent input back to the stored ratio', () => {
  assert.match(settingsCard, /ratioToPercent\(draft\[field\.key\]\)/u);
  assert.match(settingsCard, /percentToRatio\(inputValue\)/u);
  assert.match(settingsCard, /field\.description && <small/u);
  assert.match(settingsCard, /stickers-settings-unit/u);
  assert.match(stickersCss, /\.stickers-settings-unit/u);
});
