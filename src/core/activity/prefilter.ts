import type { IncomingMessage } from '../events.ts';
import { PREFILTER_WEIGHTS } from './prefilter-weights.ts';

export const PREFILTER_THRESHOLD = 0.15;

export interface PrefilterFeatures {
  active: boolean;
  cold: boolean;
  question: boolean;
  mediaOnly: boolean;
  atOther: boolean;
}

export interface PrefilterEvaluation {
  p0: number;
  shouldJudge: boolean;
}

export interface PrefilterActivityTimes {
  now: number;
  firstMessageAt: number;
  lastBotMessageAt?: number;
  lastMessageBeforeBatchAt?: number;
}

type PrefilterMessage = Pick<IncomingMessage, 'session' | 'segments' | 'plainText'>;

export function calculatePrefilterActivity(
  times: PrefilterActivityTimes,
): Pick<PrefilterFeatures, 'active' | 'cold'> {
  const active = times.lastBotMessageAt !== undefined
    && times.lastBotMessageAt <= times.now
    && times.now - times.lastBotMessageAt <= 30 * 60_000;
  const cold = times.lastMessageBeforeBatchAt !== undefined
    && times.lastMessageBeforeBatchAt <= times.firstMessageAt
    && times.firstMessageAt - times.lastMessageBeforeBatchAt >= 20 * 60_000;
  return { active, cold };
}

export function calculatePrefilterFeatures(
  messages: readonly PrefilterMessage[],
  activity: Pick<PrefilterFeatures, 'active' | 'cold'>,
): PrefilterFeatures {
  const textSegments = messages.flatMap((message) => message.segments
    .filter((segment) => segment.type === 'text')
    .map((segment) => segment.text));
  const text = [
    ...messages.map((message) => message.plainText),
    ...textSegments,
  ].join('\n');
  const contentSegments = messages.flatMap((message) => message.segments
    .filter((segment) => segment.type !== 'reply'));
  const hasMedia = contentSegments.some((segment) => segment.type === 'image' || segment.type === 'face');
  const hasNonMediaContent = contentSegments.some((segment) => {
    if (segment.type === 'image' || segment.type === 'face') return false;
    return segment.type !== 'text' || segment.text.trim() !== '';
  });
  const hasTextContent = text.trim() !== '';

  return {
    active: activity.active,
    cold: activity.cold,
    question: text.includes('?') || text.includes('？'),
    mediaOnly: messages.length > 0 && hasMedia && !hasTextContent && !hasNonMediaContent,
    atOther: messages.some((message) => message.segments.some((segment) => (
      segment.type === 'at'
      && segment.target !== 'all'
      && segment.target !== message.session.account
    ))),
  };
}

export function evaluatePrefilter(features: PrefilterFeatures): PrefilterEvaluation {
  const logit = PREFILTER_WEIGHTS.bias
    + (features.active ? PREFILTER_WEIGHTS.active : 0)
    + (features.cold ? PREFILTER_WEIGHTS.cold : 0)
    + (features.question ? PREFILTER_WEIGHTS.question : 0)
    + (features.mediaOnly ? PREFILTER_WEIGHTS.mediaOnly : 0)
    + (features.atOther ? PREFILTER_WEIGHTS.atOther : 0);
  const p0 = 1 / (1 + Math.exp(-logit));
  return { p0, shouldJudge: p0 >= PREFILTER_THRESHOLD };
}
