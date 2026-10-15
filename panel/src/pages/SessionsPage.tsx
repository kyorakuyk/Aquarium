import { useEffect, useMemo, useState } from 'react';
import { apiRequest, patch, type DefaultsView, type SessionView } from '../api.ts';
import {
  createDefaultsSettingsTarget,
  createSessionSettingsTarget,
  GLOBAL_DEFAULT_ID,
  SessionSettingsPanel,
  type SessionSettingsTarget,
} from './SessionSettingsPanel.tsx';

const SESSION_SELECTION_STORAGE_KEY = 'aquarium-session-selection';

interface SavedSessionSelection {
  sessionId: string;
  kind: 'group' | 'private';
}

function readSavedSessionSelection(): SavedSessionSelection | undefined {
  try {
    const serialized = window.localStorage.getItem(SESSION_SELECTION_STORAGE_KEY);
    if (!serialized) return undefined;
    const value: unknown = JSON.parse(serialized);
    if (typeof value !== 'object' || value === null) return undefined;
    const record = value as Record<string, unknown>;
    if (typeof record.sessionId !== 'string' || record.sessionId.trim() === '') return undefined;
    if (record.kind !== 'group' && record.kind !== 'private') return undefined;
    return { sessionId: record.sessionId, kind: record.kind };
  } catch {
    return undefined;
  }
}

function writeSavedSessionSelection(sessionId: string, kind: SavedSessionSelection['kind']): void {
  try {
    window.localStorage.setItem(SESSION_SELECTION_STORAGE_KEY, JSON.stringify({ sessionId, kind }));
  } catch {
    // Selection persistence is best-effort; the current page remains usable.
  }
}

function compareSessions(first: SessionView, second: SessionView): number {
  if (first.enabled !== second.enabled) return first.enabled ? -1 : 1;
  if (first.lastMessageAt !== second.lastMessageAt) {
    if (first.lastMessageAt === null) return 1;
    if (second.lastMessageAt === null) return -1;
    return second.lastMessageAt - first.lastMessageAt;
  }
  return first.name.localeCompare(second.name, 'zh-CN');
}

export function SessionsPage() {
  const [savedSelection] = useState(readSavedSessionSelection);
  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [defaults, setDefaults] = useState<DefaultsView | null>(null);
  const [selectedId, setSelectedId] = useState(savedSelection?.sessionId ?? GLOBAL_DEFAULT_ID);
  const [kind, setKind] = useState<SavedSessionSelection['kind']>(savedSelection?.kind ?? 'group');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const selectedSession = sessions.find((item) => item.sessionId === selectedId);
  const selected: SessionSettingsTarget | undefined = selectedId === GLOBAL_DEFAULT_ID
    ? defaults ? createDefaultsSettingsTarget(defaults) : undefined
    : selectedSession ? createSessionSettingsTarget(selectedSession) : undefined;
  const visible = useMemo(() => sessions.filter((item) => item.kind === kind
    && `${item.name} ${item.sessionId}`.toLowerCase().includes(query.trim().toLowerCase()))
    .sort(compareSessions), [sessions, kind, query]);

  async function loadSessions(preferredId?: string) {
    const result = await apiRequest<SessionView[]>('/api/sessions');
    setSessions(result);
    const nextId = preferredId ?? selectedId;
    if (nextId === GLOBAL_DEFAULT_ID) return;
    const selectedSession = result.find((item) => item.sessionId === nextId);
    if (selectedSession) {
      setKind(selectedSession.kind);
      return;
    }
    const fallback = result[0];
    setSelectedId(fallback?.sessionId ?? GLOBAL_DEFAULT_ID);
    if (fallback) setKind(fallback.kind);
  }

  async function loadDefaults() {
    setDefaults(await apiRequest<DefaultsView>('/api/defaults'));
  }

  useEffect(() => {
    void Promise.all([loadSessions(), loadDefaults()]).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : '读取会话设置失败');
    });
  }, []);

  useEffect(() => {
    writeSavedSessionSelection(selectedId, kind);
  }, [selectedId, kind]);

  function selectKind(nextKind: SavedSessionSelection['kind']) {
    setKind(nextKind);
    if (selectedId === GLOBAL_DEFAULT_ID) return;
    if (sessions.some((item) => item.sessionId === selectedId && item.kind === nextKind)) return;
    setSelectedId(sessions.find((item) => item.kind === nextKind)?.sessionId ?? GLOBAL_DEFAULT_ID);
  }

  async function patchSettings(target: SessionSettingsTarget, values: Record<string, unknown>) {
    setBusy(true);
    setError('');
    const endpoint = target.kind === 'global'
      ? '/api/defaults'
      : `/api/sessions/${encodeURIComponent(target.id)}`;
    try {
      await patch(endpoint, values);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存失败');
      throw reason;
    } finally {
      setBusy(false);
    }
  }

  async function refreshSettings(target: SessionSettingsTarget) {
    try {
      if (target.kind === 'global') await loadDefaults();
      else await loadSessions(target.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '刷新设置失败');
      throw reason;
    }
  }

  function reportError(reason: unknown) {
    setError(reason instanceof Error ? reason.message : '保存失败');
  }

  async function updateSession(session: SessionView, values: Record<string, unknown>) {
    const target = createSessionSettingsTarget(session);
    try {
      await patchSettings(target, values);
      await refreshSettings(target);
    } catch {
      // The failed request or refresh is already shown in the page notice.
    }
  }

  const groupCount = sessions.filter((item) => item.kind === 'group').length;
  const friendCount = sessions.filter((item) => item.kind === 'private').length;

  return (
    <div className="page">
      <header className="page-header">
        <h1>会话</h1>
        <p className="page-description">打开开关的会话里，它才会说话。改动立刻生效，不用重启。</p>
      </header>
      {error && <div className="notice notice-warn" role="alert">{error}</div>}
      {sessions.some((session) => session.degraded) && (
        <div className="notice notice-warn" role="status">QQ 联系人数据暂未刷新；当前会话清单可能不完整。</div>
      )}
      <div className="session-workspace">
        <section className="session-list-card panel-card">
          <div className="segmented-control" role="group" aria-label="会话类型">
            <button className={kind === 'group' ? 'is-selected' : ''} type="button" onClick={() => selectKind('group')}>群聊 <span>{groupCount}</span></button>
            <button className={kind === 'private' ? 'is-selected' : ''} type="button" onClick={() => selectKind('private')}>好友 <span>{friendCount}</span></button>
          </div>
          <label className="search-field">
            <span className="visually-hidden">搜索会话</span>
            <input type="search" placeholder="搜索名称或号码" value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
          </label>
          <div className="session-list">
            <div className={`session-row session-row-global ${selectedId === GLOBAL_DEFAULT_ID ? 'is-selected' : ''}`}>
              <button
                className="session-row-main"
                type="button"
                onClick={() => setSelectedId(GLOBAL_DEFAULT_ID)}
                aria-pressed={selectedId === GLOBAL_DEFAULT_ID}
              >
                <span className="avatar-initial">全</span>
                <span className="session-row-copy"><strong>全局默认</strong><span className="muted">所有会话继承此处设置</span></span>
              </button>
            </div>
            {visible.map((item) => (
              <div className={`session-row ${selectedId === item.sessionId ? 'is-selected' : ''}`} key={item.sessionId}>
                <button
                  className="session-row-main"
                  type="button"
                  onClick={() => setSelectedId(item.sessionId)}
                  aria-pressed={selectedId === item.sessionId}
                >
                  <span className="avatar-initial">{Array.from(item.name)[0] ?? '会'}</span>
                  <span className="session-row-copy"><strong>{item.name}</strong><span className="mono muted">{item.sessionId}{item.memberCount === undefined ? '' : ` · ${item.memberCount} 人`}</span></span>
                </button>
                <button
                  className={`switch ${item.enabled ? 'is-on' : ''}`}
                  type="button"
                  role="switch"
                  aria-checked={item.enabled}
                  aria-label={`${item.name}${item.enabled ? '已启用' : '已停用'}`}
                  disabled={busy}
                  onClick={() => void updateSession(item, { enabled: !item.enabled })}
                ><span /></button>
                <span className={`override-tag ${item.overrides.length ? 'is-overridden' : ''}`}>{item.overrides.length ? (item.kind === 'private' ? '本会话覆盖' : '本群覆盖') : '继承全局'}</span>
              </div>
            ))}
            {visible.length === 0 && <p className="empty-state">没有找到会话。</p>}
          </div>
        </section>

        <section className="session-detail panel-card">
          {selected
            ? <SessionSettingsPanel
              key={selected.id}
              target={selected}
              busy={busy}
              onPatch={patchSettings}
              onRefresh={refreshSettings}
              onError={reportError}
              onNavigateToDefaults={() => setSelectedId(GLOBAL_DEFAULT_ID)}
            />
            : <div className="empty-state">{selectedId === GLOBAL_DEFAULT_ID ? '正在读取全局默认设置…' : '选择一个会话查看设置。'}</div>}
        </section>
      </div>
    </div>
  );
}
