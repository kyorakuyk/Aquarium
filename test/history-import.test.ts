import assert from 'node:assert/strict';
import test from 'node:test';
import { createHistoryImportService } from '../src/core/impressions/history-import.ts';
import { createImpressionsService } from '../src/core/impressions/service.ts';
import type { ExtractFailureType } from '../src/core/impressions/extract-error.ts';
import { sessionId, type IncomingMessage, type SessionKey } from '../src/core/shared/events.ts';
import type { ExtractTagsPromptTemplate } from '../src/core/prompt/templates.ts';
import type { MessageStorageRecord } from '../src/store/repository.ts';
import { FakeAdapter, groupSession, makeConfig, withRepository } from './pipeline-test-helpers.ts';

const extractTemplate: ExtractTagsPromptTemplate = {
  source: 'fixture',
  version: 'fixture-v1',
  system: '提取群聊印象。',
  user: '上下文：{{context}}\n现有：{{existing}}',
};

function storedMessage(messageId: string, time: number, plainText = messageId): MessageStorageRecord {
  return {
    sessionId: sessionId(groupSession),
    messageId,
    senderId: 42,
    senderName: '群友',
    isSelf: false,
    plainText,
    segments: [{ type: 'text', text: plainText }],
    time,
  };
}

function incomingMessage(index: number): IncomingMessage {
  const messageId = `history-${String(index).padStart(3, '0')}`;
  return {
    session: groupSession,
    messageId,
    senderId: 42,
    senderName: '群友',
    segments: [{ type: 'text', text: messageId }],
    plainText: messageId,
    mentionsSelf: false,
    replyToSelf: false,
    time: 1_700_000_000_000 + index,
  };
}

class PagedHistoryAdapter extends FakeAdapter {
  readonly requests: Array<{ count: number; beforeMessageId?: string | number }> = [];
  pages: IncomingMessage[][] = [];
  historyErrors = 0;

  override async history(_session: SessionKey, request: number | { count: number; beforeMessageId?: string | number }): Promise<IncomingMessage[]> {
    const options = typeof request === 'number' ? { count: request } : request;
    this.requests.push(options);
    if (this.historyErrors > 0) {
      this.historyErrors -= 1;
      throw new Error('offline fixture');
    }
    return this.pages[this.requests.length - 1] ?? [];
  }
}

test('history windows extract the supplied records without touching newer context or tag_runs', async () => {
  await withRepository(async (repository) => {
    const key = sessionId(groupSession);
    repository.saveMessage(storedMessage('later-message', 5000, '不属于导入窗口'));
    let prompt = '';
    const impressions = createImpressionsService({
      repository,
      getConfig: () => makeConfig({ nicknames: [] }),
      callModel: async (slot, messages) => {
        assert.equal(slot, 'extract');
        prompt = messages.map((message) => String(message.content)).join('\n');
        return {
          text: JSON.stringify({
            group: {
              observe: [],
              new: [{
                text: '旧窗标签',
                messageId: 'window-old',
                category: 'personality',
                subject: null,
                polarity: null,
                origin: 'inferred',
                sensitive: false,
              }],
              contradict: [],
            },
            members: [],
          }),
          provider: 'fake',
          model: 'fake-model',
          usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0.01 },
        };
      },
    });
    const release = impressions.tryAcquireSession(key);
    assert.ok(release);
    try {
      const summary = await impressions.extractWindowUnderSessionLock({
        session: groupSession,
        records: [storedMessage('window-old', 1000, '较早消息'), storedMessage('window-new', 2000, '较新消息')],
        now: 6000,
        template: extractTemplate,
      });

      assert.equal(summary.status, 'done');
      assert.equal(summary.inserted, 1);
      assert.ok(prompt.includes('#window-old'));
      assert.ok(prompt.includes('#window-new'));
      assert.equal(prompt.includes('later-message'), false);
      assert.deepEqual(repository.getTagRun(groupSession.account, key), undefined);
      assert.equal(repository.listTagsForSubject(groupSession.account, key, null)[0]?.text, '旧窗标签');
    } finally {
      release();
    }
  });
});

test('history import pages idempotently and extracts 80-message windows oldest-first without pipeline side effects', async () => {
  await withRepository(async (repository) => {
    const config = makeConfig({ nicknames: [] });
    const messages = Array.from({ length: 200 }, (_, index) => incomingMessage(index));
    const existing = messages[5];
    assert.ok(existing);
    repository.saveMessage({
      sessionId: sessionId(groupSession),
      messageId: existing.messageId,
      senderId: existing.senderId,
      senderName: existing.senderName,
      isSelf: false,
      plainText: '数据库中已有的版本',
      segments: existing.segments,
      time: existing.time,
    });

    const adapter = new PagedHistoryAdapter();
    adapter.pages = [3, 2, 1, 0].map((page) => messages.slice(page * 50, page * 50 + 50));
    const delays: number[] = [];
    const prompts: string[] = [];
    const impressions = createImpressionsService({
      repository,
      getConfig: () => config,
      callModel: async (_slot, prompt) => {
        prompts.push(prompt.map((message) => String(message.content)).join('\n'));
        return {
          text: '{"group":{"observe":[],"new":[],"contradict":[]},"members":[]}',
          provider: 'fake',
          model: 'fake-model',
          usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0.01 },
        };
      },
    });
    const imports = createHistoryImportService({
      repository,
      getConfig: () => config,
      impressionsService: impressions,
      getTemplate: () => extractTemplate,
      now: () => 1_700_000_100_000,
      wait: async (delay) => { delays.push(delay); },
    });

    const started = imports.start({ session: groupSession, target: 200, adapter });
    assert.ok(started);
    await imports.idle();
    const job = imports.get(started.id);

    assert.equal(job?.phase, 'done');
    assert.equal(job?.fetched, 200);
    assert.equal(job?.inserted, 199);
    assert.equal(job?.windowsTotal, 3);
    assert.equal(job?.windowsDone, 3);
    assert.equal(job?.windowsFailed, 0);
    assert.equal(job?.costCny, 0.03);
    assert.equal(adapter.requests.length, 4);
    assert.deepEqual(adapter.requests.map((request) => request.count), [50, 50, 50, 50]);
    assert.deepEqual(adapter.requests.map((request) => request.beforeMessageId), [
      undefined, 'history-150', 'history-100', 'history-050',
    ]);
    assert.deepEqual(delays, [500, 500, 500, 1000, 1000]);
    assert.equal(prompts.length, 3);
    assert.ok(prompts[0]?.includes('#history-000'));
    assert.ok(prompts[0]?.includes('#history-079'));
    assert.equal(prompts[0]?.includes('#history-080'), false);
    assert.ok(prompts[1]?.includes('#history-080'));
    assert.ok(prompts[1]?.includes('#history-159'));
    assert.ok(prompts[2]?.includes('#history-160'));
    assert.ok(prompts[2]?.includes('#history-199'));
    assert.ok(prompts[0]?.includes('数据库中已有的版本'));
    assert.deepEqual(repository.recentDecisions(10), []);
    assert.deepEqual(repository.recentMoodEvents(groupSession.account, 10), []);
    assert.deepEqual(repository.recentAffinityEvents(groupSession.account, 42, 10), []);
    assert.equal(repository.getTagRun(groupSession.account, sessionId(groupSession))?.lastMessageTime, messages[199]?.time);
  });
});

test('history import stops at a short page and after three consecutive page errors', async () => {
  await withRepository(async (repository) => {
    const config = makeConfig({ nicknames: [] });
    let extractionCalls = 0;
    const impressions = createImpressionsService({
      repository,
      getConfig: () => config,
      callModel: async () => {
        extractionCalls += 1;
        return {
          text: '{"group":{"observe":[],"new":[],"contradict":[]},"members":[]}',
          provider: 'fake',
          model: 'fake-model',
          usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
        };
      },
    });
    const imports = createHistoryImportService({
      repository,
      getConfig: () => config,
      impressionsService: impressions,
      getTemplate: () => extractTemplate,
      wait: async () => {},
    });
    const shortPage = new PagedHistoryAdapter();
    shortPage.pages = [[incomingMessage(1)]];
    const shortJob = imports.start({ session: groupSession, target: 200, adapter: shortPage });
    assert.ok(shortJob);
    await imports.idle();
    assert.equal(imports.get(shortJob.id)?.phase, 'done');
    assert.equal(imports.get(shortJob.id)?.fetched, 1);
    assert.equal(shortPage.requests.length, 1);
    assert.equal(extractionCalls, 1);

    const failedPage = new PagedHistoryAdapter();
    failedPage.historyErrors = 3;
    const failedJob = imports.start({ session: groupSession, target: 200, adapter: failedPage });
    assert.ok(failedJob);
    await imports.idle();
    assert.equal(imports.get(failedJob.id)?.phase, 'error');
    assert.equal(imports.get(failedJob.id)?.error, '连续三页拉取失败');
    assert.equal(failedPage.requests.length, 3);
  });
});

test('history import retries a failed extraction window once and continues when retry succeeds', async () => {
  await withRepository(async (repository) => {
    const config = makeConfig({ nicknames: [] });
    const messages = Array.from({ length: 80 }, (_, index) => incomingMessage(index));
    const adapter = new PagedHistoryAdapter();
    adapter.pages = [messages.slice(40), messages.slice(0, 40), []];
    const waits: number[] = [];
    let calls = 0;
    const impressions = createImpressionsService({
      repository, getConfig: () => config,
      callModel: async () => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error('offline fixture'), { code: 'ECONNRESET' });
        return {
          text: '{"group":{"observe":[],"new":[],"contradict":[]},"members":[]}',
          provider: 'fake', model: 'fixture-model',
          usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
        };
      },
    });
    const imports = createHistoryImportService({
      repository, getConfig: () => config, impressionsService: impressions,
      getTemplate: () => extractTemplate, wait: async (milliseconds) => { waits.push(milliseconds); },
    });
    const started = imports.start({ session: groupSession, target: 200, adapter });
    assert.ok(started);
    await imports.idle();
    const job = imports.get(started.id);
    assert.equal(job?.phase, 'done');
    assert.equal(job?.windowsDone, 1);
    assert.equal(job?.windowsFailed, 0);
    assert.equal(job?.failureReason, undefined);
    assert.equal(calls, 2);
    assert.deepEqual(waits.filter((milliseconds) => milliseconds === 5_000), [5_000]);
  });
});

test('history import skips one failed window and continues, showing its failure reason in the job', async () => {
  await withRepository(async (repository) => {
    const config = makeConfig({ nicknames: [] });
    const messages = Array.from({ length: 100 }, (_, index) => incomingMessage(index));
    const adapter = new PagedHistoryAdapter();
    adapter.pages = [messages.slice(50), messages.slice(0, 50), []];
    let calls = 0;
    const impressions = createImpressionsService({
      repository,
      getConfig: () => config,
      callModel: async () => {
        calls += 1;
        if (calls <= 2) throw Object.assign(new Error('temporary network issue'), { code: 'ECONNRESET' });
        return {
          text: '{"group":{"observe":[],"new":[],"contradict":[]},"members":[]}',
          provider: 'fake', model: 'fixture-model',
          usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
        };
      },
    });
    const imports = createHistoryImportService({
      repository, getConfig: () => config, impressionsService: impressions,
      getTemplate: () => extractTemplate, wait: async () => {},
    });

    const started = imports.start({ session: groupSession, target: 200, adapter });
    assert.ok(started);
    await imports.idle();
    const job = imports.get(started.id);

    assert.equal(job?.phase, 'done');
    assert.equal(job?.windowsTotal, 2);
    assert.equal(job?.windowsDone, 1);
    assert.equal(job?.windowsFailed, 1);
    assert.equal(job?.failureReason, 'network');
    assert.equal(job?.failureHttpStatus, undefined);
    assert.equal(calls, 3);
  });
});

test('三段提取连续失败后终止并保留最后失败原因', async () => {
  await withRepository(async (repository) => {
    const config = makeConfig({ nicknames: [] });
    const messages = Array.from({ length: 200 }, (_, index) => incomingMessage(index));
    const adapter = new PagedHistoryAdapter();
    adapter.pages = [messages.slice(150), messages.slice(100, 150), messages.slice(50, 100), messages.slice(0, 50), []];
    const waits: number[] = [];
    let calls = 0;
    const impressions = createImpressionsService({
      repository, getConfig: () => config,
      callModel: async () => {
        calls += 1;
        throw Object.assign(new Error('timeout fixture'), { name: 'APIConnectionTimeoutError' });
      },
    });
    const imports = createHistoryImportService({
      repository, getConfig: () => config, impressionsService: impressions,
      getTemplate: () => extractTemplate, wait: async (milliseconds) => { waits.push(milliseconds); },
    });
    const started = imports.start({ session: groupSession, target: 200, adapter });
    assert.ok(started);
    await imports.idle();
    const job = imports.get(started.id);
    assert.equal(job?.phase, 'error');
    assert.equal(job?.windowsDone, 0);
    assert.equal(job?.windowsFailed, 3);
    assert.equal(job?.failureReason, 'timeout' satisfies ExtractFailureType);
    assert.equal(job?.failureHttpStatus, undefined);
    assert.equal(job?.error, '提取失败：模型超时（3 个窗口跳过）');
    assert.equal(calls, 6);
    assert.equal(waits.filter((milliseconds) => milliseconds === 5_000).length, 3);
  });
});

test('导入中间窗口成功会重置连续失败计数', async () => {
  await withRepository(async (repository) => {
    const config = makeConfig({ nicknames: [] });
    const messages = Array.from({ length: 320 }, (_, index) => incomingMessage(index));
    const adapter = new PagedHistoryAdapter();
    adapter.pages = [
      messages.slice(270), messages.slice(220, 270), messages.slice(170, 220),
      messages.slice(120, 170), messages.slice(70, 120), messages.slice(20, 70),
      messages.slice(0, 20), [],
    ];
    let calls = 0;
    const impressions = createImpressionsService({
      repository,
      getConfig: () => config,
      callModel: async () => {
        calls += 1;
        if (calls <= 4 || calls >= 6) {
          throw Object.assign(new Error('temporary failure'), { code: 'ECONNRESET' });
        }
        return {
          text: '{"group":{"observe":[],"new":[],"contradict":[]},"members":[]}',
          provider: 'fake', model: 'fixture-model',
          usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
        };
      },
    });
    const imports = createHistoryImportService({
      repository, getConfig: () => config, impressionsService: impressions,
      getTemplate: () => extractTemplate, wait: async () => {},
    });
    const started = imports.start({ session: groupSession, target: 500, adapter });
    assert.ok(started);
    await imports.idle();
    const job = imports.get(started.id);

    assert.equal(job?.phase, 'done');
    assert.equal(job?.windowsDone, 1);
    assert.equal(job?.windowsFailed, 3);
    assert.equal(calls, 7);
    assert.equal(job?.failureReason, 'network');
    assert.equal(job?.failureHttpStatus, undefined);
  });
});

test('history import retains completed windows and stops before the next one when budget is exceeded', async () => {
  await withRepository(async (repository) => {
    const baseConfig = makeConfig({ nicknames: [] });
    const config = { ...baseConfig, budget: { ...baseConfig.budget, dailyCny: 0.01 } };
    const messages = Array.from({ length: 100 }, (_, index) => incomingMessage(index));
    const adapter = new PagedHistoryAdapter();
    adapter.pages = [messages.slice(50), messages.slice(0, 50), []];
    const at = Date.now();
    let calls = 0;
    const impressions = createImpressionsService({
      repository,
      getConfig: () => config,
      now: () => at,
      callModel: async (_slot, _prompt, callOptions) => {
        calls += 1;
        callOptions.recordUsage({
          time: at,
          account: callOptions.account,
          slot: 'extract',
          provider: 'fake',
          model: 'fake-model',
          inputTokens: 1,
          cachedTokens: 0,
          outputTokens: 1,
          costCny: 0.01,
          latencyMs: 1,
          ok: true,
        });
        return {
          text: '{"group":{"observe":[],"new":[],"contradict":[]},"members":[]}',
          provider: 'fake',
          model: 'fake-model',
          usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0.01 },
        };
      },
    });
    const imports = createHistoryImportService({
      repository,
      getConfig: () => config,
      impressionsService: impressions,
      getTemplate: () => extractTemplate,
      now: () => at,
      wait: async () => {},
    });

    const started = imports.start({ session: groupSession, target: 200, adapter });
    assert.ok(started);
    await imports.idle();
    const job = imports.get(started.id);

    assert.equal(job?.phase, 'error');
    assert.equal(job?.error, '预算已用尽');
    assert.equal(job?.windowsTotal, 2);
    assert.equal(job?.windowsDone, 1);
    assert.equal(job?.costCny, 0.01);
    assert.equal(calls, 1);
    assert.equal(repository.getTagRun(groupSession.account, sessionId(groupSession)), undefined);
  });
});
