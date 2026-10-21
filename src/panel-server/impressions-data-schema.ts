import { z } from 'zod';
import { TAG_TEXT_MAX, TAG_TEXT_MIN } from '../core/impressions/service.ts';
import { isTagCategory, isTagCategoryForScope } from '../core/impressions/tag-model.ts';
import { ACCOUNT_KINDS, RELATION_TYPES } from '../store/identity-repo.ts';

const positiveId = z.number().int().positive().refine(Number.isSafeInteger);
const nonNegativeTime = z.number().int().nonnegative().refine(Number.isSafeInteger);

const importTagSchema = z.object({
  userId: positiveId.nullable(),
  text: z.string().min(TAG_TEXT_MIN).max(TAG_TEXT_MAX),
  norm: z.string().min(1),
  category: z.string().refine(isTagCategory),
  subject: z.string().nullable(),
  polarity: z.enum(['like', 'dislike']).nullable(),
  origin: z.enum(['self_report', 'inferred', 'stats', 'manual']),
  locked: z.boolean(),
  status: z.enum(['candidate', 'confirmed', 'rejected']),
  source: z.enum(['auto', 'manual']),
  samples: z.number().int().nonnegative().refine(Number.isSafeInteger),
  evidence: z.array(z.union([
    z.object({ kind: z.literal('message'), messageId: z.string().min(1), time: nonNegativeTime, quote: z.string() }).strict(),
    z.object({ kind: z.literal('signature'), text: z.string(), fetchedAt: nonNegativeTime }).strict(),
  ])),
  firstSeen: nonNegativeTime,
  lastSeen: nonNegativeTime,
  updatedAt: nonNegativeTime,
}).strict().refine((tag) => isTagCategoryForScope(tag.category, tag.userId === null ? 'group' : 'member'));

export const importFileSchema = z.object({
  version: z.literal(1),
  exportedAt: z.string().datetime(),
  account: positiveId,
  sessionId: z.string().min(1),
  groupName: z.string().min(1),
  tags: z.array(importTagSchema).optional().default([]),
  summaries: z.array(z.object({
    userId: positiveId,
    text: z.string().min(1).max(50),
    manual: z.boolean(),
    updatedAt: nonNegativeTime,
  }).strict()).optional().default([]),
  subjects: z.array(z.object({
    category: z.string().refine((category) => category === 'topic' || category === 'fandom'),
    name: z.string().min(1).max(40),
    aliases: z.array(z.string().min(1).max(40)).max(40),
  }).strict()).optional().default([]),
  vetoes: z.array(z.object({
    userId: positiveId.nullable(),
    category: z.string().refine(isTagCategory),
    subjectNorm: z.string().max(120),
    textNorm: z.string().min(1).max(120),
    createdAt: nonNegativeTime,
  }).strict().refine((veto) => isTagCategoryForScope(veto.category, veto.userId === null ? 'group' : 'member'))).optional().default([]),
  relations: z.array(z.object({
    aUserId: positiveId,
    bUserId: positiveId,
    type: z.enum(RELATION_TYPES),
    label: z.string().max(40).nullable(),
    locked: z.boolean(),
    createdAt: nonNegativeTime,
  }).strict().refine((relation) => relation.aUserId !== relation.bUserId
    && (relation.type === 'other'
      ? Boolean(relation.label?.trim())
      : relation.label === null))).optional().default([]),
  accountKinds: z.array(z.object({
    userId: positiveId,
    kind: z.enum(ACCOUNT_KINDS),
    createdAt: nonNegativeTime,
  }).strict()).optional().default([]),
  activity: z.object({
    view: z.literal('year'),
    buckets: z.array(z.object({ date: z.string(), count: nonNegativeTime }).strict()).length(365),
    summary: z.object({
      total: nonNegativeTime,
      avgChars: z.number().nonnegative(),
      imageRatio: z.number().min(0).max(1),
    }).strict(),
  }).strict().optional(),
  privateFactsL1: z.array(z.object({
    ownerId: positiveId,
    sessionId: z.string().min(1),
    text: z.string().min(4).max(40),
    keywords: z.array(z.string().min(2).max(8)).min(2).max(5),
    level: z.literal('L1'),
    levelSource: z.enum(['auto', 'manual']),
    mentions: z.number().int().nonnegative().refine(Number.isSafeInteger),
    mentionEvidence: z.array(z.object({ sessionId: z.string().min(1), messageId: z.string().min(1), time: nonNegativeTime }).strict()),
    evidence: z.array(z.object({ messageId: z.string().min(1), time: nonNegativeTime, quote: z.string() }).strict()),
    status: z.literal('active'),
    createdAt: nonNegativeTime,
    updatedAt: nonNegativeTime,
  }).strict()).optional(),
  mode: z.enum(['merge', 'overwrite']).optional(),
}).strict();

export const impressionsResetSchema = z.object({
  sessionId: z.string().min(1),
  confirm: z.string(),
}).strict();

export type ImpressionsImportFile = z.infer<typeof importFileSchema>;
export type ImpressionsImportTag = z.infer<typeof importTagSchema>;
