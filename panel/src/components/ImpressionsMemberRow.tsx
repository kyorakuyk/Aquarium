import type { ImpressionsView } from '../api.ts';
import { MemberAffinity } from './AffinityPanel.tsx';
import { memberPreviewTags } from '../impressions-model.ts';
import { redactSensitiveText } from '../sensitive-text.ts';

type Member = ImpressionsView['members'][number];

export function ImpressionsMemberRow({ member, account, selected, onSelect }: {
  member: Member;
  account: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const name = member.name;
  const highlights = memberPreviewTags(member.tags).map((tag) => {
    const subjectDisplay = tag.subject?.replaceAll('/', ' › ');
    const baseText = tag.category === 'fandom' && subjectDisplay
      ? `${subjectDisplay} › ${tag.text}`
      : tag.text;
    const displayTag = tag.category === 'catchphrase'
      ? baseText.startsWith('「') && baseText.endsWith('」') ? baseText : `「${baseText}」`
      : baseText;
    return redactSensitiveText(displayTag);
  });
  return <div className={`impressions-member-row${selected ? ' is-selected' : ''}`}>
    <button
      className="impressions-member-select"
      type="button"
      aria-pressed={selected}
      aria-label={`查看${name}画像`}
      onClick={onSelect}
    >
      <span className="member-avatar" aria-hidden="true">{Array.from(name)[0] ?? '友'}</span>
      <span className="impressions-member-copy">
        <strong>{name}</strong>
        <span className="impressions-member-tags">{highlights.length > 0 ? highlights.join(' · ') : '暂无主要标签'}</span>
      </span>
    </button>
    <MemberAffinity affinity={member.affinity} account={account} />
  </div>;
}
