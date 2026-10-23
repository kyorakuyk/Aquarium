import { Hono } from 'hono';
import { z } from 'zod';
import type { AquariumConfig } from '../config/schema.ts';
import { redactSensitiveText } from '../core/impressions/sensitive-text.ts';
import type { StoreRepository } from '../store/repository.ts';
import type { PanelAccountRuntime } from './types.ts';

interface EventRouteOptions {
  getConfig: () => AquariumConfig;
  repository: StoreRepository;
  accounts: () => PanelAccountRuntime[];
  now?: () => number;
}

const patchSchema = z.object({
  intent: z.enum(['confide', 'clarify', 'advocate']).optional(),
  level: z.enum(['L0', 'L1', 'L2']).optional(),
}).strict().refine((patch) => patch.intent !== undefined || patch.level !== undefined);

function positiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function requestedAccount(raw: string | undefined, options: EventRouteOptions): number | undefined {
  const runtimeAccounts = options.accounts().map((runtime) => runtime.adapter.account);
  const account = raw === undefined
    ? runtimeAccounts[0] ?? options.getConfig().accounts[0]?.uin
    : positiveInteger(raw);
  return account !== undefined && runtimeAccounts.includes(account) ? account : undefined;
}

function levelForIntent(intent: 'confide' | 'clarify' | 'advocate'): 'L0' | 'L1' | 'L2' {
  return intent === 'confide' ? 'L0' : intent === 'clarify' ? 'L1' : 'L2';
}

function eventNoteView(options: EventRouteOptions, account: number, eventId: number, note: {
  id: number;
  ownerId: number;
  text: string;
  intent: 'confide' | 'clarify' | 'advocate';
  level: 'L0' | 'L1' | 'L2';
  status: 'active' | 'retracted';
  createdAt: number;
  updatedAt: number;
}) {
  const action = options.repository.eventAdvocacyByEvent(account, eventId);
  const ownerName = options.repository.latestSenderNameForAccount(account, note.ownerId);
  return {
    id: note.id,
    ownerId: note.ownerId,
    ownerName: redactSensitiveText(ownerName ?? '成员'),
    text: redactSensitiveText(note.text),
    intent: note.intent,
    level: note.level,
    status: note.status,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    ...(action?.ownerId === note.ownerId ? { advocacyStatus: action.status } : {}),
  };
}

export function registerEventRoutes(app: Hono, options: EventRouteOptions): void {
  const now = options.now ?? Date.now;

  app.get('/api/events', (context) => {
    const account = requestedAccount(context.req.query('account'), options);
    if (account === undefined) return context.json({ error: 'Invalid account' }, 400);
    const groupIds = options.repository.listRecentGroupEventGroupIds(account, 0);
    const events = groupIds.flatMap((groupId) => (
      options.repository.listGroupEvents(account, groupId, 0, 1_000)
    )).sort((first, second) => second.occurredAt - first.occurredAt || second.id - first.id).slice(0, 200);
    return context.json({
      account,
      events: events.map((event) => ({
        id: event.id,
        sourceGroupId: event.sourceGroupId,
        title: redactSensitiveText(event.title),
        summary: redactSensitiveText(event.summary),
        occurredAt: event.occurredAt,
        notes: options.repository.listGroupEventNotesForEvent(account, event.id)
          .map((note) => eventNoteView(options, account, event.id, note)),
      })),
    });
  });

  app.patch('/api/events/:eventId/notes/:noteId', async (context) => {
    const eventId = positiveInteger(context.req.param('eventId'));
    const noteId = positiveInteger(context.req.param('noteId'));
    if (eventId === undefined || noteId === undefined) return context.json({ error: 'Invalid event or note ID' }, 400);
    const account = requestedAccount(context.req.query('account'), options);
    if (account === undefined) return context.json({ error: 'Invalid account' }, 400);
    let body: unknown;
    try { body = await context.req.json(); } catch { return context.json({ error: 'Invalid JSON' }, 400); }
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) return context.json({ error: 'Invalid event note patch' }, 400);
    if (!options.repository.getGroupEvent(account, eventId)) {
      return context.json({ error: 'Group event not found' }, 404);
    }
    const current = options.repository.listGroupEventNotesForEvent(account, eventId)
      .find((note) => note.id === noteId);
    if (!current) return context.json({ error: 'Event note not found' }, 404);

    const intent = parsed.data.intent ?? current.intent;
    let level = parsed.data.level ?? current.level;
    let status = current.status;
    if (parsed.data.intent !== undefined) {
      if (intent === 'confide') {
        level = 'L0';
        status = 'retracted';
      } else {
        if (parsed.data.level === undefined) level = levelForIntent(intent);
        status = 'active';
      }
    }
    const updatedAt = now();
    const updated = options.repository.transaction(() => {
      const note = options.repository.updateGroupEventNote(account, noteId, {
        sourceSessionId: current.sourceSessionId,
        text: current.text,
        intent,
        level,
        status,
        sourceMessageIds: current.sourceMessageIds,
        updatedAt,
      });
      if (!note) return undefined;
      const changed = note.intent !== current.intent || note.level !== current.level || note.status !== current.status;
      if (changed) options.repository.cancelEventAdvocacy(account, eventId, current.ownerId, updatedAt);
      if (note.intent === 'advocate' && note.level === 'L2' && note.status === 'active') {
        options.repository.ensureEventAdvocacyPending({
          account,
          eventId,
          ownerId: note.ownerId,
          sourceSessionId: note.sourceSessionId,
          requestedAt: updatedAt,
        });
      }
      return options.repository.listGroupEventNotesForEvent(account, eventId)
        .find((candidate) => candidate.id === noteId);
    });
    if (!updated || updated.intent !== intent || updated.level !== level || updated.status !== status) {
      return context.json({ error: 'Event note update could not be verified' }, 500);
    }
    return context.json({ note: eventNoteView(options, account, eventId, updated) });
  });
}
