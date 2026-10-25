import type OpenAI from 'openai';
import type { AquariumConfig } from '../../config/schema.ts';
import type { IncomingMessage } from '../shared/events.ts';
import type { StoreRepository } from '../../store/repository.ts';
import type { SelfEditMuteState } from './tools.ts';

export interface SelfEditCommandResult {
  text: string;
  reason: string;
  detail?: unknown;
}

export interface SelfEditCommandHandler {
  shouldHandle(message: IncomingMessage, ownerId: number): boolean;
  handle(message: IncomingMessage): Promise<SelfEditCommandResult>;
}

export interface SelfEditHandlerDependencies {
  getConfig: () => AquariumConfig;
  saveConfig: (config: AquariumConfig) => void;
  repository: StoreRepository;
  root: string;
  now?: () => number;
  callModel: (messages: OpenAI.ChatCompletionMessageParam[]) => Promise<string>;
  muteState: SelfEditMuteState;
}
