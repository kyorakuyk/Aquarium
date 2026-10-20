import path from 'node:path';
import type OpenAI from 'openai';
import { callSlot, type SlotCallOptions, type SlotResult } from '../llm/slots.ts';
import type { OneBotAdapter } from '../adapters/onebot/adapter.ts';
import type { StoreRepository } from '../store/repository.ts';
import type { AquariumConfig } from '../config/schema.ts';
import type { StickerDescribePromptTemplate } from '../core/prompt/templates.ts';
import { createStickerService, type StickerService } from '../core/stickers/service.ts';

export type StickerVisionCall = (
  messages: OpenAI.ChatCompletionMessageParam[],
  options: SlotCallOptions,
) => Promise<SlotResult>;

export function createAccountStickerService(options: {
  adapter: OneBotAdapter;
  root: string;
  repository: StoreRepository;
  getConfig: () => AquariumConfig;
  getPromptTemplate: () => StickerDescribePromptTemplate;
  downloadImage?: (url: string) => Promise<string>;
  callVision?: StickerVisionCall;
  onError?: (stage: string) => void;
}): StickerService {
  const callVision = options.callVision ?? ((messages, callOptions) => callSlot('vision', messages, callOptions));
  return createStickerService({
    account: options.adapter.account,
    adapter: options.adapter.customFaces,
    repository: options.repository,
    dataDirectory: path.join(options.root, 'data', 'stickers'),
    getConfig: options.getConfig,
    ...(options.downloadImage === undefined ? {} : { downloadImage: options.downloadImage }),
    describeImage: async (dataUrl) => {
      const template = options.getPromptTemplate();
      const messages: OpenAI.ChatCompletionMessageParam[] = [
        { role: 'system', content: template.system },
        {
          role: 'user',
          content: [
            { type: 'text', text: template.user },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ];
      const result = await callVision(messages, {
        config: options.getConfig(),
        account: options.adapter.account,
        costToday: () => options.repository.costToday(),
        recordUsage: (usage) => options.repository.recordUsage({ ...usage, account: options.adapter.account }),
      });
      return result.text;
    },
    ...(options.onError === undefined ? {} : { onError: () => options.onError?.('sticker') }),
  });
}

export function startStickerSyncTimer(
  service: StickerService,
  isOnline: () => boolean,
  onError: () => void,
): () => void {
  const timer = setInterval(() => {
    if (!isOnline()) return;
    void service.sync().catch(onError);
  }, 10 * 60 * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
