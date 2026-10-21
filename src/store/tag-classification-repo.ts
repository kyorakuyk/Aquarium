import type { DatabaseSync } from 'node:sqlite';
import { createTagQueries } from './tag-repo.ts';
import type { StoredTag, TagEvidence } from './tag-repo.ts';
import { createTagVetoQueries } from './tag-veto-repo.ts';
import { createTagSubjectRepository } from './tag-subject-repo.ts';
import {
  isTagCategoryForScope,
  isTagCategoryKey,
  isTagPolarity,
  normalizeTagSubjectPath,
  type TagCategoryKey,
  type TagPolarity,
} from '../core/impressions/tag-model.ts';

export interface TagClassificationProfile {
  category: TagCategoryKey;
  subject: string | null;
  polarity: TagPolarity;
  text?: string;
  norm?: string;
}

export interface TagClassificationRepository {
  listTagsToClassify(): StoredTag[];
  countLockedTagsToClassify(): number;
  hasPendingReclassification(): boolean;
  markTagReclassified(id: number): void;
  isTagVetoed(input: {
    account: number;
    sessionId: string;
    userId: number | null;
    category: TagCategoryKey;
    subject: string | null;
    textNorm: string;
  }): boolean;
  deleteTag(id: number): boolean;
  listUnlockedMiscTags(): StoredTag[];
  countLockedMiscTags(): number;
  isLegacyMiscClassificationComplete(): boolean;
  markLegacyMiscClassificationComplete(completedAt: number): void;
  mergeClassifiedTag(input: {
    sourceId: number;
    targetId: number;
    profile: TagClassificationProfile;
    at: number;
  }): boolean;
  mergeMiscTag(input: {
    sourceId: number;
    targetId: number;
    profile: TagClassificationProfile;
    at: number;
  }): boolean;
}

function numberValue(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  throw new Error(`数据库字段 ${field} 不是数字`);
}

function evidenceUnion(target: TagEvidence[], source: TagEvidence[]): TagEvidence[] {
  const messages = new Map<string, Extract<TagEvidence, { messageId: string }>>();
  const signatures = new Map<string, Extract<TagEvidence, { kind: 'signature' }>>();
  for (const evidence of [...target, ...source]) {
    if (evidence.kind === 'signature') {
      const previous = signatures.get(evidence.text);
      if (!previous || evidence.fetchedAt >= previous.fetchedAt) signatures.set(evidence.text, evidence);
      continue;
    }
    const previous = messages.get(evidence.messageId);
    if (!previous || evidence.time >= previous.time) messages.set(evidence.messageId, evidence);
  }
  const union: TagEvidence[] = [...messages.values(), ...signatures.values()];
  const timeOf = (evidence: TagEvidence) => evidence.kind === 'signature' ? evidence.fetchedAt : evidence.time;
  const keyOf = (evidence: TagEvidence) => evidence.kind === 'signature'
    ? `signature:${evidence.text}`
    : `message:${evidence.messageId}`;
  return union.sort((left, right) => timeOf(left) - timeOf(right) || keyOf(left).localeCompare(keyOf(right)));
}

export function createTagClassificationRepository(database: DatabaseSync): TagClassificationRepository {
  const tags = createTagQueries(database);
  const vetoes = createTagVetoQueries(database, tags);
  const subjects = createTagSubjectRepository(database);
  const selectClassifiableIds = database.prepare(`
    SELECT id FROM tags
    WHERE (category = 'misc' OR needs_reclassification = 1)
      AND locked = 0 AND status != 'superseded'
    ORDER BY account, session_id, user_id, id
  `);
  const selectLockedClassifiableCount = database.prepare(`
    SELECT COUNT(*) AS total FROM tags
    WHERE (category = 'misc' OR needs_reclassification = 1)
      AND locked = 1 AND status != 'superseded'
  `);
  const selectPendingReclassification = database.prepare(`
    SELECT 1 FROM tags
    WHERE needs_reclassification = 1 AND locked = 0 AND status != 'superseded'
    LIMIT 1
  `);
  const selectTagReclassification = database.prepare(
    'SELECT needs_reclassification FROM tags WHERE id = ?',
  );
  const clearTagReclassification = database.prepare(
    'UPDATE tags SET needs_reclassification = 0 WHERE id = ?',
  );
  const selectLegacyMarker = database.prepare(
    "SELECT 1 FROM profile_migrations WHERE name = 'legacy-misc-tags'",
  );
  const saveLegacyMarker = database.prepare(`
    INSERT INTO profile_migrations (name, completed_at)
    VALUES ('legacy-misc-tags', ?)
    ON CONFLICT(name) DO UPDATE SET completed_at = excluded.completed_at
  `);

  function mergeClassifiedTag({ sourceId, targetId, profile, at }: {
    sourceId: number;
    targetId: number;
    profile: TagClassificationProfile;
    at: number;
  }): boolean {
    if (!Number.isSafeInteger(sourceId) || sourceId <= 0
      || !Number.isSafeInteger(targetId) || targetId <= 0
      || sourceId === targetId || !Number.isSafeInteger(at) || at < 0
      || !isTagCategoryKey(profile.category) || profile.category === 'schedule'
      || (profile.subject !== null && (profile.category !== 'fandom' && profile.category !== 'topic'
        || !normalizeTagSubjectPath(profile.subject)))
      || (profile.category !== 'fandom' && profile.polarity !== null)
      || (profile.polarity !== null && !isTagPolarity(profile.polarity))) {
      return false;
    }

    database.exec('BEGIN IMMEDIATE');
    let transactionOpen = true;
    try {
      const source = tags.tagById(sourceId);
      const target = tags.tagById(targetId);
      const sourceNeedsReclassification = selectTagReclassification.get(sourceId) as { needs_reclassification: number } | undefined;
      if (!source || !target || (source.category !== 'misc' && sourceNeedsReclassification?.needs_reclassification !== 1)
        || source.locked || source.status === 'rejected' || source.status === 'superseded'
        || target.locked || target.status === 'rejected' || target.status === 'superseded'
        || target.category === 'misc'
        || source.norm === target.norm
        || source.account !== target.account
        || source.sessionId !== target.sessionId
        || source.userId !== target.userId
        || !isTagCategoryForScope(profile.category, source.userId === null ? 'group' : 'member')) {
        database.exec('ROLLBACK');
        transactionOpen = false;
        return false;
      }

      const sourceSubject = profile.subject === null
        ? null
        : subjects.canonicalTagSubject(source.account, profile.category, profile.subject);
      if (vetoes.isTagVetoed({
        account: source.account,
        sessionId: source.sessionId,
        userId: source.userId,
        category: profile.category,
        subject: sourceSubject,
        textNorm: profile.norm ?? source.norm,
      })) {
        database.exec('ROLLBACK');
        transactionOpen = false;
        return false;
      }
      if (target.category !== profile.category
        || target.subject !== sourceSubject
        || target.polarity !== profile.polarity) {
        database.exec('ROLLBACK');
        transactionOpen = false;
        return false;
      }
      const samples = target.samples + source.samples;
      if (!Number.isSafeInteger(samples)) {
        database.exec('ROLLBACK');
        transactionOpen = false;
        return false;
      }
      const preserveManual = target.source === 'manual' || source.source === 'manual'
        || target.origin === 'manual' || source.origin === 'manual';
      tags.updateTag(target.id, {
        samples,
        evidence: evidenceUnion(target.evidence, source.evidence),
        lastSeen: Math.max(target.lastSeen, source.lastSeen),
        status: target.status === 'confirmed' || source.status === 'confirmed' ? 'confirmed' : target.status,
        ...(preserveManual ? { source: 'manual' as const, origin: 'manual' as const } : {}),
        updatedAt: at,
      });
      tags.updateTag(source.id, {
        text: profile.text ?? source.text,
        norm: profile.norm ?? source.norm,
        category: profile.category,
        subject: sourceSubject,
        polarity: profile.polarity,
        status: 'superseded',
        supersededBy: target.id,
        updatedAt: at,
      });
      clearTagReclassification.run(source.id);
      clearTagReclassification.run(target.id);
      database.exec('COMMIT');
      transactionOpen = false;
      return true;
    } catch (error) {
      if (transactionOpen) database.exec('ROLLBACK');
      throw error;
    }
  }

  return {
    listTagsToClassify() {
      const rows = selectClassifiableIds.all() as Array<{ id: number | bigint }>;
      return rows.flatMap(({ id }) => {
        const tag = tags.tagById(Number(id));
        return tag ? [tag] : [];
      });
    },

    countLockedTagsToClassify() {
      const row = selectLockedClassifiableCount.get() as Record<string, unknown> | undefined;
      return numberValue(row?.total ?? 0, 'total');
    },

    hasPendingReclassification() {
      return selectPendingReclassification.get() !== undefined;
    },

    markTagReclassified(id) {
      if (!Number.isSafeInteger(id) || id <= 0) return;
      clearTagReclassification.run(id);
    },

    isTagVetoed(input) {
      return vetoes.isTagVetoed(input);
    },

    deleteTag(id) {
      return tags.deleteTag(id);
    },

    listUnlockedMiscTags() {
      return tags.listUnlockedMiscTags();
    },

    countLockedMiscTags() {
      return tags.countLockedMiscTags();
    },

    isLegacyMiscClassificationComplete() {
      return selectLegacyMarker.get() !== undefined;
    },

    markLegacyMiscClassificationComplete(completedAt) {
      if (!Number.isSafeInteger(completedAt) || completedAt < 0) {
        throw new RangeError('画像整理完成时间无效');
      }
      saveLegacyMarker.run(completedAt);
    },

    mergeClassifiedTag(input) {
      return mergeClassifiedTag(input);
    },

    mergeMiscTag(input) {
      return mergeClassifiedTag(input);
    },
  };
}
