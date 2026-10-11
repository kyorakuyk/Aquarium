const MAX_PART_LENGTH = 80;
const MAX_PARTS = 3;

function splitAtBoundaries(text: string): string[] {
  const pieces: string[] = [];
  let current = '';
  const flush = (): void => {
    const value = current.trim();
    if (value) pieces.push(value);
    current = '';
  };

  for (const character of text) {
    if (character === '\n' || character === '\r') {
      flush();
      continue;
    }
    current += character;
    if (/[。！？.!?]/u.test(character)) flush();
  }
  flush();
  return pieces;
}

function limitPartLength(text: string): string[] {
  const characters = Array.from(text);
  const parts: string[] = [];
  for (let offset = 0; offset < characters.length; offset += MAX_PART_LENGTH) {
    parts.push(characters.slice(offset, offset + MAX_PART_LENGTH).join(''));
  }
  return parts;
}

export function splitReply(text: string): string[] {
  const sentences = splitAtBoundaries(text.trim());
  const parts = sentences.flatMap(limitPartLength);
  if (parts.length <= MAX_PARTS) return parts;
  return [...parts.slice(0, MAX_PARTS - 1), parts.slice(MAX_PARTS - 1).join('')];
}
