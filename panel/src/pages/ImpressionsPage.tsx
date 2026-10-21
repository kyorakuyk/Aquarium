import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {
  apiRequest,
  patch,
  post,
  type HistoryImportJobView,
  type HistoryImportMode,
  type ImpressionsView,
  type SessionView,
  type TagCategory,
  type TagPolarity,
  type TagStatus,
  type TagView,
} from '../api.ts';
import { AffinityPanel } from '../components/AffinityPanel.tsx';
import { ActivityHeatmap } from '../components/ActivityHeatmap.tsx';
import { ImpressionTag, InlineTagAdd } from '../components/ImpressionTag.tsx';
import { ImpressionsMemberRow } from '../components/ImpressionsMemberRow.tsx';
import { MemberProfileCard } from '../components/MemberProfileCard.tsx';
import { ImpressionsDataMenu } from '../components/ImpressionsDataMenu.tsx';
import { QqGroupProfilePanel } from '../components/QqGroupProfilePanel.tsx';
import { buildIdentityTargets } from '../identity-targets.ts';

const PrivateFactsPanel = lazy(() => import('../components/PrivateFactsPanel.tsx').then((module) => ({ default: module.PrivateFactsPanel })));

type TagAction = (id: number, status: TagStatus) => Promise<boolean>;
type TagRename = (id: number, text: string) => Promise<boolean>;
type TagLock = (id: number, locked: boolean) => Promise<boolean>;
type TagDelete = (id: number) => Promise<boolean>;
type TagAdd = (text: string) => Promise<boolean>;
type HistoryImportTarget = 200 | 500 | 1_000 | 2_000;

const HISTORY_IMPORT_TARGETS: HistoryImportTarget[] = [200, 500, 1_000, 2_000];

function isHistoryImportTerminal(job: HistoryImportJobView | undefined): boolean {
  return job !== undefined && ['done', 'cancelled', 'expired', 'error'].includes(job.phase);
}

function historyFailureLabel(job: HistoryImportJobView): string {
  const { failureReason: reason, failureHttpStatus } = job;
  if (reason === 'timeout') return '模型超时';
  if (reason === 'network') return '网络错误';
  if (reason === 'http') return `HTTP ${failureHttpStatus ?? '错误'}`;
  return '其他错误';
}

function TagCollection({ tags, label, busy, onAction, onRename, onLock, onDelete, onAdd }: {
  tags: TagView[];
  label: string;
  busy: boolean;
  onAction: TagAction;
  onRename: TagRename;
  onLock: TagLock;
  onDelete: TagDelete;
  onAdd: TagAdd;
}) {
  const [showRejected, setShowRejected] = useState(false);
  const active = tags.filter((tag) => tag.status !== 'rejected');
  const rejected = tags.filter((tag) => tag.status === 'rejected');
  return (
    <div className="tag-collection">
      {active.length === 0 && <span className="muted tag-empty">还没有标签</span>}
      {active.map((tag) => <ImpressionTag key={tag.id} tag={tag} busy={busy} onAction={onAction} onRename={onRename} onLock={onLock} onDelete={onDelete} />)}
      <InlineTagAdd label={label} busy={busy} onSubmit={onAdd} />
      {rejected.length > 0 && <button className="rejected-tags-toggle" type="button" aria-expanded={showRejected} onClick={() => setShowRejected((value) => !value)}>
        {showRejected ? '收起已否决' : `+${rejected.length} 已否决`}
      </button>}
      {showRejected && rejected.map((tag) => <ImpressionTag key={tag.id} tag={tag} busy={busy} onAction={onAction} onRename={onRename} onLock={onLock} onDelete={onDelete} />)}
    </div>
  );
}

function GroupTags({ tags, busy, onAction, onRename, onLock, onDelete, onAdd }: {
  tags: TagView[];
  busy: boolean;
  onAction: TagAction;
  onRename: TagRename;
  onLock: TagLock;
  onDelete: TagDelete;
  onAdd: TagAdd;
}) {
  return (
    <section className="panel-card group-vibe-card">
      <h2>群的氛围</h2>
      <TagCollection tags={tags} label="新增群标签" busy={busy} onAction={onAction} onRename={onRename} onLock={onLock} onDelete={onDelete} onAdd={onAdd} />
    </section>
  );
}

export function ImpressionsPage() {
  const [groups, setGroups] = useState<SessionView[]>([]);
  const [privateSessions, setPrivateSessions] = useState<SessionView[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [selectedId, setSelectedId] = useState('');
  const [tab, setTab] = useState<'groups' | 'people' | 'privacy'>('groups');
  const [view, setView] = useState<ImpressionsView>();
  const [selectedUserId, setSelectedUserId] = useState<number>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [historyDialogOpen, setHistoryDialogOpen] = useState(false);
  const [historyMode, setHistoryMode] = useState<HistoryImportMode>('incremental');
  const [historyTarget, setHistoryTarget] = useState<HistoryImportTarget>(200);
  const [historyJobId, setHistoryJobId] = useState('');
  const [historyJob, setHistoryJob] = useState<HistoryImportJobView>();
  const [historyStarting, setHistoryStarting] = useState(false);
  const [historyConfirming, setHistoryConfirming] = useState(false);
  const [historyCancelling, setHistoryCancelling] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const refreshedHistoryJobs = useRef(new Set<string>());
  const historyDialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    void apiRequest<SessionView[]>('/api/sessions').then((rows) => {
      const groupRows = rows.filter((row) => row.kind === 'group');
      setGroups(groupRows);
      setPrivateSessions(rows.filter((row) => row.kind === 'private'));
      setSelectedId((current) => current || groupRows[0]?.sessionId || '');
    }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : '读取会话失败'))
      .finally(() => setSessionsLoading(false));
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

  useEffect(() => {
    if (!view) {
      setSelectedUserId(undefined);
      return;
    }
    setSelectedUserId((current) => view.members.some((member) => member.userId === current)
      ? current
      : view.members[0]?.userId);
  }, [view]);

  useEffect(() => {
    const dialog = historyDialogRef.current;
    if (!dialog) return;
    if (historyDialogOpen && !dialog.open) dialog.showModal();
    if (!historyDialogOpen && dialog.open) dialog.close();
  }, [historyDialogOpen]);

  useEffect(() => {
    if (!historyJobId) return;
    let active = true;
    let inFlight = false;
    let timer = 0;
    const refreshJob = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      try {
        const current = await apiRequest<HistoryImportJobView>(
          `/api/impressions/import/${encodeURIComponent(historyJobId)}`,
        );
        if (!active) return;
        setHistoryError('');
        setHistoryJob(current);
        if (isHistoryImportTerminal(current)) {
          window.clearInterval(timer);
          if (current.phase === 'done'
            && current.sessionId === selectedId
            && !refreshedHistoryJobs.current.has(current.id)) {
            refreshedHistoryJobs.current.add(current.id);
            void load(current.sessionId);
          }
        }
      } catch (reason) {
        if (active) setHistoryError(reason instanceof Error ? reason.message : '读取导入进度失败');
      } finally {
        inFlight = false;
      }
    };
    timer = window.setInterval(() => { void refreshJob(); }, 1_000);
    void refreshJob();
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [historyJobId, load, selectedId]);

  async function runAction(id: number, body: { text?: string; status?: TagStatus; locked?: boolean }): Promise<boolean> {
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

  async function deleteTag(id: number): Promise<boolean> {
    if (!selectedId || busy) return false;
    setBusy(true);
    try {
      await apiRequest<void>(`/api/tags/${id}`, { method: 'DELETE' });
      return await load(selectedId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '删除标签失败');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function addTag(
    userId: number | null,
    text: string,
    category: TagCategory = 'misc',
    subject: string | null = null,
    polarity: TagPolarity = null,
  ): Promise<boolean> {
    if (!selectedId || busy) return false;
    setBusy(true);
    try {
      await post('/api/tags', {
        sessionId: selectedId,
        userId,
        text,
        category,
        ...(category === 'fandom' ? { subject, polarity } : {}),
      });
      return await load(selectedId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '新增失败');
      return false;
    } finally {
      setBusy(false);
    }
  }

  const historyImportActive = historyStarting || Boolean(historyJobId && !isHistoryImportTerminal(historyJob));
  const selectedGroup = groups.find((group) => group.sessionId === selectedId);
  const selectedView = view?.sessionId === selectedId ? view : undefined;
  const historyGroup = groups.find((group) => group.sessionId === (historyJob?.sessionId ?? selectedId));
  const historyWaterline = historyJob?.sessionId === selectedId
    ? historyJob.waterlineTime
    : view?.sessionId === selectedId ? view.lastMessageTime : null;
  const selectedMember = view?.members.find((member) => member.userId === selectedUserId);

  function openHistoryDialog(): void {
    if (historyImportActive) {
      setHistoryDialogOpen(true);
      return;
    }
    if (isHistoryImportTerminal(historyJob)) {
      setHistoryJobId('');
      setHistoryJob(undefined);
    }
    setHistoryMode('incremental');
    setHistoryTarget(200);
    setHistoryError('');
    setHistoryDialogOpen(true);
  }

  async function startHistoryImport(): Promise<void> {
    if (!selectedId || historyImportActive) return;
    setHistoryStarting(true);
    setHistoryError('');
    setHistoryJob(undefined);
    try {
      const result = await post(`/api/impressions/${selectedId}/import`, {
        target: historyTarget,
        mode: historyMode,
      }) as { id?: unknown };
      if (typeof result.id !== 'string') throw new Error('服务器没有返回导入任务编号');
      setHistoryJobId(result.id);
    } catch (reason) {
      setHistoryError(reason instanceof Error ? reason.message : '启动历史导入失败');
    } finally {
      setHistoryStarting(false);
    }
  }

  async function confirmHistoryImport(): Promise<void> {
    if (!historyJobId || historyConfirming || historyJob?.phase !== 'awaiting_confirmation') return;
    setHistoryConfirming(true);
    setHistoryError('');
    try {
      const job = await apiRequest<HistoryImportJobView>(
        `/api/impressions/import/${encodeURIComponent(historyJobId)}/confirm`,
        { method: 'POST' },
      );
      setHistoryJob(job);
    } catch (reason) {
      setHistoryError(reason instanceof Error ? reason.message : '确认整理失败');
    } finally {
      setHistoryConfirming(false);
    }
  }

  async function cancelHistoryImport(): Promise<void> {
    if (!historyJobId || historyCancelling) return;
    setHistoryCancelling(true);
    setHistoryError('');
    try {
      const job = await apiRequest<HistoryImportJobView>(
        `/api/impressions/import/${encodeURIComponent(historyJobId)}/cancel`,
        { method: 'POST' },
      );
      setHistoryJob(job);
    } catch (reason) {
      setHistoryError(reason instanceof Error ? reason.message : '取消导入失败');
    } finally {
      setHistoryCancelling(false);
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>印象</h1>
        <p className="page-description">它对群友的了解，也是你了解朋友的一本册子。</p>
      </header>
      {error && <div className="notice notice-warn" role="alert">{error}</div>}
      <div className="impressions-controls">
        <div className="page-tabs" role="tablist" aria-label="印象视图">
          <button className={tab === 'groups' ? 'is-active' : ''} type="button" role="tab" aria-selected={tab === 'groups'} onClick={() => setTab('groups')}>群聊</button>
          <button className={tab === 'privacy' ? 'is-active' : ''} type="button" role="tab" aria-selected={tab === 'privacy'} onClick={() => setTab('privacy')}>私聊</button>
          <button className={tab === 'people' ? 'is-active' : ''} type="button" role="tab" aria-selected={tab === 'people'} onClick={() => setTab('people')}>所有人</button>
        </div>
        {tab === 'groups' && <div className="impressions-group-tools">
          <label className="impressions-group-select">
            <span className="visually-hidden">选择群</span>
            <select value={selectedId} onChange={(event) => setSelectedId(event.currentTarget.value)}>
              {groups.length === 0 && <option value="">暂无群聊</option>}
              {groups.map((group) => <option value={group.sessionId} key={group.sessionId}>{group.name} · {group.memberCount === undefined ? '人数未知' : `${group.memberCount} 人`}</option>)}
            </select>
          </label>
          <button
            className="button button-secondary"
            type="button"
            disabled={!selectedId}
            onClick={openHistoryDialog}
          >{historyImportActive ? '查看进度' : '拉取历史'}</button>
          {selectedId && <ImpressionsDataMenu
            key={selectedId}
            sessionId={selectedId}
            groupName={selectedGroup?.name ?? ''}
            groupTagCount={selectedView?.groupTags.length ?? 0}
            memberTagCount={selectedView?.members.reduce((count, member) => count + member.tags.length, 0) ?? 0}
            disabled={busy || historyImportActive || !selectedGroup?.name || !selectedView}
            onChanged={() => load(selectedId)}
          />}
        </div>}
      </div>
      {tab === 'people' && <AffinityPanel />}
      {tab === 'privacy' && <Suspense fallback={<div className="empty-state">正在载入私聊记忆…</div>}>
        <PrivateFactsPanel sessions={privateSessions} loadingFriends={sessionsLoading} />
      </Suspense>}
      {tab === 'groups' && <>
      {!view && <div className="empty-state">选择一个群，查看它攒下的标签。</div>}
      {view && <QqGroupProfilePanel
        sessionId={view.sessionId}
        profile={view.qqGroupProfile}
        onReload={() => load(view.sessionId)}
      />}
      {view && <div className="impressions-workspace">
        <aside className="impressions-sidebar">
          <GroupTags
            tags={view.groupTags}
            busy={busy}
            onAction={(id, status) => runAction(id, { status })}
            onRename={(id, text) => runAction(id, { text })}
            onLock={(id, locked) => runAction(id, { locked })}
            onDelete={deleteTag}
            onAdd={(text) => addTag(null, text)}
          />
          <ActivityHeatmap sessionId={view.sessionId} group />
          <section className="panel-card member-list-section">
            <div className="section-heading">
              <div><h2>群友</h2></div>
              <span className="muted">{view.members.length} 人 · 按最近发言</span>
            </div>
            {view.members.length === 0 && <p className="muted">还没有群友标签；群里聊得多一些就会出现。</p>}
            <div className="member-list">
              {view.members.map((member) => <ImpressionsMemberRow
                key={member.userId}
                member={member}
                account={Number(view.sessionId.split(':', 1)[0])}
                selected={member.userId === selectedUserId}
                onSelect={() => setSelectedUserId(member.userId)}
              />)}
            </div>
          </section>
        </aside>
        {selectedMember
          ? <MemberProfileCard
            key={`${view.sessionId}:${selectedMember.userId}`}
            sessionId={view.sessionId}
            member={selectedMember}
            busy={busy}
            relationTargets={buildIdentityTargets(view, privateSessions)}
            onIdentityUpdated={() => load(view.sessionId)}
            onAction={(id, status) => runAction(id, { status })}
            onRename={(id, text) => runAction(id, { text })}
            onLock={(id, locked) => runAction(id, { locked })}
            onDelete={deleteTag}
            onAdd={(text, category, subject, polarity) => addTag(selectedMember.userId, text, category, subject, polarity)}
          />
          : <div className="panel-card member-profile-empty">选择一位群友，查看它眼里的画像。</div>}
      </div>}
      </>}
      <dialog
        className="history-import-dialog"
        ref={historyDialogRef}
        aria-labelledby="history-import-title"
        onClose={() => setHistoryDialogOpen(false)}
        onCancel={() => setHistoryDialogOpen(false)}
      >
        <div className="history-import-heading">
          <div>
            <h2 id="history-import-title">拉取群聊历史</h2>
            <p className="muted">只读取记录、整理印象，不会在群里发言。</p>
          </div>
          <button className="button button-secondary" type="button" onClick={() => setHistoryDialogOpen(false)}>关闭</button>
        </div>
        {historyGroup && !historyGroup.enabled && <p className="notice history-import-disabled-notice">这个群还没启用：会整理印象，但它不会在群里说话。</p>}
        {!historyJobId && !historyStarting && <div className="history-import-form">
          <p className="history-import-waterline">上次整理到：<strong>{historyWaterline === null ? '尚未整理' : new Date(historyWaterline).toLocaleString('zh-CN')}</strong></p>
          <fieldset className="history-import-modes">
            <legend>整理模式</legend>
            <label>
              <input type="radio" name="history-import-mode" value="incremental" checked={historyMode === 'incremental'} onChange={() => setHistoryMode('incremental')} />
              <span><strong>增量</strong><small>只整理水位线之后的新消息（默认）</small></span>
            </label>
            <label>
              <input type="radio" name="history-import-mode" value="full" checked={historyMode === 'full'} onChange={() => setHistoryMode('full')} />
              <span><strong>重新整理全部</strong><small>忽略水位线，整理本次拉取范围内的消息</small></span>
            </label>
          </fieldset>
          <label>
            <span>拉取条数</span>
            <select value={historyTarget} onChange={(event) => setHistoryTarget(Number(event.currentTarget.value) as HistoryImportTarget)}>
              {HISTORY_IMPORT_TARGETS.map((target) => <option value={target} key={target}>{target.toLocaleString('zh-CN')} 条</option>)}
            </select>
          </label>
        </div>}
        {(historyStarting || (historyJobId && !historyJob)) && <p className="history-import-status" aria-live="polite">
          {historyStarting ? '正在创建导入任务…' : '正在读取导入进度…'}
        </p>}
        {historyJob?.phase === 'fetching' && <p className="history-import-status" aria-live="polite">
          正在拉取 已获取 {historyJob.fetched.toLocaleString('zh-CN')} 条
          {historyJob.cancelRequested ? '；取消将在当前页完成后生效。' : '。'}
        </p>}
        {historyJob?.phase === 'awaiting_confirmation' && <p className="history-import-status" role="status">
          新消息 {historyJob.newMessages.toLocaleString('zh-CN')} 条，预计花费 <strong>{historyJob.estimatedCostCny === undefined ? '—' : `¥${historyJob.estimatedCostCny.toFixed(2)}`}</strong>。
          {historyJob.previewChanged ? '整理水位已变化，预估已更新，请再次确认。' : '确认后才会开始提取。'}
        </p>}
        {historyJob?.phase === 'extracting' && <p className="history-import-status" aria-live="polite">
          正在整理 第 {Math.min(historyJob.windowsDone + historyJob.windowsFailed + 1, historyJob.windowsTotal)} / {historyJob.windowsTotal} 段
          {historyJob.cancelRequested ? '；取消将在当前段完成后生效。' : '。'}
        </p>}
        {historyJob?.phase === 'done' && <p className="history-import-status" role="status">
          完成：新增 {historyJob.inserted} 条消息，新增标签 {historyJob.tagsInserted} 个，确认 {historyJob.tagsObserved} 次观察，花费 ¥{historyJob.costCny.toFixed(2)}。
          {historyJob.windowsFailed > 0 && ` 提取失败：${historyFailureLabel(historyJob)}（${historyJob.windowsFailed} 个窗口跳过）`}
        </p>}
        {historyJob?.phase === 'cancelled' && <p className="history-import-status" role="status">
          已取消：已获取 {historyJob.fetched} 条，新增 {historyJob.inserted} 条消息；花费 ¥{historyJob.costCny.toFixed(2)}。
          {historyJob.windowsFailed > 0 && ` 提取失败：${historyFailureLabel(historyJob)}（${historyJob.windowsFailed} 个窗口跳过）`}
        </p>}
        {historyJob?.phase === 'error' && <p className="history-import-status is-error" role="alert">
          导入停止：{historyJob.error ?? '未知错误'}
          {historyJob.windowsFailed > 0 && !historyJob.error?.startsWith('提取失败：')
            && `；提取失败：${historyFailureLabel(historyJob)}（${historyJob.windowsFailed} 个窗口跳过）`}
          ；已获取 {historyJob.fetched} 条，新增 {historyJob.inserted} 条消息。
        </p>}
        {historyJob?.phase === 'expired' && <p className="history-import-status is-error" role="alert">确认等待超时，任务已释放；已拉取的消息仍保存在本地。</p>}
        {historyError && <p className="history-import-error" role="alert">{historyError}</p>}
        <div className="history-import-footer">
          {!historyJobId && !historyStarting && <>
            <button className="button button-secondary" type="button" onClick={() => setHistoryDialogOpen(false)}>取消</button>
            <button className="button button-primary" type="button" disabled={historyImportActive} onClick={() => void startHistoryImport()}>
              {historyStarting ? '正在开始…' : '开始拉取'}
            </button>
          </>}
          {historyJob?.phase === 'awaiting_confirmation' && <>
            <button className="button button-secondary" type="button" disabled={historyCancelling} onClick={() => void cancelHistoryImport()}>
              {historyCancelling ? '正在取消…' : '取消任务'}
            </button>
            <button className="button button-primary" type="button" disabled={historyConfirming} onClick={() => void confirmHistoryImport()}>
              {historyConfirming ? '正在确认…' : '确认并开始整理'}
            </button>
          </>}
          {historyJob && ['fetching', 'extracting'].includes(historyJob.phase) && <>
            <button className="button button-secondary" type="button" onClick={() => setHistoryDialogOpen(false)}>关闭，任务继续</button>
            <button className="button button-secondary" type="button" disabled={historyCancelling || historyJob.cancelRequested} onClick={() => void cancelHistoryImport()}>
              {historyJob.cancelRequested ? '正在等待当前步骤完成…' : historyCancelling ? '正在取消…' : '取消'}
            </button>
          </>}
          {historyJob && isHistoryImportTerminal(historyJob) && <button className="button button-primary" type="button" onClick={() => setHistoryDialogOpen(false)}>完成</button>}
        </div>
      </dialog>
    </div>
  );
}
