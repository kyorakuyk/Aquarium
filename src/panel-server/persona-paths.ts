import path from 'node:path';
import { PERSONA_ID_PATTERN } from '../persona/persona-id.ts';

export type PersonaFolder = 'personas' | 'data/personas';

export function validPersonaId(value: string): boolean {
  return PERSONA_ID_PATTERN.test(value);
}

export function personaPath(root: string, folder: PersonaFolder, id: string): string {
  return path.join(root, folder, `${id}.md`);
}
