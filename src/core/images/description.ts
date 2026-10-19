export type VisionKind = 'sticker' | 'photo' | 'screenshot' | 'other';

export interface VisionDescription {
  kind: VisionKind;
  desc: string;
  text: string;
  legible: boolean;
}

const MAX_DESCRIPTION_LENGTH = 60;
const MAX_TRANSCRIBED_TEXT_LENGTH = 200;
const KINDS: VisionKind[] = ['sticker', 'photo', 'screenshot', 'other'];

function boundedText(value: string, limit: number): string {
  return Array.from(value.replace(/\s+/gu, ' ').trim()).slice(0, limit).join('');
}

export function parseVisionDescription(value: string): VisionDescription {
  const fallback: VisionDescription = {
    kind: 'other',
    desc: Array.from(value).slice(0, MAX_DESCRIPTION_LENGTH).join(''),
    text: '',
    legible: false,
  };
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return fallback;
    const record = parsed as Record<string, unknown>;
    if (!KINDS.includes(record.kind as VisionKind)
      || typeof record.desc !== 'string'
      || typeof record.text !== 'string'
      || typeof record.legible !== 'boolean') return fallback;
    const desc = boundedText(record.desc, MAX_DESCRIPTION_LENGTH);
    if (!desc) return fallback;
    return {
      kind: record.kind as VisionKind,
      desc,
      text: Array.from(record.text).slice(0, MAX_TRANSCRIBED_TEXT_LENGTH).join(''),
      legible: record.legible,
    };
  } catch {
    return fallback;
  }
}

export function renderVisionDescription(description: VisionDescription, forceSticker = false): string {
  const kind = forceSticker ? 'sticker' : description.kind;
  const label = kind === 'sticker' ? '表情包' : kind === 'screenshot' ? '截图' : '图片';
  const prefix = `[${label}：${description.desc}`;
  if (!description.text.trim()) return `${prefix}]`;
  const textLabel = kind === 'screenshot' ? '｜文字：' : '｜图上写着';
  return `${prefix}${textLabel}“${description.text}”]`;
}

export function withUnreadableText(description: VisionDescription): VisionDescription {
  const desc = description.desc.includes('文字看不清')
    ? description.desc
    : boundedText(`${description.desc}，文字看不清`, MAX_DESCRIPTION_LENGTH);
  return { ...description, desc, text: '', legible: false };
}
