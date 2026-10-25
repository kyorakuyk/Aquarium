import type { MessageStorageRecord, StoreRepository } from '../../store/repository.ts';
import { redactSensitiveText } from '../impressions/sensitive-text.ts';
import { createQqProfileService } from '../profiles/qq-profile-service.ts';
import {
  buildPersonaCounterpartRule,
  matchPersonaCounterpartEvidence,
  type PersonaCounterpart,
} from '../../persona/counterparts.ts';

export interface PersonaCounterpartContext {
  rule: string;
  speakerAnnotations: ReadonlyMap<string, string>;
  currentUserBound: boolean;
}

export function resolvePersonaCounterpartContext(input: {
  account: number;
  personaId: string;
  sessionId: string;
  sessionKind: 'private' | 'group';
  groupId?: number;
  currentUserId: number;
  counterparts: readonly PersonaCounterpart[];
  records: readonly MessageStorageRecord[];
  replay: boolean;
  repository: StoreRepository;
  now: () => number;
}): PersonaCounterpartContext {
  const rule = buildPersonaCounterpartRule(input.counterparts);
  const speakerAnnotations = new Map<string, string>();
  if (input.counterparts.length === 0) return { rule, speakerAnnotations, currentUserBound: false };

  let currentUserBound = false;
  const qqProfiles = input.groupId === undefined
    ? undefined
    : createQqProfileService({ repository: input.repository, now: input.now });
  const process = () => {
    const bindings = input.repository.listPersonaCounterpartBindings(input.account, input.personaId);
    const claims = new Map<string, ReturnType<StoreRepository['listPersonaCounterpartClaims']>[number]>(
      input.repository.listPersonaCounterpartClaims(input.account, input.personaId)
      .map((claim) => [`${claim.counterpartName}\u0000${claim.userId}`, claim] as const));
    const boundUsersByName = new Map<string, Set<number>>();
    for (const binding of bindings) {
      const users = boundUsersByName.get(binding.counterpartName) ?? new Set<number>();
      users.add(binding.userId);
      boundUsersByName.set(binding.counterpartName, users);
    }
    currentUserBound = input.sessionKind === 'private'
      && input.counterparts.some((counterpart) => boundUsersByName.get(counterpart.name)?.has(input.currentUserId));

    const at = input.now();
    for (const record of input.records) {
      if (record.isSelf) continue;
      for (const counterpart of input.counterparts) {
        const key = `${counterpart.name}\u0000${record.senderId}`;
        const users = boundUsersByName.get(counterpart.name);
        if (users?.has(record.senderId)) {
          speakerAnnotations.set(record.messageId, `（你的${counterpart.name}）`);
          if (claims.has(key) && !input.replay) {
            input.repository.deletePersonaCounterpartClaim(
              input.account, input.personaId, counterpart.name, record.senderId,
            );
            claims.delete(key);
          }
          continue;
        }
        if (counterpart.matchByName !== 'prompt') continue;
        const existingClaim = claims.get(key);
        if (existingClaim?.status === 'dismissed') continue;
        const profile = input.groupId === undefined
          ? undefined
          : qqProfiles?.getCachedMemberProfile(input.account, input.groupId, record.senderId);
        const speakerNames = [record.senderName, profile?.nickname, profile?.card]
          .filter((name): name is string => typeof name === 'string' && name.trim().length > 0);
        const evidence = speakerNames.map((senderName) => matchPersonaCounterpartEvidence(counterpart, {
          senderName,
          plainText: record.plainText,
        })).find((match) => match !== undefined);
        if (existingClaim?.status === 'pending' || evidence) {
          speakerAnnotations.set(record.messageId, `（可能是${counterpart.name}，未确认）`);
        }
        if (!evidence || input.replay) continue;
        const safeEvidence = Array.from(redactSensitiveText(evidence.evidence)).slice(0, 512).join('');
        const claim = input.repository.upsertPersonaCounterpartClaim({
          account: input.account,
          personaId: input.personaId,
          counterpartName: counterpart.name,
          userId: record.senderId,
          sessionId: input.sessionId,
          evidence: safeEvidence,
          firstSeen: existingClaim?.firstSeen ?? at,
          lastSeen: at,
        });
        claims.set(key, claim);
      }
    }
  };

  input.repository.transaction(process);
  return { rule, speakerAnnotations, currentUserBound };
}
