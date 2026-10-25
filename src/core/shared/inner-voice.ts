import type { PersonaInnerVoiceMode } from '../../persona/load.ts';

export interface InnerVoiceSplit {
  spoken: string;
  asides: string[];
}

const CLOSING_FOR: Readonly<Record<string, string>> = {
  '（': '）',
  '(': ')',
};
const SENTENCE_END = /[。！？.!?…]$/u;
const SHORT_ASIDE_LIMIT = 8;

function characterCount(value: string): number {
  return Array.from(value).length;
}

function matchingClose(line: string, start: number, open: string, close: string): number {
  let depth = 0;
  for (let index = start; index < line.length; index += 1) {
    const character = line[index];
    if (character === open) depth += 1;
    if (character === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function isAside(line: string, start: number, end: number, inner: string): boolean {
  const prefix = line.slice(0, start).trim();
  const suffix = line.slice(end + 1).trim();
  const standalone = prefix === '' && suffix === '';
  if (standalone) return true;
  return (prefix === '' || SENTENCE_END.test(prefix)) && characterCount(inner) >= 9;
}

function processLine(
  line: string,
  mode: PersonaInnerVoiceMode,
  asides: string[],
  shortAsideRetained: { value: boolean },
): string {
  let spoken = '';
  let copiedThrough = 0;
  let searchFrom = 0;

  while (searchFrom < line.length) {
    const open = line[searchFrom];
    const close = open === undefined ? undefined : CLOSING_FOR[open];
    if (!open || !close) {
      searchFrom += 1;
      continue;
    }

    const end = matchingClose(line, searchFrom, open, close);
    if (end < 0) {
      searchFrom += 1;
      continue;
    }
    const inner = line.slice(searchFrom + 1, end);
    if (!isAside(line, searchFrom, end, inner)) {
      searchFrom = end + 1;
      continue;
    }

    const aside = line.slice(searchFrom, end + 1);
    const short = characterCount(inner) <= SHORT_ASIDE_LIMIT;
    const keep = mode === 'full'
      || (mode === 'light' && short && !shortAsideRetained.value);

    if (mode === 'full' || !keep) asides.push(aside);
    if (mode === 'light' && keep) shortAsideRetained.value = true;
    if (!keep) {
      spoken += line.slice(copiedThrough, searchFrom);
      copiedThrough = end + 1;
    }
    searchFrom = end + 1;
  }

  return spoken + line.slice(copiedThrough);
}

export function extractAsides(text: string, mode: PersonaInnerVoiceMode): InnerVoiceSplit {
  const asides: string[] = [];
  const shortAsideRetained = { value: false };
  const spoken = text
    .split(/\r\n|\r|\n/u)
    .map((line) => processLine(line, mode, asides, shortAsideRetained).trim())
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();

  return { spoken, asides };
}
