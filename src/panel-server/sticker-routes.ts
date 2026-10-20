import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Hono } from 'hono';
import { AquariumConfigSchema, type AquariumConfig } from '../config/schema.ts';
import type { PanelAccountRuntime } from './types.ts';
import type { StickerService } from '../core/stickers/service.ts';
import type { StoreRepository } from '../store/repository.ts';

const uploadSchema = z.object({
  dataBase64: z.string().min(1).max(7 * 1024 * 1024),
  filename: z.string().min(1).max(255),
}).strict();

const patchSchema = z.object({
  enabled: z.boolean().optional(),
  tags: z.array(z.string().refine((tag) => {
    const length = Array.from(tag.trim()).length;
    return length >= 2 && length <= 4;
  })).max(5).optional(),
  descAi: z.string().refine((value) => Array.from(value).length <= 20).optional(),
}).strict().refine((value) => Object.keys(value).length > 0);

const settingsPatchSchema = z.object({
  enabled: z.boolean().optional(),
  maxRatio: z.number().min(0).max(1).optional(),
  onlyStickerRatio: z.number().min(0).max(1).optional(),
  cooldownSec: z.number().int().min(0).max(86_400).optional(),
  candidates: z.number().int().min(1).max(50).optional(),
}).strict();

function parseAccount(value: string | undefined): number | undefined | null {
  if (value === undefined) return undefined;
  const account = Number(value);
  return Number.isSafeInteger(account) && account > 0 ? account : null;
}

function resolveImagePath(root: string, file: string): string | undefined {
  if (!/^[a-f\d]{32}\.(?:jpg|png|gif|webp)$/iu.test(file) || path.basename(file) !== file) return undefined;
  const directory = path.resolve(root, 'data', 'stickers');
  const target = path.resolve(directory, file);
  return target.startsWith(`${directory}${path.sep}`) ? target : undefined;
}

function publicSticker(record: ReturnType<StoreRepository['stickerById']>): unknown {
  if (!record) return undefined;
  const { file, ...safeRecord } = record;
  return { ...safeRecord, imageUrl: file ? `/api/stickers/${record.id}/image` : null };
}

export function registerStickerRoutes(app: Hono, options: {
  root: string;
  repository: StoreRepository;
  accounts: () => PanelAccountRuntime[];
  services: () => StickerService[];
  now: () => number;
  getConfig?: () => AquariumConfig;
  saveConfig?: (config: AquariumConfig) => void | Promise<void>;
  serializeConfigWrite?: <T>(task: () => Promise<T>) => Promise<T>;
}): void {
  app.get('/api/stickers/settings', (context) => {
    if (!options.getConfig) return context.json({ error: 'Sticker settings are unavailable' }, 501);
    return context.json(options.getConfig().stickers);
  });

  app.patch('/api/stickers/settings', async (context) => {
    if (!options.getConfig || !options.saveConfig) {
      return context.json({ error: 'Sticker settings are unavailable' }, 501);
    }
    let raw: unknown;
    try { raw = await context.req.json(); } catch { return context.json({ error: 'Invalid JSON' }, 400); }
    const parsed = settingsPatchSchema.safeParse(raw);
    if (!parsed.success) return context.json({ error: 'Invalid sticker settings' }, 400);
    const task = async () => {
      const config = options.getConfig!();
      const next = AquariumConfigSchema.parse({
        ...config,
        stickers: { ...config.stickers, ...parsed.data },
      });
      await options.saveConfig!(next);
      return context.json(next.stickers);
    };
    return options.serializeConfigWrite ? options.serializeConfigWrite(task) : task();
  });

  app.get('/api/stickers', (context) => {
    const account = parseAccount(context.req.query('account'));
    if (account === null) return context.json({ error: 'Invalid account' }, 400);
    const syncTimes = options.services()
      .filter((service) => account === undefined || service.account === account)
      .map((service) => service.getLastSyncAt())
      .filter((time): time is number => time !== null);
    return context.json({
      stickers: options.repository.listStickers(account).map((sticker) => publicSticker(sticker)),
      lastSyncAt: syncTimes.length > 0 ? Math.max(...syncTimes) : null,
    });
  });

  app.get('/api/stickers/:id/image', (context) => {
    const id = Number(context.req.param('id'));
    if (!Number.isSafeInteger(id) || id < 1) return context.json({ error: 'Invalid sticker ID' }, 400);
    const sticker = options.repository.stickerById(id);
    if (!sticker || !sticker.file) return context.json({ error: 'Sticker image not found' }, 404);
    const imagePath = resolveImagePath(options.root, sticker.file);
    if (!imagePath) return context.json({ error: 'Invalid sticker image path' }, 400);
    if (!existsSync(imagePath)) return context.json({ error: 'Sticker image not found' }, 404);
    const image = readFileSync(imagePath);
    if (image.length === 0 || image.length > 5 * 1024 * 1024) {
      return context.json({ error: 'Sticker image size is invalid' }, 400);
    }
    const extension = path.extname(imagePath).toLowerCase();
    const contentType = extension === '.jpg' ? 'image/jpeg'
      : extension === '.png' ? 'image/png'
        : extension === '.gif' ? 'image/gif'
          : 'image/webp';
    return context.body(image, 200, {
      'Content-Type': contentType,
      'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    });
  });

  app.patch('/api/stickers/:id', async (context) => {
    const id = Number(context.req.param('id'));
    if (!Number.isSafeInteger(id) || id < 1) return context.json({ error: 'Invalid sticker ID' }, 400);
    let raw: unknown;
    try { raw = await context.req.json(); } catch { return context.json({ error: 'Invalid JSON' }, 400); }
    const parsed = patchSchema.safeParse(raw);
    if (!parsed.success) return context.json({ error: 'Invalid sticker update' }, 400);
    const sticker = options.repository.stickerById(id);
    if (!sticker) return context.json({ error: 'Sticker not found' }, 404);
    if (parsed.data.descAi !== undefined && parsed.data.descAi !== sticker.descAi) {
      const service = options.services().find((candidate) => candidate.account === sticker.account);
      if (!service) return context.json({ error: 'Sticker account is unavailable' }, 409);
      try {
        await service.modifyCustomFace(sticker.emojiId, parsed.data.descAi);
      } catch {
        return context.json({ error: 'QQ favorite description update failed' }, 409);
      }
    }
    const updated = options.repository.updateSticker(id, parsed.data, options.now());
    if (!updated) return context.json({ error: 'Sticker not found' }, 404);
    return context.json(publicSticker(updated));
  });

  app.post('/api/stickers/sync', async (context) => {
    const account = parseAccount(context.req.query('account'));
    if (account === null) return context.json({ error: 'Invalid account' }, 400);
    const services = options.services();
    const selected = account === undefined
      ? services
      : services.filter((service) => service.account === account);
    if (selected.length === 0) return context.json({ error: 'Sticker account not found' }, 404);
    const onlineAccounts = new Set(options.accounts()
      .filter((runtime) => runtime.getStatus() === 'online')
      .map((runtime) => runtime.adapter.account));
    const online = selected.filter((service) => onlineAccounts.has(service.account));
    if (online.length === 0) return context.json({ error: 'No sticker account is online' }, 409);
    const results = await Promise.all(online.map(async (service) => {
      try {
        return { ...(await service.sync()), ok: true };
      } catch {
        return { account: service.account, ok: false, error: 'Sticker sync failed' };
      }
    }));
    return context.json({ results });
  });

  app.post('/api/stickers/upload', async (context) => {
    const account = parseAccount(context.req.query('account'));
    if (account === null) return context.json({ error: 'Invalid account' }, 400);
    let raw: unknown;
    try { raw = await context.req.json(); } catch { return context.json({ error: 'Invalid JSON' }, 400); }
    const parsed = uploadSchema.safeParse(raw);
    if (!parsed.success) return context.json({ error: 'Invalid sticker upload' }, 400);

    const services = options.services();
    let service: StickerService | undefined;
    if (account !== undefined) {
      service = services.find((candidate) => candidate.account === account);
    } else if (services.length === 1) {
      service = services[0];
    } else {
      return context.json({ error: 'Select an account for sticker upload' }, 409);
    }
    if (!service) return context.json({ error: 'Sticker account not found' }, 404);
    const runtime = options.accounts().find((candidate) => candidate.adapter.account === service.account);
    if (!runtime || runtime.getStatus() !== 'online') return context.json({ error: 'Sticker account is offline' }, 409);
    try {
      const result = await service.upload(parsed.data.dataBase64, parsed.data.filename);
      return context.json({ account: service.account, synced: result.synced });
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError) {
        return context.json({ error: error.message }, 400);
      }
      return context.json({ error: 'QQ favorite upload failed' }, 502);
    }
  });
}
