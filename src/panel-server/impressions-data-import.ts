import { normalizeTagSubject } from '../core/impressions/tag-model.ts';
import { normalizeTagText } from '../core/impressions/tags.ts';
import { redactSensitiveText } from '../core/impressions/sensitive-text.ts';
import type { TagCategory } from '../core/impressions/tag-model.ts';
import type { StoredTag, TagRecord } from '../store/affect-repo.ts';
import type { MemberSummaryRepository } from '../store/member-summary-repo.ts';
import type { TagSubjectRepository } from '../store/tag-subject-repo.ts';
import type { StoreRepository } from '../store/repository.ts';
import type { ImpressionsImportFile, ImpressionsImportTag } from './impressions-data-schema.ts';

function transferTags(file: ImpressionsImportFile): ImpressionsImportTag[] {
  const seen = new Set<string>();
  return file.tags.filter((tag) => {
    const key = JSON.stringify([tag.userId, tag.category, normalizeTagText(redactSensitiveText(tag.text))]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function tagKey(tag: Pick<StoredTag, 'userId' | 'category' | 'norm'>): string {
  return JSON.stringify([tag.userId, tag.category, tag.norm]);
}

function recordForImport(account: number, sessionId: string, tag: ImpressionsImportTag): TagRecord {
  const text = redactSensitiveText(tag.text);
  return {
    account,
    sessionId,
    userId: tag.userId,
    text,
    norm: normalizeTagText(text),
    category: tag.category as TagCategory,
    subject: tag.subject === null ? null : redactSensitiveText(tag.subject),
    polarity: tag.polarity,
    origin: tag.origin,
    locked: tag.locked,
    status: tag.status,
    source: tag.source,
    samples: tag.samples,
    evidence: tag.evidence.map((item) => item.kind === 'signature'
      ? { kind: item.kind, text: redactSensitiveText(item.text), fetchedAt: item.fetchedAt }
      : { kind: 'message', messageId: item.messageId, time: item.time, quote: redactSensitiveText(item.quote) }),
    firstSeen: tag.firstSeen,
    lastSeen: tag.lastSeen,
    supersededBy: null,
    updatedAt: tag.updatedAt,
  };
}

export function previewImpressionsImport(file: ImpressionsImportFile, existing: readonly StoredTag[]) {
  const seen = new Set<string>();
  let added = 0;
  let conflicts = 0;
  for (const source of transferTags(file)) {
    const tag = recordForImport(file.account, file.sessionId, source);
    const key = tagKey(tag);
    if (seen.has(key) || existing.some((current) => tagKey(current) === key)) conflicts += 1;
    else {
      added += 1;
      seen.add(key);
    }
  }
  return { added, conflicts, vetoes: file.vetoes.length, summaries: file.summaries.length };
}

function sameRelation(
  current: ReturnType<StoreRepository['listRelationsForUser']>[number],
  relation: ImpressionsImportFile['relations'][number],
): boolean {
  if (current.type !== relation.type) return false;
  if (relation.type === 'alt') return current.aUserId === relation.aUserId && current.bUserId === relation.bUserId;
  return current.aUserId === Math.min(relation.aUserId, relation.bUserId)
    && current.bUserId === Math.max(relation.aUserId, relation.bUserId);
}

export function applyImpressionsImport(input: {
  repository: StoreRepository;
  tagSubjects?: TagSubjectRepository;
  summaries?: MemberSummaryRepository;
  account: number;
  sessionId: string;
  file: ImpressionsImportFile;
  mode: 'merge' | 'overwrite';
}): void {
  const { repository, tagSubjects, summaries, account, sessionId, file, mode } = input;
  repository.transaction(() => {
    const currentTags = new Map(repository.listTagsForSession(account, sessionId).map((tag) => [tagKey(tag), tag]));
    for (const source of transferTags(file)) {
      const imported = recordForImport(account, sessionId, source);
      const key = tagKey(imported);
      const current = currentTags.get(key);
      if (!current) {
        const id = repository.insertTag(imported);
        const saved = repository.tagById(id);
        if (saved) currentTags.set(key, saved);
        continue;
      }
      if (current.locked || mode === 'merge') continue;
      repository.updateTag(current.id, {
        text: imported.text,
        norm: imported.norm,
        category: imported.category,
        subject: imported.subject,
        polarity: imported.polarity,
        origin: imported.origin,
        locked: imported.locked,
        status: imported.status,
        source: imported.source,
        samples: imported.samples,
        evidence: imported.evidence,
        lastSeen: imported.lastSeen,
        supersededBy: null,
        updatedAt: imported.updatedAt,
      });
      currentTags.set(key, { ...current, ...imported });
    }

    for (const veto of file.vetoes) {
      repository.insertTagVeto({
        account,
        sessionId,
        userId: veto.userId,
        category: veto.category as TagCategory,
        subjectNorm: redactSensitiveText(veto.subjectNorm),
        textNorm: normalizeTagText(redactSensitiveText(veto.textNorm)),
        createdAt: veto.createdAt,
      });
    }

    for (const summary of file.summaries) {
      const existing = summaries?.get(account, summary.userId);
      if (existing && mode === 'merge') continue;
      summaries?.saveImported({
        account,
        userId: summary.userId,
        text: redactSensitiveText(summary.text),
        manual: summary.manual,
        updatedAt: summary.updatedAt,
      });
    }

    for (const subject of file.subjects) {
      if (!tagSubjects) continue;
      const name = redactSensitiveText(subject.name);
      const existing = tagSubjects.listTagSubjects(account, subject.category as TagCategory)
        .find((candidate) => normalizeTagSubject(candidate.name) === normalizeTagSubject(name));
      const aliases = subject.aliases.map(redactSensitiveText);
      tagSubjects.saveTagSubject({
        account,
        category: subject.category as TagCategory,
        name,
        aliases: mode === 'merge' && existing ? [...existing.aliases, ...aliases] : aliases,
      });
    }

    for (const kind of file.accountKinds) {
      const existing = repository.getAccountKind(account, kind.userId);
      if (existing && mode === 'merge') continue;
      repository.setAccountKind(account, kind.userId, kind.kind, kind.createdAt);
    }

    for (const relation of file.relations) {
      if (relation.aUserId === relation.bUserId) continue;
      const aUserId = relation.type === 'alt' ? relation.aUserId : Math.min(relation.aUserId, relation.bUserId);
      const current = repository.listRelationsForUser(account, aUserId)
        .find((candidate) => sameRelation(candidate, relation));
      if (current?.locked || (current && mode === 'merge')) continue;
      if (current) repository.deleteRelation(account, current.id);
      repository.createRelation({
        account,
        aUserId: relation.aUserId,
        bUserId: relation.bUserId,
        type: relation.type,
        label: relation.label === null ? null : redactSensitiveText(relation.label),
        locked: relation.locked,
        createdAt: relation.createdAt,
      });
    }

    for (const fact of file.privateFactsL1 ?? []) {
      const text = redactSensitiveText(fact.text);
      const existing = repository.listPrivateFactsForOwner(account, fact.ownerId)
        .find((candidate) => candidate.level === 'L1' && candidate.text === text);
      if (existing && mode === 'merge') continue;
      const value = {
        text,
        keywords: fact.keywords.map(redactSensitiveText),
        evidence: fact.evidence.map((item) => ({ ...item, quote: redactSensitiveText(item.quote) })),
        updatedAt: fact.updatedAt,
      };
      if (existing) {
        repository.updatePrivateFact(existing.id, value);
        continue;
      }
      repository.insertPrivateFact({
        account,
        ownerId: fact.ownerId,
        sessionId: `${account}:private:${fact.ownerId}`,
        ...value,
        level: 'L1',
        levelSource: fact.levelSource,
        mentions: fact.mentions,
        mentionEvidence: fact.mentionEvidence,
        status: 'active',
        createdAt: fact.createdAt,
      });
    }
  });
}
