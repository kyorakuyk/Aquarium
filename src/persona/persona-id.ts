export const PERSONA_ID_PATTERN = /^[\p{L}\p{N}_-]{1,40}$/u;

export function normalizePersonaId(value: string): string {
  return value.trim().toLowerCase();
}

export function validPersonaId(value: string): boolean {
  return PERSONA_ID_PATTERN.test(value);
}

export function hasPersonaIdCollision(existingIds: readonly string[], candidate: string): boolean {
  const normalizedCandidate = normalizePersonaId(candidate);
  return existingIds.some((id) => normalizePersonaId(id) === normalizedCandidate);
}
