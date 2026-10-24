import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as modelsView from '../panel/src/models-view.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const inlineSlotRow = read('../panel/src/pages/InlineSlotRow.tsx');
const modelDialogs = read('../panel/src/pages/ModelDialogs.tsx');
const modelsPage = read('../panel/src/pages/ModelsPage.tsx');
const modelsCss = read('../panel/src/styles/models.css');

test('model page replaces the sample URL and states the vision input requirement', () => {
  const provider = {
    id: 'mimo',
    kind: 'api' as const,
    label: 'Mimo',
    keyStatus: { set: false, last4: '' },
    baseUrl: '<待用户填写>',
  };
  assert.equal(modelsView.providerMeta(provider), '尚未填写 API 地址');
  const baseUrlInputValue = Reflect.get(modelsView, 'providerBaseUrlInputValue') as
    ((value: string | undefined) => string) | undefined;
  const baseUrlNeedsInput = Reflect.get(modelsView, 'providerBaseUrlNeedsInput') as
    ((value: string | undefined) => boolean) | undefined;
  assert.equal(baseUrlInputValue?.('<待用户填写>'), '');
  assert.equal(baseUrlNeedsInput?.('<待用户填写>'), true);
  const visionSlot = modelsView.MODEL_SLOT_DEFS.find((item) => item.slot === 'vision');
  const requirement = Reflect.get(visionSlot ?? {}, 'requirement');
  assert.match(typeof requirement === 'string' ? requirement : '', /支持图片输入/u);
});

test('model chain editing has one entry point and unknown markers have breathing room', () => {
  assert.match(inlineSlotRow, /slot-chain-edit[^>]*>[^<]*<span[^>]*>✎<\/span>调整/u);
  assert.doesNotMatch(inlineSlotRow, /slot-inline-edit/u);
  assert.doesNotMatch(modelsPage, /<th>操作<\/th>/u);
  assert.match(inlineSlotRow, /definition\.requirement/u);
  assert.match(modelDialogs, /definition\.requirement/u);
  assert.match(modelDialogs, /providerBaseUrlInputValue\(baseUrl\)/u);
  assert.match(modelDialogs, /providerBaseUrlNeedsInput\(baseUrl\)/u);
  assert.match(modelsCss, /\.param-unknown-marker\s*\{[^}]*margin-left:\s*4px/su);
});
