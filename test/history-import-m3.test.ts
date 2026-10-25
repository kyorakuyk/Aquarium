import assert from 'node:assert/strict';
import test from 'node:test';
import { createHistoryImportService } from '../src/core/impressions/history-import.ts';
import { createImpressionsService } from '../src/core/impressions/service.ts';
import type { HistoryOptions } from '../src/adapters/types.ts';
import { sessionId, type IncomingMessage, type SessionKey } from '../src/core/shared/events.ts';
import type { ExtractTagsPromptTemplate } from '../src/core/prompt/templates.ts';
import type { StoreRepository } from '../src/store/repository.ts';
import { FakeAdapter, groupSession, makeConfig, withRepository } from './pipeline-test-helpers.ts';

const template: ExtractTagsPromptTemplate = {
  source: 'fixture',
  version: 'm3-v1',
  system: '提取群聊印象。',
  user: '上下文：{{context}}\n现有：{{existing}}',
};

function message(index: number): IncomingMessage {
  const messageId = `m3-${String(index).padStart(3, '0')}`;
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

function saveMessage(repository: StoreRepository, input: IncomingMessage): void {
  repository.saveMessage({
    sessionId: sessionId(groupSession),
    messageId: input.messageId,
    senderId: input.senderId,
    senderName: input.senderName,
    isSelf: false,
    plainText: input.plainText,
    segments: input.segments,
    time: input.time,
  });
}

class PagedAdapter extends FakeAdapter {
  historyPages: IncomingMessage[][] = [];
  historyCalls = 0;

  override async history(_session: SessionKey, _request: number | HistoryOptions): Promise<IncomingMessage[]> {
    this.historyCalls += 1;
    return this.historyPages.shift() ?? [];
  }
}

test('incremental history waits for confirmation, filters strictly after the waterline, and shows a recent-cost estimate', async () => {
  await withRepository(async (repository) => {
    const config = makeConfig({ nicknames: [] });
    const messages = Array.from({ length: 100 }, (_, index) => message(index));
    const sessionKey = sessionId(groupSession);
    const waterline = messages[49]?.time;
    assert.ok(waterline !== undefined && messages[49]);
    saveMessage(repository, messages[49]);
    repository.saveTagRun({ account: groupSession.account, sessionId: sessionKey, lastRunAt: waterline, lastMessageTime: waterline });
    for (const [index, costCny] of [0.01, 0.02, 0.03].entries()) {
      repository.recordUsage({
        time: index + 1,
        account: groupSession.account,
        slot: 'extract',
        provider: 'fixture',
        model: 'fixture-model',
        inputTokens: 1,
        cachedTokens: 0,
        outputTokens: 1,
        costCny,
        latencyMs: 1,
        ok: true,
      });
    }
    const adapter = new PagedAdapter();
    adapter.historyPages = [messages.slice(50), messages.slice(0, 50)];
    const modelCalls = { count: 0 };
    const impressions = createImpressionsService({
      repository,
      getConfig: () => config,
      callModel: async () => {
        modelCalls.count += 1;
        return {
          text: '{"group":{"observe":[],"new":[],"contradict":[]},"members":[]}',
          provider: 'fixture',
          model: 'fixture-model',
          usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0.01 },
        };
      },
    });
    const imports = createHistoryImportService({
      repository,
      getConfig: () => config,
      impressionsService: impressions,
      getTemplate: () => template,
      wait: async () => {},
    });

    const started = imports.start({ session: groupSession, target: 200, adapter, mode: 'incremental' });
    assert.ok(started);
    await imports.idle();
    const preview = imports.get(started.id);

    assert.equal(preview?.phase, 'awaiting_confirmation');
    assert.equal(preview?.fetched, 100);
    assert.equal(preview?.newMessages, 50);
    assert.equal(preview?.windowsTotal, 1);
    assert.equal(preview?.waterlineTime, waterline);
    assert.equal(preview?.estimatedCostCny, 0.02);
    assert.equal(modelCalls.count, 0);
    assert.equal(repository.getTagRun(groupSession.account, sessionKey)?.lastMessageTime, waterline);

    assert.equal(imports.confirm(started.id)?.phase, 'extracting');
    await imports.idle();
    assert.equal(imports.get(started.id)?.phase, 'done');
    assert.equal(repository.getTagRun(groupSession.account, sessionKey)?.lastMessageTime, messages[99]?.time);
  });
});

test('waterline advances after each completed extraction window', async () => {
  await withRepository(async (repository) => {
    const config = makeConfig({ nicknames: [] });
    const messages = Array.from({ length: 170 }, (_, index) => message(index));
    const adapter = new PagedAdapter();
    adapter.historyPages = [messages.slice(120), messages.slice(70, 120), messages.slice(20, 70), messages.slice(0, 20)];
    const waterlines: Array<number | null | undefined> = [];
    const impressions = createImpressionsService({
      repository,
      getConfig: () => config,
      callModel: async () => ({
        text: '{"group":{"observe":[],"new":[],"contradict":[]},"members":[]}',
        provider: 'fixture',
        model: 'fixture-model',
        usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
      }),
    });
    const imports = createHistoryImportService({
      repository,
      getConfig: () => config,
      impressionsService: impressions,
      getTemplate: () => template,
      wait: async (milliseconds) => {
        if (milliseconds === 1_000) waterlines.push(repository.getTagRun(groupSession.account, sessionId(groupSession))?.lastMessageTime);
      },
    });

    const started = imports.start({ session: groupSession, target: 200, adapter });
    assert.ok(started);
    await imports.idle();
    assert.equal(imports.get(started.id)?.newMessages, 170);
    assert.equal(repository.getTagRun(groupSession.account, sessionId(groupSession)), undefined);
    assert.equal(imports.confirm(started.id)?.phase, 'extracting');
    await imports.idle();

    assert.deepEqual(waterlines, [messages[79]?.time, messages[159]?.time]);
    assert.equal(repository.getTagRun(groupSession.account, sessionId(groupSession))?.lastMessageTime, messages[169]?.time);
  });
});

test('full mode reprocesses the fetched range even when every message is at or before the waterline', async () => {
  await withRepository(async (repository) => {
    const config = makeConfig({ nicknames: [] });
    const messages = Array.from({ length: 60 }, (_, index) => message(index));
    const sessionKey = sessionId(groupSession);
    const newest = messages[59];
    const oldest = messages[0];
    assert.ok(newest && oldest);
    saveMessage(repository, oldest);
    repository.saveTagRun({ account: groupSession.account, sessionId: sessionKey, lastRunAt: newest.time, lastMessageTime: newest.time });
    const adapter = new PagedAdapter();
    adapter.historyPages = [messages.slice(30), messages.slice(0, 30)];
    const calls = { count: 0 };
    const impressions = createImpressionsService({
      repository,
      getConfig: () => config,
      callModel: async () => {
        calls.count += 1;
        return {
          text: '{"group":{"observe":[],"new":[],"contradict":[]},"members":[]}',
          provider: 'fixture',
          model: 'fixture-model',
          usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
        };
      },
    });
    const imports = createHistoryImportService({ repository, getConfig: () => config, impressionsService: impressions, getTemplate: () => template });

    const started = imports.start({ session: groupSession, target: 200, adapter, mode: 'full' });
    assert.ok(started);
    await imports.idle();
    assert.equal(imports.get(started.id)?.newMessages, 60);
    assert.equal(imports.get(started.id)?.waterlineTime, newest.time);
    assert.equal(imports.confirm(started.id)?.phase, 'extracting');
    await imports.idle();

    assert.equal(imports.get(started.id)?.phase, 'done');
    assert.equal(calls.count, 1);
    assert.equal(repository.getTagRun(groupSession.account, sessionKey)?.lastMessageTime, newest.time);
  });
});

test('full mode continues after a stored first page and previews all local session messages', async () => {
  await withRepository(async (repository) => {
    const config = makeConfig({ nicknames: [] });
    const messages = Array.from({ length: 60 }, (_, index) => message(index));
    const localOnly = Array.from({ length: 30 }, (_, index) => message(index - 30));
    const sessionKey = sessionId(groupSession);
    for (const stored of localOnly) saveMessage(repository, stored);
    for (const stored of messages.slice(30)) saveMessage(repository, stored);
    for (const [index, costCny] of [0.01, 0.02, 0.03].entries()) {
      repository.recordUsage({
        time: index + 1,
        account: groupSession.account,
        slot: 'extract',
        provider: 'fixture',
        model: 'fixture-model',
        inputTokens: 1,
        cachedTokens: 0,
        outputTokens: 1,
        costCny,
        latencyMs: 1,
        ok: true,
      });
    }

    const adapter = new PagedAdapter();
    adapter.historyPages = [messages.slice(30), messages.slice(0, 30), []];
    const prompts: string[] = [];
    const impressions = createImpressionsService({
      repository,
      getConfig: () => config,
      callModel: async (_slot, messagesForPrompt) => {
        prompts.push(messagesForPrompt.map(({ content }) => String(content)).join('\n'));
        return {
          text: '{"group":{"observe":[],"new":[],"contradict":[]},"members":[]}',
          provider: 'fixture',
          model: 'fixture-model',
          usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
        };
      },
    });
    const imports = createHistoryImportService({
      repository,
      getConfig: () => config,
      impressionsService: impressions,
      getTemplate: () => template,
      wait: async () => {},
    });

    const started = imports.start({ session: groupSession, target: 200, adapter, mode: 'full' });
    assert.ok(started);
    await imports.idle();

    assert.equal(adapter.historyCalls, 3);
    assert.equal(imports.get(started.id)?.fetched, 60);
    assert.equal(imports.get(started.id)?.newMessages, 90);
    assert.equal(imports.get(started.id)?.windowsTotal, 2);
    assert.equal(imports.get(started.id)?.estimatedCostCny, 0.04);
    assert.equal(imports.get(started.id)?.phase, 'awaiting_confirmation');
    assert.ok(imports.confirm(started.id));
    await imports.idle();

    assert.equal(imports.get(started.id)?.phase, 'done');
    assert.equal(imports.get(started.id)?.windowsDone, 2);
    const prompt = prompts.join('\n');
    assert.ok(prompt.includes('#m3--30'));
    assert.ok(prompt.includes('#m3-000'));
    assert.ok(prompt.includes('#m3-059'));
    assert.equal(repository.getTagRun(groupSession.account, sessionKey)?.lastMessageTime, messages[59]?.time);
  });
});

test('reimporting the same evidence message does not increase samples or refresh lastSeen', async () => {
  await withRepository(async (repository) => {
    const config = makeConfig({ nicknames: [] });
    const input = message(0);
    let calls = 0;
    const impressions = createImpressionsService({
      repository,
      getConfig: () => config,
      callModel: async () => {
        calls += 1;
        return {
          text: JSON.stringify({
            group: {
              observe: [],
              new: [{
                text: '喜欢解谜游戏', messageId: input.messageId, category: 'topic', subject: null,
                polarity: null, origin: 'inferred', sensitive: false,
              }],
              contradict: [],
            },
            members: [],
          }),
          provider: 'fixture',
          model: 'fixture-model',
          usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
        };
      },
    });
    const imports = createHistoryImportService({ repository, getConfig: () => config, impressionsService: impressions, getTemplate: () => template });

    for (let run = 0; run < 2; run += 1) {
      const adapter = new PagedAdapter();
      adapter.historyPages = [[input]];
      const started = imports.start({ session: groupSession, target: 200, adapter, mode: 'full' });
      assert.ok(started);
      await imports.idle();
      assert.equal(imports.get(started.id)?.phase, 'awaiting_confirmation');
      assert.equal(imports.confirm(started.id)?.phase, 'extracting');
      await imports.idle();
      assert.equal(imports.get(started.id)?.phase, 'done');
    }

    const learned = repository.listTagsForSubject(groupSession.account, sessionId(groupSession), null)[0];
    assert.equal(calls, 2);
    assert.equal(learned?.samples, 1);
    assert.equal(learned?.lastSeen, input.time);
    assert.deepEqual(learned?.evidence.map((item) => item.messageId), [input.messageId]);
  });
});

test('a changed waterline refreshes the preview and requires confirmation again', async () => {
  await withRepository(async (repository) => {
    const config = makeConfig({ nicknames: [] });
    const messages = [message(0), message(1)];
    const adapter = new PagedAdapter();
    adapter.historyPages = [messages, []];
    const calls = { count: 0 };
    const impressions = createImpressionsService({
      repository,
      getConfig: () => config,
      callModel: async () => {
        calls.count += 1;
        return {
          text: '{"group":{"observe":[],"new":[],"contradict":[]},"members":[]}',
          provider: 'fixture',
          model: 'fixture-model',
          usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
        };
      },
    });
    const imports = createHistoryImportService({ repository, getConfig: () => config, impressionsService: impressions, getTemplate: () => template });

    const started = imports.start({ session: groupSession, target: 200, adapter });
    assert.ok(started);
    await imports.idle();
    assert.equal(imports.get(started.id)?.newMessages, 2);
    const first = messages[0];
    assert.ok(first);
    repository.saveTagRun({ account: groupSession.account, sessionId: sessionId(groupSession), lastRunAt: first.time, lastMessageTime: first.time });

    const refreshed = imports.confirm(started.id);
    assert.equal(refreshed?.phase, 'awaiting_confirmation');
    assert.equal(refreshed?.newMessages, 1);
    assert.equal(refreshed?.previewChanged, true);
    assert.equal(calls.count, 0);
    assert.equal(imports.confirm(started.id)?.phase, 'extracting');
    await imports.idle();
    assert.equal(imports.get(started.id)?.phase, 'done');
    assert.equal(calls.count, 1);
  });
});

test('an unconfirmed preview expires and releases the session after its bounded lifetime', async () => {
  await withRepository(async (repository) => {
    const config = makeConfig({ nicknames: [] });
    let clock = 1_000;
    const adapter = new PagedAdapter();
    adapter.historyPages = [[message(0), message(1)]];
    const impressions = createImpressionsService({ repository, getConfig: () => config, callModel: async () => {
      throw new Error('expired preview must never extract');
    } });
    const imports = createHistoryImportService({
      repository,
      getConfig: () => config,
      impressionsService: impressions,
      getTemplate: () => template,
      now: () => clock,
      wait: async () => {},
    });
    const started = imports.start({ session: groupSession, target: 200, adapter });
    assert.ok(started);
    await imports.idle();
    const preview = imports.get(started.id);
    assert.equal(preview?.phase, 'awaiting_confirmation');
    assert.equal(preview?.confirmationExpiresAt, clock + 15 * 60_000);

    clock += 15 * 60_000;
    assert.equal(imports.get(started.id)?.phase, 'expired');
    assert.equal(imports.isRunning(sessionId(groupSession)), false);
    assert.equal(imports.confirm(started.id), undefined);
  });
});

test('精细分析用 oneoff 槽展示预估，并只保存窗口内真实消息出处', async () => {
  await withRepository(async (repository) => {
    const baseConfig = makeConfig({ nicknames: [] });
    const config = { ...baseConfig, budget: { ...baseConfig.budget, dailyCny: 0 } };
    const messages = Array.from({ length: 400 }, (_, index) => message(index));
    repository.recordUsage({
      time: 1,
      account: groupSession.account,
      slot: 'oneoff',
      provider: 'fixture',
      model: 'fixture-model',
      inputTokens: 20,
      cachedTokens: 0,
      outputTokens: 10,
      costCny: 0.07,
      latencyMs: 1,
      ok: true,
    });
    const adapter = new PagedAdapter();
    adapter.historyPages = [
      messages.slice(350), messages.slice(300, 350), messages.slice(250, 300), messages.slice(200, 250),
      messages.slice(150, 200), messages.slice(100, 150), messages.slice(50, 100), messages.slice(0, 50),
    ];
    const calls: Array<{ slot: string; prompt: string; budgetScope?: string; taskCost?: number }> = [];
    const impressions = createImpressionsService({
      repository,
      getConfig: () => config,
      callModel: async (slot, prompt, callOptions) => {
        calls.push({
          slot,
          prompt: prompt.map(({ content }) => String(content)).join('\n'),
          budgetScope: callOptions.budgetScope,
          taskCost: callOptions.oneoffTaskCostCny?.(),
        });
        callOptions.recordUsage({
          time: 2,
          account: callOptions.account,
          slot: 'oneoff',
          provider: 'fixture',
          model: 'fixture-model',
          inputTokens: 20,
          cachedTokens: 0,
          outputTokens: 10,
          costCny: 0.05,
          latencyMs: 1,
          ok: true,
        });
        return {
          text: JSON.stringify({
            group: {
              observe: [],
              new: [
                {
                  text: calls.length === 1 ? '真实兴趣一' : '真实兴趣二',
                  messageId: calls.length === 1 ? 'm3-199' : 'm3-399',
                  category: 'topic', subject: null, polarity: null, origin: 'inferred', sensitive: false,
                },
                { text: '虚构出处', messageId: 'fabricated-id', category: 'topic', subject: null, polarity: null, origin: 'inferred', sensitive: false },
              ],
              contradict: [],
            },
            members: [],
          }),
          provider: 'fixture',
          model: 'fixture-model',
          usage: { inputTokens: 20, cachedTokens: 0, outputTokens: 10, costCny: 0.05 },
        };
      },
    });
    const imports = createHistoryImportService({
      repository,
      getConfig: () => config,
      impressionsService: impressions,
      getTemplate: () => template,
      wait: async () => {},
    });

    const started = imports.start({ session: groupSession, target: 500, adapter, fineAnalysis: true });
    assert.ok(started);
    await imports.idle();
    const preview = imports.get(started.id);
    assert.equal(preview?.phase, 'awaiting_confirmation');
    assert.equal(preview?.fineAnalysis, true);
    assert.equal(preview?.fetched, 400);
    assert.equal(preview?.windowsTotal, 2);
    assert.equal(preview?.estimatedCostCny, 0.14);

    assert.equal(imports.confirm(started.id)?.phase, 'extracting');
    await imports.idle();
    const completed = imports.get(started.id);
    assert.equal(completed?.phase, 'done');
    assert.equal(completed?.windowsDone, 2);
    assert.equal(completed?.windowsFailed, 0);
    assert.equal(completed?.costCny, 0.1);
    assert.deepEqual(calls.map(({ slot, budgetScope, taskCost }) => ({ slot, budgetScope, taskCost })), [
      { slot: 'oneoff', budgetScope: 'oneoff', taskCost: 0 },
      { slot: 'oneoff', budgetScope: 'oneoff', taskCost: 0.05 },
    ]);
    assert.ok(calls[0]?.prompt.includes('#m3-000'));
    assert.ok(calls[0]?.prompt.includes('#m3-199'));
    assert.equal(calls[0]?.prompt.includes('#m3-200'), false);
    assert.ok(calls[1]?.prompt.includes('#m3-200'));
    assert.ok(calls[1]?.prompt.includes('#m3-399'));
    const tags = repository.listTagsForSubject(groupSession.account, sessionId(groupSession), null);
    const tagEvidence = tags.map((tag) => ({ text: tag.text, messageId: tag.evidence[0]?.messageId }));
    tagEvidence.sort((first, second) => (first.messageId ?? '').localeCompare(second.messageId ?? ''));
    assert.deepEqual(tagEvidence, [
      { text: '真实兴趣一', messageId: 'm3-199' },
      { text: '真实兴趣二', messageId: 'm3-399' },
    ]);
  });
});
