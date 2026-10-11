function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function cleanReply(text: string, nicknamePrefixes: readonly string[] = []): string {
  let cleaned = text.trim()
    .replace(/^\s*```[^\r\n]*(?:\r?\n)?/u, '')
    .replace(/(?:\r?\n)?```\s*$/u, '')
    .replace(/!\[([^\]]*)\]\([^)]+\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, '$1')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gmu, '')
    .replace(/^[ \t]*>[ \t]?/gmu, '')
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gmu, '')
    .replace(/[`*_~]/gu, '')
    .trim();

  const prefixes = nicknamePrefixes
    .map((nickname) => nickname.trim())
    .filter(Boolean)
    .map(escapePattern);
  if (prefixes.length > 0) {
    const prefix = new RegExp(`^(?:${prefixes.join('|')})[\\t ]*[:：][\\t ]*`, 'u');
    cleaned = cleaned.replace(prefix, '').trimStart();
  }

  return cleaned.trim();
}
