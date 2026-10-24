import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { PersonaTraits } from './api.ts';

const frontmatterPattern = /^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m;
const zeroTraits: PersonaTraits = { order: 0, morality: 0, talk: 0, mind: 0, humor: 0, openness: 0, imitation: 0 };
const traitFields: Array<keyof PersonaTraits> = ['order', 'morality', 'talk', 'mind', 'humor', 'openness', 'imitation'];
const traitLevelValues = { m2: -2, m1: -1, p1: 1, p2: 2 } as const;

function isTraitValue(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= -2
    && value <= 2
    && Math.abs(value * 10 - Math.round(value * 10)) <= 1e-8;
}

export function parsePersonaTraits(markdown: string): PersonaTraits | null {
  const match = frontmatterPattern.exec(markdown);
  if (!match) return { ...zeroTraits };
  try {
    const header: unknown = parseYaml(match[1] ?? '');
    if (header === null) return { ...zeroTraits };
    if (typeof header !== 'object' || Array.isArray(header)) return null;
    const headerValues = header as Record<string, unknown>;
    if (!Object.hasOwn(headerValues, 'traits')) return { ...zeroTraits };
    const raw = headerValues.traits;
    if (typeof raw !== 'object' || Array.isArray(raw)) return null;
    const values = raw as Record<string, unknown>;
    const traits = { ...zeroTraits };
    for (const field of traitFields) {
      const rawValue = Object.hasOwn(values, field) ? values[field] : 0;
      const value = typeof rawValue === 'string' && Object.hasOwn(traitLevelValues, rawValue)
        ? traitLevelValues[rawValue as keyof typeof traitLevelValues]
        : rawValue;
      if (!isTraitValue(value)) return null;
      traits[field] = value;
    }
    return traits;
  } catch {
    return null;
  }
}

export function updatePersonaMarkdownTraits(markdown: string, traits: PersonaTraits): string {
  const match = frontmatterPattern.exec(markdown);
  let header: Record<string, unknown> = {};
  let body = markdown;
  if (match) {
    try {
      const parsed: unknown = parseYaml(match[1] ?? '');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        header = parsed as Record<string, unknown>;
      }
    } catch {
      // Replacing an invalid header through the selectors keeps the Markdown body recoverable.
    }
    body = markdown.slice(match[0].length);
  }
  return `---\n${stringifyYaml({ ...header, traits })}---\n${body}`;
}
