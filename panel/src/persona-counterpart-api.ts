import type { ImpressionsView } from './api.ts';
import type { PersonaCounterpart } from '../../src/persona/counterparts.ts';

export type { PersonaCounterpart };

export interface PersonaCounterpartBindingView {
  account: number;
  personaId: string;
  counterpartName: string;
  userId: number;
  createdAt: number;
  senderName: string;
}

export interface PersonaCounterpartClaimView {
  account: number;
  personaId: string;
  counterpartName: string;
  userId: number;
  sessionId: string;
  evidence: string;
  firstSeen: number;
  lastSeen: number;
  status: 'pending';
  senderName: string;
}

export interface PersonaCounterpartsView {
  personaId: string;
  counterparts: PersonaCounterpart[];
  bindings: PersonaCounterpartBindingView[];
  claims: PersonaCounterpartClaimView[];
}

export type ImpressionsViewWithCounterparts = Omit<ImpressionsView, 'members'> & {
  members: Array<ImpressionsView['members'][number] & {
    counterpartClaims: PersonaCounterpartClaimView[];
  }>;
};
