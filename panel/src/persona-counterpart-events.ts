export const PERSONA_COUNTERPARTS_UPDATED_EVENT = 'aquarium-persona-counterparts-updated';

export function notifyPersonaCounterpartsUpdated(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(PERSONA_COUNTERPARTS_UPDATED_EVENT));
}
