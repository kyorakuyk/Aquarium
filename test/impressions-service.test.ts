import assert from 'node:assert/strict';
import test from 'node:test';
import { createImpressionsService, type ExtractSummary } from '../src/core/impressions/service.ts';
import { promptTemplateStore } from '../src/core/prompt/templates.ts';
import { createMessagePipeline } from '../src/core/conversation/pipeline.ts';
import { sessionId, type SessionKey } from '../src/core/shared/events.ts';
import {
  FakeAdapter,
  groupSession,
  makeConfig,
  makeIncoming,
  withRepository,
  withDefaultExtractProfiles,
} from './pipeline-test-helpers.ts';

const account = groupSession.account;

function createImpressionsHarness(
  repository: Parameters<Parameters<typeof withRepository>[0]>[0],
  config: ReturnType<typeof makeConfig>,
  personaRoot: string,
  options: { extractText?: string } = {},
) {
  const adapter = new FakeAdapter();
  const clock = { value: new Date(2026, 9, 12, 9, 0).getTime() };
  const extractRequests: string[] = [];
  const summaries: ExtractSummary[] = [];
  const replyPrompts: string[] = [];
  const impressionsService = createImpressionsService({
    repository,
    getConfig: () => config,
    now: () => clock.value,
    callModel: async (_slot, messages) => {
      extractRequests.push(messages.map((message) => String(message.content)).join('\n'));
      return {
        text: withDefaultExtractProfiles(options.extractText ?? '{"group":{"observe":[],"new":[],"contradict":[]},"members":[]}'),
        provider: 'fake',
        model: 'fake-model',
        usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
      };
    },
    onExtract: (summary) => { summaries.push(summary); },
  });
  const pipeline = createMessagePipeline({
    getConfig: () => config,
    repository,
    adapter,
    getNickname: () => adapter.nickname,
    personaRoot,
    impressionsService,
    callModel: async (_slot, messages) => {
      replyPrompts.push(messages.map((message) => String(message.content)).join('\n'));
      return {
        text: '普通回复。',
        provider: 'fake',
        model: 'fake-model',
        usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
      };
    },
    now: () => clock.value,
    wait: async () => {},
    random: () => 0.4,
  });
  return { adapter, clock, extractRequests, impressionsService, pipeline, replyPrompts, summaries };
}

async function pump(
  harness: ReturnType<typeof createImpressionsHarness>,
  session: SessionKey,
  count: number,
  startIndex = 0,
): Promise<void> {
  for (let index = startIndex; index < startIndex + count; index += 1) {
    harness.clock.value += 1_000;
    await harness.pipeline(makeIncoming({
      session,
      messageId: `msg-${index}`,
      time: harness.clock.value - 1_000,
      senderId: 42 + (index % 3),
    }));
    await harness.impressionsService.idle();
  }
}

test('假模型下完成一次提取：观察转正、新标签、成员标签与 tag_runs', async () => {
  await withRepository(async (repository, personaRoot) => {
    const key = sessionId(groupSession);
    const t0 = new Date(2026, 9, 12, 9, 0).getTime();
    const seeded = repository.insertTag({
      account,
      sessionId: key,
      userId: null,
      text: '爱聊游戏',
      norm: '爱聊游戏',
      category: 'misc',
      subject: null,
      polarity: null,
      origin: 'inferred',
      locked: false,
      status: 'candidate',
      source: 'auto',
      samples: 1,
      evidence: [{ messageId: 'seed', time: 0, quote: '' }],
      firstSeen: 0,
      lastSeen: 0,
      supersededBy: null,
      updatedAt: 0,
    });
    const harness = createImpressionsHarness(repository, makeConfig({ nicknames: [] }), personaRoot, {
      extractText: JSON.stringify({
        group: {
          observe: [{ id: seeded, messageId: 'msg-3' }],
          new: [{ text: '氛围轻松', messageId: 'msg-4' }],
          contradict: [],
        },
        members: [{ userId: 42, observe: [], new: [{ text: '热情开朗', messageId: 'msg-3' }], contradict: [] }],
      }),
    });

    await pump(harness, groupSession, 10);
    await harness.impressionsService.idle();

    assert.equal(harness.extractRequests.length, 1);
    assert.ok(harness.extractRequests[0]?.includes('#msg-3'));
    assert.ok(harness.extractRequests[0]?.includes('(QQ 42)'));
    assert.ok(harness.extractRequests[0]?.includes(`#${seeded} 爱聊游戏（candidate）`));
    const summary = harness.summaries[0];
    assert.equal(summary?.status, 'done');
    assert.equal(summary?.inserted, 2);
    assert.equal(summary?.observed, 1);
    assert.equal(summary?.superseded, 0);
    assert.equal(summary?.dropped, 0);

    const groupTags = repository.listTagsForSubject(account, key, null);
    const observed = groupTags.find((tag) => tag.id === seeded);
    assert.equal(observed?.status, 'confirmed');
    assert.equal(observed?.samples, 2);
    assert.equal(observed?.lastSeen, t0 + 3_000);
    assert.equal(observed?.evidence.length, 2);
    assert.equal(groupTags.find((tag) => tag.text === '氛围轻松')?.status, 'candidate');
    assert.equal(groupTags.find((tag) => tag.text === '氛围轻松')?.samples, 1);
    const memberTags = repository.listTagsForSubject(account, key, 42);
    assert.equal(memberTags[0]?.text, '热情开朗');
    assert.equal(memberTags[0]?.status, 'candidate');

    const run = repository.getTagRun(account, key);
    assert.equal(run?.lastRunAt, harness.clock.value);
    assert.equal(run?.lastMessageTime, t0 + 9_000);
  });
});

test('one group extraction stores only events backed by window messages and known speakers', async () => {
  await withRepository(async (repository, personaRoot) => {
    const t0 = new Date(2026, 9, 12, 9, 0).getTime();
    const harness = createImpressionsHarness(repository, makeConfig({ nicknames: [] }), personaRoot, {
      extractText: JSON.stringify({
        group: { observe: [], new: [], contradict: [] },
        members: [],
        events: [
          {
            title: '周末漫展',
            summary: '群友约好周末一同参加漫展',
            participantIds: [43, 44],
            messageIds: ['msg-2', 'msg-4'],
          },
          {
            title: '无证据事件',
            summary: '引用不在本次提取窗口中的消息',
            participantIds: [42],
            messageIds: ['outside-window'],
          },
          {
            title: '未知参与者',
            summary: '参与者未出现在当前群聊窗口',
            participantIds: [999],
            messageIds: ['msg-3'],
          },
          {
            title: '这条事件标题明显超过十六个字的上限',
            summary: '该事件标题不符合限制',
            participantIds: [43],
            messageIds: ['msg-1'],
          },
        ],
      }),
    });

    await pump(harness, groupSession, 10);
    await harness.impressionsService.idle();

    const events = repository.listGroupEvents(account, groupSession.peer, 0, 10);
    assert.equal(harness.extractRequests.length, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.title, '周末漫展');
    assert.equal(events[0]?.summary, '群友约好周末一同参加漫展');
    assert.equal(events[0]?.anchorMessageId, 'msg-2');
    assert.deepEqual(events[0]?.participantIds, [43, 44]);
    assert.deepEqual(events[0]?.evidenceMessageIds, ['msg-2', 'msg-4']);
    assert.equal(events[0]?.occurredAt, t0 + 2_000);
  });
});

test('group event persistence redacts credentials and keeps sanitized text within field limits', async () => {
  await withRepository(async (repository, personaRoot) => {
    const credential = 'token=FAKE_TOKEN_VALUE_123456';
    const summaryPrefix = `${credential} 群友约好周末参加漫展`;
    const summary = summaryPrefix + '。'.repeat(60 - Array.from(summaryPrefix).length);
    const harness = createImpressionsHarness(repository, makeConfig({ nicknames: [] }), personaRoot, {
      extractText: JSON.stringify({
        group: { observe: [], new: [], contradict: [] },
        members: [],
        events: [{
          title: '周末漫展',
          summary,
          participantIds: [44],
          messageIds: ['msg-2'],
        }],
      }),
    });

    await pump(harness, groupSession, 10);

    const events = repository.listGroupEvents(account, groupSession.peer, 0, 10);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.title, '周末漫展');
    assert.ok(!events[0]?.summary.includes(credential));
    assert.ok(events[0]?.summary.includes('[敏感内容已隐藏]'));
    assert.ok(Array.from(events[0]?.title ?? '').length <= 16);
    assert.ok(Array.from(events[0]?.summary ?? '').length <= 60);
  });
});

test('event persistence failure does not advance the group extraction cursor', async () => {
  await withRepository(async (repository, personaRoot) => {
    const harness = createImpressionsHarness(repository, makeConfig({ nicknames: [] }), personaRoot, {
      extractText: JSON.stringify({
        group: { observe: [], new: [], contradict: [] },
        members: [],
        events: [{
          title: '周末漫展',
          summary: '群友约好周末一同参加漫展',
          participantIds: [43, 44],
          messageIds: ['msg-2', 'msg-4'],
        }],
      }),
    });
    const upsertGroupEvent = repository.upsertGroupEvent.bind(repository);
    let failFirstWrite = true;
    repository.upsertGroupEvent = (event) => {
      if (failFirstWrite) {
        failFirstWrite = false;
        throw new Error('synthetic event write failure');
      }
      return upsertGroupEvent(event);
    };

    await pump(harness, groupSession, 10);
    assert.equal(repository.getTagRun(account, sessionId(groupSession)), undefined);

    await pump(harness, groupSession, 10, 10);
    assert.equal(harness.extractRequests.length, 2);
    assert.equal(repository.listGroupEvents(account, groupSession.peer, 0, 10).length, 1);
  });
});

test('模型提取异常发出安全 WARN，保留错误分类且不输出模型正文', async () => {
  await withRepository(async (repository) => {
    const config = makeConfig({ nicknames: [] });
    const warnings: string[] = [];
    const secretLikeBody = 'private request body must not be logged';
    const service = createImpressionsService({
      repository,
      getConfig: () => config,
      now: () => 20,
      callModel: async () => {
        throw Object.assign(new Error(secretLikeBody), { name: 'APIConnectionTimeoutError' });
      },
      onWarn: (message) => warnings.push(message),
    });
    const release = service.tryAcquireSession(sessionId(groupSession));
    assert.ok(release);
    try {
      const summary = await service.extractWindowUnderSessionLock({
        session: groupSession,
        records: [],
        now: 20,
        template: promptTemplateStore.get().extractTags,
      });

      assert.equal(summary.status, 'error');
      assert.equal(summary.failureReason, 'timeout');
      assert.equal(warnings.length, 1);
      assert.match(warnings[0] ?? '', /slot=extract provider=\S+ model=\S+ durationMs=\d+ reason=模型超时/u);
      assert.equal(warnings[0]?.includes(secretLikeBody), false);
    } finally {
      release();
    }
  });
});

test('WARN 记录实际失败的降级模型，而不是链首模型', async () => {
  await withRepository(async (repository) => {
    const base = makeConfig({ nicknames: [] });
    const config = {
      ...base,
      slots: {
        ...base.slots,
        extract: [
          { provider: 'deepseek', model: 'deepseek-flash', reasoning: 'off' as const },
          { provider: 'mimo', model: 'mimo-model', reasoning: 'off' as const },
        ],
      },
    };
    const warnings: string[] = [];
    const service = createImpressionsService({
      repository,
      getConfig: () => config,
      callModel: async (_slot, _messages, callOptions) => {
        callOptions.recordUsage({
          time: 20, account, slot: 'extract', provider: 'mimo', model: 'mimo-model',
          inputTokens: 0, cachedTokens: 0, outputTokens: 0, costCny: 0, latencyMs: 0, ok: false,
        });
        throw Object.assign(new Error('private failure body'), { status: 503 });
      },
      onWarn: (message) => warnings.push(message),
    });
    const release = service.tryAcquireSession(sessionId(groupSession));
    assert.ok(release);
    try {
      await service.extractWindowUnderSessionLock({
        session: groupSession, records: [], now: 20,
        template: promptTemplateStore.get().extractTags,
      });
      assert.match(warnings[0] ?? '', /slot=extract provider=mimo model=mimo-model .*HTTP 503/u);
      assert.equal(warnings.length, 1);
    } finally {
      release();
    }
  });
});

test('外链分享卡片宣传文案不作为群友观点或标签证据', async () => {
  await withRepository(async (repository, personaRoot) => {
    const key = sessionId(groupSession);
    const harness = createImpressionsHarness(repository, makeConfig({ nicknames: [] }), personaRoot, {
      extractText: JSON.stringify({
        group: { observe: [], new: [{ text: '爱聊游戏', messageId: 'share-card' }], contradict: [] },
        members: [],
      }),
    });

    await pump(harness, groupSession, 9);
    harness.clock.value += 1_000;
    await harness.pipeline(makeIncoming({
      messageId: 'share-card',
      time: harness.clock.value - 1_000,
      plainText: '这张地图超级好玩，快点击链接和我一起开黑→平台标题：@url:https://example.invalid/card',
    }));
    await harness.impressionsService.idle();

    const prompt = harness.extractRequests[0] ?? '';
    assert.ok(prompt.includes('分享了外链卡片'));
    assert.equal(prompt.includes('超级好玩'), false);
    assert.equal(prompt.includes('example.invalid'), false);
    assert.equal(repository.listTagsForSubject(account, key, null).length, 0);
    assert.equal(harness.summaries[0]?.dropped, 1);
  });
});

test('触发条件：60 条且 30 分钟，或 10 条且 6 小时', async () => {
  await withRepository(async (repository, personaRoot) => {
    const groupA: SessionKey = { account, kind: 'group', peer: 111111 };
    const groupB: SessionKey = { account, kind: 'group', peer: 222222 };
    const harness = createImpressionsHarness(repository, makeConfig({ nicknames: [] }), personaRoot);

    repository.saveTagRun({
      account,
      sessionId: sessionId(groupA),
      lastRunAt: harness.clock.value - 40 * 60_000,
      lastMessageTime: null,
    });
    await pump(harness, groupA, 59);
    await harness.impressionsService.idle();
    assert.equal(harness.extractRequests.length, 0);

    await pump(harness, groupA, 1, 59);
    await harness.impressionsService.idle();
    assert.equal(harness.extractRequests.length, 1);

    repository.saveTagRun({
      account,
      sessionId: sessionId(groupB),
      lastRunAt: harness.clock.value - 7 * 60 * 60_000,
      lastMessageTime: null,
    });
    await pump(harness, groupB, 9, 100);
    await harness.impressionsService.idle();
    assert.equal(harness.extractRequests.length, 1);

    await pump(harness, groupB, 1, 109);
    await harness.impressionsService.idle();
    assert.equal(harness.extractRequests.length, 2);
  });
});

test('常规自动提取仍跳过未启用群', async () => {
  await withRepository(async (repository, personaRoot) => {
    const config = makeConfig({
      nicknames: [],
      sessions: { [sessionId(groupSession)]: { enabled: false } },
    });
    const harness = createImpressionsHarness(repository, config, personaRoot);

    await pump(harness, groupSession, 10);
    await harness.impressionsService.idle();

    assert.equal(harness.extractRequests.length, 0);
    assert.equal(repository.getTagRun(account, sessionId(groupSession)), undefined);
  });
});

test('非法条目被单独丢弃，其余条目照常生效', async () => {
  await withRepository(async (repository, personaRoot) => {
    const key = sessionId(groupSession);
    const harness = createImpressionsHarness(repository, makeConfig({ nicknames: [] }), personaRoot, {
      extractText: JSON.stringify({
        group: {
          observe: [{ id: 999, messageId: 'msg-1' }],
          new: [
            { text: '合格的群标签', messageId: 'msg-2' },
            { text: '这条标签文字确实超过了十六个字限制', messageId: 'msg-3' },
            { text: '短', messageId: 'msg-4' },
            { text: '不在窗口内', messageId: 'missing-message' },
            { text: '第二个标签', messageId: 'msg-5' },
            { text: '第三个标签', messageId: 'msg-6' },
            { text: '第四个标签', messageId: 'msg-7' },
          ],
          contradict: [],
        },
        members: [{ userId: 999, observe: [{ id: 1, messageId: 'msg-1' }], new: [], contradict: [] }],
      }),
    });

    await pump(harness, groupSession, 10);
    await harness.impressionsService.idle();

    const summary = harness.summaries[0];
    assert.equal(summary?.status, 'done');
    assert.equal(summary?.inserted, 3);
    assert.equal(summary?.observed, 0);
    assert.equal(summary?.dropped, 6);
    const groupTags = repository.listTagsForSubject(account, key, null);
    assert.deepEqual(
      groupTags.map((tag) => tag.text).sort(),
      ['合格的群标签', '第二个标签', '第三个标签'].sort(),
    );
    assert.equal(repository.listTagsForSubject(account, key, 999).length, 0);
  });
});

test('整体解析失败时记原因且不改标签，tag_runs 照常更新', async () => {
  await withRepository(async (repository, personaRoot) => {
    const key = sessionId(groupSession);
    const t0 = new Date(2026, 9, 12, 9, 0).getTime();
    const harness = createImpressionsHarness(repository, makeConfig({ nicknames: [] }), personaRoot, {
      extractText: '这不是 JSON',
    });

    await pump(harness, groupSession, 10);
    await harness.impressionsService.idle();

    assert.equal(harness.extractRequests.length, 1);
    assert.equal(harness.summaries[0]?.status, 'parse_error');
    assert.equal(repository.listTagsForSubject(account, key, null).length, 0);
    const run = repository.getTagRun(account, key);
    assert.equal(run?.lastRunAt, harness.clock.value);
    assert.equal(run?.lastMessageTime, t0 + 9_000);
  });
});

test('同一轮同标签 samples 最多加一且重复 observe 证据均保留', async () => {
  await withRepository(async (repository, personaRoot) => {
    const key = sessionId(groupSession);
    const seeded = repository.insertTag({
      account,
      sessionId: key,
      userId: null,
      text: '聊游戏',
      norm: '聊游戏',
      category: 'misc',
      subject: null,
      polarity: null,
      origin: 'inferred',
      locked: false,
      status: 'candidate',
      source: 'auto',
      samples: 1,
      evidence: [{ messageId: 'seed', time: 0, quote: '初始证据' }],
      firstSeen: 0,
      lastSeen: 0,
      supersededBy: null,
      updatedAt: 0,
    });
    const existingByNew = repository.insertTag({
      account,
      sessionId: key,
      userId: null,
      text: '看电影',
      norm: '看电影',
      category: 'misc',
      subject: null,
      polarity: null,
      origin: 'inferred',
      locked: false,
      status: 'candidate',
      source: 'auto',
      samples: 1,
      evidence: [{ messageId: 'seed-movie', time: 0, quote: '初始证据' }],
      firstSeen: 0,
      lastSeen: 0,
      supersededBy: null,
      updatedAt: 0,
    });
    const harness = createImpressionsHarness(repository, makeConfig({ nicknames: [] }), personaRoot, {
      extractText: JSON.stringify({
        group: {
          observe: [
            { id: seeded, messageId: 'msg-3' },
            { id: seeded, messageId: 'msg-4' },
          ],
          new: [
            { text: '爱聊“游戏”！', messageId: 'msg-5' },
            { text: '爱看电影', messageId: 'msg-6' },
            { text: '爱看“电影”！', messageId: 'msg-7' },
          ],
          contradict: [],
        },
        members: [],
      }),
    });

    await pump(harness, groupSession, 10);
    await harness.impressionsService.idle();

    const updated = repository.tagById(seeded);
    assert.equal(updated?.samples, 2);
    assert.equal(updated?.status, 'confirmed');
    assert.deepEqual(updated?.evidence
      .filter((item) => item.kind !== 'signature')
      .map((item) => item.messageId), ['seed', 'msg-3', 'msg-4']);
    assert.equal(repository.tagById(existingByNew)?.samples, 2);
    assert.deepEqual(repository.tagById(existingByNew)?.evidence
      .filter((item) => item.kind !== 'signature')
      .map((item) => item.messageId), ['seed-movie', 'msg-6']);
    assert.equal(harness.summaries[0]?.observed, 3);
    assert.equal(harness.summaries[0]?.dropped, 2);
  });
});

test('群友标签拒绝使用其他发送者的消息作证据', async () => {
  await withRepository(async (repository, personaRoot) => {
    const harness = createImpressionsHarness(repository, makeConfig({ nicknames: [] }), personaRoot, {
      extractText: JSON.stringify({
        group: { observe: [], new: [], contradict: [] },
        members: [{ userId: 42, observe: [], new: [{ text: '爱聊游戏', messageId: 'msg-1' }], contradict: [] }],
      }),
    });

    await pump(harness, groupSession, 10);
    await harness.impressionsService.idle();

    assert.equal(repository.listTagsForSubject(account, sessionId(groupSession), 42).length, 0);
    assert.equal(harness.summaries[0]?.dropped, 1);
  });
});

test('群标签与群友标签都拒绝使用 bot 自己的消息作证据', async () => {
  await withRepository(async (repository, personaRoot) => {
    const key = sessionId(groupSession);
    const t0 = new Date(2026, 9, 12, 9, 0).getTime();
    repository.saveMessage({
      sessionId: key,
      messageId: 'bot-evidence',
      senderId: account,
      senderName: 'Aquarium',
      isSelf: true,
      plainText: 'bot 自己说的话',
      segments: [],
      time: t0 + 500,
    });
    const harness = createImpressionsHarness(repository, makeConfig({ nicknames: [] }), personaRoot, {
      extractText: JSON.stringify({
        group: {
          observe: [],
          new: [{ text: '群里气氛活跃', messageId: 'bot-evidence' }],
          contradict: [],
        },
        members: [{ userId: 42, observe: [], new: [{ text: '爱开玩笑', messageId: 'bot-evidence' }], contradict: [] }],
      }),
    });

    await pump(harness, groupSession, 9);
    await harness.impressionsService.idle();

    assert.equal(repository.listTagsForSubject(account, key, null).length, 0);
    assert.equal(repository.listTagsForSubject(account, key, 42).length, 0);
    assert.equal(harness.extractRequests.length, 1);
    assert.equal(harness.summaries[0]?.dropped, 2);
  });
});

test('contradict 新标签计入每个主语每次最多新增三条', async () => {
  await withRepository(async (repository, personaRoot) => {
    const key = sessionId(groupSession);
    const seed = (text: string) => repository.insertTag({
      account,
      sessionId: key,
      userId: null,
      text,
      norm: text,
      category: 'misc',
      subject: null,
      polarity: null,
      origin: 'inferred',
      locked: false,
      status: 'candidate' as const,
      source: 'auto' as const,
      samples: 1,
      evidence: [{ messageId: `seed-${text}`, time: 0, quote: '' }],
      firstSeen: 0,
      lastSeen: 0,
      supersededBy: null,
      updatedAt: 0,
    });
    const first = seed('旧标签甲');
    const second = seed('旧标签乙');
    const harness = createImpressionsHarness(repository, makeConfig({ nicknames: [] }), personaRoot, {
      extractText: JSON.stringify({
        group: {
          observe: [],
          new: [
            { text: '普通新增标签甲', messageId: 'msg-0' },
            { text: '普通新增标签乙', messageId: 'msg-1' },
          ],
          contradict: [
            { id: first, text: '推翻后标签甲', messageId: 'msg-2' },
            { id: second, text: '推翻后标签乙', messageId: 'msg-3' },
          ],
        },
        members: [],
      }),
    });

    await pump(harness, groupSession, 10);
    await harness.impressionsService.idle();

    const tags = repository.listTagsForSubject(account, key, null);
    assert.equal(tags.filter((tag) => tag.id !== first && tag.id !== second).length, 3);
    assert.equal(repository.tagById(first)?.status, 'superseded');
    assert.equal(repository.tagById(second)?.status, 'candidate');
    assert.equal(harness.summaries[0]?.inserted, 3);
    assert.equal(harness.summaries[0]?.superseded, 1);
    assert.equal(harness.summaries[0]?.dropped, 1);
  });
});

test('群聊提示分开注入 fact 知识与符合范围的 view 印象', async () => {
  await withRepository(async (repository, personaRoot) => {
    const key = sessionId(groupSession);
    const harness = createImpressionsHarness(repository, makeConfig(), personaRoot);
    const at = harness.clock.value;
    const seedTag = (userId: number | null, text: string, samples: number, lastSeen: number) => {
      repository.insertTag({
        account,
        sessionId: key,
        userId,
        text,
        norm: text,
        category: userId === null ? 'atmosphere' : 'schedule',
        subject: null,
        polarity: null,
        origin: 'inferred',
        locked: false,
        status: 'confirmed',
        source: 'auto',
        samples,
        evidence: [],
        firstSeen: lastSeen,
        lastSeen,
        supersededBy: null,
        updatedAt: lastSeen,
      });
    };
    seedTag(null, '爱聊游戏', 5, at);
    for (const [index, label] of ['扩展一', '扩展二', '扩展三', '扩展四', '扩展五', '扩展六', '扩展七'].entries()) {
      seedTag(null, label, 2, at - (index + 1) * 1_000);
    }
    seedTag(42, '夜猫子', 2, at);

    harness.clock.value += 1_000;
    await harness.pipeline(makeIncoming({
      messageId: 'inj-1',
      time: harness.clock.value - 1_000,
      senderId: 42,
    }));
    await harness.impressionsService.idle();

    const groupPrompt = harness.replyPrompts[0] ?? '';
    assert.equal(groupPrompt.includes('这个群的氛围'), false);
    assert.ok(groupPrompt.includes('关于"小明"：作息：夜猫子'));
    assert.ok(groupPrompt.includes('以下是你个人的看法，带 ? 的不确定，可与他人不同'));
    const groupDetail = repository.recentDecisions(1)[0]?.detail as {
      promptBlocks?: Array<{ id: string }>;
      droppedTags?: number;
    };
    assert.deepEqual(groupDetail.promptBlocks?.map((block) => block.id), [
      'persona', 'rules', 'groupNote', 'memberTags', 'impressions',
    ]);
    assert.equal(groupDetail.droppedTags, 4);

    const privateSession: SessionKey = { account, kind: 'private', peer: 42 };
    harness.clock.value += 60_000;
    await harness.pipeline(makeIncoming({
      session: privateSession,
      messageId: 'inj-2',
      time: harness.clock.value - 1_000,
      senderId: 42,
    }));
    await harness.impressionsService.idle();

    const privatePrompt = harness.replyPrompts[1] ?? '';
    assert.equal(privatePrompt.includes('这个群的氛围'), false);
    assert.equal(privatePrompt.includes('夜猫子'), false);
    const privateDetail = repository.recentDecisions(1)[0]?.detail as {
      promptBlocks?: Array<{ id: string }>;
      droppedTags?: number;
    };
    assert.deepEqual(privateDetail.promptBlocks?.map((block) => block.id), ['persona', 'rules', 'groupNote']);
    assert.equal(privateDetail.droppedTags, undefined);
  });
});

test('标签注入在来源会话与目标会话不一致时经策略拒绝', async () => {
  await withRepository(async (repository, personaRoot) => {
    const harness = createImpressionsHarness(repository, makeConfig(), personaRoot);
    const sourceSessionId = `${account}:group:999999`;
    const at = harness.clock.value;
    for (const userId of [null, 42]) {
      const text = userId === null ? '其他群氛围' : '其他群成员标签';
      repository.insertTag({
        account,
        sessionId: sourceSessionId,
        userId,
        text,
        norm: text,
        category: 'misc',
        subject: null,
        polarity: null,
        origin: 'inferred',
        locked: false,
        status: 'confirmed',
        source: 'auto',
        samples: 2,
        evidence: [],
        firstSeen: at,
        lastSeen: at,
        supersededBy: null,
        updatedAt: at,
      });
    }

    const blocks = harness.impressionsService.promptBlocks({
      session: groupSession,
      sessionId: sourceSessionId,
      senderId: 42,
      senderName: '小明',
      now: at,
      template: {
        source: '',
        version: 'test',
        system: '',
        groupNote: '',
        request: '',
        groupTags: 'group {{tags}}',
        memberTags: 'member {{name}} {{tags}}',
        impressions: 'impressions {{tags}}',
        privateFacts: 'private {{name}} {{facts}}',
        knownFacts: 'known {{facts}}',
        stickers: '',
      },
    });

    assert.equal(blocks.groupTags, undefined);
    assert.equal(blocks.memberTags, undefined);
  });
});
