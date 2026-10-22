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
} from '../api.ts';
import { AffinityPanel } from '../components/AffinityPanel.tsx';
import { ImpressionsDataMenu } from '../components/ImpressionsDataMenu.tsx';
import { ImpressionsDetail } from '../components/ImpressionsDetail.tsx';
import { ImpressionsSidebar } from '../components/ImpressionsSidebar.tsx';
import { KinGroupsPanel } from '../components/KinGroupsPanel.tsx';
import { parseAppHash, serializeAppHash } from '../hash-navigation.ts';
import { buildIdentityTargets } from '../identity-targets.ts';
import { shouldRefreshHistoryImport, tagClassificationStatusText } from '../impressions-refresh-model.ts';
import { useImpressionsBackgroundRefresh } from '../use-impressions-background-refresh.ts';

const PrivateFactsPanel = lazy(() => import('../components/PrivateFactsPanel.tsx').then((module) => ({ default: module.PrivateFactsPanel })));

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

function currentImpressionsRoute() {
  const route = parseAppHash(window.location.hash);
  return route?.page === 'impressions' ? route : undefined;
}

function writeImpressionsHash(sessionId: string, userId: number | undefined, replace: boolean): void {
  const hash = serializeAppHash({ page: 'impressions', sessionId, ...(userId === undefined ? {} : { userId }) });
  if (window.location.hash === hash) return;
  if (replace) window.history.replaceState(window.history.state, '', hash);
  else window.history.pushState(window.history.state, '', hash);
}

export function ImpressionsPage() {
  const [groups, setGroups] = useState<SessionView[]>([]);
  const [privateSessions, setPrivateSessions] = useState<SessionView[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState(() => currentImpressionsRoute()?.sessionId ?? '');
  const [tab, setTab] = useState<'groups' | 'people' | 'privacy' | 'kin-groups'>('groups');
  const [view, setView] = useState<ImpressionsView>();
  const [selectedUserId, setSelectedUserId] = useState<number | undefined>(() => currentImpressionsRoute()?.userId);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [tagClassificationRetrying, setTagClassificationRetrying] = useState(false);
  const [historyDialogOpen, setHistoryDialogOpen] = useState(false);
  const [historyMode, setHistoryMode] = useState<HistoryImportMode>('incremental');
  const [historyTarget, setHistoryTarget] = useState<HistoryImportTarget>(200);
  const [historyJobId, setHistoryJobId] = useState('');
  const [historyJob, setHistoryJob] = useState<HistoryImportJobView>();
  const [historyStarting, setHistoryStarting] = useState(false);
  const [historyConfirming, setHistoryConfirming] = useState(false);
  const [historyCancelling, setHistoryCancelling] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [refreshVersion, setRefreshVersion] = useState(0);
  const refreshedHistoryJobs = useRef(new Set<string>());
  const historyDialogRef = useRef<HTMLDialogElement>(null);
  const lastViewLoadStartedAt = useRef(0);
  const historyImportActive = historyStarting || Boolean(historyJobId && !isHistoryImportTerminal(historyJob));
  const historyExtractionActive = historyJob?.phase === 'extracting';

  useEffect(() => {
    void apiRequest<SessionView[]>('/api/sessions').then((rows) => {
      const groupRows = rows.filter((row) => row.kind === 'group');
      const route = currentImpressionsRoute();
      const requestedId = route?.sessionId ?? '';
      const hasRequestedGroup = groupRows.some((group) => group.sessionId === requestedId);
      const nextId = hasRequestedGroup ? requestedId : groupRows[0]?.sessionId ?? '';
      setGroups(groupRows);
      setPrivateSessions(rows.filter((row) => row.kind === 'private'));
      setSessionsLoaded(true);
      setSelectedId(nextId);
      if (route) {
        const nextUserId = hasRequestedGroup ? route.userId : undefined;
        setSelectedUserId(nextUserId);
        writeImpressionsHash(nextId, nextUserId, true);
      } else {
        setSelectedUserId(undefined);
      }
    }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : '读取会话失败'))
      .finally(() => setSessionsLoading(false));
  }, []);

  useEffect(() => {
    const restoreSelection = (): void => {
      const route = currentImpressionsRoute();
      if (!route) return;
      setSelectedId(route.sessionId ?? '');
      setSelectedUserId(route.userId);
    };
    window.addEventListener('hashchange', restoreSelection);
    window.addEventListener('popstate', restoreSelection);
    return () => {
      window.removeEventListener('hashchange', restoreSelection);
      window.removeEventListener('popstate', restoreSelection);
    };
  }, []);

  useEffect(() => {
    if (!sessionsLoaded || groups.some((group) => group.sessionId === selectedId)) return;
    const fallbackId = groups[0]?.sessionId ?? '';
    setSelectedId(fallbackId);
    setSelectedUserId(undefined);
    writeImpressionsHash(fallbackId, undefined, true);
  }, [groups, selectedId, sessionsLoaded]);

  const load = useCallback(async (sessionId: string): Promise<boolean> => {
    const startedAt = Date.now();
    lastViewLoadStartedAt.current = startedAt;
    try {
      setView(await apiRequest<ImpressionsView>(`/api/impressions/${sessionId}`));
      setRefreshVersion((current) => current + 1);
      setError('');
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '读取知识失败');
      return false;
    }
  }, []);

  const { tagClassificationStatus, extractionRunning, retryTagClassification } = useImpressionsBackgroundRefresh({
    sessionId: selectedId,
    enabled: Boolean(selectedId),
    historyExtractionActive,
    lastViewLoadStartedAt,
    onRefresh: load,
  });
  const tagClassificationMessage = tagClassificationStatusText(tagClassificationStatus);

  useEffect(() => {
    if (selectedId) void load(selectedId);
    else setView(undefined);
  }, [selectedId, load]);

  useEffect(() => {
    if (!view || view.sessionId !== selectedId || selectedUserId === undefined
      || view.members.some((member) => member.userId === selectedUserId)) return;
    setSelectedUserId(undefined);
    writeImpressionsHash(selectedId, undefined, true);
  }, [selectedId, selectedUserId, view]);

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
          if (shouldRefreshHistoryImport(current.phase, current.sessionId, selectedId)
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

  const selectedGroup = groups.find((group) => group.sessionId === selectedId);
  const selectedView = view?.sessionId === selectedId ? view : undefined;
  const historyGroup = groups.find((group) => group.sessionId === (historyJob?.sessionId ?? selectedId));
  const historyWaterline = historyJob?.sessionId === selectedId
    ? historyJob.waterlineTime
    : view?.sessionId === selectedId ? view.lastMessageTime : null;
  const selectedMember = selectedView?.members.find((member) => member.userId === selectedUserId);

  function selectGroup(sessionId: string): void {
    setSelectedId(sessionId);
    setSelectedUserId(undefined);
    writeImpressionsHash(sessionId, undefined, false);
  }

  function selectMember(userId: number | undefined): void {
    setSelectedUserId(userId);
    if (selectedId) writeImpressionsHash(selectedId, userId, false);
  }

  async function retryOldTagClassification(): Promise<void> {
    if (tagClassificationRetrying) return;
    setTagClassificationRetrying(true);
    setError('');
    try {
      await retryTagClassification();
    } catch {
      setError('旧标签分类重试失败，请稍后再试。');
    } finally {
      setTagClassificationRetrying(false);
    }
  }

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
        <h1>知识</h1>
        <p className="page-description">记录群聊与成员的客观事实，并查看置信度和来源。</p>
      </header>
      {error && <div className="notice notice-warn" role="alert">{error}</div>}
      {tab === 'groups' && tagClassificationStatus?.state === 'running' && tagClassificationMessage
        && <p className="muted" role="status">{tagClassificationMessage}</p>}
      {tab === 'groups' && tagClassificationStatus?.state === 'error' && tagClassificationMessage
        && <div className="notice notice-warn impressions-classification-error" role="alert">
          <span>{tagClassificationMessage}</span>
          <button className="text-button" type="button" disabled={tagClassificationRetrying} onClick={() => void retryOldTagClassification()}>
            {tagClassificationRetrying ? '正在重试…' : '重试'}
          </button>
        </div>}
      {tab === 'groups' && extractionRunning && <p className="muted" role="status">正在整理当前群的知识…</p>}
      {historyImportActive && historyJob && <p className="muted" role="status">
        {historyJob.phase === 'fetching' ? '正在拉取群聊历史…' : historyJob.phase === 'extracting' ? '正在整理历史知识…' : '历史整理等待确认。'}
      </p>}
      <div className="impressions-controls">
        <div className="page-tabs" role="tablist" aria-label="知识视图">
          <button className={tab === 'groups' ? 'is-active' : ''} type="button" role="tab" aria-selected={tab === 'groups'} onClick={() => setTab('groups')}>群聊</button>
          <button className={tab === 'privacy' ? 'is-active' : ''} type="button" role="tab" aria-selected={tab === 'privacy'} onClick={() => setTab('privacy')}>私聊</button>
          <button className={tab === 'people' ? 'is-active' : ''} type="button" role="tab" aria-selected={tab === 'people'} onClick={() => setTab('people')}>所有人</button>
          <button className={tab === 'kin-groups' ? 'is-active' : ''} type="button" role="tab" aria-selected={tab === 'kin-groups'} onClick={() => setTab('kin-groups')}>眷属组</button>
        </div>
        {tab === 'groups' && <div className="impressions-group-tools">
          <label className="impressions-group-select">
            <span className="visually-hidden">选择群</span>
            <select value={selectedId} onChange={(event) => selectGroup(event.currentTarget.value)}>
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
            onChanged={async () => {
              setSelectedUserId(undefined);
              writeImpressionsHash(selectedId, undefined, true);
              return load(selectedId);
            }}
          />}
        </div>}
      </div>
      {tab === 'people' && <AffinityPanel />}
      {tab === 'kin-groups' && <KinGroupsPanel />}
      {tab === 'privacy' && <Suspense fallback={<div className="empty-state">正在载入私聊记忆…</div>}>
        <PrivateFactsPanel sessions={privateSessions} loadingFriends={sessionsLoading} />
      </Suspense>}
      {tab === 'groups' && <>
      {!selectedView && <div className="empty-state">{selectedGroup ? '正在读取群知识…' : '选择一个群，查看已整理的知识。'}</div>}
      {selectedView && selectedGroup && <div className="impressions-workspace">
        <ImpressionsSidebar
          group={selectedGroup}
          view={selectedView}
          selectedUserId={selectedUserId}
          onSelectGroup={() => selectMember(undefined)}
          onSelectMember={selectMember}
        />
        <ImpressionsDetail
          sessionId={selectedView.sessionId}
          groupName={selectedGroup.name}
          enabled={selectedGroup.enabled}
          view={selectedView}
          refreshVersion={refreshVersion}
          member={selectedMember}
          relationTargets={buildIdentityTargets(selectedView, privateSessions)}
          busy={busy}
          onReload={() => load(selectedView.sessionId)}
          onAction={(id, status) => runAction(id, { status })}
          onRename={(id, text) => runAction(id, { text })}
          onLock={(id, locked) => runAction(id, { locked })}
          onDelete={deleteTag}
          onAdd={addTag}
        />
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
            <p className="muted">只读取记录、整理知识，不会在群里发言。</p>
          </div>
        </div>
        {historyGroup && !historyGroup.enabled && <p className="notice history-import-disabled-notice">这个群还没启用：会整理知识，但它不会在群里说话。</p>}
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
          {historyJob.mode === 'full' ? '待整理' : '新消息'} {historyJob.newMessages.toLocaleString('zh-CN')} 条，预计花费 <strong>{historyJob.estimatedCostCny === undefined ? '—' : `¥${historyJob.estimatedCostCny.toFixed(2)}`}</strong>。
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
