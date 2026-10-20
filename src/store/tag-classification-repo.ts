import type { DatabaseSync } from 'node:sqlite';
import { createTagQueries } from './tag-repo.ts';
import type { StoredTag, TagEvidence } from './tag-repo.ts';
import { createTagSubjectRepository } from './tag-subject-repo.ts';
import type { TagCategoryKey, TagPolarity } from '../core/impressions/tag-model.ts';

export interface TagClassificationProfile {
  category: TagCategoryKey;
  subject: string | null;
  polarity: TagPolarity;
}

export interface TagClassificationRepository {
  listUnlockedMiscTags(): StoredTag[];
  countLockedMiscTags(): number;
  isLegacyMiscClassificationComplete(): boolean;
  markLegacyMiscClassificationComplete(completedAt: number): void;
  mergeMiscTag(input: {
    sourceId: number;
    targetId: number;
    profile: TagClassificationProfile;
    at: number;
  }): boolean;
}

function evidenceUnion(target: TagEvidence[], source: TagEvidence[]): TagEvidence[] {
  const byMessageId = new Map<string, TagEvidence>();
  for (const evidence of [...target, ...source]) {
    const previous = byMessageId.get(evidence.messageId);
    if (!previous || evidence.time >= previous.time) byMessageId.set(evidence.messageId, evidence);
  }
  return [...byMessageId.values()].sort((left, right) => left.time - right.time
    || left.messageId.localeCompare(right.messageId));
}

export function createTagClassificationRepository(database: DatabaseSync): TagClassificationRepository {
  const tags = createTagQueries(database);
  const subjects = createTagSubjectRepository(database);
  const selectLegacyMarker = database.prepare(
    "SELECT 1 FROM profile_migrations WHERE name = 'legacy-misc-tags'",
  );
  const saveLegacyMarker = database.prepare(`
    INSERT INTO profile_migrations (name, completed_at)
    VALUES ('legacy-misc-tags', ?)
    ON CONFLICT(name) DO UPDATE SET completed_at = excluded.completed_at
  `);
  return {
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

    mergeMiscTag({ sourceId, targetId, profile, at }) {
      if (!Number.isSafeInteger(sourceId) || sourceId <= 0
        || !Number.isSafeInteger(targetId) || targetId <= 0
        || sourceId === targetId || !Number.isSafeInteger(at) || at < 0) {
        return false;
      }
      if (profile.category !== 'fandom' && (profile.subject !== null || profile.polarity !== null)) return false;
      if (profile.subject !== null && profile.subject.trim().length === 0) return false;

      database.exec('BEGIN IMMEDIATE');
      let transactionOpen = true;
      try {
        const source = tags.tagById(sourceId);
        const target = tags.tagById(targetId);
        if (!source || !target || source.category !== 'misc' || source.locked
          || source.status === 'rejected' || source.status === 'superseded'
          || target.locked || target.status === 'rejected' || target.status === 'superseded'
          || target.category === 'misc'
          || source.norm === target.norm
          || source.account !== target.account
          || source.sessionId !== target.sessionId
          || source.userId !== target.userId) {
          database.exec('ROLLBACK');
          transactionOpen = false;
          return false;
        }

        const sourceSubject = profile.subject === null
          ? null
          : subjects.canonicalTagSubject(source.account, profile.category, profile.subject);
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
          category: profile.category,
          subject: sourceSubject,
          polarity: profile.polarity,
          status: 'superseded',
          supersededBy: target.id,
          updatedAt: at,
        });
        database.exec('COMMIT');
        transactionOpen = false;
        return true;
      } catch (error) {
        if (transactionOpen) database.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
