import { readFileSync } from 'node:fs';
import type { AffinityLevel } from '../../store/affect-repo.ts';
import { sessionId, type IncomingMessage } from '../shared/events.ts';
import { containsSensitiveText } from '../impressions/sensitive-text.ts';
import type { InteractionAction, InteractionCheckContext, InteractionDecision, InteractionSource } from './model.ts';
import type { RateLimiter, RateLimits } from '../shared/rate-limit.ts';
import type { MoodBand } from '../../store/affect-repo.ts';

export interface EmojiWhitelistEntry {
  emoji_id: string;
  name: string;
}

export type EmojiWhitelist = Record<MoodBand, readonly EmojiWhitelistEntry[]>;

const MOOD_BANDS: readonly MoodBand[] = ['low', 'annoyed', 'calm', 'happy', 'excited'];
const SERIOUS_TOPIC_PATTERN = /生病|发烧|重病|癌症|住院|手术|去世|过世|死亡|丧事|吵架|争吵|冲突|分手|离婚|自杀|抑郁|崩溃|绝望|被欺负|霸凌|事故|失业|被裁员|坏消息|没(?:有)?好消息|失败|没通过|没成功|落选|被拒|遗憾|难过|伤心|失望|出问题|故障|受伤|急诊|家暴|不想活|想死|\b(?:cancer|hospitalized|surgery|passed away|died|suicide|depressed|abuse)\b/iu;
const NEGATIVE_SOCIAL_PATTERN = /不想分享|不愿分享|不能分享|没什么好分享|没有什么好分享/u;
const POSITIVE_PATTERNS = [
  /谢谢|谢啦|多谢|辛苦了/u,
  /好消息|成功了|终于|过关了|拿下了|中奖|做到了|恭喜/u,
  /分享|给你看|我拍了|我做了/u,
  /哈哈|笑死|自嘲|我太菜|我真笨|开个玩笑|\bh{2,}\b/iu,
];
const CLOSING_PATTERN = /^(?:谢谢(?:你)?|多谢(?:你)?|感谢(?:你)?|辛苦了|晚安|好的?|好哒|收到|知道了|懂了|拜拜|再见|嗯+|ok(?:ay)?)$/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function loadEmojiWhitelist(): EmojiWhitelist {
  const source = readFileSync(new URL('./emoji-whitelist.json', import.meta.url), 'utf8');
  const parsed: unknown = JSON.parse(source);
  if (!isRecord(parsed) || Object.keys(parsed).length !== MOOD_BANDS.length
    || !MOOD_BANDS.every((band) => Object.hasOwn(parsed, band))) {
    throw new TypeError('Emoji whitelist must contain exactly the five mood buckets');
  }
  const ids = new Set<string>();
  const result = {} as Record<MoodBand, EmojiWhitelistEntry[]>;
  for (const band of MOOD_BANDS) {
    const entries = parsed[band];
    if (!Array.isArray(entries) || entries.length < 3 || entries.length > 6) {
      throw new TypeError(`Emoji whitelist bucket ${band} must contain 3–6 entries`);
    }
    result[band] = entries.map((entry) => {
      if (!isRecord(entry) || Object.keys(entry).length !== 2
        || typeof entry.emoji_id !== 'string' || entry.emoji_id.length === 0
        || typeof entry.name !== 'string' || entry.name.trim().length === 0
        || ids.has(entry.emoji_id)) {
        throw new TypeError(`Emoji whitelist bucket ${band} contains an invalid or duplicate entry`);
      }
      ids.add(entry.emoji_id);
      return { emoji_id: entry.emoji_id, name: entry.name };
    });
  }
  return result;
}

export function selectEmoji(
  whitelist: EmojiWhitelist,
  band: MoodBand,
  previousEmojiId: string | undefined,
  random: () => number,
): EmojiWhitelistEntry {
  const entries = whitelist[band];
  if (!entries?.length) throw new RangeError(`Emoji whitelist bucket ${band} is empty`);
  const alternatives = previousEmojiId === undefined || entries.length < 2
    ? entries
    : entries.filter((entry) => entry.emoji_id !== previousEmojiId);
  const value = random();
  const sample = Number.isFinite(value) ? Math.min(Math.max(value, 0), 0.999999999999) : 0.5;
  return alternatives[Math.floor(sample * alternatives.length)]!;
}

export function isSeriousTopic(text: string): boolean {
  return SERIOUS_TOPIC_PATTERN.test(text);
}

export function isPositiveSocialMessage(text: string): boolean {
  if (isSeriousTopic(text) || NEGATIVE_SOCIAL_PATTERN.test(text)) return false;
  return POSITIVE_PATTERNS.some((pattern) => pattern.test(text));
}

export function isClosingMention(message: Pick<IncomingMessage, 'mentionsSelf' | 'plainText'>): boolean {
  if (!message.mentionsSelf) return false;
  const text = message.plainText.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
  return CLOSING_PATTERN.test(text);
}

export type ReactionTrigger = 'busy_suppressed' | 'positive_silence' | 'closing_mention';

export interface ReactionAttempt {
  message: IncomingMessage;
  trigger: ReactionTrigger;
  moodBand: MoodBand;
  affinityLevel?: AffinityLevel;
  probabilityScale?: number;
  random: () => number;
  rateLimiter: RateLimiter;
  limits: RateLimits;
  rateAlreadyReserved?: boolean;
}

export interface ReactionRuleService {
  tryReact(input: ReactionAttempt): Promise<InteractionDecision | undefined>;
}

function randomUnit(random: () => number): number {
  const value = random();
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), 0.999999999999) : 0.5;
}

export function createReactionRuleService(options: {
  gate: {
    check(action: InteractionAction, source?: InteractionSource, context?: InteractionCheckContext): Promise<InteractionDecision>;
  };
  whitelist?: EmojiWhitelist;
  onError?: (error: unknown, message: IncomingMessage) => void;
}): ReactionRuleService {
  const whitelist = options.whitelist ?? loadEmojiWhitelist();
  const previousEmojiBySession = new Map<string, string>();
  return {
    async tryReact(input) {
      if (input.message.session.kind !== 'group') return undefined;
      if (input.trigger === 'positive_silence'
        && (!(input.affinityLevel === 'more_than_friends'
          || input.affinityLevel === 'lover')
          || !isPositiveSocialMessage(input.message.plainText))) return undefined;
      if (input.trigger === 'closing_mention' && !isClosingMention(input.message)) return undefined;

      const policyBlockedReason = containsSensitiveText(input.message.plainText)
        ? 'sensitive_text'
        : isSeriousTopic(input.message.plainText) ? 'serious_topic' : undefined;
      const baseProbability = input.trigger === 'busy_suppressed' ? 0.7
        : input.trigger === 'closing_mention' ? 0.6 : 0.25;
      const configuredScale = input.probabilityScale ?? 1;
      const probabilityScale = Number.isFinite(configuredScale)
        ? Math.min(Math.max(configuredScale, 0), 1)
        : 0;
      const probability = baseProbability * probabilityScale;
      const probabilityMissed = !policyBlockedReason && randomUnit(input.random) >= probability;
      const blockReason = policyBlockedReason ?? (probabilityMissed ? 'probability_skip' : undefined);

      const currentSessionId = sessionId(input.message.session);
      const emoji = selectEmoji(whitelist, input.moodBand, previousEmojiBySession.get(currentSessionId), input.random);
      const action: InteractionAction = {
        kind: 'react',
        session: input.message.session,
        messageId: input.message.messageId,
        emojiId: emoji.emoji_id,
      };
      const context: InteractionCheckContext = {
        sourceMessageId: input.message.messageId,
        ...(blockReason === undefined ? {} : { policyBlockedReason: blockReason }),
        ...(input.rateAlreadyReserved ? {} : {
          sharedRateLimit: () => input.rateLimiter.check(input.message.session, input.message.senderId, input.limits),
        }),
      };
      try {
        const decision = await options.gate.check(action, 'rule', context);
        if (decision.verdict === 'executed') previousEmojiBySession.set(currentSessionId, emoji.emoji_id);
        return decision;
      } catch (error) {
        try { options.onError?.(error, input.message); } catch { /* 诊断回调不能覆盖 Gate 错误 */ }
        return undefined;
      }
    },
  };
}
