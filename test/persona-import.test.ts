import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createElement } from 'react';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fileURLToPath } from 'node:url';
import type { SlotCallOptions } from '../src/llm/slots.ts';
import { createServer } from 'vite';
import { authHeaders, withPanel } from './panel-test-helpers.ts';

// 从 personas/input/安达樱.md 摘录关键原句，保留原有分类特征。
const adachiSourceFixture = [
  'Name: 安达樱 (安達 桜 / Adachi Sakura)',
  '  - 极度动摇、害羞或被岛村触碰时，整张脸会瞬间爆红到耳根与脖颈，甚至像烧开水一样冒热气。',
  '- 平时面对外人冷漠寡言、生人勿近；在岛村面前笨拙拘谨、结结巴巴；',
  '  - 面对他人：冷淡、简短、礼貌而疏离。',
  '  - 面对岛村：语句经常停顿、犹豫（“那个……岛村……”、“我、我不是那个意思……”），被戳中心事时会声调变高、语速加快；',
  '  - 紧张时低头玩手指、拉扯衣角、把碎发挽到耳后；',
  '  - 视线频繁偷瞄岛村的侧脸、嘴唇或手指，偷瞄被发现会慌乱地别开视线。',
].join('\n');

const emptyFields = {
  身份: [], 年龄: [], 背景: [], 说话方式: [], 口头禅: [], 常用表情: [], 对熟人: [], 对陌生人: [], 对主人: [], 底线: [],
};
const neutralTraits = {
  order: { value: 0, src: '' }, morality: { value: 0, src: '' }, talk: { value: 0, src: '' },
  mind: { value: 0, src: '' }, humor: { value: 0, src: '' }, openness: { value: 0, src: '' }, imitation: { value: 0, src: '' },
};

const flawedExtraction = {
  fields: {
    ...emptyFields,
    身份: [{ text: '安达樱', src: '不存在的校验文本' }],
    说话方式: [{ text: '冷淡、简短、礼貌而疏离', src: '面对他人：冷淡、简短、礼貌而疏离' }],
    常用表情: [{ text: '整张脸会瞬间爆红到耳根与脖颈', src: '整张脸会瞬间爆红到耳根与脖颈' }],
    对陌生人: [{ text: '冷淡、简短、礼貌而疏离', src: '面对他人：冷淡、简短、礼貌而疏离' }],
  },
  traits: neutralTraits,
  other: [{ heading: '动作', text: '紧张时低头玩手指、拉扯衣角。', src: '紧张时低头玩手指、拉扯衣角' }],
};

const correctedExtraction = {
  fields: {
    ...emptyFields,
    身份: [{ text: '安达樱', src: '安达樱' }],
    说话方式: [{ text: '面对岛村时说话会停顿、犹豫。', src: '语句经常停顿、犹豫' }],
    对陌生人: [
      { text: '面对外人冷漠寡言、生人勿近。', src: '面对外人冷漠寡言、生人勿近' },
      { text: '冷淡、简短、礼貌而疏离。', src: '面对他人：冷淡、简短、礼貌而疏离' },
    ],
    对主人: [{ text: '在岛村面前笨拙拘谨、结结巴巴。', src: '在岛村面前笨拙拘谨、结结巴巴' }],
  },
  traits: neutralTraits,
  other: [
    { heading: '神态与小动作', text: '害羞或被触碰时会脸红到耳根与脖颈。', src: '整张脸会瞬间爆红到耳根与脖颈' },
    { heading: '神态与小动作', text: '紧张时会低头玩手指、拉扯衣角。', src: '紧张时低头玩手指、拉扯衣角' },
    { heading: '神态与小动作', text: '频繁偷瞄岛村的侧脸、嘴唇或手指，被发现会慌乱地别开视线。', src: '视线频繁偷瞄岛村的侧脸、嘴唇或手指' },
  ],
};
const partiallyRepairedExtraction = {
  ...correctedExtraction,
  fields: {
    ...correctedExtraction.fields,
    常用表情: [{ text: '整张脸会瞬间爆红到耳根与脖颈', src: '整张脸会瞬间爆红到耳根与脖颈' }],
  },
};

test('persona import source-checks the Adachi fixture and completes two repair rounds', async () => {
  const calls: Array<{ slot: string; options: SlotCallOptions; messages: string; taskCostAtCall: number | undefined }> = [];
  let callCount = 0;

  await withPanel(async ({ app }) => {
    const response = await app.request('/api/personas/import', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: '安达樱.md', text: adachiSourceFixture }),
    });
    assert.equal(response.status, 200);
    const result = await response.json() as {
      draft: string;
      mappedCount: number;
      otherCount: number;
      repairCount: number;
      fixedCount: number;
      warnings: Array<{ code: string; field?: string; message: string; excerpt?: string }>;
    };
    assert.equal(result.repairCount, 2);
    assert.ok(result.fixedCount > 0);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.otherCount, 3);
    assert.ok(!result.draft.includes('src:'), 'source citations must be stripped before draft construction');

    const listResponse = await app.request('/api/personas', { headers: authHeaders() });
    assert.deepEqual((await listResponse.json() as Array<{ id: string }>).map(({ id }) => id), ['default']);
  }, undefined, {
    callModel: async (slot, messages, options) => {
      callCount += 1;
      calls.push({ slot, options, messages: JSON.stringify(messages), taskCostAtCall: options.oneoffTaskCostCny?.() });
      if (callCount === 1) {
        options.recordUsage({
          time: 1,
          account: null,
          slot: 'oneoff',
          provider: 'fake',
          model: 'fake-model',
          inputTokens: 1,
          cachedTokens: 0,
          outputTokens: 1,
          costCny: 0.01,
          latencyMs: 0,
          ok: true,
        });
      }
      const result = callCount === 1 ? flawedExtraction
        : callCount === 2 ? partiallyRepairedExtraction
          : correctedExtraction;
      return {
        text: JSON.stringify(result),
        provider: 'fake',
        model: 'fake-model',
        usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
      };
    },
  });

  assert.equal(callCount, 3);
  assert.equal(calls[0]?.slot, 'oneoff');
  assert.equal(calls[0]?.options.budgetScope, 'oneoff');
  assert.equal(calls[0]?.taskCostAtCall, 0);
  assert.equal(calls[1]?.taskCostAtCall, 0.01);
  assert.ok(calls[1]?.messages.includes('wrong_expression_field'));
  assert.ok(calls[1]?.messages.includes('cross_field_duplicate'));
  assert.ok(calls[1]?.messages.includes('source_not_found'));
  assert.ok(calls[1]?.messages.includes('invalid_other_heading'));
  assert.ok(calls[2]?.messages.includes('wrong_expression_field'));
});

test('persona import preserves a draft when the oneoff cap stops repair and shows yellow warnings', async () => {
  let callCount = 0;
  let warnings: Array<{ code: string; field?: string; message: string; excerpt?: string }> = [];

  await withPanel(async ({ app }) => {
    const response = await app.request('/api/personas/import', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: '安达樱.md', text: adachiSourceFixture }),
    });
    assert.equal(response.status, 200);
    const result = await response.json() as {
      draft: string;
      repairCount: number;
      warnings: typeof warnings;
    };
    assert.ok(result.draft.length > 0, 'the last valid response remains available as a draft');
    assert.equal(result.repairCount, 0);
    assert.ok(result.warnings.some((warning) => warning.code === 'wrong_expression_field'));
    assert.ok(result.warnings.some((warning) => warning.code === 'budget_exceeded'));
    warnings = result.warnings;
  }, undefined, {
    callModel: async (_slot, _messages, options) => {
      callCount += 1;
      if (callCount === 2) {
        throw Object.assign(new Error('budget cap'), { name: 'BudgetExceededError', code: 'BUDGET_EXCEEDED' });
      }
      options.recordUsage({
        time: 1,
        account: null,
        slot: 'oneoff',
        provider: 'fake',
        model: 'fake-model',
        inputTokens: 1,
        cachedTokens: 0,
        outputTokens: 1,
        costCny: 3,
        latencyMs: 0,
        ok: true,
      });
      return {
        text: JSON.stringify(flawedExtraction),
        provider: 'fake',
        model: 'fake-model',
        usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
      };
    },
  });
  assert.equal(callCount, 2, 'the endpoint stops after the oneoff task budget is exhausted');

  const personaPage = readFileSync(new URL('../panel/src/pages/PersonasPage.tsx', import.meta.url), 'utf8');
  assert.match(personaPage, /<PersonaImportBanner/u, 'the actual persona page mounts the warning component');
  assert.match(personaPage, /const personaLibraryBusy = busy \|\| Boolean\(importDraft && selectedId\)/u,
    'persona selection stays locked to the import target while a draft is open');
  const vite = await createServer({
    configFile: fileURLToPath(new URL('../panel/vite.config.ts', import.meta.url)),
    server: { middlewareMode: true },
    logLevel: 'silent',
  });
  try {
    const { PersonaImportBanner } = await vite.ssrLoadModule('/src/pages/PersonaImportBanner.tsx') as {
      PersonaImportBanner: (props: {
        filename: string;
        mappedCount: number;
        otherCount: number;
        repairCount: number;
        fixedCount: number;
        warnings: typeof warnings;
        busy: boolean;
        canAccept: boolean;
        onCompare: () => void;
        onDiscard: () => void;
        onAccept: () => void;
      }) => ReactElement;
    };
    const html = renderToStaticMarkup(createElement(PersonaImportBanner, {
      filename: '安达樱.md',
      mappedCount: 4,
      otherCount: 0,
      repairCount: 0,
      fixedCount: 0,
      warnings,
      busy: false,
      canAccept: true,
      onCompare: () => undefined,
      onDiscard: () => undefined,
      onAccept: () => undefined,
    }));
    assert.match(html, /已尝试修复 0 轮/u);
    assert.match(html, /剩余警告 \d+ 条/u);
    assert.match(html, /notice notice-warn persona-import-warning/u);
    assert.match(html, /<mark class="persona-import-warning-mark">/u);
    assert.match(html, /常用表情/u);
    const personaStyles = readFileSync(new URL('../panel/src/styles/personas.css', import.meta.url), 'utf8');
    assert.match(personaStyles, /\.persona-import-warning-mark\s*\{[^}]*background:\s*var\(--warn-soft\)/u);
  } finally {
    await vite.close();
  }
});
