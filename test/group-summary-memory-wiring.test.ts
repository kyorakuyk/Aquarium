import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryServices } from '../src/app/memory-services.ts';
import { promptTemplateStore } from '../src/core/prompt/templates.ts';
import { createRepository } from '../src/store/repository.ts';
import { createMemberSummaryRepository } from '../src/store/member-summary-repo.ts';
import { createTagSubjectRepository } from '../src/store/tag-subject-repo.ts';
import { createTagClassificationRepository } from '../src/store/tag-classification-repo.ts';
import { openDatabase } from '../src/store/db.ts';
import { baseTime, groupSession, makeConfig } from './pipeline-test-helpers.ts';

const account = groupSession.account;
const groupId = `${account}:group:${groupSession.peer}`;

test('memory services generate a group summary after a successful group extraction', async () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    for (const [text, category] of [
      ['游戏', 'positioning'],
      ['CS2', 'topic'],
      ['晚间活跃', 'schedule'],
    ] as const) {
      repository.insertTag({
        account,
        sessionId: groupId,
        userId: null,
        text,
        norm: text,
        category,
        subject: category === 'topic' ? '游戏' : null,
        polarity: null,
        origin: category === 'schedule' ? 'stats' : 'inferred',
        locked: false,
        status: 'confirmed',
        source: 'auto',
        samples: 2,
        evidence: [],
        firstSeen: baseTime,
        lastSeen: baseTime,
        supersededBy: null,
        updatedAt: baseTime,
      });
    }
    const calls: string[] = [];
    const callModel = async (_slot: string, messages: Array<{ role: string; content: unknown }>) => {
      const prompt = messages.map(({ content }) => String(content)).join('\n');
      calls.push(prompt);
      return {
        text: prompt.includes('已确认的群画像标签：')
          ? '群里常在晚间聚在一起讨论游戏。'
          : JSON.stringify({ group: { observe: [], new: [], contradict: [] }, members: [] }),
        provider: 'fake',
        model: 'fake-extract',
        usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
      };
    };
    const services = createMemoryServices({
      repository,
      memberSummaryRepository: createMemberSummaryRepository(database),
      tagSubjects: createTagSubjectRepository(database),
      tagClassificationRepository: createTagClassificationRepository(database),
      getConfig: makeConfig,
      logger: { error() {}, info() {}, warn() {} },
      describeError: () => '测试错误',
      callModel,
      now: () => baseTime,
    } as unknown as Parameters<typeof createMemoryServices>[0]);
    const groupSummaryService = Reflect.get(services, 'groupSummaryService') as { idle: () => Promise<void> } | undefined;

    assert.equal(typeof groupSummaryService?.idle, 'function');
    if (!groupSummaryService) return;
    const release = services.impressionsService.tryAcquireSession(groupId);
    assert.ok(release);
    try {
      const result = await services.impressionsService.extractWindowUnderSessionLock({
        session: groupSession,
        records: [{
          sessionId: groupId,
          messageId: 'group-summary-hook',
          senderId: 42,
          senderName: '小明',
          isSelf: false,
          plainText: '今晚开黑吗',
          segments: [],
          time: baseTime,
        }],
        now: baseTime,
        template: promptTemplateStore.get().extractTags,
      });
      assert.equal(result.status, 'done');
    } finally {
      release();
    }
    await groupSummaryService.idle();

    assert.equal(calls.length, 2);
    assert.equal(repository.getGroupSummary(account, groupId)?.text, '群里常在晚间聚在一起讨论游戏。');
  } finally {
    database.close();
  }
});
