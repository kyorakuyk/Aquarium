import type { AquariumConfig } from './schema.ts';

export function isDebugEnabled(config: Pick<AquariumConfig, 'debug'>, sessionId: string): boolean {
  return config.debug.sessions[sessionId] ?? config.debug.enabled;
}
