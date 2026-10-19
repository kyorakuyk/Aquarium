import type { DatabaseSync } from 'node:sqlite';

export interface StoredPersonaVersion {
  id: number;
  personaId: string;
  savedAt: number;
  markdown: string;
  traitsJson: string;
  note: string | null;
}

export interface PersonaVersionRepository {
  recordPersonaVersion(personaId: string, markdown: string, traitsJson: string): number;
  personaVersions(personaId: string, count: number): StoredPersonaVersion[];
  personaVersion(personaId: string, id: number): StoredPersonaVersion | undefined;
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

function storedVersion(row: Record<string, unknown>): StoredPersonaVersion {
  return {
    id: numberValue(row.id, 'id'),
    personaId: stringValue(row.persona_id, 'persona_id'),
    savedAt: numberValue(row.saved_at, 'saved_at'),
    markdown: stringValue(row.markdown, 'markdown'),
    traitsJson: stringValue(row.traits_json, 'traits_json'),
    note: row.note === null ? null : stringValue(row.note, 'note'),
  };
}

export function createPersonaVersionRepository(
  database: DatabaseSync,
  clock: () => Date = () => new Date(),
): PersonaVersionRepository {
  const insert = database.prepare(`
    INSERT INTO persona_versions (persona_id, saved_at, markdown, traits_json, note)
    VALUES (?, ?, ?, ?, NULL)
  `);
  const prune = database.prepare(`
    DELETE FROM persona_versions
    WHERE persona_id = ?
      AND id NOT IN (
        SELECT id FROM persona_versions
        WHERE persona_id = ?
        ORDER BY saved_at DESC, id DESC
        LIMIT 50
      )
  `);
  const selectForPersona = database.prepare(`
    SELECT id, persona_id, saved_at, markdown, traits_json, note
    FROM persona_versions
    WHERE persona_id = ?
    ORDER BY saved_at, id
    LIMIT ?
  `);
  const selectOne = database.prepare(`
    SELECT id, persona_id, saved_at, markdown, traits_json, note
    FROM persona_versions
    WHERE persona_id = ? AND id = ?
  `);

  return {
    recordPersonaVersion(personaId, markdown, traitsJson) {
      if (!personaId.trim()) throw new TypeError('人设版本缺少 persona_id');
      database.exec('BEGIN IMMEDIATE;');
      try {
        const result = insert.run(personaId, clock().getTime(), markdown, traitsJson);
        prune.run(personaId, personaId);
        database.exec('COMMIT;');
        return numberValue(result.lastInsertRowid, 'lastInsertRowid');
      } catch (error) {
        if (database.isTransaction) database.exec('ROLLBACK;');
        throw error;
      }
    },

    personaVersions(personaId, count) {
      if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('查询数量必须是非负安全整数');
      if (count === 0) return [];
      const rows = selectForPersona.all(personaId, count) as Array<Record<string, unknown>>;
      return rows.map(storedVersion);
    },

    personaVersion(personaId, id) {
      if (!Number.isSafeInteger(id) || id <= 0) return undefined;
      const row = selectOne.get(personaId, id) as Record<string, unknown> | undefined;
      return row ? storedVersion(row) : undefined;
    },
  };
}
