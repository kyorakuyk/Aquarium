import { randomUUID } from 'node:crypto';
import {
  existsSync,
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
import type { AquariumConfig } from '../config/schema.ts';
import type { PipelineModelCall } from '../core/conversation/pipeline.ts';
import { createAffinityService } from '../core/affinity/service.ts';
import { promptTemplateStore } from '../core/prompt/templates.ts';
import { redactSensitiveText } from '../core/impressions/sensitive-text.ts';
import { callSlot } from '../llm/slots.ts';
import { effectiveTalkLevel, renderTraitsBlock } from '../persona/traits.ts';
import { loadPersona, parsePersonaMarkdown, updatePersonaTraits, validatePersonaAffinityFrontmatter, type PersonaTraits } from '../persona/load.ts';
import {
  buildSections,
  parseSections,
  renderPersonaSectionBlocks,
  type PersonaSectionFields,
  type PersonaSectionsForm,
} from '../persona/sections.ts';
import type { StoreRepository } from '../store/repository.ts';
import { personaPath, validPersonaId } from './persona-paths.ts';
import { recordPersonaVersionOnSave, registerPersonaVersionRoutes } from './persona-version-routes.ts';

const personaTraitValueSchema = z.number().min(-2).max(2).refine(
  (value) => Number.isFinite(value) && Math.abs(value * 10 - Math.round(value * 10)) <= 1e-8,
  '最多一位小数',
);
const personaTraitsSchema: z.ZodType<PersonaTraits> = z.object({
  order: personaTraitValueSchema.default(0),
  morality: personaTraitValueSchema.default(0),
  talk: personaTraitValueSchema.default(0),
  mind: personaTraitValueSchema.default(0),
  humor: personaTraitValueSchema.default(0),
  openness: personaTraitValueSchema.default(0),
  imitation: personaTraitValueSchema.default(0),
}).strict();
const personaImportTraitsSchema = z.object({
  order: personaTraitValueSchema,
  morality: personaTraitValueSchema,
  talk: personaTraitValueSchema,
  mind: personaTraitValueSchema,
  humor: personaTraitValueSchema,
  openness: personaTraitValueSchema,
  imitation: personaTraitValueSchema,
}).strict();
const personaBodySchema = z.object({
  markdown: z.string().max(100_000),
  traits: personaTraitsSchema.optional(),
}).strict();
const accountPersonaSchema = z.object({ persona: z.string() }).strict();
const personaImportSchema = z.object({
  filename: z.string().min(1).max(255),
  text: z.string().min(1).max(100_000),
}).strict();
const personaPreviewSchema = z.object({
  content: z.string().max(100_000),
  name: z.string().max(100).optional(),
}).strict();
const personaImportFieldsSchema = z.object({
  身份: z.string().max(10_000),
  年龄: z.string().max(10_000),
  背景: z.string().max(10_000),
  说话方式: z.string().max(10_000),
  口头禅: z.array(z.string().max(10_000)).max(100),
  常用表情: z.array(z.string().max(10_000)).max(100),
  对熟人: z.string().max(10_000),
  对陌生人: z.string().max(10_000),
  对主人: z.string().max(10_000),
  底线: z.array(z.string().max(10_000)).max(100),
}).strict();
const personaImportResultSchema = z.object({
  fields: personaImportFieldsSchema,
  traits: personaImportTraitsSchema,
  other: z.array(z.object({
    heading: z.string().max(255).refine((value) => !/[\r\n]/u.test(value)),
    text: z.string().max(100_000),
  }).strict()).max(100),
}).strict();

interface PersonaRouteOptions {
  getConfig: () => AquariumConfig;
  saveConfig: (config: AquariumConfig) => void | Promise<void>;
  serializeConfigWrite: <T>(task: () => Promise<T>) => Promise<T>;
  repository: StoreRepository;
  callModel?: PipelineModelCall;
  now?: () => number;
}

function listPersonaIds(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name.slice(0, -3))
      .filter((id) => validPersonaId(id.toLowerCase()));
  } catch {
    return [];
  }
}

function writeTextAtomic(filePath: string, content: string): void {
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, content, { encoding: 'utf8', flag: 'wx' });
    renameSync(temporaryPath, filePath);
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch { /* best-effort temporary-file cleanup */ }
    throw error;
  }
}

function parseBody<T>(body: unknown, schema: z.ZodType<T>): T | undefined {
  const result = schema.safeParse(body);
  return result.success ? result.data : undefined;
}

export function registerPersonaRoutes(app: Hono, root: string, options: PersonaRouteOptions): void {
  app.put('/api/accounts/:uin/persona', async (context) => {
    const uinText = context.req.param('uin');
    if (!/^[1-9]\d*$/u.test(uinText)) return context.json({ error: 'Invalid account UIN' }, 400);
    const uin = Number(uinText);
    if (!Number.isSafeInteger(uin)) return context.json({ error: 'Invalid account UIN' }, 400);

    let rawBody: unknown;
    try { rawBody = await context.req.json(); } catch { return context.json({ error: 'Invalid JSON' }, 400); }
    const body = parseBody(rawBody, accountPersonaSchema);
    if (!body) return context.json({ error: 'Invalid persona binding' }, 400);
    if (!validPersonaId(body.persona.toLowerCase())) return context.json({ error: 'Invalid persona ID' }, 400);

    const personaFile = [
      personaPath(root, 'data/personas', body.persona),
      personaPath(root, 'personas', body.persona),
    ].find((candidate) => existsSync(candidate));
    if (!personaFile) return context.json({ error: 'Persona not found' }, 404);

    return options.serializeConfigWrite(async () => {
      const config = options.getConfig();
      const account = config.accounts.find((candidate) => candidate.uin === uin);
      if (!account) return context.json({ error: 'Account not found' }, 404);
      if (account.persona === body.persona) {
        return context.json({ account: account.uin, persona: account.persona });
      }

      const nextConfig: AquariumConfig = {
        ...config,
        accounts: config.accounts.map((candidate) => candidate.uin === uin
          ? { ...candidate, persona: body.persona }
          : candidate),
      };
      await options.saveConfig(nextConfig);
      const updatedAccount = nextConfig.accounts.find((candidate) => candidate.uin === uin);
      if (!updatedAccount) return context.json({ error: 'Account not found' }, 404);
      return context.json({ account: updatedAccount.uin, persona: updatedAccount.persona });
    });
  });

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

  app.post('/api/personas/preview', async (context) => {
    let rawBody: unknown;
    try { rawBody = await context.req.json(); } catch { return context.json({ error: 'Invalid JSON' }, 400); }
    const body = parseBody(rawBody, personaPreviewSchema);
    if (!body) return context.json({ error: 'Invalid persona preview' }, 400);
    try {
      const form = parseSections(body.content);
      const rawPersonaText = parsePersonaMarkdown(buildSections(form)).text;
      const rawPersonaBlocks = renderPersonaSectionBlocks(form);
      const renderedPersonaText = rawPersonaBlocks.map((block) => block.text).join(`${form.lineEnding}${form.lineEnding}`);
      if (renderedPersonaText !== rawPersonaText) return context.json({ error: 'Invalid persona preview' }, 400);
      const displayName = body.name?.trim() || '水族箱';
      const personaText = rawPersonaText.replaceAll('{{name}}', () => displayName);
      const personaBlocks = rawPersonaBlocks.map((block) => ({
        ...block,
        text: block.text.replaceAll('{{name}}', () => displayName),
      }));
      const traits = renderTraitsBlock(
        form.traits,
        effectiveTalkLevel(form.traits.talk, 0),
        promptTemplateStore.get().traits,
      );
      const blocks = [...personaBlocks, ...(traits ? [{ id: 'traits', label: 'traits', text: traits }] : [])];
      const promptText = personaText + (traits ? `\n\n${traits}` : '');
      const safeBlocks = blocks.map((block) => ({
        id: block.id,
        label: redactSensitiveText(block.label),
        text: redactSensitiveText(block.text),
      }));
      const chars = redactSensitiveText(promptText).length;
      return context.json({ blocks: safeBlocks, chars, estTokens: Math.ceil(chars / 1.3) });
    } catch {
      return context.json({ error: 'Invalid persona preview' }, 400);
    }
  });

  app.get('/api/personas/:id', (context) => {
    const id = context.req.param('id');
    if (!validPersonaId(id.toLowerCase())) return context.json({ error: 'Invalid persona ID' }, 400);
    const userPath = personaPath(root, 'data/personas', id);
    const builtInPath = personaPath(root, 'personas', id);
    const selectedPath = existsSync(userPath) ? userPath : builtInPath;
    if (!existsSync(selectedPath)) return context.json({ error: 'Persona not found' }, 404);
    const markdown = readFileSync(selectedPath, 'utf8');
    let traits: PersonaTraits | null = null;
    try { traits = parsePersonaMarkdown(markdown).traits; } catch { /* keep invalid files editable in the panel */ }
    return context.json({ id, markdown, traits });
  });

  app.get('/api/personas/:id/affinity-preview', (context) => {
    const id = context.req.param('id');
    if (!validPersonaId(id.toLowerCase())) return context.json({ error: 'Invalid persona ID' }, 400);
    const accountText = context.req.query('account');
    if (!accountText || !/^[1-9]\d*$/u.test(accountText)) return context.json({ error: 'Invalid account' }, 400);
    const account = Number(accountText);
    const config = options.getConfig();
    if (!Number.isSafeInteger(account) || !config.accounts.some((item) => item.uin === account)) {
      return context.json({ error: 'Invalid account' }, 400);
    }
    const userPath = personaPath(root, 'data/personas', id);
    const builtInPath = personaPath(root, 'personas', id);
    if (!existsSync(userPath) && !existsSync(builtInPath)) return context.json({ error: 'Persona not found' }, 404);
    let personaAffinity: ReturnType<typeof loadPersona>['affinity'];
    try { personaAffinity = loadPersona(id, '', { root }).affinity; }
    catch { return context.json({ error: 'Invalid persona affinity' }, 400); }

    const previewConfig: AquariumConfig = {
      ...config,
      accounts: config.accounts.map((item) => item.uin === account ? { ...item, persona: id } : item),
    };
    function currentFor(mode: 'inherit' | 'independent'): number {
      return createAffinityService({
        repository: options.repository,
        getConfig: () => previewConfig,
        getPersonaAffinity: () => ({ ...personaAffinity, mode }),
      }).getCurrent(account, config.owner, (options.now ?? Date.now)()).value;
    }
    const start = config.affinity.start;
    const current = Number.isSafeInteger(config.owner) && config.owner > 0
      ? {
        inherit: currentFor('inherit'),
        independent: currentFor('independent'),
      }
      : { inherit: start, independent: start };

    return context.json({
      account,
      start,
      current,
      tiers: config.affinity.tiers,
      curveDefaults: config.affinity.curveDefaults,
    });
  });

  registerPersonaVersionRoutes(app, root, options.repository);

  app.put('/api/personas/:id', async (context) => {
    const id = context.req.param('id');
    if (!validPersonaId(id.toLowerCase())) return context.json({ error: 'Invalid persona ID' }, 400);
    let rawBody: unknown;
    try { rawBody = await context.req.json(); } catch { return context.json({ error: 'Invalid JSON' }, 400); }
    const body = parseBody(rawBody, personaBodySchema);
    if (!body) return context.json({ error: 'Invalid persona' }, 400);
    let markdown = body.markdown;
    if (body.traits) {
      try { markdown = updatePersonaTraits(body.markdown, body.traits); }
      catch { return context.json({ error: 'Invalid persona YAML front matter' }, 400); }
    }
    try { validatePersonaAffinityFrontmatter(markdown); }
    catch { return context.json({ error: 'Invalid persona affinity' }, 400); }
    writeTextAtomic(personaPath(root, 'data/personas', id), markdown);
    recordPersonaVersionOnSave(options.repository, id, markdown);
    return context.json({ id, saved: true });
  });

  app.post('/api/personas/import', async (context) => {
    let rawBody: unknown;
    try { rawBody = await context.req.json(); } catch { return context.json({ error: 'Invalid JSON' }, 400); }
    const body = parseBody(rawBody, personaImportSchema);
    if (!body || /[\\/\u0000-\u001f\u007f]/u.test(body.filename) || body.filename === '.' || body.filename === '..'
      || body.text.trim().length === 0) {
      return context.json({ error: 'Invalid persona import' }, 400);
    }
    const template = promptTemplateStore.get().personaImport;
    const messages: Parameters<PipelineModelCall>[1] = [
      { role: 'system', content: template.system },
      { role: 'user', content: template.user.replaceAll('{{text}}', () => body.text) },
    ];
    let modelResult;
    try {
      modelResult = await (options.callModel ?? callSlot)('extract', messages, {
        config: options.getConfig(),
        account: null,
        costToday: options.repository.costToday,
        recordUsage: options.repository.recordUsage,
      });
    } catch {
      return context.json({ error: 'Persona import failed', reason: '模型调用失败' }, 502);
    }
    let modelJson: unknown;
    try {
      modelJson = JSON.parse(modelResult.text);
    } catch {
      return context.json({ error: 'Invalid persona import response', reason: '模型返回内容不是有效 JSON' }, 422);
    }
    const parsed = personaImportResultSchema.safeParse(modelJson);
    if (!parsed.success) {
      return context.json({ error: 'Invalid persona import response', reason: '模型返回字段或 traits 数值不符合要求' }, 422);
    }
    const extracted = parsed.data;
    const other = extracted.other.filter((section) => section.text.trim().length > 0);
    const fields: PersonaSectionFields = Object.fromEntries(
      Object.entries(extracted.fields).map(([heading, value]) => [
        heading,
        Array.isArray(value) ? value.map(redactSensitiveText) : redactSensitiveText(value),
      ]),
    ) as PersonaSectionFields;
    const form: PersonaSectionsForm = {
      title: '# {{name}}',
      introduction: '',
      traits: extracted.traits,
      fields,
      other: other.map((section) => ({
        heading: redactSensitiveText(section.heading),
        text: redactSensitiveText(section.text),
      })),
      metadata: {},
      lineEnding: '\n',
    };
    let draft: string;
    try {
      draft = buildSections(form);
    } catch {
      return context.json({ error: 'Invalid persona import response', reason: '模型返回内容无法生成草稿' }, 422);
    }
    const mappedFields = Object.values(extracted.fields).filter((value) => Array.isArray(value)
      ? value.some((item) => item.trim().length > 0)
      : value.trim().length > 0).length;
    const mappedTraits = Object.values(extracted.traits).filter((value) => value !== 0).length;
    return context.json({ draft, mappedCount: mappedFields + mappedTraits, otherCount: other.length });
  });
}
