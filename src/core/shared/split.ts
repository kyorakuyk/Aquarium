const MAX_PART_LENGTH = 80;
const MAX_PARTS = 3;
const TERMINAL_MARKS = new Set(['。', '！', '？', '!', '?', '…']);

export interface SplitReplyOptions {
  segmenting?: 'multi' | 'one_message';
  maxPartLength?: number;
}

function characterCount(text: string): number {
  return Array.from(text).length;
}

function isTerminal(character: string): boolean {
  return TERMINAL_MARKS.has(character);
}

function hasText(text: string): boolean {
  return /[^\p{P}\p{Z}\s]/u.test(text);
}

function isPunctuationOnly(text: string): boolean {
  return /^[\p{P}\p{Z}\s]*$/u.test(text);
}

interface ReplyPart {
  text: string;
  firstParagraph: number;
  lastParagraph: number;
}

function joinParts(first: ReplyPart, second: ReplyPart): ReplyPart {
  const separator = first.lastParagraph === second.firstParagraph ? '' : '\n';
  return {
    text: first.text + separator + second.text,
    firstParagraph: first.firstParagraph,
    lastParagraph: second.lastParagraph,
  };
}

function splitLongParagraph(paragraph: string): string[] {
  const characters = Array.from(paragraph);
  const sentences: string[] = [];
  let current = '';

  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index] ?? '';
    current += character;
    if (!isTerminal(character)) continue;

    while (index + 1 < characters.length && isTerminal(characters[index + 1] ?? '')) {
      index += 1;
      current += characters[index];
    }
    if (hasText(current)) {
      sentences.push(current);
      current = '';
    }
  }

  if (current) sentences.push(current);
  return sentences;
}

function terminalTokens(text: string): string[] {
  const characters = Array.from(text);
  const tokens: string[] = [];
  for (let index = 0; index < characters.length; index += 1) {
    let token = characters[index] ?? '';
    if (isTerminal(token)) {
      while (index + 1 < characters.length && isTerminal(characters[index + 1] ?? '')) {
        index += 1;
        token += characters[index];
      }
    }
    tokens.push(token);
  }
  return tokens;
}

function limitPartLength(text: string, maxPartLength: number): string[] {
  const parts: string[] = [];
  let current = '';
  let currentLength = 0;

  for (const token of terminalTokens(text)) {
    const tokenLength = characterCount(token);
    if (current && currentLength + tokenLength > maxPartLength) {
      parts.push(current);
      current = '';
      currentLength = 0;
    }
    current += token;
    currentLength += tokenLength;
  }

  if (current) parts.push(current);
  return parts;
}

function attachPunctuationOnlyParts(parts: ReplyPart[], maxPartLength: number): ReplyPart[] {
  const result = parts.map((part) => ({ ...part }));
  for (let index = 0; index < result.length; index += 1) {
    const part = result[index];
    if (!part || !part.text || !isPunctuationOnly(part.text)) continue;

    if (index + 1 < result.length) {
      const next = result[index + 1];
      if (!next) continue;
      const separatorLength = part.lastParagraph === next.firstParagraph ? 0 : 1;
      const available = Math.max(
        0,
        maxPartLength - characterCount(part.text) - separatorLength,
      );
      const nextCharacters = Array.from(next.text);
      const prefixLength = Math.min(available, nextCharacters.length);
      if (prefixLength > 0) {
        const prefix: ReplyPart = {
          text: nextCharacters.slice(0, prefixLength).join(''),
          firstParagraph: next.firstParagraph,
          lastParagraph: next.firstParagraph,
        };
        result[index] = joinParts(part, prefix);
        result[index + 1] = {
          ...next,
          text: nextCharacters.slice(prefixLength).join(''),
        };
      } else if (index > 0) {
        attachToPrevious(result, index, part);
      }
    } else if (index > 0) {
      attachToPrevious(result, index, part);
    }
  }
  return result.filter((part) => part.text !== '' && !isPunctuationOnly(part.text));
}

function isStandaloneShortAside(text: string): boolean {
  const value = text.trim();
  const open = value[0];
  const close = open === '（' ? '）' : open === '(' ? ')' : undefined;
  if (!close || value.at(-1) !== close) return false;
  return characterCount(value.slice(1, -1)) <= 8;
}

function attachStandaloneShortAsides(parts: ReplyPart[], maxPartLength: number): ReplyPart[] {
  const result = parts.map((part) => ({ ...part }));
  let index = 0;
  while (index < result.length) {
    const aside = result[index];
    if (!aside || !isStandaloneShortAside(aside.text)) {
      index += 1;
      continue;
    }

    const previous = result[index - 1];
    if (previous) {
      const combined = joinParts(previous, aside);
      if (characterCount(combined.text) <= maxPartLength) {
        result[index - 1] = combined;
        result.splice(index, 1);
      } else {
        const separator = previous.lastParagraph === aside.firstParagraph ? '' : '\n';
        const available = Math.max(1, maxPartLength - characterCount(aside.text) - characterCount(separator));
        const previousCharacters = Array.from(previous.text);
        const moveLength = Math.min(available, previousCharacters.length);
        const moved = previousCharacters.slice(-moveLength).join('');
        const remaining = previousCharacters.slice(0, -moveLength).join('');
        const attached: ReplyPart = {
          text: moved + separator + aside.text,
          firstParagraph: previous.lastParagraph,
          lastParagraph: aside.lastParagraph,
        };
        result.splice(index - 1, 2, ...(remaining ? [{ ...previous, text: remaining }, attached] : [attached]));
      }
      index = Math.max(0, index - 1);
      continue;
    }

    const next = result[index + 1];
    if (!next) {
      index += 1;
      continue;
    }
    const combined = joinParts(aside, next);
    if (characterCount(combined.text) <= maxPartLength) {
      result[index] = combined;
      result.splice(index + 1, 1);
      continue;
    }
    const separator = aside.lastParagraph === next.firstParagraph ? '' : '\n';
    const available = Math.max(1, maxPartLength - characterCount(aside.text) - characterCount(separator));
    const nextCharacters = Array.from(next.text);
    const moveLength = Math.min(available, nextCharacters.length);
    const attached: ReplyPart = {
      text: aside.text + separator + nextCharacters.slice(0, moveLength).join(''),
      firstParagraph: aside.firstParagraph,
      lastParagraph: next.firstParagraph,
    };
    const remaining = nextCharacters.slice(moveLength).join('');
    result.splice(index, 2, attached, ...(remaining ? [{ ...next, text: remaining }] : []));
    index += 1;
  }
  return result;
}

function attachToPrevious(parts: ReplyPart[], index: number, part: ReplyPart): void {
  const previous = parts[index - 1];
  if (!previous) return;
  const previousCharacters = Array.from(previous.text);
  const moveLength = Math.min(Math.max(1, characterCount(part.text)), previousCharacters.length);
  if (moveLength === 0) return;

  const moved: ReplyPart = {
    text: previousCharacters.slice(-moveLength).join(''),
    firstParagraph: previous.lastParagraph,
    lastParagraph: previous.lastParagraph,
  };
  parts[index - 1] = {
    ...previous,
    text: previousCharacters.slice(0, -moveLength).join(''),
  };
  parts[index] = joinParts(moved, part);
}

function mergeAdjacentParts(parts: ReplyPart[], maxPartLength: number, mergeAcrossLines: boolean): ReplyPart[] {
  const merged: ReplyPart[] = [];
  for (const part of parts) {
    const previous = merged.at(-1);
    if (previous && (mergeAcrossLines || previous.lastParagraph === part.firstParagraph)) {
      const combined = joinParts(previous, part);
      if (characterCount(combined.text) <= maxPartLength) {
        merged[merged.length - 1] = combined;
        continue;
      }
      merged.push(part);
    } else {
      merged.push(part);
    }
  }
  return merged;
}

export function splitReply(
  text: string,
  maxParts: 1 | 2 | 3 = MAX_PARTS,
  options: SplitReplyOptions | number = {},
): string[] {
  const segmenting = typeof options === 'number' ? 'multi' : options.segmenting ?? 'multi';
  const maxPartLength = typeof options === 'number' ? options : options.maxPartLength ?? MAX_PART_LENGTH;
  const hasLineBreak = /[\r\n]/u.test(text);
  if (characterCount(text) <= maxPartLength) {
    if (segmenting === 'one_message') return text === '' ? [] : [text];
    if (!hasLineBreak) return text.trim() === '' ? [] : [text];
  }

  const paragraphs = text.split(/\r\n|\r|\n/u);
  const parts = paragraphs.flatMap((paragraph, paragraphIndex) => {
    if (!paragraph.trim()) return [];
    const sentences = characterCount(paragraph) > maxPartLength
      ? splitLongParagraph(paragraph)
      : [paragraph];
    return sentences.flatMap((sentence) => limitPartLength(sentence, maxPartLength).map((part): ReplyPart => ({
      text: part,
      firstParagraph: paragraphIndex,
      lastParagraph: paragraphIndex,
    })));
  });
  const merged = mergeAdjacentParts(
    attachStandaloneShortAsides(attachPunctuationOnlyParts(parts, maxPartLength), maxPartLength),
    maxPartLength,
    segmenting === 'one_message',
  );
  if (merged.length <= maxParts) return merged.map((part) => part.text);

  let last = merged[maxParts - 1];
  if (!last) return merged.slice(0, maxParts).map((part) => part.text);
  for (const extra of merged.slice(maxParts)) last = joinParts(last, extra);
  return [...merged.slice(0, maxParts - 1), last].map((part) => part.text);
}
