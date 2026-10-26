import { createSessionQueue } from '../core/conversation/session-queue.ts';
import type { AquariumConfig } from '../config/schema.ts';
import type { PromptTemplateSet } from '../core/prompt/templates.ts';
import { redactSensitiveText } from '../core/impressions/sensitive-text.ts';
import type { ExtractWindowResult, ImpressionsService } from '../core/impressions/service.ts';
import type { PrivateMentionService } from '../core/privacy/mentions.ts';
import type { PrivateFactsService } from '../core/privacy/service.ts';
import type { PersonaMemoryProcessResult, PersonaMemoryProcessStatus } from '../core/persona-memory.ts';
import { sessionId, type SessionKey } from '../core/shared/events.ts';
import type { MessageStorageRecord, StoreRepository } from '../store/repository.ts';
import { loadPersona } from '../persona/load.ts';

export type PersonaMemorySessionProcessor = (
  session: SessionKey,
  records: MessageStorageRecord[],
  now: number,
) => Promise<PersonaMemoryProcessStatus | PersonaMemoryProcessResult>;

export function createQueuedPersonaMemoryProcessor(options: {
  isSessionEnabled: (session: SessionKey) => boolean;
  process: PersonaMemorySessionProcessor;
}): PersonaMemorySessionProcessor {
  const queue = createSessionQueue();
  return (session, records, now) => queue.run(sessionId(session), async () => {
    if (!options.isSessionEnabled(session)) return 'failed';
    return options.process(session, records, now);
  });
}

export function createPersonaMemorySegmentProcessor(options: {
  repository: StoreRepository;
  impressionsService: ImpressionsService;
  privateFactsService: PrivateFactsService;
  privateMentionService: PrivateMentionService;
  getConfig: () => AquariumConfig;
  getTemplates: () => PromptTemplateSet;
}): {
  process: PersonaMemorySessionProcessor;
  isSignificantSegment: (session: SessionKey, records: MessageStorageRecord[]) => boolean;
} {
  const personaNames = new Map<string, string[]>();

  function namesForAccount(account: number): string[] {
    const configured = options.getConfig().accounts.find((item) => item.uin === account);
    if (!configured) return [];
    const cached = personaNames.get(configured.persona);
    if (cached) return cached;
    let names: string[] = [];
    try {
      const profile = loadPersona(configured.persona, '').profile;
      names = profile ? [profile.name, ...profile.aliases].map((name) => name.trim()).filter(Boolean) : [];
    } catch {
      names = [];
    }
    personaNames.set(configured.persona, names);
    return names;
  }

  function isSignificantSegment(session: SessionKey, records: MessageStorageRecord[]): boolean {
    if (records.length >= 4 || records.some((record) => record.isSelf || record.senderId === session.account)) return true;
    const mentionsAccount = records.some((record) => record.segments.some((segment) => {
      if (typeof segment !== 'object' || segment === null || Array.isArray(segment)) return false;
      const candidate = segment as Record<string, unknown>;
      return candidate.type === 'at' && (candidate.target === session.account || candidate.target === 'all');
    }));
    if (mentionsAccount) return true;
    const names = namesForAccount(session.account).map((name) => name.toLocaleLowerCase());
    return records.some((record) => {
      const text = record.plainText.toLocaleLowerCase();
      return names.some((name) => text.includes(name));
    });
  }

  function groupEventMemos(
    session: SessionKey,
    records: MessageStorageRecord[],
    now: number,
    events: NonNullable<ExtractWindowResult['persistedGroupEvents']>,
  ): NonNullable<PersonaMemoryProcessResult['memos']> {
    const messageIds = new Set(records.map(({ messageId }) => messageId));
    return events.flatMap((event) => {
      if (!event.evidenceMessageIds.every((messageId) => messageIds.has(messageId))) return [];
      const evidence = records.filter((record) => event.evidenceMessageIds.includes(record.messageId))
        .sort((first, second) => first.time - second.time || first.messageId.localeCompare(second.messageId));
      const first = evidence[0];
      const last = evidence.at(-1);
      if (!first || !last) return [];
      return [{
        account: session.account,
        sessionId: sessionId(session),
        eventId: event.id,
        title: event.title,
        summary: event.summary,
        participantIds: [...event.participantIds],
        startMessageId: first.messageId,
        endMessageId: last.messageId,
        level: 'L0' as const,
        createdAt: now,
      }];
    });
  }

  function privateFactMemos(
    session: SessionKey,
    records: MessageStorageRecord[],
    now: number,
  ): NonNullable<PersonaMemoryProcessResult['memos']> {
    const messageIds = new Set(records.map(({ messageId }) => messageId));
    return options.repository.listPrivateFactsForOwner(session.account, session.peer)
      .filter((fact) => fact.sessionId === sessionId(session))
      .flatMap((fact) => {
        const evidence = fact.evidence.filter((item) => messageIds.has(item.messageId))
          .sort((first, second) => first.time - second.time || first.messageId.localeCompare(second.messageId));
        const first = evidence[0];
        const last = evidence.at(-1);
        if (!first || !last) return [];
        const title = Array.from(redactSensitiveText(fact.keywords.join('、'))).slice(0, 16).join('') || '私聊近况';
        return [{
          account: session.account,
          sessionId: fact.sessionId,
          eventId: null,
          title,
          summary: Array.from(redactSensitiveText(fact.text)).slice(0, 120).join(''),
          participantIds: [fact.ownerId],
          startMessageId: first.messageId,
          endMessageId: last.messageId,
          level: fact.level,
          createdAt: now,
        }];
      });
  }

  return {
    isSignificantSegment,
    async process(session, records, now) {
      const templates = options.getTemplates();
      if (session.kind === 'group') {
        const key = sessionId(session);
        const release = options.impressionsService.tryAcquireSession(key);
        if (!release) return 'failed';
        try {
          for (const record of records) {
            if (record.isSelf) continue;
            options.privateMentionService.maybePromote({
              session,
              senderId: record.senderId,
              messageId: record.messageId,
              now: record.time,
              template: templates.privacyMention,
            });
          }
          await options.privateMentionService.idle();
          const summary = await options.impressionsService.extractWindowUnderSessionLock({
            session,
            records,
            now,
            template: templates.extractTags,
            includePersistedGroupEvents: true,
          });
          if (summary.status !== 'done') return summary.status === 'budget' ? 'budget' : 'failed';
          return {
            status: 'done',
            memos: groupEventMemos(session, records, now, summary.persistedGroupEvents ?? []),
          };
        } finally {
          release();
        }
      }
      const summary = await options.privateFactsService.extractWindowUnderSessionLock({
        session,
        records,
        now,
        template: templates.extractPrivate,
      });
      if (summary.status !== 'done') return summary.status === 'budget' ? 'budget' : 'failed';
      return { status: 'done', memos: privateFactMemos(session, records, now) };
    },
  };
}
