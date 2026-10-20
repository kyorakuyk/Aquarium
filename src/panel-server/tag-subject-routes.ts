import type { Hono } from 'hono';
import { z } from 'zod';
import type { AquariumConfig } from '../config/schema.ts';
import { parseSessionId } from '../core/sessions.ts';
import { redactSensitiveText } from '../core/impressions/sensitive-text.ts';
import { isTagCategory, type TagCategory } from '../store/tag-profile.ts';
import type { TagSubjectRecord, TagSubjectRepository } from '../store/tag-subject-repo.ts';

const subjectWriteSchema = z.object({
  name: z.string(),
  aliases: z.array(z.string()).max(40),
}).strict();

export interface TagSubjectRouteOptions {
  getConfig: () => AquariumConfig;
  tagSubjects: TagSubjectRepository;
}

function tagCategory(value: string): TagCategory | undefined {
  return isTagCategory(value) ? value : undefined;
}

function validSubjectText(value: string): boolean {
  const text = value.trim();
  return text.length > 0 && Array.from(text).length <= 40;
}

function safeSubjectView(subject: TagSubjectRecord): TagSubjectRecord {
  return {
    ...subject,
    name: redactSensitiveText(subject.name),
    aliases: subject.aliases.map(redactSensitiveText),
  };
}

export function registerTagSubjectRoutes(app: Hono, options: TagSubjectRouteOptions): void {
  app.get('/api/tag-subjects/:sessionId/:category', (context) => {
    const key = parseSessionId(context.req.param('sessionId'));
    const category = tagCategory(context.req.param('category'));
    if (!key || key.kind !== 'group'
      || !options.getConfig().accounts.some((account) => account.uin === key.account)
      || !category) {
      return context.json({ error: 'Invalid tag subject scope' }, 400);
    }
    return context.json(options.tagSubjects.listTagSubjects(key.account, category).map(safeSubjectView));
  });

  app.put('/api/tag-subjects/:sessionId/:category', async (context) => {
    const key = parseSessionId(context.req.param('sessionId'));
    const category = tagCategory(context.req.param('category'));
    if (!key || key.kind !== 'group'
      || !options.getConfig().accounts.some((account) => account.uin === key.account)
      || !category) {
      return context.json({ error: 'Invalid tag subject scope' }, 400);
    }

    let rawBody: unknown;
    try { rawBody = await context.req.json(); } catch { return context.json({ error: 'Invalid JSON' }, 400); }
    const parsed = subjectWriteSchema.safeParse(rawBody);
    if (!parsed.success
      || !validSubjectText(parsed.data.name)
      || parsed.data.aliases.some((alias) => !validSubjectText(alias))) {
      return context.json({ error: 'Invalid tag subject' }, 400);
    }
    if ([parsed.data.name, ...parsed.data.aliases].some((value) => redactSensitiveText(value.trim()) !== value.trim())) {
      return context.json({ error: 'Tag subject contains sensitive text' }, 400);
    }

    try {
      const id = options.tagSubjects.saveTagSubject({
        account: key.account,
        category,
        name: parsed.data.name.trim(),
        aliases: parsed.data.aliases.map((alias) => alias.trim()),
      });
      const saved = options.tagSubjects.listTagSubjects(key.account, category).find((subject) => subject.id === id);
      return saved ? context.json(safeSubjectView(saved)) : context.json({ error: 'Tag subject save failed' }, 500);
    } catch (error) {
      if (error instanceof Error && error.message === '标签 subject 名称或别名冲突') {
        return context.json({ error: 'Tag subject name or alias conflicts with another subject' }, 409);
      }
      return context.json({ error: 'Invalid tag subject' }, 400);
    }
  });
}
