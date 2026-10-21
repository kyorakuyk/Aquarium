import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../src/store/db.ts';
import { createRepository } from '../src/store/repository.ts';
import { createActivitySuggestionRepository } from '../src/store/activity-suggestion-repo.ts';
import { createProfileActivityService } from '../src/core/profiles/presence-service.ts';
import { makeConfig } from './pipeline-test-helpers.ts';

const account = 7;
const sessionId = `${account}:group:9`;

function saveMessage(repository: ReturnType<typeof createRepository>, time: number, messageId: string): void {
  repository.saveMessage({
    sessionId,
    messageId,
    senderId: 42,
    senderName: '好友',
    isSelf: false,
    plainText: 'private-secret-marker',
    segments: [{ type: 'text', text: 'private-secret-marker' }],
    time,
  });
}

test('stats 作息标签满足两天转正，连续三天不满足后只删除 stats 标签', async () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    const suggestionRepository = createActivitySuggestionRepository(database);
    const firstRun = new Date(2026, 5, 1, 4, 0, 0, 0).getTime();
    for (let index = 1; index <= 70; index += 1) {
      const time = new Date(firstRun);
      time.setDate(time.getDate() - index);
      time.setHours(23, 0, 0, 0);
      saveMessage(repository, time.getTime(), `night-${index}`);
    }
    const base = makeConfig();
    let nightOwlRatio = 0.4;
    const service = createProfileActivityService({
      repository,
      suggestionRepository,
      getConfig: () => ({
        ...base,
        profile: { schedule: { ...base.profile.schedule, nightOwlRatio } },
      }),
      now: () => firstRun,
    });

    await service.recomputeSchedules(firstRun);
    let tags = repository.listTagsForSession(account, sessionId);
    let statsTag = tags.find((tag) => tag.text === '夜猫子' && tag.origin === 'stats');
    assert.equal(statsTag?.status, 'candidate');
    assert.equal(statsTag?.samples, 1);
    assert.ok(!statsTag?.evidence[0]?.quote.includes('private-secret-marker'));

    const secondRun = new Date(firstRun);
    secondRun.setDate(secondRun.getDate() + 1);
    await service.recomputeSchedules(secondRun.getTime());
    tags = repository.listTagsForSession(account, sessionId);
    statsTag = tags.find((tag) => tag.text === '夜猫子' && tag.origin === 'stats');
    assert.equal(statsTag?.status, 'confirmed');
    assert.equal(statsTag?.samples, 2);

    const manualId = repository.insertTag({
      account,
      sessionId,
      userId: 42,
      text: '夜猫子',
      norm: '夜猫子',
      category: 'schedule',
      subject: null,
      polarity: null,
      origin: 'manual',
      locked: false,
      status: 'confirmed',
      source: 'manual',
      samples: 1,
      evidence: [],
      firstSeen: secondRun.getTime(),
      lastSeen: secondRun.getTime(),
      supersededBy: null,
      updatedAt: secondRun.getTime(),
    });
    nightOwlRatio = 1;
    for (let miss = 1; miss <= 3; miss += 1) {
      const run = new Date(firstRun);
      run.setDate(run.getDate() + miss + 1);
      const daytime = new Date(run);
      daytime.setDate(daytime.getDate() - 1);
      daytime.setHours(12, 0, 0, 0);
      saveMessage(repository, daytime.getTime(), `day-${miss}`);
      await service.recomputeSchedules(run.getTime());
    }

    tags = repository.listTagsForSession(account, sessionId);
    assert.equal(tags.some((tag) => tag.origin === 'stats' && tag.text === '夜猫子'), false);
    assert.equal(repository.tagById(manualId)?.origin, 'manual');
  } finally {
    database.close();
  }
});

test('stats 按周末日均与早间占比生成作息标签', async () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    const suggestionRepository = createActivitySuggestionRepository(database);
    const config = makeConfig();
    const firstRun = new Date(2026, 5, 1, 4, 0, 0, 0).getTime();
    const start = new Date(firstRun);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - 89);
    let weekendMessages = 0;
    let weekdayMessages = 0;
    for (let dayIndex = 0; dayIndex < 90; dayIndex += 1) {
      const day = new Date(start);
      day.setDate(day.getDate() + dayIndex);
      const weekday = day.getDay();
      if ((weekday === 0 || weekday === 6) && weekendMessages < 90) {
        const count = Math.min(4, 90 - weekendMessages);
        for (let messageIndex = 0; messageIndex < count; messageIndex += 1) {
          const messageTime = new Date(day);
          messageTime.setHours(12, messageIndex, 0, 0);
          saveMessage(repository, messageTime.getTime(), `weekend-${weekendMessages}`);
          weekendMessages += 1;
        }
      } else if (weekday !== 0 && weekday !== 6 && weekdayMessages < 40) {
        const messageTime = new Date(day);
        messageTime.setHours(12, 0, 0, 0);
        saveMessage(repository, messageTime.getTime(), `weekday-${weekdayMessages}`);
        weekdayMessages += 1;
      }
    }
    assert.equal(weekendMessages, 90);
    assert.equal(weekdayMessages, 40);
    const service = createProfileActivityService({
      repository,
      suggestionRepository,
      getConfig: () => config,
      now: () => firstRun,
    });

    await service.recomputeSchedules(firstRun);
    let tags = repository.listTagsForSession(account, sessionId);
    assert.equal(tags.find((tag) => tag.text === '周末更活跃' && tag.origin === 'stats')?.status, 'candidate');
    assert.equal(tags.find((tag) => tag.text === '早上不在线' && tag.origin === 'stats')?.status, 'candidate');
    assert.equal(tags.some((tag) => tag.text === '夜猫子' && tag.origin === 'stats'), false);

    const secondRun = new Date(firstRun);
    secondRun.setDate(secondRun.getDate() + 1);
    await service.recomputeSchedules(secondRun.getTime());
    tags = repository.listTagsForSession(account, sessionId);
    assert.equal(tags.find((tag) => tag.text === '周末更活跃' && tag.origin === 'stats')?.samples, 2);
    assert.equal(tags.find((tag) => tag.text === '早上不在线' && tag.origin === 'stats')?.samples, 2);
  } finally {
    database.close();
  }
});

test('群和群友按本地最活跃三小时生成标签，群级星期标签按占比生成', async () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    const suggestionRepository = createActivitySuggestionRepository(database);
    const config = makeConfig();
    const at = new Date(2026, 5, 1, 4, 0, 0, 0).getTime();
    const start = new Date(at);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - 89);
    let messageIndex = 0;
    for (let dayIndex = 0; dayIndex < 90; dayIndex += 1) {
      const day = new Date(start);
      day.setDate(day.getDate() + dayIndex);
      const count = day.getDay() === 1 ? 3 : day.getDay() === 2 ? 2 : 0;
      for (let index = 0; index < count; index += 1) {
        const messageTime = new Date(day);
        messageTime.setHours(20 + index, 0, 0, 0);
        if (messageTime.getTime() <= at) {
          saveMessage(repository, messageTime.getTime(), `peak-${messageIndex}`);
          messageIndex += 1;
        }
      }
    }
    assert.ok(messageIndex >= 50);
    const service = createProfileActivityService({
      repository,
      suggestionRepository,
      getConfig: () => config,
      now: () => at,
    });

    await service.recomputeSchedules(at);

    const tags = repository.listTagsForSession(account, sessionId);
    const groupTags = tags.filter((tag) => tag.userId === null && tag.origin === 'stats');
    const memberTags = tags.filter((tag) => tag.userId === 42 && tag.origin === 'stats');
    assert.ok(
      groupTags.some((tag) => tag.text === '「20:00–23:00 点最热闹」' && tag.category === 'schedule'),
      JSON.stringify(groupTags.map(({ text, userId }) => ({ text, userId }))),
    );
    assert.ok(groupTags.some((tag) => tag.text === '周一最热闹'));
    assert.ok(groupTags.some((tag) => tag.text === '周二最热闹'));
    assert.ok(memberTags.some((tag) => tag.text === '「20:00–23:00 点最活跃」'));
    assert.equal(groupTags.some((tag) => tag.text === '夜猫子' || tag.text === '早上不在线'), false);
  } finally {
    database.close();
  }
});

test('小号消息参与主号的作息标签统计', async () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    const suggestionRepository = createActivitySuggestionRepository(database);
    const base = makeConfig();
    const config = {
      ...base,
      profile: { schedule: { ...base.profile.schedule, minimumMessages: 20 } },
    };
    const at = new Date(2026, 5, 1, 4, 0, 0, 0).getTime();
    for (let index = 0; index < 30; index += 1) {
      const time = new Date(at);
      time.setDate(time.getDate() - index - 1);
      time.setHours(23, 0, 0, 0);
      repository.saveMessage({
        sessionId,
        messageId: `alt-schedule-${index}`,
        senderId: 43,
        senderName: '小号',
        isSelf: false,
        plainText: '晚间消息',
        segments: [{ type: 'text', text: '晚间消息' }],
        time: time.getTime(),
      });
    }
    repository.linkAltAccount({ account, aUserId: 42, bUserId: 43, createdAt: at });
    const service = createProfileActivityService({
      repository,
      suggestionRepository,
      getConfig: () => config,
      now: () => at,
    });

    await service.recomputeSchedules(at);
    const tags = repository.listTagsForSession(account, sessionId);
    assert.equal(tags.some((tag) => tag.userId === 42 && tag.text === '夜猫子' && tag.origin === 'stats'), true);
    assert.equal(tags.some((tag) => tag.userId === 43 && tag.origin === 'stats'), false);
  } finally {
    database.close();
  }
});
