import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../src/store/db.ts';
import { createRepository } from '../src/store/repository.ts';
import { createTagSubjectRepository } from '../src/store/tag-subject-repo.ts';
import { createTagClassificationRepository } from '../src/store/tag-classification-repo.ts';
import {
  buildClassifyTagsMessages,
  createTagClassificationService,
  parseClassifyTagsResponse,
} from '../src/core/impressions/classify-tags.ts';
import { promptTemplateStore } from '../src/core/prompt/templates.ts';
import { makeConfig } from './pipeline-test-helpers.ts';
import type { TagRecord } from '../src/store/tag-repo.ts';

const account = 7;
const key = '7:group:8';
const at = 1_800_000_000_000;

function insertTag(
  repository: ReturnType<typeof createRepository>,
  overrides: Partial<TagRecord> = {},
): number {
  const tag: TagRecord = {
    account,
    sessionId: key,
    userId: 42,
    text: '旧标签',
    norm: '旧标签',
    category: 'misc',
    subject: null,
    polarity: null,
    origin: 'inferred',
    locked: false,
    status: 'candidate',
    source: 'auto',
    samples: 1,
    evidence: [],
    firstSeen: at - 1_000,
    lastSeen: at - 1_000,
    supersededBy: null,
    updatedAt: at - 1_000,
    ...overrides,
  };
  return repository.insertTag(tag);
}

function responseFor(
  messages: Parameters<NonNullable<Parameters<typeof createTagClassificationService>[0]['callModel']>>[1],
  classify: (id: number, index: number) => Record<string, unknown>,
) {
  const userText = String(messages.find((message) => message.role === 'user')?.content ?? '');
  const batch = JSON.parse(userText.trim().split('\n').at(-1) ?? '[]') as Array<{ id: number; text: string }>;
  return {
    text: JSON.stringify({ items: batch.map(({ id, text }, index) => ({ id, text, ...classify(id, index) })) }),
    provider: 'fake',
    model: 'fake-model',
    usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
  };
}

function configWithBudget(dailyCny: number) {
  const config = makeConfig();
  return { ...config, budget: { ...config.budget, dailyCny, warnRatio: 0.8 } };
}

test('分类提示只携带未锁定 misc 标签，解析器拒绝 misc 和 schedule', () => {
  const locked = {
    id: 1,
    account,
    sessionId: key,
    userId: 42,
    text: '锁定文本不可发送',
    norm: '锁定文本不可发送',
    category: 'misc' as const,
    subject: null,
    polarity: null,
    origin: 'inferred' as const,
    locked: true,
    status: 'candidate' as const,
    source: 'auto' as const,
    samples: 1,
    evidence: [],
    firstSeen: at,
    lastSeen: at,
    supersededBy: null,
    updatedAt: at,
  };
  const visible = { ...locked, id: 2, text: '守望先锋', norm: '守望先锋', locked: false };
  const messages = buildClassifyTagsMessages([locked, visible], 'member', promptTemplateStore.get().classifyTags);
  const prompt = messages.map((message) => String(message.content)).join('\n');
  assert.ok(prompt.includes('守望先锋'));
  assert.ok(prompt.includes('"norm":"守望先锋"'));
  assert.ok(!prompt.includes('锁定文本不可发送'));

  assert.equal(parseClassifyTagsResponse(JSON.stringify({
    items: [{ id: 2, category: 'schedule', subject: null, polarity: null, mergeInto: null }],
  })), undefined);
  assert.equal(parseClassifyTagsResponse(JSON.stringify({
    items: [{ id: 2, category: 'misc', subject: null, polarity: null, mergeInto: null }],
  })), undefined);
});

test('分类用途的固定说明先于 scope 和标签数据', () => {
  const template = promptTemplateStore.get().classifyTags;
  const group = buildClassifyTagsMessages([], 'group', template);
  const member = buildClassifyTagsMessages([], 'member', template);
  const fixedPrefix = '以下是本批次最多 50 条待分类标签的 JSON：\nscope: ';

  assert.equal(group[0]?.content, member[0]?.content);
  assert.ok(String(group[1]?.content).startsWith(fixedPrefix));
  assert.ok(String(member[1]?.content).startsWith(fixedPrefix));
  assert.notEqual(group[1]?.content, member[1]?.content);
});

test('分类输入保留原标签类别，供口头禅迁移规则读取', () => {
  const speech = {
    id: 3,
    account,
    sessionId: key,
    userId: 42,
    text: '「要饭」',
    norm: '「要饭」',
    category: 'speech' as const,
    subject: null,
    polarity: null,
    origin: 'inferred' as const,
    locked: false,
    status: 'confirmed' as const,
    source: 'auto' as const,
    samples: 1,
    evidence: [{ messageId: 'speech-quote', time: at, quote: '我又说「要饭」了' }],
    firstSeen: at,
    lastSeen: at,
    supersededBy: null,
    updatedAt: at,
  };
  const messages = buildClassifyTagsMessages([speech], 'member', promptTemplateStore.get().classifyTags);

  assert.ok(String(messages[1]?.content).includes('"category":"speech"'));
  assert.ok(promptTemplateStore.get().classifyTags.system.includes('speech 且 text 被「」或“”包住'));
});

test('整理引号说话风格时迁移有证据的口头禅并丢弃无证据原话', async () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    const classifications = createTagClassificationRepository(database);
    const supportedId = insertTag(repository, {
      userId: 42,
      text: '「要饭」',
      norm: '「要饭」',
      category: 'speech',
      status: 'confirmed',
      evidence: [{ messageId: 'supported-quote', time: at, quote: '我又说「要饭」了' }],
    });
    const unsupportedId = insertTag(repository, {
      userId: 42,
      text: '“哈哈”',
      norm: '“哈哈”',
      category: 'speech',
      status: 'confirmed',
      evidence: [{ messageId: 'unsupported-quote', time: at, quote: '今天心情不错' }],
    });
    const supportedCurlyId = insertTag(repository, {
      userId: 42,
      text: '“开心”',
      norm: '“开心”',
      category: 'speech',
      status: 'confirmed',
      evidence: [{ messageId: 'supported-curly-quote', time: at, quote: '她说“开心”' }],
    });
    database.prepare('UPDATE tags SET needs_reclassification = 1 WHERE id IN (?, ?, ?)')
      .run(supportedId, unsupportedId, supportedCurlyId);
    let modelCalls = 0;
    const service = createTagClassificationService({
      repository,
      classificationRepository: classifications,
      getConfig: () => configWithBudget(1),
      getTemplate: () => promptTemplateStore.get().classifyTags,
      now: () => at,
      callModel: async (_slot, messages) => {
        modelCalls += 1;
        return responseFor(messages, (id) => ({
          id,
          category: 'speech',
          subject: null,
          polarity: null,
          mergeInto: null,
        }));
      },
    });

    assert.equal(service.startManual(), true);
    await service.idle();

    assert.equal(service.status().state, 'completed');
    assert.equal(modelCalls, 0);
    assert.equal(repository.tagById(supportedId)?.category, 'catchphrase');
    assert.equal(repository.tagById(supportedId)?.text, '要饭');
    assert.equal(repository.tagById(supportedCurlyId)?.category, 'catchphrase');
    assert.equal(repository.tagById(supportedCurlyId)?.text, '开心');
    assert.equal(repository.tagById(unsupportedId)?.status, 'rejected');
    const markers = database.prepare('SELECT needs_reclassification FROM tags ORDER BY id')
      .all() as Array<{ needs_reclassification: number }>;
    assert.deepEqual(markers.map(({ needs_reclassification }) => needs_reclassification), [0, 0, 0]);
  } finally {
    database.close();
  }
});

test('分类按 50 条分批、同义标签合并并持久化完成标记', async () => {
  const database = openDatabase(':memory:');
  try {
    const baseRepository = createRepository(database);
    const subjects = createTagSubjectRepository(database);
    const classificationRepository = createTagClassificationRepository(database);
    subjects.saveTagSubject({ account, category: 'fandom', name: '守望先锋', aliases: ['OW'] });
    const targetId = insertTag(baseRepository, {
      text: '守望先锋玩家', norm: '守望先锋玩家', category: 'misc', samples: 3,
      evidence: [{ messageId: 'target-evidence', time: at - 2_000, quote: '玩守望先锋' }],
    });
    const sourceId = insertTag(baseRepository, {
      text: '喜欢OW', norm: '喜欢ow', source: 'manual', origin: 'manual', status: 'confirmed', samples: 2,
      evidence: [{ messageId: 'source-evidence', time: at - 1_000, quote: '喜欢OW' }],
    });
    const config = configWithBudget(1);
    const service = createTagClassificationService({
      repository: baseRepository,
      classificationRepository,
      getConfig: () => config,
      getTemplate: () => promptTemplateStore.get().classifyTags,
      now: () => at,
      callModel: async (_slot, messages) => responseFor(messages, (id) => ({
        id,
        category: 'fandom',
        subject: 'OW',
        polarity: 'like',
        mergeInto: id === sourceId ? targetId : null,
      })),
    });

    assert.equal(service.startManual(), true);
    await service.idle();

    const target = baseRepository.tagById(targetId);
    const source = baseRepository.tagById(sourceId);
    assert.equal(service.status().state, 'completed');
    assert.equal(service.status().merged, 1);
    assert.equal(target?.category, 'fandom');
    assert.equal(target?.subject, '守望先锋');
    assert.equal(target?.samples, 5);
    assert.deepEqual(target?.evidence.map(({ messageId }) => messageId), ['target-evidence', 'source-evidence']);
    assert.equal(target?.source, 'manual');
    assert.equal(target?.status, 'confirmed');
    assert.equal(source?.status, 'superseded');
    assert.equal(source?.supersededBy, targetId);
    assert.equal(classificationRepository.isLegacyMiscClassificationComplete(), true);
  } finally {
    database.close();
  }
});

test('旧的 inferred identity 即使曾 confirmed，整理后也回到 candidate', async () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    const classifications = createTagClassificationRepository(database);
    const id = insertTag(repository, {
      text: 'INTJ', norm: 'intj', origin: 'inferred', source: 'auto', status: 'confirmed',
    });
    const service = createTagClassificationService({
      repository,
      classificationRepository: classifications,
      getConfig: () => configWithBudget(1),
      getTemplate: () => promptTemplateStore.get().classifyTags,
      now: () => at,
      callModel: async (_slot, messages) => responseFor(messages, (tagId) => ({
        id: tagId, category: 'identity', subject: null, polarity: null, mergeInto: null,
      })),
    });

    service.startManual();
    await service.idle();
    assert.equal(repository.tagById(id)?.category, 'identity');
    assert.equal(repository.tagById(id)?.status, 'candidate');
  } finally {
    database.close();
  }
});

test('预算超限后保留未完成状态，后续启动续跑且锁定 misc 标签跳过', async () => {
  const database = openDatabase(':memory:');
  try {
    const baseRepository = createRepository(database);
    const classificationRepository = createTagClassificationRepository(database);
    for (let index = 0; index < 51; index += 1) {
      insertTag(baseRepository, { text: `标签${index}`, norm: `标签${index}` });
    }
    insertTag(baseRepository, { text: '锁定misc', norm: '锁定misc', locked: true });
    const config = configWithBudget(1);
    let spent = false;
    const prompts: string[] = [];
    const getCost = () => (spent ? 2 : 0);
    const firstService = createTagClassificationService({
      repository: { ...baseRepository, costToday: getCost },
      classificationRepository,
      getConfig: () => config,
      getTemplate: () => promptTemplateStore.get().classifyTags,
      now: () => at,
      callModel: async (_slot, messages) => {
        prompts.push(messages.map((message) => String(message.content)).join('\n'));
        const result = responseFor(messages, (id) => ({
          id, category: 'personality', subject: null, polarity: null, mergeInto: null,
        }));
        spent = true;
        return result;
      },
    });

    assert.equal(firstService.startManual(), true);
    await firstService.idle();
    assert.equal(firstService.status().state, 'budget');
    assert.equal(classificationRepository.listUnlockedMiscTags().length, 1);
    assert.equal(classificationRepository.isLegacyMiscClassificationComplete(), false);
    assert.ok(prompts.every((prompt) => !prompt.includes('锁定misc')));

    const budgetErrors: unknown[] = [];
    const racingService = createTagClassificationService({
      repository: { ...baseRepository, costToday: () => 0 },
      classificationRepository,
      getConfig: () => config,
      getTemplate: () => promptTemplateStore.get().classifyTags,
      now: () => at,
      callModel: async () => { throw Object.assign(new Error('budget cap'), { name: 'BudgetExceededError', code: 'BUDGET_EXCEEDED' }); },
      onError: (error) => budgetErrors.push(error),
    });
    assert.equal(racingService.startManual(), true);
    await racingService.idle();
    assert.equal(racingService.status().state, 'budget');
    assert.deepEqual(budgetErrors, []);

    const resumedService = createTagClassificationService({
      repository: { ...baseRepository, costToday: () => 0 },
      classificationRepository,
      getConfig: () => config,
      getTemplate: () => promptTemplateStore.get().classifyTags,
      now: () => at + 1,
      callModel: async (_slot, messages) => responseFor(messages, (id) => ({
        id, category: 'personality', subject: null, polarity: null, mergeInto: null,
      })),
    });
    resumedService.startOnStartup();
    await resumedService.idle();
    assert.equal(resumedService.status().state, 'completed');
    assert.equal(resumedService.status().lockedSkipped, 1);
    assert.equal(classificationRepository.isLegacyMiscClassificationComplete(), true);

    const calls: string[] = [];
    const completedService = createTagClassificationService({
      repository: baseRepository,
      classificationRepository,
      getConfig: () => config,
      getTemplate: () => promptTemplateStore.get().classifyTags,
      now: () => at + 2,
      callModel: async (slot, messages) => {
        calls.push(slot);
        return responseFor(messages, (id) => ({ id, category: 'personality', subject: null, polarity: null, mergeInto: null }));
      },
    });
    completedService.startOnStartup();
    await completedService.idle();
    assert.equal(calls.length, 0);
    assert.equal(completedService.status().state, 'completed');
  } finally {
    database.close();
  }
});

test('startup 处理迁移标记的旧群标签，采用短名词并清除待整理标记', async () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    const classifications = createTagClassificationRepository(database);
    const id = insertTag(repository, {
      userId: null,
      text: '爱游戏',
      norm: '爱游戏',
      category: 'atmosphere',
      evidence: [{ messageId: 'old-group-tag', time: at - 1_000, quote: '大家爱游戏' }],
    });
    database.prepare('UPDATE tags SET needs_reclassification = 1 WHERE id = ?').run(id);
    classifications.markLegacyMiscClassificationComplete(at);
    const service = createTagClassificationService({
      repository,
      classificationRepository: classifications,
      getConfig: () => configWithBudget(1),
      getTemplate: () => promptTemplateStore.get().classifyTags,
      now: () => at,
      callModel: async (_slot, messages) => responseFor(messages, (tagId) => ({
        id: tagId,
        text: '游戏',
        category: 'positioning',
        subject: null,
        polarity: null,
        mergeInto: null,
      })),
    });

    service.startOnStartup();
    await service.idle();

    const tag = repository.tagById(id);
    const marker = database.prepare('SELECT needs_reclassification FROM tags WHERE id = ?').get(id) as {
      needs_reclassification: number;
    };
    assert.equal(service.status().state, 'completed');
    assert.equal(tag?.category, 'positioning');
    assert.equal(tag?.text, '游戏');
    assert.equal(tag?.norm, '游戏');
    assert.equal(marker.needs_reclassification, 0);
  } finally {
    database.close();
  }
});

test('整理命中已否决的分类文本时删除来源标签而不复活该画像', async () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    const classifications = createTagClassificationRepository(database);
    const deletedId = insertTag(repository, {
      userId: null,
      text: '不聊政治',
      norm: '不聊政治',
      category: 'norms',
      origin: 'manual',
      source: 'manual',
      status: 'confirmed',
    });
    assert.equal(repository.deleteTagAndCreateVeto(deletedId), true);
    const sourceId = insertTag(repository, {
      userId: null,
      text: '不聊政治',
      norm: '不聊政治',
      category: 'misc',
    });
    const service = createTagClassificationService({
      repository,
      classificationRepository: classifications,
      getConfig: () => configWithBudget(1),
      getTemplate: () => promptTemplateStore.get().classifyTags,
      now: () => at,
      callModel: async (_slot, messages) => responseFor(messages, (id) => ({
        id, category: 'norms', subject: null, polarity: null, mergeInto: null,
      })),
    });

    assert.equal(service.startManual(), true);
    await service.idle();

    assert.equal(service.status().state, 'completed');
    assert.equal(repository.tagById(sourceId), undefined);
    assert.equal(repository.listTagVetoes(account, key).length, 1);
  } finally {
    database.close();
  }
});

test('startup 分类失败记录安全阶段，面板可再次触发整理', async () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    const classifications = createTagClassificationRepository(database);
    const id = insertTag(repository, { userId: null });
    database.prepare('UPDATE tags SET needs_reclassification = 1 WHERE id = ?').run(id);
    let modelCalls = 0;
    const errors: unknown[][] = [];
    const service = createTagClassificationService({
      repository,
      classificationRepository: classifications,
      getConfig: () => configWithBudget(1),
      getTemplate: () => promptTemplateStore.get().classifyTags,
      now: () => at,
      onError: (...args: unknown[]) => errors.push(args),
      callModel: async (_slot, messages) => {
        modelCalls += 1;
        if (modelCalls === 1) throw new Error('synthetic provider failure');
        return responseFor(messages, (tagId) => ({
          id: tagId,
          category: 'positioning',
          subject: null,
          polarity: null,
          mergeInto: null,
        }));
      },
    });

    service.startOnStartup();
    await service.idle();
    assert.equal(service.status().state, 'error');
    assert.equal(errors[0]?.[1], '调用模型');
    assert.equal((errors[0]?.[0] as Error | undefined)?.message, 'synthetic provider failure');

    assert.equal(service.startManual(), true);
    await service.idle();
    assert.equal(service.status().state, 'completed');
    assert.equal(modelCalls, 2);
  } finally {
    database.close();
  }
});
