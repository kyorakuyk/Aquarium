import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { apiRequest, patch, post, type AccountKind, type MemberRelationView, type QqMemberTargetView, type RelationType } from '../api.ts';
import { containsSensitiveText, redactSensitiveText } from '../sensitive-text.ts';

const KIND_LABELS: Record<AccountKind, string> = {
  human: '普通成员',
  bot: 'bot',
  alt: '小号',
  owner: '主人',
};
const RELATION_LABELS: Record<Exclude<RelationType, 'alt' | 'other'>, string> = {
  lover: '恋人',
  brother: '兄弟',
  sister: '姐妹',
  roommate: '室友',
  enemy: '敌人',
};
const RELATION_TYPES: RelationType[] = ['alt', 'lover', 'brother', 'sister', 'roommate', 'enemy', 'other'];
const KINDS: AccountKind[] = ['human', 'bot', 'alt', 'owner'];

function relationLabel(relation: MemberRelationView): string {
  if (relation.type === 'alt') {
    return relation.currentRole === 'main'
      ? `主号，关联小号：${relation.otherName}`
      : `小号，主号：${relation.otherName}`;
  }
  if (relation.type === 'other') return `${relation.otherName} · ${redactSensitiveText(relation.label ?? '其他关系')}`;
  return `${relation.otherName} · ${RELATION_LABELS[relation.type]}`;
}

export function IdentityRelationsPanel({
  sessionId,
  userId,
  kind: savedKind,
  relations,
  isRobot,
  targets,
  onUpdated,
}: {
  sessionId: string;
  userId: number;
  kind: AccountKind | null;
  relations: MemberRelationView[];
  isRobot: boolean;
  targets: QqMemberTargetView[];
  onUpdated: () => Promise<unknown>;
}) {
  const [kind, setKind] = useState<AccountKind | ''>(savedKind ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedTarget, setSelectedTarget] = useState<number>();
  const [relationType, setRelationType] = useState<RelationType>('brother');
  const [currentRole, setCurrentRole] = useState<'main' | 'alt'>('main');
  const [label, setLabel] = useState('');
  const [labelSensitive, setLabelSensitive] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const endpoint = `/api/identity/${encodeURIComponent(sessionId)}/${userId}`;

  useEffect(() => setKind(savedKind ?? ''), [savedKind, sessionId, userId]);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (dialogOpen && !dialog.open) dialog.showModal();
    if (!dialogOpen && dialog.open) dialog.close();
  }, [dialogOpen]);

  const filteredTargets = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return targets.filter((target) => target.userId !== userId && (
      needle.length === 0
      || target.name.toLocaleLowerCase().includes(needle)
      || String(target.userId).includes(needle)
      || target.card?.toLocaleLowerCase().includes(needle)
    )).slice(0, 8);
  }, [query, targets, userId]);
  const directValue = /^\d+$/u.test(query.trim()) ? Number(query.trim()) : undefined;
  const directTarget = directValue !== undefined && Number.isSafeInteger(directValue) && directValue > 0
    ? directValue
    : undefined;
  const targetUserId = selectedTarget ?? directTarget;
  const labelText = label.trim();
  const invalidLabel = relationType === 'other'
    && (!labelText || Array.from(labelText).length > 40 || /[\r\n]/u.test(labelText) || containsSensitiveText(labelText));

  async function saveKind(next: AccountKind | ''): Promise<void> {
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      await patch(`${endpoint}/kind`, { kind: next || null });
      setKind(next);
      await onUpdated();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存身份失败');
    } finally {
      setSaving(false);
    }
  }

  async function saveRelation(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (saving || targetUserId === undefined || targetUserId === userId || invalidLabel) return;
    setSaving(true);
    setError('');
    const body = {
      targetUserId,
      type: relationType,
      ...(relationType === 'alt' ? { currentRole } : {}),
      ...(relationType === 'other' ? { label: labelText } : {}),
    };
    try {
      await post(`${endpoint}/relations`, body);
      setDialogOpen(false);
      await onUpdated();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '建立关系失败');
    } finally {
      setSaving(false);
    }
  }

  async function setLocked(relation: MemberRelationView, locked: boolean): Promise<void> {
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      await patch(`${endpoint}/relations/${relation.id}`, { locked });
      await onUpdated();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '更新关系失败');
    } finally {
      setSaving(false);
    }
  }

  async function removeRelation(relation: MemberRelationView): Promise<void> {
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      await apiRequest(`${endpoint}/relations/${relation.id}`, { method: 'DELETE' });
      await onUpdated();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '解除关系失败');
    } finally {
      setSaving(false);
    }
  }

  function openLinkDialog(): void {
    setQuery('');
    setSelectedTarget(undefined);
    setRelationType('brother');
    setCurrentRole('main');
    setLabel('');
    setLabelSensitive(false);
    setError('');
    setDialogOpen(true);
  }

  return <section className="identity-relations panel-subcard" aria-label="身份与关系">
    <header className="identity-relations-heading">
      <div>
        <h3>身份与关系</h3>
        <span className="muted">仅手动设置；未锁定关系会写入双方的 memberTags。</span>
      </div>
    </header>
    <div className="identity-kind-row">
      <label htmlFor={`identity-kind-${userId}`}>身份</label>
      <select id={`identity-kind-${userId}`} value={kind} disabled={saving} onChange={(event) => setKind(event.currentTarget.value as AccountKind | '')}>
        <option value="">未设置</option>
        {KINDS.map((value) => <option key={value} value={value}>{KIND_LABELS[value]}</option>)}
      </select>
      <button type="button" className="button" disabled={saving || kind === (savedKind ?? '')} onClick={() => void saveKind(kind)}>
        保存
      </button>
    </div>
    {isRobot && kind !== 'bot' && <p className="identity-bot-suggestion" role="status">
      QQ 标记为机器人，设为 bot？
      <button type="button" className="text-button" disabled={saving} onClick={() => void saveKind('bot')}>设为 bot</button>
    </p>}
    <ul className="identity-relation-list">
      {relations.map((relation) => <li key={relation.id}>
        <span className="identity-relation-text">{relationLabel(relation)} <span className="mono muted">QQ {relation.otherUserId}</span></span>
        {relation.locked && <span className="status-pill">锁定，不注入</span>}
        <button type="button" className="text-button" disabled={saving} onClick={() => void setLocked(relation, !relation.locked)}>
          {relation.locked ? '恢复注入' : '锁定，不注入'}
        </button>
        <button type="button" className="text-button" disabled={saving} onClick={() => void removeRelation(relation)}>
          {relation.type === 'alt' ? '解除链接' : '删除关系'}
        </button>
      </li>)}
    </ul>
    <button type="button" className="button" disabled={saving} onClick={openLinkDialog}>链接一个账号</button>
    {error && <p className="notice notice-warn" role="alert">{error}</p>}

    <dialog ref={dialogRef} className="identity-link-dialog" aria-label="链接一个账号" onClose={() => setDialogOpen(false)}>
      <form onSubmit={(event) => void saveRelation(event)}>
        <header className="identity-link-heading">
          <div><h3>链接一个账号</h3><p className="muted">搜索本群群友、好友，或直接输入 QQ 号。</p></div>
          <button type="button" className="text-button" aria-label="关闭对话框" onClick={() => setDialogOpen(false)}>关闭</button>
        </header>
        <label htmlFor={`identity-target-${userId}`}>搜索成员或输入 QQ 号</label>
        <input
          id={`identity-target-${userId}`}
          value={query}
          inputMode="search"
          autoComplete="off"
          onChange={(event) => { setQuery(event.currentTarget.value); setSelectedTarget(undefined); }}
        />
        {filteredTargets.length > 0 && <ul className="identity-target-results">
          {filteredTargets.map((target) => <li key={target.userId}>
            <button type="button" className={selectedTarget === target.userId ? 'selected' : ''} onClick={() => {
              setSelectedTarget(target.userId);
              setQuery(target.name);
            }}>
              <span>{target.name}{target.card ? ` · ${redactSensitiveText(target.card)}` : ''}</span>
              <span className="mono muted">QQ {target.userId}</span>
            </button>
          </li>)}
        </ul>}
        {directTarget !== undefined && directTarget !== userId && <p className="muted">直接使用 QQ {directTarget}</p>}
        <label htmlFor={`identity-relation-type-${userId}`}>关系类型</label>
        <select id={`identity-relation-type-${userId}`} value={relationType} onChange={(event) => setRelationType(event.currentTarget.value as RelationType)}>
          {RELATION_TYPES.map((value) => <option key={value} value={value}>{value === 'other' ? '其他' : value === 'alt' ? '小号链接' : RELATION_LABELS[value]}</option>)}
        </select>
        {relationType === 'alt' && <>
          <label htmlFor={`identity-alt-role-${userId}`}>当前账号是</label>
          <select id={`identity-alt-role-${userId}`} value={currentRole} onChange={(event) => setCurrentRole(event.currentTarget.value as 'main' | 'alt')}>
            <option value="main">主号</option>
            <option value="alt">小号</option>
          </select>
        </>}
        {relationType === 'other' && <>
          <label htmlFor={`identity-relation-label-${userId}`}>关系名称</label>
          <input id={`identity-relation-label-${userId}`} value={label} maxLength={40} onChange={(event) => {
            const value = event.currentTarget.value;
            if (containsSensitiveText(value)) {
              setLabel('');
              setLabelSensitive(true);
              setError('疑似敏感内容已清除，未发送。');
            } else {
              setLabel(value);
              setLabelSensitive(false);
              setError('');
            }
          }} />
          {labelSensitive && <span className="tag-sensitive-hint" role="status">疑似敏感内容已清除，未发送。</span>}
        </>}
        {error && <p className="notice notice-warn" role="alert">{error}</p>}
        <footer className="identity-link-actions">
          <button type="submit" className="button button-primary" disabled={saving || targetUserId === undefined || targetUserId === userId || invalidLabel}>
            {saving ? '正在保存…' : '建立关系'}
          </button>
          <button type="button" className="button" disabled={saving} onClick={() => setDialogOpen(false)}>取消</button>
        </footer>
      </form>
    </dialog>
  </section>;
}
