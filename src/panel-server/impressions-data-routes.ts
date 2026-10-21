import type { Hono } from 'hono';
import type { AquariumConfig } from '../config/schema.ts';
import { parseSessionId } from '../core/conversation/sessions.ts';
import { buildActivityResponse, localStartOfDays } from '../core/profiles/presence.ts';
import { normalizeTagText } from '../core/impressions/tags.ts';
import { redactSensitiveText } from '../core/impressions/sensitive-text.ts';
import { normalizeTagSubjectPath } from '../core/impressions/tag-model.ts';
import type { StoredTag } from '../store/affect-repo.ts';
import type { MemberSummaryRepository } from '../store/member-summary-repo.ts';
import type { TagSubjectRepository } from '../store/tag-subject-repo.ts';
import type { StoreRepository } from '../store/repository.ts';
import { writeImpressionsBackup } from './impressions-data-backup.ts';
import { applyImpressionsImport, previewImpressionsImport } from './impressions-data-import.ts';
import { importFileSchema, impressionsResetSchema } from './impressions-data-schema.ts';
import type { ContactSnapshot, PanelAccountRuntime } from './types.ts';

const DEFAULT_INCLUDES = ['tags', 'summaries', 'subjects', 'vetoes', 'relations'] as const;
const ALLOWED_INCLUDES = new Set([...DEFAULT_INCLUDES, 'activity', 'l1']);

type ImpressionsInclude = (typeof DEFAULT_INCLUDES)[number] | 'activity' | 'l1';

export interface ImpressionsDataRouteOptions {
  root: string;
  getConfig: () => AquariumConfig;
  repository: StoreRepository;
  accounts: () => PanelAccountRuntime[];
  loadContacts: (runtime: PanelAccountRuntime) => Promise<ContactSnapshot>;
  tagSubjects?: TagSubjectRepository;
  summaries?: MemberSummaryRepository;
  now: () => number;
}

function includedItems(raw: string | undefined): Set<ImpressionsInclude> | undefined {
  if (raw === undefined) return new Set(DEFAULT_INCLUDES);
  const values = raw.split(',');
  if (values.some((value) => !ALLOWED_INCLUDES.has(value as ImpressionsInclude))
    || new Set(values).size !== values.length) return undefined;
  return new Set(values as ImpressionsInclude[]);
}

function exportedTag(tag: StoredTag) {
  const text = redactSensitiveText(tag.text);
  return {
    userId: tag.userId,
    text,
    norm: normalizeTagText(text),
    category: tag.category,
    subject: tag.subject === null ? null : redactSensitiveText(tag.subject),
    polarity: tag.polarity,
    origin: tag.origin,
    locked: tag.locked,
    status: tag.status,
    source: tag.source,
    samples: tag.samples,
    evidence: tag.evidence.map((item) => item.kind === 'signature'
      ? { kind: item.kind, text: redactSensitiveText(item.text), fetchedAt: item.fetchedAt }
      : { kind: 'message' as const, messageId: item.messageId, time: item.time, quote: redactSensitiveText(item.quote) }),
    firstSeen: tag.firstSeen,
    lastSeen: tag.lastSeen,
    updatedAt: tag.updatedAt,
  };
}

function groupMembers(tags: readonly StoredTag[], account: number, repository: StoreRepository): number[] {
  return [...new Set(tags.flatMap((tag) => tag.userId === null ? [] : [
    tag.userId,
    repository.mainUserIdFor(account, tag.userId),
  ]))].sort((left, right) => left - right);
}

async function groupNameFor(options: ImpressionsDataRouteOptions, account: number, groupId: number): Promise<string | undefined> {
  const runtime = options.accounts().find((candidate) => candidate.adapter.account === account);
  if (!runtime) return undefined;
  const contacts = await options.loadContacts(runtime);
  return contacts.groups.find((group) => group.groupId === groupId)?.name.trim() || undefined;
}

function exportDocument(options: ImpressionsDataRouteOptions, input: {
  account: number;
  sessionId: string;
  groupName: string;
  at: number;
  includes: ReadonlySet<ImpressionsInclude>;
}): Record<string, unknown> {
  const { account, sessionId, groupName, at, includes } = input;
  const sessionTags = options.repository.listTagsForSession(account, sessionId);
  const tags = sessionTags.filter((tag) => tag.status !== 'superseded');
  const memberIds = groupMembers(sessionTags, account, options.repository);
  const exported: Record<string, unknown> = {
    version: 1,
    exportedAt: new Date(at).toISOString(),
    account,
    sessionId,
    groupName,
    accountKinds: options.repository.listAccountKinds(account)
      .filter((kind) => memberIds.includes(kind.userId))
      .map(({ userId, kind, createdAt }) => ({ userId, kind, createdAt })),
  };
  if (includes.has('tags')) exported.tags = tags.map(exportedTag);
  if (includes.has('summaries')) {
    const groupSummary = options.repository.getGroupSummary(account, sessionId);
    if (groupSummary) {
      exported.groupSummary = {
        text: redactSensitiveText(groupSummary.text),
        manual: groupSummary.manual,
        updatedAt: groupSummary.updatedAt,
      };
    }
    exported.summaries = memberIds.flatMap((userId) => {
      const summary = options.summaries?.get(account, userId);
      return summary ? [{ userId, text: redactSensitiveText(summary.text), manual: summary.manual, updatedAt: summary.updatedAt }] : [];
    });
  }
  if (includes.has('subjects')) {
    const categories = new Set(tags.filter((tag) => tag.category === 'topic' || tag.category === 'fandom')
      .map((tag) => tag.category));
    exported.subjects = [...categories].flatMap((category) => options.tagSubjects?.listTagSubjects(account, category) ?? [])
      .map(({ category, name, aliases }) => ({
        category,
        name: redactSensitiveText(name),
        aliases: aliases.map(redactSensitiveText),
      }));
  }
  if (includes.has('vetoes')) {
    exported.vetoes = options.repository.listTagVetoes(account, sessionId).map((veto) => ({
      userId: veto.userId,
      category: veto.category,
      subjectNorm: normalizeTagSubjectPath(redactSensitiveText(veto.subjectNorm)) ?? '',
      textNorm: normalizeTagText(redactSensitiveText(veto.textNorm)),
      createdAt: veto.createdAt,
    }));
  }
  if (includes.has('relations')) {
    const relations = new Map<number, ReturnType<StoreRepository['listRelationsForUser']>[number]>();
    for (const userId of memberIds) {
      for (const relation of options.repository.listRelationsForUser(account, userId)) relations.set(relation.id, relation);
    }
    exported.relations = [...relations.values()].map(({ aUserId, bUserId, type, label, locked, createdAt }) => ({
      aUserId,
      bUserId,
      type,
      label: label === null ? null : redactSensitiveText(label),
      locked,
      createdAt,
    }));
  }
  if (includes.has('activity')) {
    const from = localStartOfDays(at, 365);
    const messages = options.repository.messagesInRange(sessionId, from, at).map((message) => ({
      ...message,
      senderId: options.repository.mainUserIdFor(account, message.senderId),
    }));
    exported.activity = buildActivityResponse(messages, at, 'year');
  }
  if (includes.has('l1')) {
    exported.privateFactsL1 = options.repository.listPrivateFactsForGroup(account, sessionId)
      .filter((fact) => fact.level === 'L1' && fact.status === 'active')
      .map((fact) => ({
        ownerId: fact.ownerId,
        sessionId: fact.sessionId,
        text: redactSensitiveText(fact.text),
        keywords: fact.keywords.map(redactSensitiveText),
        level: 'L1' as const,
        levelSource: fact.levelSource,
        mentions: fact.mentions,
        mentionEvidence: fact.mentionEvidence,
        evidence: fact.evidence.map((item) => ({ ...item, quote: redactSensitiveText(item.quote) })),
        status: 'active' as const,
        createdAt: fact.createdAt,
        updatedAt: fact.updatedAt,
      }));
  }
  return exported;
}

export function registerImpressionsDataRoutes(app: Hono, options: ImpressionsDataRouteOptions): void {
  app.post('/api/impressions/import/preview', async (context) => {
    let rawBody: unknown;
    try { rawBody = await context.req.json(); } catch { return context.json({ error: 'Invalid JSON' }, 400); }
    const parsed = importFileSchema.safeParse(rawBody);
    if (!parsed.success) return context.json({ error: 'Invalid import file' }, 400);
    const file = parsed.data;
    const key = parseSessionId(file.sessionId);
    if (!key || key.kind !== 'group' || key.account !== file.account
      || !options.getConfig().accounts.some((account) => account.uin === key.account)
      || !await groupNameFor(options, key.account, key.peer)) {
      return context.json({ error: 'Import session not found' }, 400);
    }
    const existing = options.repository.listTagsForSession(key.account, file.sessionId);
    return context.json(previewImpressionsImport(file, existing));
  });

  app.post('/api/impressions/import', async (context) => {
    let rawBody: unknown;
    try { rawBody = await context.req.json(); } catch { return context.json({ error: 'Invalid JSON' }, 400); }
    const parsed = importFileSchema.safeParse(rawBody);
    if (!parsed.success) return context.json({ error: 'Invalid import request' }, 400);
    const file = parsed.data;
    const mode = file.mode;
    if (!mode) return context.json({ error: 'Invalid import request' }, 400);
    const key = parseSessionId(file.sessionId);
    if (!key || key.kind !== 'group' || key.account !== file.account
      || !options.getConfig().accounts.some((account) => account.uin === key.account)) {
      return context.json({ error: 'Import session not found' }, 400);
    }
    const groupName = await groupNameFor(options, key.account, key.peer);
    if (!groupName) return context.json({ error: 'Import session not found' }, 400);
    const at = options.now();
    if (!Number.isSafeInteger(at) || at < 0) return context.json({ error: 'Invalid import time' }, 500);
    const backup = exportDocument(options, {
      account: key.account,
      sessionId: file.sessionId,
      groupName,
      at,
      includes: new Set(DEFAULT_INCLUDES),
    });
    try {
      writeImpressionsBackup(options.root, file.sessionId, at, backup);
    } catch {
      return context.json({ error: 'Could not create impressions backup' }, 500);
    }
    const counts = previewImpressionsImport(file, options.repository.listTagsForSession(key.account, file.sessionId));
    try {
      applyImpressionsImport({
        repository: options.repository,
        ...(options.tagSubjects ? { tagSubjects: options.tagSubjects } : {}),
        ...(options.summaries ? { summaries: options.summaries } : {}),
        account: key.account,
        sessionId: file.sessionId,
        file,
        mode,
      });
    } catch {
      return context.json({ error: 'Import failed; no data was applied' }, 400);
    }
    return context.json(counts);
  });

  app.post('/api/impressions/reset', async (context) => {
    let rawBody: unknown;
    try { rawBody = await context.req.json(); } catch { return context.json({ error: 'Invalid JSON' }, 400); }
    const parsed = impressionsResetSchema.safeParse(rawBody);
    if (!parsed.success) return context.json({ error: 'Invalid reset request' }, 400);
    const key = parseSessionId(parsed.data.sessionId);
    if (!key || key.kind !== 'group'
      || !options.getConfig().accounts.some((account) => account.uin === key.account)) {
      return context.json({ error: 'Invalid group session' }, 400);
    }
    const groupName = await groupNameFor(options, key.account, key.peer);
    if (!groupName || parsed.data.confirm !== groupName) {
      return context.json({ error: 'Group name confirmation does not match' }, 400);
    }
    const at = options.now();
    if (!Number.isSafeInteger(at) || at < 0) return context.json({ error: 'Invalid reset time' }, 500);
    const backup = exportDocument(options, {
      account: key.account,
      sessionId: parsed.data.sessionId,
      groupName,
      at,
      includes: new Set(DEFAULT_INCLUDES),
    });
    try {
      writeImpressionsBackup(options.root, parsed.data.sessionId, at, backup);
    } catch {
      return context.json({ error: 'Could not create impressions backup' }, 500);
    }
    try {
      return context.json({ reset: true, ...options.repository.resetImpressionsSession(key.account, parsed.data.sessionId) });
    } catch {
      return context.json({ error: 'Could not reset impressions data' }, 500);
    }
  });

  app.get('/api/impressions/export', async (context) => {
    const rawSessionId = context.req.query('sessionId');
    const key = rawSessionId ? parseSessionId(rawSessionId) : undefined;
    const config = options.getConfig();
    if (!rawSessionId || !key || key.kind !== 'group'
      || !config.accounts.some((account) => account.uin === key.account)) {
      return context.json({ error: 'Invalid group session' }, 400);
    }
    const includes = includedItems(context.req.query('include'));
    if (!includes) return context.json({ error: 'Invalid export include list' }, 400);
    const groupName = await groupNameFor(options, key.account, key.peer);
    if (!groupName) return context.json({ error: 'Group not found' }, 404);

    const at = options.now();
    if (!Number.isSafeInteger(at) || at < 0) return context.json({ error: 'Invalid export time' }, 500);
    return context.json(exportDocument(options, {
      account: key.account,
      sessionId: rawSessionId,
      groupName,
      at,
      includes,
    }));
  });
}
