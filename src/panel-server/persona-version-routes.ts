import { existsSync, readFileSync } from 'node:fs';
import { Hono } from 'hono';
import type { PersonaTraits } from '../persona/load.ts';
import { parsePersonaMarkdown } from '../persona/load.ts';
import { PERSONA_SECTION_HEADINGS, parseSections, type PersonaSectionsForm } from '../persona/sections.ts';
import type { StoreRepository } from '../store/repository.ts';
import { personaPath, validPersonaId } from './persona-paths.ts';

const traitNames: Record<keyof PersonaTraits, string> = {
  order: '规矩',
  morality: '善意',
  talk: '话量',
  mind: '思维',
  humor: '脱线',
  openness: '好奇',
  imitation: '模仿',
};
const traitKeys = Object.keys(traitNames) as Array<keyof PersonaTraits>;

function neutralTraits(): PersonaTraits {
  return { order: 0, morality: 0, talk: 0, mind: 0, humor: 0, openness: 0, imitation: 0 };
}

function traitsForVersion(markdown: string): PersonaTraits {
  try { return parsePersonaMarkdown(markdown).traits; }
  catch { return neutralTraits(); }
}

function traitsFromJson(value: string): PersonaTraits {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return neutralTraits();
    const values = parsed as Record<string, unknown>;
    const traits = neutralTraits();
    for (const key of traitKeys) {
      const trait = Object.hasOwn(values, key) ? values[key] : 0;
      if (typeof trait !== 'number' || !Number.isFinite(trait)
        || trait < -2 || trait > 2
        || Math.abs(trait * 10 - Math.round(trait * 10)) > 1e-8) return neutralTraits();
      traits[key] = trait;
    }
    return traits;
  } catch {
    return neutralTraits();
  }
}

function traitDelta(previous: PersonaTraits | undefined, current: PersonaTraits): PersonaTraits {
  const before = previous ?? neutralTraits();
  const delta = neutralTraits();
  for (const key of traitKeys) delta[key] = Math.round((current[key] - before[key]) * 10) / 10;
  return delta;
}

function changedPersonaSections(previous: string, current: string): string[] {
  try {
    const before = parseSections(previous);
    const after = parseSections(current);
    const changed: string[] = [];
    if (before.title !== after.title || before.introduction !== after.introduction) changed.push('开头说明');
    for (const heading of PERSONA_SECTION_HEADINGS) {
      if (JSON.stringify(before.fields[heading]) !== JSON.stringify(after.fields[heading])) changed.push(heading);
    }
    const customSections = (form: PersonaSectionsForm) => {
      const grouped = new Map<string, string[]>();
      for (const section of form.other) {
        const key = section.heading || '其他小节';
        grouped.set(key, [...(grouped.get(key) ?? []), section.text]);
      }
      return grouped;
    };
    const beforeOther = customSections(before);
    const afterOther = customSections(after);
    const customHeadings = new Set([...beforeOther.keys(), ...afterOther.keys()]);
    for (const heading of customHeadings) {
      if (JSON.stringify(beforeOther.get(heading) ?? []) !== JSON.stringify(afterOther.get(heading) ?? [])) {
        changed.push(heading);
      }
    }
    return changed;
  } catch {
    return previous === current ? [] : ['人设内容'];
  }
}

function versionSummary(
  previous: { markdown: string; traits: PersonaTraits } | undefined,
  current: { markdown: string; traits: PersonaTraits },
): string {
  if (!previous) return '初始版本';
  const traitChanges = traitKeys
    .filter((key) => previous.traits[key] !== current.traits[key])
    .map((key) => {
      const format = (value: number) => value < 0 ? `−${Math.abs(value)}` : value > 0 ? `+${value}` : '0';
      return `${traitNames[key]} ${format(previous.traits[key])}→${format(current.traits[key])}`;
    });
  const changedSections = changedPersonaSections(previous.markdown, current.markdown);
  const sections = changedSections.length > 0 ? [`改写了 ${changedSections.join('、')}`] : [];
  return [...traitChanges, ...sections].join('；') || '未改变性格底色或人设小节';
}

function validPersonaVersionId(value: string): number | undefined {
  if (!/^[1-9]\d*$/u.test(value)) return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : undefined;
}

export function recordPersonaVersionOnSave(repository: StoreRepository, id: string, markdown: string): void {
  repository.recordPersonaVersion(id, markdown, JSON.stringify(traitsForVersion(markdown)));
}

export function registerPersonaVersionRoutes(app: Hono, root: string, repository: StoreRepository): void {
  app.get('/api/personas/:id/versions', (context) => {
    const id = context.req.param('id');
    if (!validPersonaId(id.toLowerCase())) return context.json({ error: 'Invalid persona ID' }, 400);
    const userPath = personaPath(root, 'data/personas', id);
    const selectedPath = existsSync(userPath) ? userPath : personaPath(root, 'personas', id);
    if (!existsSync(selectedPath)) return context.json({ error: 'Persona not found' }, 404);
    let versions = repository.personaVersions(id, 50);
    if (versions.length === 0) {
      const markdown = readFileSync(selectedPath, 'utf8');
      recordPersonaVersionOnSave(repository, id, markdown);
      versions = repository.personaVersions(id, 50);
    }
    const listed = versions.map((version, index) => {
      const previous = versions[index - 1];
      const traits = traitsFromJson(version.traitsJson);
      const previousTraits = previous ? traitsFromJson(previous.traitsJson) : undefined;
      return {
        id: version.id,
        savedAt: version.savedAt,
        traits,
        traitsDelta: traitDelta(previousTraits, traits),
        summary: versionSummary(
          previous ? { markdown: previous.markdown, traits: previousTraits ?? neutralTraits() } : undefined,
          { markdown: version.markdown, traits },
        ),
      };
    });
    return context.json(listed.reverse());
  });

  app.get('/api/personas/:id/versions/:versionId', (context) => {
    const id = context.req.param('id');
    const versionId = validPersonaVersionId(context.req.param('versionId'));
    if (!validPersonaId(id.toLowerCase())) return context.json({ error: 'Invalid persona ID' }, 400);
    if (versionId === undefined) return context.json({ error: 'Invalid persona version ID' }, 400);
    const version = repository.personaVersion(id, versionId);
    if (!version) return context.json({ error: 'Persona version not found' }, 404);
    return context.json({
      id: version.id,
      savedAt: version.savedAt,
      markdown: version.markdown,
      traits: traitsFromJson(version.traitsJson),
      note: version.note,
    });
  });

  app.post('/api/personas/:id/versions/:versionId/restore', (context) => {
    const id = context.req.param('id');
    const versionId = validPersonaVersionId(context.req.param('versionId'));
    if (!validPersonaId(id.toLowerCase())) return context.json({ error: 'Invalid persona ID' }, 400);
    if (versionId === undefined) return context.json({ error: 'Invalid persona version ID' }, 400);
    const version = repository.personaVersion(id, versionId);
    if (!version) return context.json({ error: 'Persona version not found' }, 404);
    return context.json({
      id: version.id,
      markdown: version.markdown,
      traits: traitsFromJson(version.traitsJson),
    });
  });
}
