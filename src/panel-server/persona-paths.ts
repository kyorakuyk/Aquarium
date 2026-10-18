import path from 'node:path';

export type PersonaFolder = 'personas' | 'data/personas';

export function validPersonaId(value: string): boolean {
  return /^[a-z0-9_-]+$/u.test(value);
}

export function personaPath(root: string, folder: PersonaFolder, id: string): string {
  return path.join(root, folder, `${id}.md`);
}
