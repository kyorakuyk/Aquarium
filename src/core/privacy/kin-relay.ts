import { EVIDENCE_MAX, normalizeTagText } from '../impressions/tags.ts';
import { decide } from './policy.ts';
import type { StoredTag } from '../../store/affect-repo.ts';
import type { StoreRepository } from '../../store/repository.ts';

function relayAllowed(repository: StoreRepository, fact: ReturnType<StoreRepository['privateFactById']>, targetAccount: number, groupId: number): boolean {
  return fact !== undefined && fact.status === 'active'
    && decide({
      info: {
        origin: 'private',
        sessionId: fact.sessionId,
        ownerId: fact.ownerId,
        level: fact.level,
      },
      target: { kind: 'kin', groupId },
      purpose: 'prompt',
    }) === 'allow'
    && repository.kinGroupAccounts(groupId).includes(fact.account)
    && repository.kinGroupAccounts(groupId).includes(targetAccount);
}

export function listAuthorizedKinRelays(repository: StoreRepository, targetAccount: number): StoredTag[] {
  if (!Number.isSafeInteger(targetAccount) || targetAccount <= 0) return [];
  const groups = repository.listKinGroups().filter((group) => group.accounts.includes(targetAccount));
  return repository.listRelayTagsForAccount(targetAccount).filter((tag) => {
    if (tag.account !== targetAccount || tag.kind !== 'fact' || tag.sourceAccount == null
      || tag.sourceFactId == null) return false;
    const group = groups.find(({ accounts }) => accounts.includes(tag.sourceAccount!));
    if (!group) return false;
    const fact = repository.privateFactById(tag.sourceFactId);
    return fact !== undefined && fact.account === tag.sourceAccount
      && relayAllowed(repository, fact, targetAccount, group.id);
  });
}

export function syncKinRelays(
  repository: StoreRepository,
  at: number,
  accountsToClean: readonly number[] = [],
): void {
  if (!Number.isFinite(at) || at < 0) throw new RangeError('转述时间无效');
  const groups = repository.listKinGroups();
  if (accountsToClean.some((account) => !Number.isSafeInteger(account) || account <= 0)) {
    throw new RangeError('转述账号无效');
  }
  const accounts = [...new Set([...groups.flatMap((group) => group.accounts), ...accountsToClean])];

  for (const targetAccount of accounts) {
    for (const relay of repository.listRelayTagsForAccount(targetAccount)) {
      const fact = relay.sourceFactId === null || relay.sourceFactId === undefined
        ? undefined
        : repository.privateFactById(relay.sourceFactId);
      const groupId = groups.find((group) => group.accounts.includes(targetAccount)
        && group.accounts.includes(relay.sourceAccount ?? -1))?.id;
      if (!fact || fact.account !== relay.sourceAccount || groupId === undefined
        || !relayAllowed(repository, fact, targetAccount, groupId)) {
        repository.deleteTag(relay.id, { account: targetAccount, kind: 'fact' });
      }
    }
  }

  for (const group of groups) {
    for (const sourceAccount of group.accounts) {
      const facts = repository.listPrivateFactsForAccount(sourceAccount);
      for (const fact of facts) {
        if (!relayAllowed(repository, fact, sourceAccount, group.id)) continue;
        for (const targetAccount of group.accounts) {
          if (targetAccount === sourceAccount) continue;
          const existing = repository.listRelayTagsForAccount(targetAccount)
            .find((tag) => tag.sourceFactId === fact.id && tag.sourceAccount === sourceAccount);
          if (existing) {
            const evidence = fact.evidence.slice(-EVIDENCE_MAX)
              .map(({ messageId, time }) => ({ messageId, time, quote: '' }));
            const knownMessageIds = new Set(existing.evidence
              .filter((item) => item.kind !== 'signature')
              .map((item) => item.messageId));
            const newEvidence = evidence.filter((item) => !knownMessageIds.has(item.messageId));
            repository.updateTag(existing.id, {
              ...(existing.text === fact.text ? {} : { text: fact.text, norm: normalizeTagText(fact.text) }),
              ...(newEvidence.length === 0 ? {} : {
                samples: Math.min(EVIDENCE_MAX, existing.samples + newEvidence.length),
                evidence: [...existing.evidence, ...newEvidence].slice(-EVIDENCE_MAX),
                lastSeen: newEvidence.reduce((latest, item) => Math.max(latest, item.time), existing.lastSeen),
              }),
              updatedAt: at,
            });
            continue;
          }
          const evidence = fact.evidence.slice(-EVIDENCE_MAX)
            .map(({ messageId, time }) => ({ messageId, time, quote: '' }));
          repository.insertTag({
            account: targetAccount,
            sessionId: `kin:${targetAccount}`,
            userId: null,
            text: fact.text,
            norm: normalizeTagText(fact.text),
            category: 'recent',
            kind: 'fact',
            subject: null,
            polarity: null,
            origin: 'inferred',
            locked: false,
            status: 'confirmed',
            source: 'auto',
            sourceAccount,
            sourceFactId: fact.id,
            samples: 1,
            evidence,
            firstSeen: fact.createdAt,
            lastSeen: fact.updatedAt,
            supersededBy: null,
            updatedAt: at,
          });
        }
      }
    }
  }
}
