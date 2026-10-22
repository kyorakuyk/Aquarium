const MAX_PART_LENGTH = 80;
const MAX_PARTS = 3;
const TERMINAL_MARKS = new Set(['。', '！', '？', '!', '?', '…']);

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

function mergeAdjacentParts(parts: ReplyPart[], maxPartLength: number): ReplyPart[] {
  const merged: ReplyPart[] = [];
  for (const part of parts) {
    const previous = merged.at(-1);
    if (previous) {
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
  maxPartLength = MAX_PART_LENGTH,
): string[] {
  if (characterCount(text) <= maxPartLength) return text === '' ? [] : [text];

  const paragraphs = text.split(/\r\n|\r|\n/u);
  const parts = paragraphs.flatMap((paragraph, paragraphIndex) => {
    if (!paragraph) return [];
    const sentences = characterCount(paragraph) > maxPartLength
      ? splitLongParagraph(paragraph)
      : [paragraph];
    return sentences.flatMap((sentence) => limitPartLength(sentence, maxPartLength).map((part): ReplyPart => ({
      text: part,
      firstParagraph: paragraphIndex,
      lastParagraph: paragraphIndex,
    })));
  });
  const merged = mergeAdjacentParts(attachPunctuationOnlyParts(parts, maxPartLength), maxPartLength);
  if (merged.length <= maxParts) return merged.map((part) => part.text);

  let last = merged[maxParts - 1];
  if (!last) return merged.slice(0, maxParts).map((part) => part.text);
  for (const extra of merged.slice(maxParts)) last = joinParts(last, extra);
  return [...merged.slice(0, maxParts - 1), last].map((part) => part.text);
}
