import type { StickerOffer } from './selection.ts';

const MARKER_PATTERN = /\[表情:[^\]\n]*\]/gu;
const VALID_MARKER = /^\[表情:(\d{1,3})\]$/u;

export interface StickerReply {
  text: string;
  sticker?: StickerOffer['candidates'][number];
}

export function parseStickerReply(text: string, offer: StickerOffer | null | undefined): StickerReply {
  if (!offer || offer.candidates.length === 0) {
    return { text: text.replace(MARKER_PATTERN, '').trim() };
  }
  let sticker: StickerOffer['candidates'][number] | undefined;
  for (const match of text.matchAll(MARKER_PATTERN)) {
    if (sticker !== undefined) continue;
    const index = VALID_MARKER.exec(match[0])?.[1];
    if (index === undefined) continue;
    sticker = offer.candidates[Number(index) - 1];
  }
  return {
    text: text.replace(MARKER_PATTERN, '').trim(),
    ...(sticker === undefined ? {} : { sticker }),
  };
}
