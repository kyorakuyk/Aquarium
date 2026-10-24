import { useEffect, useState } from 'react';
import {
  apiRequest,
  patch,
  type EventBookEvent,
  type EventBookNote,
  type EventBookResponse,
  type EventNoteIntent,
  type EventNoteLevel,
  type PanelStatus,
} from '../api.ts';

interface NoteDraft {
  intent: EventNoteIntent;
  level: EventNoteLevel;
}

const DEFAULT_LEVEL: Record<EventNoteIntent, EventNoteLevel> = {
  confide: 'L0',
  clarify: 'L1',
  advocate: 'L2',
};

const INTENT_LABEL: Record<EventNoteIntent, string> = {
  confide: '只告诉眷属',
  clarify: '私下澄清',
  advocate: '请眷属出面',
};

const ADVOCACY_STATUS_LABEL: Record<NonNullable<EventBookNote['advocacyStatus']>, string> = {
  awaiting_confirmation: '等待私聊确认',
  confirmed: '已确认，等待发送',
  sending: '正在发送',
  sent: '已出面一次',
  failed: '发送失败，不会自动重发',
  cancelled: '已取消',
};

const eventTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
});

function eventBookError(reason: unknown): string {
  return reason instanceof Error ? reason.message : '读取事件簿失败，请重试。';
}

function eventTime(value: number): { iso: string | undefined; label: string } {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { iso: undefined, label: '时间未知' };
  return { iso: date.toISOString(), label: eventTimeFormatter.format(date) };
}

function noteDraft(note: EventBookNote, drafts: Record<number, NoteDraft>): NoteDraft {
  return drafts[note.id] ?? { intent: note.intent, level: note.level };
}

function EventNoteRow({
  event,
  note,
  draft,
  pending,
  onIntentChange,
  onLevelChange,
  onSave,
}: {
  event: EventBookEvent;
  note: EventBookNote;
  draft: NoteDraft;
  pending: boolean;
  onIntentChange: (intent: EventNoteIntent) => void;
  onLevelChange: (level: EventNoteLevel) => void;
  onSave: () => void;
}) {
  const dirty = draft.intent !== note.intent || draft.level !== note.level;
  const levelLabel = draft.level === 'L0' ? '仅私聊' : draft.level === 'L1' ? '群内接话' : '可申请出面';
  return (
    <article className="event-book-note">
      <div className="event-book-note-heading">
        <div>
          <strong>{note.ownerName}</strong>
          <span className="mono muted"> · {note.ownerId}</span>
        </div>
        <div className="event-book-note-badges">
          <span className={`status-pill ${note.status === 'active' ? 'status-online' : 'status-offline'}`}>
            {note.status === 'active' ? '有效' : '已撤回'}
          </span>
          {note.advocacyStatus && <span className="status-pill status-connecting">
            {ADVOCACY_STATUS_LABEL[note.advocacyStatus]}
          </span>}
        </div>
      </div>
      <p className="event-book-note-text">{note.text}</p>
      <div className="event-book-note-editor">
        <label>
          <span>意图</span>
          <select
            aria-label={`修改「${event.title}」中 ${note.ownerName} 注解的意图`}
            value={draft.intent}
            disabled={pending}
            onChange={(change) => onIntentChange(change.currentTarget.value as EventNoteIntent)}
          >
            {Object.entries(INTENT_LABEL).map(([intent, label]) => <option value={intent} key={intent}>{label}</option>)}
          </select>
        </label>
        <label>
          <span>级别</span>
          <select
            aria-label={`修改「${event.title}」中 ${note.ownerName} 注解的级别`}
            value={draft.level}
            disabled={pending}
            onChange={(change) => onLevelChange(change.currentTarget.value as EventNoteLevel)}
          >
            <option value="L0">L0 · 仅私聊</option>
            <option value="L1">L1 · 群内接话</option>
            <option value="L2">L2 · 可申请出面</option>
          </select>
        </label>
        <button
          className="button button-secondary"
          type="button"
          disabled={!dirty || pending}
          onClick={onSave}
        >保存
        </button>
      </div>
      <p className="event-book-note-current muted">当前分类：{INTENT_LABEL[note.intent]} · {note.level}（{note.level === 'L0' ? '仅私聊' : note.level === 'L1' ? '群内接话' : '可申请出面'}）</p>
      <span className="visually-hidden" aria-live="polite">{levelLabel}</span>
    </article>
  );
}

export function EventBookPage() {
  const [status, setStatus] = useState<PanelStatus>();
  const [selectedAccount, setSelectedAccount] = useState<number>();
  const [events, setEvents] = useState<EventBookResponse>();
  const [drafts, setDrafts] = useState<Record<number, NoteDraft>>({});
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [pendingNoteId, setPendingNoteId] = useState<number>();
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void apiRequest<PanelStatus>('/api/status').then((result) => {
      if (!active) return;
      setStatus(result);
      setSelectedAccount((current) => current ?? result.accounts[0]?.account);
    }).catch((reason: unknown) => {
      if (active) setError(eventBookError(reason));
    }).finally(() => {
      if (active) setLoadingAccounts(false);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (selectedAccount === undefined) {
      setEvents(undefined);
      setLoadingEvents(false);
      return;
    }
    let active = true;
    setEvents(undefined);
    setLoadingEvents(true);
    setError('');
    void apiRequest<EventBookResponse>(`/api/events?account=${selectedAccount}`).then((result) => {
      if (!active) return;
      if (result.account === selectedAccount) setEvents(result);
      else setError('返回的 QQ 号与所选眷属不一致，请重新读取。');
    }).catch((reason: unknown) => {
      if (active) setError(eventBookError(reason));
    }).finally(() => {
      if (active) setLoadingEvents(false);
    });
    return () => { active = false; };
  }, [selectedAccount, refreshVersion]);

  async function saveNote(event: EventBookEvent, note: EventBookNote): Promise<void> {
    if (selectedAccount === undefined || pendingNoteId !== undefined) return;
    const draft = noteDraft(note, drafts);
    setPendingNoteId(note.id);
    setError('');
    try {
      const response = await patch<{ note: EventBookNote }>(
        `/api/events/${event.id}/notes/${note.id}?account=${selectedAccount}`,
        { intent: draft.intent, level: draft.level },
      );
      const expectedLevel = draft.intent === 'confide' ? 'L0' : draft.level;
      if (response.note.id !== note.id || response.note.intent !== draft.intent
        || response.note.level !== expectedLevel) {
        throw new Error('事件注解保存后读回不一致，请刷新核对。');
      }
      setEvents((current) => current?.account !== selectedAccount ? current : {
        ...current,
        events: current.events.map((item) => item.id !== event.id ? item : {
          ...item,
          notes: item.notes.map((entry) => entry.id === note.id ? response.note : entry),
        }),
      });
      setDrafts((current) => ({
        ...current,
        [note.id]: { intent: response.note.intent, level: response.note.level },
      }));
      setRefreshVersion((version) => version + 1);
    } catch (reason) {
      setError(eventBookError(reason));
    } finally {
      setPendingNoteId(undefined);
    }
  }

  const visibleEvents = events !== undefined && events.account === selectedAccount ? events.events : [];
  return (
    <div className="page event-book-page">
      <header className="page-header event-book-header">
        <div>
          <h1>事件簿</h1>
          <p className="page-description">查看群聊事件与成员注解；调整分类不会绕过私聊确认或出面限制。</p>
        </div>
        {(status?.accounts.length ?? 0) > 1 && <label className="event-book-account">
          <span>眷属</span>
          <select
            aria-label="选择眷属"
            value={selectedAccount ?? ''}
            onChange={(change) => {
              setEvents(undefined);
              setDrafts({});
              setError('');
              setSelectedAccount(Number(change.currentTarget.value));
            }}
          >
            {status?.accounts.map((item) => <option key={item.account} value={item.account}>
              {item.name} · {item.account}
            </option>)}
          </select>
        </label>}
      </header>
      {error && <div className="notice notice-warn" role="alert">{error}</div>}
      {loadingAccounts && <div className="empty-state" role="status">正在读取眷属…</div>}
      {!loadingAccounts && !status?.accounts.length && <div className="empty-state">尚无可查看的眷属。</div>}
      {!loadingAccounts && selectedAccount !== undefined && loadingEvents
        && <div className="empty-state" role="status">正在读取事件簿…</div>}
      {!loadingEvents && selectedAccount !== undefined && visibleEvents.length === 0 && !error
        && <div className="empty-state">还没有整理出的群聊事件。</div>}
      <div className="event-book-list">
        {visibleEvents.map((event) => <section className="panel-card event-book-event" key={event.id}>
          <header className="event-book-event-heading">
            <div>
              <h2>{event.title}</h2>
              <p>{event.summary}</p>
            </div>
            <div className="event-book-event-meta">
              <span>群 <span className="mono">{event.sourceGroupId}</span></span>
              <time className="mono" dateTime={eventTime(event.occurredAt).iso}>
                {eventTime(event.occurredAt).label}
              </time>
            </div>
          </header>
          <div className="event-book-notes">
            {event.notes.length === 0 && <p className="muted">暂无成员注解。</p>}
            {event.notes.map((note) => <EventNoteRow
              key={note.id}
              event={event}
              note={note}
              draft={noteDraft(note, drafts)}
              pending={pendingNoteId === note.id}
              onIntentChange={(intent) => setDrafts((current) => ({
                ...current,
                [note.id]: { intent, level: DEFAULT_LEVEL[intent] },
              }))}
              onLevelChange={(level) => setDrafts((current) => ({
                ...current,
                [note.id]: { ...noteDraft(note, current), level },
              }))}
              onSave={() => void saveNote(event, note)}
            />)}
          </div>
        </section>)}
      </div>
    </div>
  );
}
