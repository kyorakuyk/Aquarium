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

function limitPartLength(text: string): string[] {
  const parts: string[] = [];
  let current = '';
  let currentLength = 0;

  for (const token of terminalTokens(text)) {
    const tokenLength = characterCount(token);
    if (current && currentLength + tokenLength > MAX_PART_LENGTH) {
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

function attachPunctuationOnlyParts(parts: string[]): string[] {
  const result = [...parts];
  for (let index = 0; index < result.length; index += 1) {
    const part = result[index] ?? '';
    if (!part || !isPunctuationOnly(part)) continue;

    if (index + 1 < result.length) {
      const nextCharacters = Array.from(result[index + 1] ?? '');
      const available = Math.max(0, MAX_PART_LENGTH - characterCount(part));
      const prefixLength = Math.min(available, nextCharacters.length);
      result[index] = part + nextCharacters.slice(0, prefixLength).join('');
      result[index + 1] = nextCharacters.slice(prefixLength).join('');
    } else if (index > 0) {
      const previousCharacters = Array.from(result[index - 1] ?? '');
      const moveLength = Math.min(characterCount(part), previousCharacters.length);
      result[index - 1] = previousCharacters.slice(0, -moveLength).join('');
      result[index] = previousCharacters.slice(-moveLength).join('') + part;
    }
  }
  return result.filter((part) => part !== '' && !isPunctuationOnly(part));
}

function mergeAdjacentParts(parts: string[]): string[] {
  const merged: string[] = [];
  for (const part of parts) {
    const previous = merged.at(-1);
    if (previous && characterCount(previous) + characterCount(part) <= MAX_PART_LENGTH) {
      merged[merged.length - 1] = previous + part;
    } else {
      merged.push(part);
    }
  }
  return merged;
}

export function splitReply(text: string): string[] {
  if (characterCount(text) <= MAX_PART_LENGTH) return text === '' ? [] : [text];

  const paragraphs = text.split(/\r\n|\r|\n/u).filter(Boolean);
  const sentences = paragraphs.flatMap((paragraph) => (
    characterCount(paragraph) > MAX_PART_LENGTH ? splitLongParagraph(paragraph) : [paragraph]
  ));
  const boundedParts = sentences.flatMap(limitPartLength);
  const parts = mergeAdjacentParts(attachPunctuationOnlyParts(boundedParts));
  if (parts.length <= MAX_PARTS) return parts;
  return [...parts.slice(0, MAX_PARTS - 1), parts.slice(MAX_PARTS - 1).join('')];
}
