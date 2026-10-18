import yaml from 'yaml';
import { parsePersonaMarkdown, type PersonaTraits } from './load.ts';

export const PERSONA_SECTION_HEADINGS = [
  '身份',
  '年龄',
  '背景',
  '说话方式',
  '口头禅',
  '常用表情',
  '对熟人',
  '对陌生人',
  '对主人',
  '底线',
] as const;

export type PersonaSectionHeading = typeof PERSONA_SECTION_HEADINGS[number];
export type PersonaSectionFields = {
  身份: string;
  年龄: string;
  背景: string;
  说话方式: string;
  口头禅: string[];
  常用表情: string[];
  对熟人: string;
  对陌生人: string;
  对主人: string;
  底线: string[];
};

export interface OtherPersonaSection {
  heading: string;
  text: string;
}

export interface PersonaSectionsForm {
  title: string;
  introduction: string;
  traits: PersonaTraits;
  fields: PersonaSectionFields;
  other: OtherPersonaSection[];
  metadata: Record<string, unknown>;
  lineEnding: '\n' | '\r\n';
}

export interface PersonaSectionBlock {
  id: string;
  label: string;
  text: string;
}

const frontmatterPattern = /^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m;
const headingPattern = /^## ([^\r\n]*)$/gm;
const listHeadings = new Set<PersonaSectionHeading>(['口头禅', '常用表情', '底线']);

function emptyFields(): PersonaSectionFields {
  return {
    身份: '',
    年龄: '',
    背景: '',
    说话方式: '',
    口头禅: [],
    常用表情: [],
    对熟人: '',
    对陌生人: '',
    对主人: '',
    底线: [],
  };
}

function isPersonaSectionHeading(value: string): value is PersonaSectionHeading {
  return (PERSONA_SECTION_HEADINGS as readonly string[]).includes(value);
}

function stripTrailingLineBreaks(value: string): string {
  return value.replace(/(?:\r?\n)+$/u, '');
}

function parseList(text: string): string[] {
  if (!text) return [];
  return text.split(/\r?\n/u).map((line) => line.startsWith('- ') ? line.slice(2) : line);
}

function parseMetadata(source: string): Record<string, unknown> {
  const match = frontmatterPattern.exec(source);
  if (!match) return {};
  const header: unknown = yaml.parse(match[1] ?? '');
  if (header === null) return {};
  if (typeof header !== 'object' || Array.isArray(header)) {
    throw new Error('人设 YAML 文件头必须是对象（traits）');
  }
  return Object.fromEntries(Object.entries(header).filter(([key]) => key !== 'traits'));
}

function parsedSectionText(body: string, start: number, end: number): string {
  let contentStart = start;
  if (body.startsWith('\r\n', contentStart)) contentStart += 2;
  else if (body.startsWith('\n', contentStart)) contentStart += 1;
  return stripTrailingLineBreaks(body.slice(contentStart, end));
}

export function parseSections(markdown: string): PersonaSectionsForm {
  const loaded = parsePersonaMarkdown(markdown);
  const body = loaded.text;
  const lineEnding = markdown.includes('\r\n') ? '\r\n' : '\n';
  const headings = [...body.matchAll(headingPattern)];
  const preambleEnd = headings[0]?.index ?? body.length;
  const preamble = body.slice(0, preambleEnd);
  const titleMatch = /^(#[ \t]+[^\r\n]*)(?:\r\n|\n|$)/u.exec(preamble);
  const title = titleMatch?.[1] ?? '';
  const introduction = stripTrailingLineBreaks(
    titleMatch ? preamble.slice(titleMatch[0].length) : preamble,
  );
  const fields = emptyFields();
  const seenStandardHeadings = new Set<PersonaSectionHeading>();
  const other: OtherPersonaSection[] = [];

  for (let index = 0; index < headings.length; index += 1) {
    const match = headings[index];
    if (!match || match.index === undefined) continue;
    const heading = match[1] ?? '';
    const contentStart = match.index + match[0].length;
    const contentEnd = headings[index + 1]?.index ?? body.length;
    const text = parsedSectionText(body, contentStart, contentEnd);
    if (isPersonaSectionHeading(heading) && !seenStandardHeadings.has(heading)) {
      seenStandardHeadings.add(heading);
      if (listHeadings.has(heading)) {
        (fields[heading] as string[]) = parseList(text);
      } else {
        (fields[heading] as string) = text;
      }
    } else if (text.length > 0) {
      other.push({ heading, text });
    }
  }

  return {
    title,
    introduction,
    traits: loaded.traits,
    fields,
    other,
    metadata: parseMetadata(markdown),
    lineEnding,
  };
}

function standardSectionText(heading: PersonaSectionHeading, fields: PersonaSectionFields, lineEnding: string): string {
  const value = fields[heading];
  if (Array.isArray(value)) return value.length > 0 ? value.map((line) => `- ${line}`).join(lineEnding) : '';
  return value;
}

export function renderPersonaSectionBlocks(form: PersonaSectionsForm): PersonaSectionBlock[] {
  const blocks: PersonaSectionBlock[] = [];
  const title = form.title.replace(/^#[ \t]*/u, '').trim() ? form.title : '# {{name}}';
  const opening = form.introduction ? `${title}${form.lineEnding}${form.introduction}` : title;
  if (opening.length > 0) {
    blocks.push({ id: 'persona-opening', label: 'persona · 开头说明', text: opening });
  }

  for (const heading of PERSONA_SECTION_HEADINGS) {
    const content = standardSectionText(heading, form.fields, form.lineEnding);
    if (content.length === 0) continue;
    blocks.push({
      id: `persona-section-${heading}`,
      label: `persona · ${heading}`,
      text: `## ${heading}${form.lineEnding}${content}`,
    });
  }
  for (let index = 0; index < form.other.length; index += 1) {
    const section = form.other[index];
    if (!section) continue;
    if (section.text.length === 0) continue;
    if (/[\r\n]/u.test(section.heading)) throw new Error('人设小节标题不能包含换行');
    blocks.push({
      id: `persona-other-section-${index}`,
      label: `persona · ${section.heading}`,
      text: `## ${section.heading}${form.lineEnding}${section.text}`,
    });
  }
  return blocks;
}

export function buildSections(form: PersonaSectionsForm): string {
  const header = yaml.stringify({ ...form.metadata, traits: form.traits })
    .replace(/\r?\n+$/u, '')
    .replace(/\r?\n/gu, form.lineEnding);
  const frontmatter = `---${form.lineEnding}${header}${form.lineEnding}---${form.lineEnding}`;
  const body = renderPersonaSectionBlocks(form)
    .map((block) => block.text)
    .join(`${form.lineEnding}${form.lineEnding}`);
  const markdown = frontmatter + body;
  parsePersonaMarkdown(markdown);
  return markdown;
}
