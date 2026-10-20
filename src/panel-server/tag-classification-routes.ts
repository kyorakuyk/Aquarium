import type { Hono } from 'hono';
import type { TagClassificationService } from '../core/impressions/classify-tags.ts';

export function registerTagClassificationRoutes(
  app: Hono,
  service: TagClassificationService | undefined,
): void {
  app.get('/api/tags/classify', (context) => {
    if (!service) return context.json({ error: '旧标签整理暂不可用' }, 503);
    return context.json(service.status());
  });

  app.post('/api/tags/classify', (context) => {
    if (!service) return context.json({ error: '旧标签整理暂不可用' }, 503);
    if (!service.startManual()) {
      return context.json({ error: '旧标签整理正在运行', ...service.status() }, 409);
    }
    return context.json(service.status(), 202);
  });
}
