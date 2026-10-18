import { useCallback, useEffect, useState } from 'react';
import { apiRequest, patch, post, type ImpressionsView, type SessionView, type TagStatus, type TagView } from '../api.ts';
import { AffinityPanel, MemberAffinity } from '../components/AffinityPanel.tsx';
import { ImpressionTag, InlineTagAdd } from '../components/ImpressionTag.tsx';
import { redactSensitiveText } from '../sensitive-text.ts';

type TagAction = (id: number, status: TagStatus) => Promise<boolean>;
type TagRename = (id: number, text: string) => Promise<boolean>;
type TagAdd = (text: string) => Promise<boolean>;

function TagCollection({ tags, label, busy, onAction, onRename, onAdd }: {
  tags: TagView[];
  label: string;
  busy: boolean;
  onAction: TagAction;
  onRename: TagRename;
  onAdd: TagAdd;
}) {
  const [showRejected, setShowRejected] = useState(false);
  const active = tags.filter((tag) => tag.status !== 'rejected');
  const rejected = tags.filter((tag) => tag.status === 'rejected');
  return (
    <div className="tag-collection">
      {active.length === 0 && <span className="muted tag-empty">还没有标签</span>}
      {active.map((tag) => <ImpressionTag key={tag.id} tag={tag} busy={busy} onAction={onAction} onRename={onRename} />)}
      <InlineTagAdd label={label} busy={busy} onSubmit={onAdd} />
      {rejected.length > 0 && <button className="rejected-tags-toggle" type="button" aria-expanded={showRejected} onClick={() => setShowRejected((value) => !value)}>
        {showRejected ? '收起已否决' : `+${rejected.length} 已否决`}
      </button>}
      {showRejected && rejected.map((tag) => <ImpressionTag key={tag.id} tag={tag} busy={busy} onAction={onAction} onRename={onRename} />)}
    </div>
  );
}

function MemberRow({ member, account, busy, onAction, onRename, onAdd }: {
  member: ImpressionsView['members'][number];
  account: number;
  busy: boolean;
  onAction: TagAction;
  onRename: TagRename;
  onAdd: TagAdd;
}) {
  const safeName = redactSensitiveText(member.name);
  return (
    <article className="member-row">
      <div className="member-identity">
        <span className="member-avatar" aria-hidden="true">{Array.from(safeName)[0] ?? '友'}</span>
        <span><strong>{safeName}</strong><span className="mono muted">{member.userId}</span></span>
      </div>
      <MemberAffinity affinity={member.affinity} account={account} />
      <TagCollection tags={member.tags} label={`给${safeName}新增标签`} busy={busy} onAction={onAction} onRename={onRename} onAdd={onAdd} />
    </article>
  );
}

function GroupTags({ tags, busy, onAction, onRename, onAdd }: {
  tags: TagView[];
  busy: boolean;
  onAction: TagAction;
  onRename: TagRename;
  onAdd: TagAdd;
}) {
  return (
    <section className="panel-card group-vibe-card">
      <h2>群的氛围</h2>
      <TagCollection tags={tags} label="新增群标签" busy={busy} onAction={onAction} onRename={onRename} onAdd={onAdd} />
    </section>
  );
}

export function ImpressionsPage() {
  const [groups, setGroups] = useState<SessionView[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [tab, setTab] = useState<'groups' | 'people'>('groups');
  const [view, setView] = useState<ImpressionsView>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void apiRequest<SessionView[]>('/api/sessions').then((rows) => {
      const groupRows = rows.filter((row) => row.kind === 'group');
      setGroups(groupRows);
      setSelectedId((current) => current || groupRows[0]?.sessionId || '');
    }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : '读取会话失败'));
  }, []);

  const load = useCallback(async (sessionId: string): Promise<boolean> => {
    try {
      setView(await apiRequest<ImpressionsView>(`/api/impressions/${sessionId}`));
      setError('');
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '读取印象失败');
      return false;
    }
  }, []);

  useEffect(() => {
    if (selectedId) void load(selectedId);
    else setView(undefined);
  }, [selectedId, load]);

  async function runAction(id: number, body: { text?: string; status?: TagStatus }): Promise<boolean> {
    if (!selectedId || busy) return false;
    setBusy(true);
    try {
      await patch(`/api/tags/${id}`, body);
      return await load(selectedId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '操作失败');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function addTag(userId: number | null, text: string): Promise<boolean> {
    if (!selectedId || busy) return false;
    setBusy(true);
    try {
      await post('/api/tags', { sessionId: selectedId, userId, text });
      return await load(selectedId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '新增失败');
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>印象</h1>
        <p className="page-description">从群聊里慢慢攒出来的标签；确认后的标签会随回复提示词一起生效。</p>
      </header>
      {error && <div className="notice notice-warn" role="alert">{error}</div>}
      <div className="impressions-controls">
        <div className="page-tabs" role="tablist" aria-label="印象视图">
          <button className={tab === 'groups' ? 'is-active' : ''} type="button" role="tab" aria-selected={tab === 'groups'} onClick={() => setTab('groups')}>群聊</button>
          <button className={tab === 'people' ? 'is-active' : ''} type="button" role="tab" aria-selected={tab === 'people'} onClick={() => setTab('people')}>所有人</button>
        </div>
        {tab === 'groups' && <label className="impressions-group-select">
          <span className="visually-hidden">选择群</span>
          <select value={selectedId} onChange={(event) => setSelectedId(event.currentTarget.value)}>
            {groups.length === 0 && <option value="">暂无群聊</option>}
            {groups.map((group) => <option value={group.sessionId} key={group.sessionId}>{redactSensitiveText(group.name)} · {group.memberCount ?? 0} 人</option>)}
          </select>
        </label>}
      </div>
      {tab === 'people' && <AffinityPanel />}
      {tab === 'groups' && <>
      {!view && <div className="empty-state">选择一个群，查看它攒下的标签。</div>}
      {view && (
        <>
          <GroupTags
            tags={view.groupTags}
            busy={busy}
            onAction={(id, status) => runAction(id, { status })}
            onRename={(id, text) => runAction(id, { text })}
            onAdd={(text) => addTag(null, text)}
          />

          <section className="panel-card member-list-section">
            <div className="section-heading">
              <div><h2>群友</h2></div>
              <span className="muted">{view.members.length} 人 · 按最近发言</span>
            </div>
            {view.members.length === 0 && <p className="muted">还没有群友标签；群里聊得多一些就会出现。</p>}
            <div className="member-list">
              {view.members.map((member) => <MemberRow
                key={member.userId}
                member={member}
                account={Number(view.sessionId.split(':', 1)[0])}
                busy={busy}
                onAction={(id, status) => runAction(id, { status })}
                onRename={(id, text) => runAction(id, { text })}
                onAdd={(text) => addTag(member.userId, text)}
              />)}
            </div>
          </section>
        </>
      )}
      </>}
    </div>
  );
}
