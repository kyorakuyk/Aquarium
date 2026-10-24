const NAMED_ENTITIES = new Map([
  ['amp', '&'],
  ['apos', "'"],
  ['gt', '>'],
  ['lt', '<'],
  ['nbsp', '\u00a0'],
  ['quot', '"'],
]);

function decodeNumericEntity(reference: string, original: string): string {
  const hexadecimal = /^#x/i.test(reference);
  const digits = reference.slice(hexadecimal ? 2 : 1);
  const codePoint = Number.parseInt(digits, hexadecimal ? 16 : 10);
  if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
    return original;
  }
  return String.fromCodePoint(codePoint);
}

export function decodeGroupAnnouncement(value: string): string {
  return value.replace(/&(#(?:x[\da-f]+|\d+)|[a-z][a-z\d]*);/giu, (original, reference: string) => {
    if (reference.startsWith('#')) return decodeNumericEntity(reference, original);
    return NAMED_ENTITIES.get(reference.toLowerCase()) ?? original;
  });
}
