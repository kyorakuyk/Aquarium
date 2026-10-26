import type { Hono } from 'hono';
import { z } from 'zod';
import type { AquariumConfig } from '../config/schema.ts';
import { parseSessionId } from '../core/conversation/sessions.ts';
import { redactSensitiveText } from '../core/impressions/sensitive-text.ts';
import { memorySilenceMs } from '../core/persona-memory-segments.ts';
import type { StoreRepository } from '../store/repository.ts';
import type { PanelAccountRuntime } from './types.ts';

export interface PersonaMemoryRouteOptions {
  repository: StoreRepository;
  getConfig: () => AquariumConfig;
  accounts: () => PanelAccountRuntime[];
  now?: () => number;
}

const visibilitySchema = z.object({ visibleToAni: z.boolean() }).strict();
const MEMORY_VIEW_LIMIT = 100;

function positiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function activeAccount(options: PersonaMemoryRouteOptions, raw: string | undefined): number | undefined {
  const account = positiveInteger(raw);
  if (account === undefined) return undefined;
  if (!options.getConfig().accounts.some((entry) => entry.uin === account)
    || !options.accounts().some((runtime) => runtime.adapter.account === account)) return undefined;
  return account;
}

function safeMemoText(text: string): string {
  return redactSensitiveText(text);
}

export function registerPersonaMemoryRoutes(app: Hono, options: PersonaMemoryRouteOptions): void {
  app.get('/api/persona-memory/accounts', (context) => context.json(
    options.getConfig().accounts.flatMap((configured) => {
      const runtime = options.accounts().find((candidate) => candidate.adapter.account === configured.uin);
      return runtime ? [{ account: configured.uin, name: runtime.getNickname() }] : [];
    }).sort((left, right) => left.account - right.account),
  ));

  app.get('/api/persona-memory', (context) => {
    const account = activeAccount(options, context.req.query('account'));
    if (account === undefined) return context.json({ error: 'Unknown account' }, 400);
    const cursors = options.repository.listPersonaMemoryCursorSummaries(account);
    const pendingMessageCount = cursors.reduce((total, cursor) => total + cursor.pendingMessageCount, 0);
    const cacheSessions = cursors.flatMap((cursor) => {
      const session = parseSessionId(cursor.sessionId);
      if (!session || session.account !== account) return [];
      return [{
        sessionId: cursor.sessionId,
        label: `${session.kind === 'group' ? '群聊' : '私聊'} ${session.peer}`,
        pendingMessageCount: cursor.pendingMessageCount,
      }];
    });
    const now = options.now?.() ?? Date.now();
    const openSegmentCount = cursors.filter((cursor) => {
      if (cursor.openSegmentStart === null || cursor.pendingMessageCount === 0 || cursor.latestPendingMessageTime === null) {
        return false;
      }
      const session = parseSessionId(cursor.sessionId);
      return session?.account === account
        && now - cursor.latestPendingMessageTime < memorySilenceMs(session.kind);
    }).length;
    const memos = options.repository.listPersonaEventMemos(account, MEMORY_VIEW_LIMIT).map((memo) => ({
      id: memo.id,
      eventId: memo.eventId,
      title: safeMemoText(memo.title),
      summary: safeMemoText(memo.summary),
      participantIds: memo.participantIds,
      startMessageId: memo.startMessageId,
      endMessageId: memo.endMessageId,
      level: memo.level,
      createdAt: memo.createdAt,
      diaryCycle: memo.diaryCycle,
    }));
    const diaries = options.repository.listPersonaDiaries(account, MEMORY_VIEW_LIMIT).map((diary) => ({
      id: diary.id,
      account: diary.account,
      cycleKey: diary.cycleKey,
      text: safeMemoText(diary.text),
      sourceMemoIds: diary.sourceMemoIds,
      visibleToAni: diary.visibleToAni,
      sourceCount: diary.sourceCount,
      createdAt: diary.createdAt,
    }));
    return context.json({ account, pendingMessageCount, openSegmentCount, cacheSessions, memos, diaries });
  });

  app.delete('/api/persona-memory/cache', (context) => {
    const account = activeAccount(options, context.req.query('account'));
    if (account === undefined) return context.json({ error: 'Unknown account' }, 400);
    const rawSessionId = context.req.query('sessionId');
    if (rawSessionId !== undefined && parseSessionId(rawSessionId)?.account !== account) {
      return context.json({ error: 'Invalid session ID' }, 400);
    }
    const deletedMessages = options.repository.clearOrganizedPersonaMemoryMessages(account, rawSessionId);
    return context.json({ account, sessionId: rawSessionId ?? null, deletedMessages });
  });

  app.patch('/api/persona-memory/diaries/:id', async (context) => {
    const account = activeAccount(options, context.req.query('account'));
    if (account === undefined) return context.json({ error: 'Unknown account' }, 400);
    const id = positiveInteger(context.req.param('id'));
    if (id === undefined) return context.json({ error: 'Invalid diary ID' }, 400);
    let raw: unknown;
    try { raw = await context.req.json(); } catch { return context.json({ error: 'Invalid JSON' }, 400); }
    const parsed = visibilitySchema.safeParse(raw);
    if (!parsed.success) return context.json({ error: 'Invalid diary visibility' }, 400);
    const existing = options.repository.listPersonaDiaries(account, MEMORY_VIEW_LIMIT).find((diary) => diary.id === id);
    if (!existing) return context.json({ error: 'Diary not found' }, 404);
    if (!options.repository.setPersonaDiaryVisibility(account, id, parsed.data.visibleToAni)) {
      return context.json({ error: 'Diary not found' }, 404);
    }
    const diary = options.repository.listPersonaDiaries(account, MEMORY_VIEW_LIMIT).find((candidate) => candidate.id === id);
    if (!diary || diary.visibleToAni !== parsed.data.visibleToAni) {
      return context.json({ error: 'Diary visibility could not be verified' }, 500);
    }
    return context.json({ diary: { id: diary.id, account: diary.account, visibleToAni: diary.visibleToAni } });
  });
}
