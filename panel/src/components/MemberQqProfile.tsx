import type { QqMemberProfileView } from '../api.ts';
import { memberSexAgeLabel } from '../impressions-model.ts';

const ROLE_LABELS: Record<NonNullable<QqMemberProfileView['role']>, string> = {
  owner: '群主',
  admin: '管理员',
  member: '成员',
};

function dateFromSeconds(value: number | undefined, includeTime = false): string {
  if (value === undefined || !Number.isSafeInteger(value) || value <= 0) return '—';
  const date = new Date(value * 1_000);
  return includeTime ? date.toLocaleString('zh-CN') : date.toLocaleDateString('zh-CN');
}

function ProfileField({ label, value, locked = false, mono = false }: {
  label: string;
  value: string | number;
  locked?: boolean;
  mono?: boolean;
}) {
  return <div className="qq-member-field">
    <dt>{label}{locked && <span className="qq-lock-mark" aria-label="不进入提示词">锁</span>}</dt>
    <dd className={mono ? 'mono' : ''}>{value || '—'}</dd>
  </div>;
}

export function MemberQqProfile({ profile }: { profile: QqMemberProfileView }) {
  const sexAge = memberSexAgeLabel(profile.sex, profile.age);
  return <section className="qq-member-profile" aria-labelledby="member-qq-profile-title">
    <header className="qq-member-profile-heading">
      <div><h3 id="member-qq-profile-title">QQ 资料</h3><span className="muted">来自 QQ</span></div>
      <span className="muted">锁标记字段仅在控制台显示</span>
    </header>
    <dl className="qq-member-profile-grid">
      <ProfileField label="群名片" value={profile.card ?? '—'} />
      <ProfileField label="身份" value={profile.role ? ROLE_LABELS[profile.role] : '—'} />
      <ProfileField label="头衔" value={profile.title ?? '—'} />
      <ProfileField label="入群时间" value={dateFromSeconds(profile.joinTime)} locked mono />
      <ProfileField label="最后发言" value={dateFromSeconds(profile.lastSentTime, true)} mono />
      <ProfileField label="群等级" value={profile.level ? `Lv.${profile.level}` : '—'} locked mono />
      <ProfileField label="性别 / 年龄" value={sexAge} locked />
      <ProfileField label="Q 龄" value={profile.qage === undefined ? '—' : `${profile.qage} 年`} locked mono />
      {profile.isRobot && <ProfileField label="QQ 标记" value="机器人" />}
    </dl>
  </section>;
}
