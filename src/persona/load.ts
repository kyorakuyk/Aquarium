import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'yaml';

export interface PersonaTraits {
  order: number;
  morality: number;
  talk: number;
  mind: number;
}

export interface LoadedPersona {
  text: string;
  traits: PersonaTraits;
}

export interface LoadPersonaOptions {
  root?: string;
}

const traitFields = ['order', 'morality', 'talk', 'mind'] as const;

function parseTraits(frontmatter: string): PersonaTraits {
  let header: unknown;
  try {
    header = yaml.parse(frontmatter);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`人设 YAML 文件头无效：${detail}`);
  }

  if (header === null) header = {};
  if (typeof header !== 'object' || Array.isArray(header)) {
    throw new Error('人设 YAML 文件头必须是对象（traits）');
  }
  const values = (header as Record<string, unknown>).traits;
  if (values !== undefined && (values === null || typeof values !== 'object' || Array.isArray(values))) {
    throw new Error('人设性格字段 traits 必须是对象');
  }

  const input = (values ?? {}) as Record<string, unknown>;
  const traits = {} as PersonaTraits;
  for (const field of traitFields) {
    const value = Object.hasOwn(input, field) ? input[field] : 0;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < -2 || value > 2) {
      throw new Error(`人设性格字段 ${field} 必须是 -2 到 2 的整数`);
    }
    traits[field] = value;
  }
  return traits;
}

export function loadPersona(
  id: string,
  nickname: string,
  options: LoadPersonaOptions = {},
): LoadedPersona {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`无效的人设 ID：${id}`);
  const root = options.root ?? process.cwd();
  const candidates = [
    join(root, 'data', 'personas', `${id}.md`),
    join(root, 'personas', `${id}.md`),
  ];
  const personaPath = candidates.find(existsSync);
  if (!personaPath) throw new Error(`找不到人设文件：${id}.md`);

  const displayName = nickname.trim() || '水族箱';
  const source = readFileSync(personaPath, 'utf8');
  const match = /^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m.exec(source);
  const traits = match ? parseTraits(match[1] ?? '') : { order: 0, morality: 0, talk: 0, mind: 0 };
  const text = (match ? source.slice(match[0].length) : source).replaceAll('{{name}}', () => displayName);
  return { text, traits };
}
