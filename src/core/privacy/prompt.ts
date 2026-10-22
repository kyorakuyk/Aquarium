import type { StoredTag } from '../../store/affect-repo.ts';
import type { PrivateFactRecord } from '../../store/privacy-repo.ts';
import { selectInjectableTags, type TagPromptStateUpdate } from '../impressions/tags.ts';
import { formatMemberTags } from '../impressions/member-tags.ts';
import { sessionId, type SessionKey } from '../shared/events.ts';
import type { ReplySystemTemplate } from '../prompt/templates.ts';
import { decide } from './policy.ts';

const privateFactLimit = { max: 6, maxChars: 200 } as const;

function textLength(value: string): number {
  return Array.from(value).length;
}

export function buildPrivateFactsBlock(input: {
  session: SessionKey;
  name: string;
  now: number;
  template: ReplySystemTemplate;
  facts: readonly PrivateFactRecord[];
  groupTags: readonly StoredTag[];
  onTagPromptStates?: (updates: readonly TagPromptStateUpdate[]) => void;
}): string | undefined {
  if (input.session.kind !== 'private') return undefined;

  const targetSessionId = sessionId(input.session);
  const ownerId = input.session.peer;
  const target = { kind: 'private' as const, sessionId: targetSessionId, peerId: ownerId };
  const facts = input.facts
    .filter((fact) => fact.account === input.session.account && fact.ownerId === ownerId)
    .filter((fact) => decide({
      info: {
        origin: 'private',
        sessionId: fact.sessionId,
        ownerId: fact.ownerId,
        level: fact.level,
      },
      target,
      purpose: 'prompt',
    }) === 'allow')
    .sort((left, right) => right.updatedAt - left.updatedAt || right.id - left.id);
  const groupTags = input.groupTags.filter((tag) => tag.account === input.session.account
    && tag.userId === ownerId
    && tag.kind === 'fact'
    && decide({
      info: { origin: 'group', sessionId: tag.sessionId, ownerId: tag.userId },
      target,
      purpose: 'prompt',
    }) === 'allow');

  const selectedFacts: string[] = [];
  let characters = 0;
  for (const fact of facts) {
    const addition = textLength(fact.text) + (selectedFacts.length > 0 ? 1 : 0);
    if (selectedFacts.length >= privateFactLimit.max || characters + addition > privateFactLimit.maxChars) continue;
    selectedFacts.push(fact.text);
    characters += addition;
  }

  const remainingCount = privateFactLimit.max - selectedFacts.length;
  const remainingCharacters = Math.max(0, privateFactLimit.maxChars - characters - (selectedFacts.length > 0 ? 1 : 0));
  const tagSelection = selectInjectableTags(groupTags, input.now, {
    max: remainingCount,
    maxChars: remainingCharacters,
  }, { renderText: formatMemberTags });
  input.onTagPromptStates?.(tagSelection.stateUpdates);
  const formattedTags = tagSelection.tags.length > 0 ? formatMemberTags(tagSelection.tags) : undefined;
  const factsText = [...selectedFacts, ...(formattedTags ? [formattedTags] : [])].join('；');
  if (factsText.length === 0) return undefined;

  return input.template.privateFacts
    .replaceAll('{{name}}', JSON.stringify(input.name))
    .replaceAll('{{facts}}', factsText);
}
