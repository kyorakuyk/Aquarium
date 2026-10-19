import type { AquariumConfig } from '../../config/schema.ts';
import type { MoodBand } from '../../store/affect-repo.ts';
import type { StoredDecision } from '../../store/repository.ts';
import type { StickerRecord } from '../../store/sticker-repo.ts';

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const THIRTY_MINUTES_MS = 30 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

type StickerConfig = AquariumConfig['stickers'];

export interface StickerOfferCandidate {
  id: number;
  emojiId: string;
  file: string;
  descAi: string;
  tags: string[];
}

export interface StickerOffer {
  candidates: StickerOfferCandidate[];
  promptList: string;
}

function decisionDetail(decision: StoredDecision): Record<string, unknown> | undefined {
  return typeof decision.detail === 'object' && decision.detail !== null && !Array.isArray(decision.detail)
    ? decision.detail as Record<string, unknown>
    : undefined;
}

function sentStickerId(decision: StoredDecision): number | undefined {
  const id = decisionDetail(decision)?.stickerSent;
  return decision.replied && typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function characterBigrams(value: string): Set<string> {
  const characters = Array.from(value.toLowerCase());
  const result = new Set<string>();
  for (let index = 0; index + 1 < characters.length; index += 1) {
    result.add(`${characters[index]}${characters[index + 1]}`);
  }
  return result;
}

function overlapScore(messageBigrams: Set<string>, sticker: StickerRecord): number {
  const stickerBigrams = new Set<string>();
  for (const value of [sticker.descAi, ...sticker.tags]) {
    for (const bigram of characterBigrams(value)) stickerBigrams.add(bigram);
  }
  let score = 0;
  for (const bigram of messageBigrams) {
    if (stickerBigrams.has(bigram)) score += 1;
  }
  return score;
}

function moodBonus(sticker: StickerRecord, moodBand: MoodBand): number {
  const words: Record<Exclude<MoodBand, 'calm'>, string[]> = {
    low: ['低落', '难过'],
    annoyed: ['无语', '生气'],
    happy: ['开心', '好耶'],
    excited: ['激动', '兴奋'],
  };
  if (moodBand === 'calm') return 0;
  return sticker.tags.some((tag) => words[moodBand].some((word) => tag.includes(word))) ? 2 : 0;
}

function stableOrder(sessionId: string, hour: number, id: number): number {
  let hash = 2_166_136_261;
  for (const character of `${sessionId}:${hour}:${id}`) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return hash;
}

function repliesWithin(history: readonly StoredDecision[], now: number): StoredDecision[] {
  const cutoff = now - TWO_HOURS_MS;
  return history.filter((decision) => decision.replied && decision.time >= cutoff && decision.time <= now);
}

export function canSendStickerOnly(
  history: readonly StoredDecision[],
  now: number,
  onlyStickerRatio: number,
): boolean {
  if (!Number.isFinite(now) || !Number.isFinite(onlyStickerRatio)
    || onlyStickerRatio < 0 || onlyStickerRatio > 1) {
    throw new RangeError('只发表情比例参数无效');
  }
  const replies = repliesWithin(history, now);
  if (replies.length === 0) return 0 < onlyStickerRatio;
  const stickerOnlyReplies = replies.filter((decision) => decisionDetail(decision)?.stickerOnly === true).length;
  return stickerOnlyReplies / replies.length < onlyStickerRatio;
}

export function selectStickerCandidates(input: {
  config: StickerConfig;
  stickers: readonly StickerRecord[];
  history: readonly StoredDecision[];
  messageText: string;
  moodBand: MoodBand;
  sessionId: string;
  now: number;
}): StickerOffer | null {
  if (!Number.isFinite(input.now)) throw new RangeError('表情候选时间无效');
  if (!input.config.enabled) return null;
  const eligible = input.stickers.filter((sticker) => (
    sticker.enabled && !sticker.missing && sticker.file !== null
  ));
  if (eligible.length < 3) return null;

  const replies = repliesWithin(input.history, input.now);
  const stickerReplies = replies.filter((decision) => sentStickerId(decision) !== undefined);
  const stickerRatio = replies.length === 0 ? 0 : stickerReplies.length / replies.length;
  if (!(stickerRatio < input.config.maxRatio)) return null;

  const cooldownMs = input.config.cooldownSec * 1000;
  const lastStickerReply = input.history
    .filter((decision) => sentStickerId(decision) !== undefined && decision.time <= input.now)
    .reduce<StoredDecision | undefined>((latest, decision) => (
      latest === undefined || decision.time > latest.time ? decision : latest
    ), undefined);
  if (lastStickerReply && input.now - lastStickerReply.time < cooldownMs) return null;

  const recentlyUsed = new Set(input.history
    .filter((decision) => decision.time >= input.now - THIRTY_MINUTES_MS
      && decision.time <= input.now)
    .map(sentStickerId)
    .filter((id): id is number => id !== undefined));
  const messageBigrams = characterBigrams(input.messageText);
  const hour = Math.floor(input.now / HOUR_MS);
  const ordered = eligible.map((sticker) => ({
    sticker,
    score: overlapScore(messageBigrams, sticker)
      + moodBonus(sticker, input.moodBand)
      - (recentlyUsed.has(sticker.id) ? 3 : 0),
    tieBreak: stableOrder(input.sessionId, hour, sticker.id),
  })).sort((left, right) => (
    right.score - left.score || left.tieBreak - right.tieBreak || left.sticker.id - right.sticker.id
  ));

  const candidates = ordered.slice(0, input.config.candidates).map(({ sticker }) => ({
    id: sticker.id,
    emojiId: sticker.emojiId,
    file: sticker.file!,
    descAi: sticker.descAi,
    tags: [...sticker.tags],
  }));
  return {
    candidates,
    promptList: candidates.map((candidate, index) => `${index + 1} ${candidate.descAi || '暂无描述'}`).join(' / '),
  };
}
