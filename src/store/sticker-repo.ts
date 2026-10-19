import type { DatabaseSync } from 'node:sqlite';

export interface StickerRecord {
  id: number;
  account: number;
  emojiId: string;
  md5: string;
  file: string | null;
  descQq: string;
  descAi: string;
  manualDesc: string;
  tags: string[];
  enabled: boolean;
  missing: boolean;
  useCount: number;
  lastUsedAt: number | null;
  descriptionAttempts: number;
  createdAt: number;
  updatedAt: number;
}

export interface StickerDetailRecord {
  account: number;
  emojiId: string;
  md5: string;
  descQq: string;
}

export interface StickerUpdate {
  enabled?: boolean;
  tags?: string[];
  descAi?: string;
}

export interface StickerRepository {
  listStickers(account?: number): StickerRecord[];
  stickerById(id: number): StickerRecord | undefined;
  stickerByMd5(account: number, md5: string): StickerRecord | undefined;
  upsertSticker(detail: StickerDetailRecord, now: number): { sticker: StickerRecord; inserted: boolean };
  markMissingStickers(account: number, seenMd5s: string[], now: number): number;
  setStickerFile(id: number, file: string | null, now: number): void;
  stickersNeedingDescription(account: number, maxAttempts: number): StickerRecord[];
  recordStickerDescriptionAttempt(id: number, now: number): void;
  saveStickerDescription(id: number, descAi: string, tags: string[], now: number): void;
  updateSticker(id: number, update: StickerUpdate, now: number): StickerRecord | undefined;
  recordStickerUse(id: number, now: number): StickerRecord | undefined;
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

function nullableNumber(value: unknown, field: string): number | null {
  if (value === null) return null;
  return numberValue(value, field);
}

function positiveId(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${field} 必须是正整数`);
  return value;
}

function normalizeMd5(value: string): string {
  if (!/^[a-f\d]{32}$/iu.test(value)) throw new TypeError('表情 md5 格式无效');
  return value.toLowerCase();
}

function validateDescription(descAi: string, tags: string[]): void {
  if (Array.from(descAi).length > 20) throw new RangeError('表情描述不能超过 20 字');
  if (tags.length > 5 || tags.some((tag) => {
    const length = Array.from(tag).length;
    return length < 2 || length > 4;
  })) {
    throw new RangeError('表情标签必须为 2–4 字且最多 5 个');
  }
}

function stickerFromRow(row: Record<string, unknown>): StickerRecord {
  const parsedTags: unknown = JSON.parse(stringValue(row.tags_json, 'tags_json'));
  if (!Array.isArray(parsedTags) || parsedTags.some((tag) => typeof tag !== 'string')) {
    throw new Error('数据库字段 tags_json 格式无效');
  }
  return {
    id: numberValue(row.id, 'id'),
    account: numberValue(row.account, 'account'),
    emojiId: stringValue(row.emoji_id, 'emoji_id'),
    md5: stringValue(row.md5, 'md5'),
    file: row.file === null ? null : stringValue(row.file, 'file'),
    descQq: stringValue(row.desc_qq, 'desc_qq'),
    descAi: stringValue(row.desc_ai, 'desc_ai'),
    manualDesc: stringValue(row.manual_desc, 'manual_desc'),
    tags: parsedTags as string[],
    enabled: numberValue(row.enabled, 'enabled') === 1,
    missing: numberValue(row.missing, 'missing') === 1,
    useCount: numberValue(row.use_count, 'use_count'),
    lastUsedAt: nullableNumber(row.last_used_at, 'last_used_at'),
    descriptionAttempts: numberValue(row.description_attempts, 'description_attempts'),
    createdAt: numberValue(row.created_at, 'created_at'),
    updatedAt: numberValue(row.updated_at, 'updated_at'),
  };
}

const SELECT_COLUMNS = `
  id, account, emoji_id, md5, file, desc_qq, desc_ai, manual_desc, tags_json,
  enabled, missing, use_count, last_used_at, description_attempts, created_at, updated_at
`;

export function createStickerQueries(database: DatabaseSync): StickerRepository {
  const selectAll = database.prepare(`SELECT ${SELECT_COLUMNS} FROM stickers ORDER BY account, id`);
  const selectForAccount = database.prepare(`SELECT ${SELECT_COLUMNS} FROM stickers WHERE account = ? ORDER BY id`);
  const selectById = database.prepare(`SELECT ${SELECT_COLUMNS} FROM stickers WHERE id = ?`);
  const selectByAccountMd5 = database.prepare(`SELECT ${SELECT_COLUMNS} FROM stickers WHERE account = ? AND md5 = ?`);
  const selectNeedingDescription = database.prepare(`
    SELECT ${SELECT_COLUMNS} FROM stickers
    WHERE account = ? AND missing = 0 AND file IS NOT NULL AND desc_ai = '' AND description_attempts < ?
    ORDER BY id
  `);
  const insertSticker = database.prepare(`
    INSERT INTO stickers (account, emoji_id, md5, desc_qq, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(account, md5) DO UPDATE SET
      emoji_id = excluded.emoji_id,
      desc_qq = excluded.desc_qq,
      missing = 0,
      updated_at = excluded.updated_at
  `);
  const updateStickerFile = database.prepare('UPDATE stickers SET file = ?, updated_at = ? WHERE id = ?');
  const updateDescriptionAttempt = database.prepare(`
    UPDATE stickers SET description_attempts = MIN(3, description_attempts + 1), updated_at = ? WHERE id = ?
  `);
  const updateStickerDescription = database.prepare(`
    UPDATE stickers SET desc_ai = ?, tags_json = ?,
      description_attempts = MIN(3, description_attempts + 1), updated_at = ? WHERE id = ?
  `);
  const updateStickerFields = database.prepare(`
    UPDATE stickers SET enabled = ?, tags_json = ?, desc_ai = ?, desc_qq = ?, manual_desc = ?, updated_at = ? WHERE id = ?
  `);
  const updateStickerUse = database.prepare(`
    UPDATE stickers SET use_count = use_count + 1, last_used_at = ?, updated_at = ? WHERE id = ?
  `);

  return {
    listStickers(account) {
      if (account === undefined) {
        return (selectAll.all() as Array<Record<string, unknown>>).map(stickerFromRow);
      }
      positiveId(account, 'account');
      return (selectForAccount.all(account) as Array<Record<string, unknown>>).map(stickerFromRow);
    },

    stickerById(id) {
      positiveId(id, 'sticker id');
      const row = selectById.get(id) as Record<string, unknown> | undefined;
      return row ? stickerFromRow(row) : undefined;
    },

    stickerByMd5(account, md5) {
      positiveId(account, 'account');
      const row = selectByAccountMd5.get(account, normalizeMd5(md5)) as Record<string, unknown> | undefined;
      return row ? stickerFromRow(row) : undefined;
    },

    upsertSticker(detail, now) {
      positiveId(detail.account, 'account');
      if (!detail.emojiId.trim()) throw new TypeError('表情 emoji_id 不能为空');
      if (!Number.isFinite(now)) throw new RangeError('更新时间无效');
      const md5 = normalizeMd5(detail.md5);
      const existing = selectByAccountMd5.get(detail.account, md5) as Record<string, unknown> | undefined;
      insertSticker.run(detail.account, detail.emojiId, md5, detail.descQq, now, now);
      const row = selectByAccountMd5.get(detail.account, md5) as Record<string, unknown>;
      return { sticker: stickerFromRow(row), inserted: existing === undefined };
    },

    markMissingStickers(account, seenMd5s, now) {
      positiveId(account, 'account');
      if (!Number.isFinite(now)) throw new RangeError('更新时间无效');
      const seen = [...new Set(seenMd5s.map(normalizeMd5))];
      const sql = seen.length === 0
        ? 'UPDATE stickers SET missing = 1, updated_at = ? WHERE account = ? AND missing = 0'
        : `UPDATE stickers SET missing = 1, updated_at = ? WHERE account = ? AND missing = 0 AND md5 NOT IN (${seen.map(() => '?').join(',')})`;
      const result = database.prepare(sql).run(now, account, ...seen);
      return numberValue(result.changes, 'changes');
    },

    setStickerFile(id, file, now) {
      positiveId(id, 'sticker id');
      if (!Number.isFinite(now)) throw new RangeError('更新时间无效');
      const sticker = selectById.get(id) as Record<string, unknown> | undefined;
      if (!sticker) throw new Error('表情不存在');
      if (file !== null) {
        const md5 = stringValue(sticker.md5, 'md5');
        if (file !== `${md5}.jpg` && file !== `${md5}.png` && file !== `${md5}.gif` && file !== `${md5}.webp`) {
          throw new TypeError('表情文件名必须是 md5 与图片扩展名');
        }
      }
      updateStickerFile.run(file, now, id);
    },

    stickersNeedingDescription(account, maxAttempts) {
      positiveId(account, 'account');
      if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 0 || maxAttempts > 3) {
        throw new RangeError('表情描述重试次数无效');
      }
      return (selectNeedingDescription.all(account, maxAttempts) as Array<Record<string, unknown>>).map(stickerFromRow);
    },

    recordStickerDescriptionAttempt(id, now) {
      positiveId(id, 'sticker id');
      if (!Number.isFinite(now)) throw new RangeError('更新时间无效');
      updateDescriptionAttempt.run(now, id);
    },

    saveStickerDescription(id, descAi, tags, now) {
      positiveId(id, 'sticker id');
      if (!Number.isFinite(now)) throw new RangeError('更新时间无效');
      validateDescription(descAi, tags);
      updateStickerDescription.run(descAi, JSON.stringify(tags), now, id);
    },

    updateSticker(id, update, now) {
      positiveId(id, 'sticker id');
      if (!Number.isFinite(now)) throw new RangeError('更新时间无效');
      const row = selectById.get(id) as Record<string, unknown> | undefined;
      if (!row) return undefined;
      const current = stickerFromRow(row);
      const enabled = update.enabled ?? current.enabled;
      const tags = update.tags ?? current.tags;
      const descAi = update.descAi ?? current.descAi;
      const descQq = update.descAi ?? current.descQq;
      const manualDesc = update.descAi === undefined ? current.manualDesc : update.descAi;
      validateDescription(descAi, tags);
      updateStickerFields.run(enabled ? 1 : 0, JSON.stringify(tags), descAi, descQq, manualDesc, now, id);
      const saved = selectById.get(id) as Record<string, unknown>;
      return stickerFromRow(saved);
    },

    recordStickerUse(id, now) {
      positiveId(id, 'sticker id');
      if (!Number.isFinite(now)) throw new RangeError('更新时间无效');
      const result = updateStickerUse.run(now, now, id);
      if (numberValue(result.changes, 'changes') === 0) return undefined;
      const row = selectById.get(id) as Record<string, unknown>;
      return stickerFromRow(row);
    },
  };
}
