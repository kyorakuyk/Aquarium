import { randomUUID } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';
import { parsePersonaMarkdown, updatePersonaTraits, type PersonaTraits } from '../persona/load.ts';

const personaTraitsSchema: z.ZodType<PersonaTraits> = z.object({
  order: z.number().int().min(-2).max(2).default(0),
  morality: z.number().int().min(-2).max(2).default(0),
  talk: z.number().int().min(-2).max(2).default(0),
  mind: z.number().int().min(-2).max(2).default(0),
}).strict();
const personaBodySchema = z.object({
  markdown: z.string().max(100_000),
  traits: personaTraitsSchema.optional(),
}).strict();
const personaImportSchema = z.object({
  filename: z.string().min(1).max(255),
  markdown: z.string().max(100_000),
}).strict();

function validPersonaId(value: string): boolean {
  return /^[a-z0-9_-]+$/u.test(value);
}

function personaPath(root: string, folder: 'personas' | 'data/personas', id: string): string {
  return path.join(root, folder, `${id}.md`);
}

function listPersonaIds(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name.slice(0, -3))
      .filter(validPersonaId);
  } catch {
    return [];
  }
}

function writeTextAtomic(filePath: string, content: string, exclusive = false): void {
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, content, { encoding: 'utf8', flag: 'wx' });
    if (exclusive) {
      linkSync(temporaryPath, filePath);
      unlinkSync(temporaryPath);
    } else {
      renameSync(temporaryPath, filePath);
    }
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch { /* best-effort temporary-file cleanup */ }
    throw error;
  }
}

function parseBody<T>(body: unknown, schema: z.ZodType<T>): T | undefined {
  const result = schema.safeParse(body);
  return result.success ? result.data : undefined;
}

function isAlreadyExists(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST';
}

export function registerPersonaRoutes(app: Hono, root: string): void {
  app.get('/api/personas', (context) => {
    const ids = new Set([
      ...listPersonaIds(path.join(root, 'personas')),
      ...listPersonaIds(path.join(root, 'data', 'personas')),
    ]);
    return context.json([...ids].sort().map((id) => ({
      id,
      filename: `${id}.md`,
      source: existsSync(personaPath(root, 'data/personas', id)) ? 'data' : 'built-in',
    })));
  });

  app.get('/api/personas/:id', (context) => {
    const id = context.req.param('id');
    if (!validPersonaId(id)) return context.json({ error: 'Invalid persona ID' }, 400);
    const userPath = personaPath(root, 'data/personas', id);
    const builtInPath = personaPath(root, 'personas', id);
    const selectedPath = existsSync(userPath) ? userPath : builtInPath;
    if (!existsSync(selectedPath)) return context.json({ error: 'Persona not found' }, 404);
    const markdown = readFileSync(selectedPath, 'utf8');
    let traits: PersonaTraits | null = null;
    try { traits = parsePersonaMarkdown(markdown).traits; } catch { /* keep invalid files editable in the panel */ }
    return context.json({ id, markdown, traits });
  });

  app.put('/api/personas/:id', async (context) => {
    const id = context.req.param('id');
    if (!validPersonaId(id)) return context.json({ error: 'Invalid persona ID' }, 400);
    let rawBody: unknown;
    try { rawBody = await context.req.json(); } catch { return context.json({ error: 'Invalid JSON' }, 400); }
    const body = parseBody(rawBody, personaBodySchema);
    if (!body) return context.json({ error: 'Invalid persona' }, 400);
    let markdown = body.markdown;
    if (body.traits) {
      try { markdown = updatePersonaTraits(body.markdown, body.traits); }
      catch { return context.json({ error: 'Invalid persona YAML front matter' }, 400); }
    }
    writeTextAtomic(personaPath(root, 'data/personas', id), markdown);
    return context.json({ id, saved: true });
  });

  app.post('/api/personas/import', async (context) => {
    let rawBody: unknown;
    try { rawBody = await context.req.json(); } catch { return context.json({ error: 'Invalid JSON' }, 400); }
    const body = parseBody(rawBody, personaImportSchema);
    if (!body || /[\\/]/u.test(body.filename)) return context.json({ error: 'Invalid persona filename' }, 400);
    const extension = body.filename.lastIndexOf('.');
    const id = extension > 0 ? body.filename.slice(0, extension) : body.filename;
    if (!validPersonaId(id)) return context.json({ error: 'Invalid persona ID' }, 400);
    const destination = personaPath(root, 'data/personas', id);
    if (existsSync(destination) || existsSync(personaPath(root, 'personas', id))) {
      return context.json({ error: 'Persona already exists' }, 409);
    }
    try {
      writeTextAtomic(destination, body.markdown, true);
    } catch (error) {
      if (isAlreadyExists(error)) return context.json({ error: 'Persona already exists' }, 409);
      throw error;
    }
    return context.json({ id, filename: `${id}.md` }, 201);
  });
}
