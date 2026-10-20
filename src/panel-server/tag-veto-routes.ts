import { Hono } from 'hono';
import { parseSessionId } from '../core/conversation/sessions.ts';
import { redactSensitiveText } from '../core/impressions/sensitive-text.ts';
import type { StoreRepository } from '../store/repository.ts';

export function registerTagVetoRoutes(app: Hono, repository: StoreRepository): void {
  app.get('/api/tag-vetoes', (context) => {
    const requestedSessionId = context.req.query('sessionId');
    if (!requestedSessionId) return context.json({ error: 'Invalid group sessionId' }, 400);
    const key = parseSessionId(requestedSessionId);
    if (!key || key.kind !== 'group') return context.json({ error: 'Invalid group sessionId' }, 400);

    const vetoes = repository.listTagVetoes(key.account, requestedSessionId);
    return context.json(vetoes.map((veto) => ({
      id: veto.id,
      userId: veto.userId,
      category: veto.category,
      subjectNorm: redactSensitiveText(veto.subjectNorm),
      textNorm: redactSensitiveText(veto.textNorm),
      createdAt: veto.createdAt,
    })));
  });

  app.delete('/api/tag-vetoes/:id', (context) => {
    const id = Number(context.req.param('id'));
    if (!Number.isSafeInteger(id) || id <= 0) return context.json({ error: 'Invalid veto id' }, 400);
    if (!repository.deleteTagVeto(id)) return context.json({ error: 'Tag veto not found' }, 404);
    return context.body(null, 204);
  });
}
