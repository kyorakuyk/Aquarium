import type { DatabaseSync } from 'node:sqlite';
import {
  canonicalizeTagSubject,
  isTagCategory,
  normalizeTagSubject,
  type TagCategory,
} from '../core/impressions/tag-model.ts';

export interface TagSubjectRecord {
  id: number;
  account: number;
  category: TagCategory;
  name: string;
  aliases: string[];
}

export interface TagSubjectWrite {
  account: number;
  category: TagCategory;
  name: string;
  aliases: readonly string[];
}

export interface TagSubjectRepository {
  saveTagSubject(input: TagSubjectWrite): number;
  listTagSubjects(account: number, category: TagCategory): TagSubjectRecord[];
  canonicalTagSubject(account: number, category: TagCategory, subject: string): string;
}

function numberValue(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  throw new Error(`数据库字段 ${field} 不是数字`);
}

function stringValue(value: unknown, field: string): string {
  if (typeof value === 'string') return value;
  throw new Error(`数据库字段 ${field} 不是文本`);
}

function tagSubjectRecord(row: Record<string, unknown>): TagSubjectRecord {
  const category = stringValue(row.category, 'category');
  if (!isTagCategory(category)) throw new Error('数据库字段 category 无效');
  const aliases = JSON.parse(stringValue(row.aliases_json, 'aliases_json')) as unknown;
  if (!Array.isArray(aliases) || !aliases.every((alias) => typeof alias === 'string')) {
    throw new Error('数据库字段 aliases_json 无效');
  }
  return {
    id: numberValue(row.id, 'id'),
    account: numberValue(row.account, 'account'),
    category,
    name: stringValue(row.name, 'name'),
    aliases,
  };
}

function normalizedAliases(name: string, aliases: readonly string[]): string[] {
  const seen = new Set([normalizeTagSubject(name)]);
  const result: string[] = [];
  for (const alias of aliases) {
    const trimmed = alias.trim();
    const normalized = normalizeTagSubject(trimmed);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(trimmed);
  }
  return result;
}

function subjectKeys(subject: TagSubjectRecord): Set<string> {
  return new Set([subject.name, ...subject.aliases].map(normalizeTagSubject));
}

export function createTagSubjectRepository(database: DatabaseSync): TagSubjectRepository {
  const selectTagSubjects = database.prepare(`
    SELECT id, account, category, name, aliases_json
    FROM tag_subjects
    WHERE account = ? AND category = ?
    ORDER BY id
  `);
  const insertTagSubject = database.prepare(`
    INSERT INTO tag_subjects (account, category, name, aliases_json)
    VALUES (?, ?, ?, ?)
  `);
  const updateTagSubject = database.prepare(`
    UPDATE tag_subjects SET aliases_json = ? WHERE id = ?
  `);

  function listTagSubjects(account: number, category: TagCategory): TagSubjectRecord[] {
    if (!Number.isSafeInteger(account)) throw new RangeError('account 无效');
    if (!isTagCategory(category)) throw new RangeError('标签 category 无效');
    const rows = selectTagSubjects.all(account, category) as Array<Record<string, unknown>>;
    return rows.map(tagSubjectRecord);
  }

  return {
    saveTagSubject(input) {
      if (!Number.isSafeInteger(input.account)) throw new RangeError('account 无效');
      if (!isTagCategory(input.category)) throw new RangeError('标签 category 无效');
      const name = input.name.trim();
      const nameKey = normalizeTagSubject(name);
      if (!nameKey) throw new RangeError('标签 subject 不能为空');
      const existing = listTagSubjects(input.account, input.category);
      const sameName = existing.find((subject) => normalizeTagSubject(subject.name) === nameKey);
      const aliases = normalizedAliases(sameName?.name ?? name, input.aliases);
      const candidates = [sameName?.name ?? name, ...aliases].map(normalizeTagSubject);
      for (const subject of existing) {
        if (subject.id === sameName?.id) continue;
        const keys = subjectKeys(subject);
        if (candidates.some((candidate) => keys.has(candidate))) {
          throw new Error('标签 subject 名称或别名冲突');
        }
      }

      const canonicalName = sameName?.name ?? name;
      if (sameName) {
        updateTagSubject.run(JSON.stringify(aliases), sameName.id);
        return sameName.id;
      }
      const result = insertTagSubject.run(input.account, input.category, canonicalName, JSON.stringify(aliases));
      return numberValue(result.lastInsertRowid, 'lastInsertRowid');
    },

    listTagSubjects,

    canonicalTagSubject(account, category, subject) {
      return canonicalizeTagSubject(subject, listTagSubjects(account, category));
    },
  };
}
