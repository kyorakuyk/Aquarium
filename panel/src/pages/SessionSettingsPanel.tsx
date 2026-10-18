import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { DefaultsView, ModeScheduleEntry, SessionSettings, SessionView } from '../api.ts';
import { InfoTip } from '../components/InfoTip.tsx';
import {
  addModeScheduleEntry,
  changeModeScheduleDraft,
  createModeScheduleEntryChangeFromInput,
  discardModeScheduleDraft,
  getModeScheduleDraft,
  getModeScheduleRowKeys,
  readModeScheduleDrafts,
  removeModeScheduleEntry,
  saveModeScheduleDraft,
  SESSION_MODE_OPTIONS,
  writeModeScheduleDrafts,
  type ModeScheduleDrafts,
  type ModeScheduleRowKeys,
} from '../session-mode.ts';

export const GLOBAL_DEFAULT_ID = '__global-defaults__';

type SessionField = 'enabled' | 'mode' | 'modeSchedule' | 'nicknames' | 'contextMessages' | 'proactiveCooldownSec' | 'talkOffset' | 'rate' | 'groupNote';
type RateField = keyof SessionSettings['rate'];

export interface SessionSettingsTarget {
  id: string;
  name: string;
  kind: 'global' | 'group' | 'private';
  enabled: boolean;
  overrides: string[];
  settings: SessionSettings;
}

interface SessionSettingsPanelProps {
  target: SessionSettingsTarget;
  busy: boolean;
  onPatch: (target: SessionSettingsTarget, values: Record<string, unknown>) => Promise<void>;
  onRefresh: (target: SessionSettingsTarget) => Promise<void>;
  onError: (error: unknown) => void;
  onNavigateToDefaults: () => void;
}

function readModeScheduleDraftSnapshot(): ModeScheduleDrafts {
  try {
    return readModeScheduleDrafts(window.sessionStorage);
  } catch {
    return new Map();
  }
}

function writeModeScheduleDraftSnapshot(drafts: ModeScheduleDrafts): boolean {
  try {
    return writeModeScheduleDrafts(window.sessionStorage, drafts);
  } catch {
    return false;
  }
}

function FieldHeading({ title, help, fields, target, onReset, onNavigateToDefaults }: {
  title: string;
  help?: string;
  fields: SessionField[];
  target: SessionSettingsTarget;
  onReset: (fields: SessionField[]) => void;
  onNavigateToDefaults: () => void;
}) {
  const headingTitle = <div className="field-heading-title"><h3>{title}</h3>{help && <InfoTip label={`${title}说明`} text={help} />}</div>;
  if (target.kind === 'global') return <div className="field-heading">{headingTitle}</div>;
  const overridden = fields.some((field) => target.overrides.includes(field));
  return (
    <div className="field-heading">
      {headingTitle}
      {overridden
        ? <button className="inherit-button is-overridden" type="button" onClick={() => onReset(fields)}>{target.kind === 'private' ? '本会话覆盖' : '本群覆盖'} · 恢复继承</button>
        : <button className="inherit-button" type="button" onClick={onNavigateToDefaults}>继承全局</button>}
    </div>
  );
}

function SettingGroup({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`setting-group ${className}`}>{children}</section>;
}

export function createSessionSettingsTarget(session: SessionView): SessionSettingsTarget {
  return {
    id: session.sessionId,
    name: session.name,
    kind: session.kind,
    enabled: session.enabled,
    overrides: session.overrides,
    settings: session.effective,
  };
}

export function createDefaultsSettingsTarget(defaults: DefaultsView): SessionSettingsTarget {
  return {
    id: GLOBAL_DEFAULT_ID,
    name: '全局默认',
    kind: 'global',
    enabled: defaults.enabled,
    overrides: [],
    settings: defaults,
  };
}

export function SessionSettingsPanel({
  target,
  busy,
  onPatch,
  onRefresh,
  onError,
  onNavigateToDefaults,
}: SessionSettingsPanelProps) {
  const [nicknames, setNicknames] = useState(target.settings.nicknames.join(', '));
  const [groupNote, setGroupNote] = useState(target.settings.groupNote);
  const [rateDraft, setRateDraft] = useState(target.settings.rate);
  const [contextMessagesDraft, setContextMessagesDraft] = useState(target.settings.contextMessages);
  const [proactiveCooldownDraft, setProactiveCooldownDraft] = useState(String(target.settings.proactiveCooldownSec));
  const [modeScheduleDrafts, setModeScheduleDrafts] = useState<ModeScheduleDrafts>(readModeScheduleDraftSnapshot);
  const modeScheduleDraftsRef = useRef(modeScheduleDrafts);
  const [modeScheduleRowKeys, setModeScheduleRowKeys] = useState<ModeScheduleRowKeys>(() => new Map());
  const [draftPersistenceError, setDraftPersistenceError] = useState('');
  const [savedAt, setSavedAt] = useState('');
  const nextScheduleRowKey = useRef(0);

  const scheduleEntries = getModeScheduleDraft(modeScheduleDrafts, target.id, target.settings.modeSchedule);
  const scheduleRowKeys = getModeScheduleRowKeys(modeScheduleRowKeys, target.id, scheduleEntries);
  const scheduleIsDirty = JSON.stringify(scheduleEntries) !== JSON.stringify(target.settings.modeSchedule);

  useEffect(() => {
    setNicknames(target.settings.nicknames.join(', '));
    setGroupNote(target.settings.groupNote);
    setRateDraft(target.settings.rate);
    setContextMessagesDraft(target.settings.contextMessages);
    setProactiveCooldownDraft(String(target.settings.proactiveCooldownSec));
  }, [target.id, target.settings.nicknames, target.settings.groupNote, target.settings.rate, target.settings.contextMessages, target.settings.proactiveCooldownSec]);

  async function update(values: Record<string, unknown>) {
    try {
      await onPatch(target, values);
      await onRefresh(target);
      setSavedAt(new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date()));
    } catch (error) {
      onError(error);
    }
  }

  function restore(fields: SessionField[]) {
    void update(Object.fromEntries(fields.map((field) => [field, null])));
  }

  function replaceModeScheduleDrafts(drafts: ModeScheduleDrafts, storageError: string) {
    modeScheduleDraftsRef.current = drafts;
    setModeScheduleDrafts(drafts);
    setDraftPersistenceError(writeModeScheduleDraftSnapshot(drafts) ? '' : storageError);
  }

  function updateScheduleDraft(change: (entries: readonly ModeScheduleEntry[]) => ModeScheduleEntry[]) {
    replaceModeScheduleDrafts(changeModeScheduleDraft(
      modeScheduleDraftsRef.current,
      target.id,
      target.settings.modeSchedule,
      change,
    ), '当前标签页无法保留未提交的时段草稿；请点击“保存时段”。');
  }

  function addScheduleEntry() {
    const rowKey = `${target.id}:new:${nextScheduleRowKey.current++}`;
    updateScheduleDraft(addModeScheduleEntry);
    setModeScheduleRowKeys((rowKeys) => new Map(rowKeys).set(
      target.id,
      [...getModeScheduleRowKeys(rowKeys, target.id, scheduleEntries), rowKey],
    ));
  }

  function removeScheduleEntry(index: number) {
    updateScheduleDraft((entries) => removeModeScheduleEntry(entries, index));
    setModeScheduleRowKeys((rowKeys) => new Map(rowKeys).set(
      target.id,
      getModeScheduleRowKeys(rowKeys, target.id, scheduleEntries)
        .filter((_, currentIndex) => currentIndex !== index),
    ));
  }

  async function saveSchedule() {
    try {
      await saveModeScheduleDraft(
        () => onPatch(target, { modeSchedule: scheduleEntries }),
        () => replaceModeScheduleDrafts(
          discardModeScheduleDraft(modeScheduleDraftsRef.current, target.id),
          '时段已保存，但无法清理当前标签页的草稿副本。',
        ),
        () => onRefresh(target),
      );
      setSavedAt(new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date()));
    } catch (error) {
      onError(error);
    }
  }

  async function setRate(field: RateField, rawValue: string) {
    if (target.kind === 'global' && rawValue.trim() === '') {
      setRateDraft(target.settings.rate);
      return;
    }
    const value = rawValue.trim() === '' ? null : Number(rawValue);
    await update({ rate: { [field]: value } });
  }

  async function setRateLimit(rawValue: string) {
    if (target.kind === 'global' && rawValue.trim() === '') {
      setRateDraft(target.settings.rate);
      return;
    }
    const value = rawValue.trim() === '' ? null : Number(rawValue);
    await update({ rate: { perUserPerMinute: value, perSessionPerMinute: value } });
  }

  async function setProactiveCooldown(rawValue: string) {
    if (target.kind === 'global' && rawValue.trim() === '') {
      setProactiveCooldownDraft(String(target.settings.proactiveCooldownSec));
      return;
    }
    const value = rawValue.trim() === '' ? null : Number(rawValue);
    await update({ proactiveCooldownSec: value });
  }

  function changeRateDraft(field: RateField, value: number) {
    setRateDraft((rate) => ({ ...rate, [field]: value }));
  }

  function changeRateLimitDraft(value: number) {
    setRateDraft((rate) => ({ ...rate, perUserPerMinute: value, perSessionPerMinute: value }));
  }

  return (
    <>
      <div className="detail-title-row">
        <div>
          <div className="eyebrow">{target.kind === 'global' ? '所有会话' : target.kind === 'group' ? '群聊' : '好友'}</div>
          <h2>{target.name}</h2>
          {target.kind !== 'global' && <span className={`result-pill ${target.enabled ? 'result-positive' : 'result-neutral'}`}>{target.enabled ? '已启用' : '已停用'}</span>}
        </div>
        {target.kind !== 'global' && <button className={`switch switch-large ${target.enabled ? 'is-on' : ''}`} type="button" role="switch" aria-checked={target.enabled} aria-label="启用会话" disabled={busy} onClick={() => void update({ enabled: !target.enabled })}><span /></button>}
      </div>

      {target.kind === 'private'
        ? <SettingGroup className="private-mode-note"><p>私聊里每条消息都会回复。</p></SettingGroup>
        : <>
      <SettingGroup>
        <FieldHeading title="什么时候说话" fields={['mode']} target={target} onReset={restore} onNavigateToDefaults={onNavigateToDefaults} />
        <div className="mode-grid">
          {SESSION_MODE_OPTIONS.map((option) => (
            <button
              className={`mode-card ${target.settings.mode === option.mode ? 'is-current' : ''}`}
              key={option.mode}
              type="button"
              disabled={busy}
              onClick={() => void update({ mode: option.mode })}
            ><strong>{option.title}</strong><span>{option.note}</span></button>
          ))}
        </div>
      </SettingGroup>

      <SettingGroup>
        <FieldHeading title="在这里的话量" fields={['talkOffset']} target={target} onReset={restore} onNavigateToDefaults={onNavigateToDefaults} />
        <div className="field-label-row"><label className="field-label" htmlFor="session-talk-offset">调整这个会话里的话量</label><InfoTip label="话量设置说明" text="按人设底色叠加，群聊可单独覆盖全局默认；私聊不显示。" /></div>
        <select
          id="session-talk-offset"
          className="talk-offset-select"
          value={target.settings.talkOffset}
          disabled={busy}
          onChange={(event) => void update({ talkOffset: Number(event.currentTarget.value) })}
        >
          <option value={-2}>更安静 −2</option>
          <option value={-1}>−1</option>
          <option value={0}>不变 0</option>
          <option value={1}>+1</option>
          <option value={2}>更话痨 +2</option>
        </select>
      </SettingGroup>

      <SettingGroup>
        <FieldHeading title="按时间段切换" help="按列表顺序首个匹配项生效，支持跨午夜；没有匹配时使用上方默认模式。未提交草稿会在当前标签页刷新后保留，点击“保存时段”才写入配置。" fields={['modeSchedule']} target={target} onReset={restore} onNavigateToDefaults={onNavigateToDefaults} />
        {draftPersistenceError && <p className="schedule-help" role="alert">{draftPersistenceError}</p>}
        {scheduleEntries.length > 0
          ? <div className="schedule-list">
            {scheduleEntries.map((entry, index) => (
              <div className="schedule-row" key={scheduleRowKeys[index]}>
                <label>
                  <span>开始</span>
                  <input type="time" value={entry.from} aria-label={`第 ${index + 1} 个时段开始时间`} disabled={busy} onChange={(event) => updateScheduleDraft(createModeScheduleEntryChangeFromInput(event, index, 'from'))} />
                </label>
                <label>
                  <span>结束</span>
                  <input type="time" value={entry.to} aria-label={`第 ${index + 1} 个时段结束时间`} disabled={busy} onChange={(event) => updateScheduleDraft(createModeScheduleEntryChangeFromInput(event, index, 'to'))} />
                </label>
                <label className="schedule-mode">
                  <span>模式</span>
                  <select value={entry.mode} aria-label={`第 ${index + 1} 个时段模式`} disabled={busy} onChange={(event) => updateScheduleDraft(createModeScheduleEntryChangeFromInput(event, index, 'mode'))}>
                    {SESSION_MODE_OPTIONS.map((option) => <option value={option.mode} key={option.mode}>{option.title}</option>)}
                  </select>
                </label>
                <button className="text-button schedule-remove" type="button" aria-label={`删除第 ${index + 1} 个时段`} disabled={busy} onClick={() => removeScheduleEntry(index)}>删除</button>
              </div>
            ))}
          </div>
          : <p className="empty-state schedule-empty">尚未设置时段，将始终使用上方默认模式。</p>}
        <div className="schedule-actions">
          <button className="text-button" type="button" disabled={busy} onClick={addScheduleEntry}>添加时段</button>
          <div>
            {scheduleIsDirty && <span className="schedule-dirty" role="status">有未保存改动</span>}
            <button className="button button-secondary" type="button" disabled={busy || !scheduleIsDirty} onClick={() => void saveSchedule()}>保存时段</button>
          </div>
        </div>
      </SettingGroup>
      </>}

      {target.kind !== 'private' && <SettingGroup>
        <FieldHeading title="叫它的名字" fields={['nicknames']} target={target} onReset={restore} onNavigateToDefaults={onNavigateToDefaults} />
        <label className="field-label" htmlFor="session-nicknames">多个名字用逗号分开</label>
        <input id="session-nicknames" value={nicknames} onChange={(event) => setNicknames(event.currentTarget.value)} onBlur={() => void update({ nicknames: nicknames.split(',').map((name) => name.trim()).filter(Boolean) })} />
      </SettingGroup>}

      <SettingGroup>
        <FieldHeading title={target.kind === 'private' ? '对这个人的补充说明' : '在这个群里的补充说明'} fields={['groupNote']} target={target} onReset={restore} onNavigateToDefaults={onNavigateToDefaults} />
        <textarea rows={3} value={groupNote} onChange={(event) => setGroupNote(event.currentTarget.value)} onBlur={() => void update({ groupNote })} aria-label="会话补充说明" />
      </SettingGroup>

      <SettingGroup>
        <FieldHeading title="频率与上下文" fields={['rate', 'contextMessages']} target={target} onReset={restore} onNavigateToDefaults={onNavigateToDefaults} />
        <div className="number-grid">
          {target.kind === 'private'
            ? <label><span>每分钟最多</span><input type="number" min="1" value={rateDraft.perUserPerMinute} disabled={busy} onBlur={(event) => void setRateLimit(event.currentTarget.value)} onChange={(event) => changeRateLimitDraft(Number(event.currentTarget.value))} /></label>
            : <>
              <label><span>{target.kind === 'global' ? '每个用户每分钟最多' : '每人每分钟最多'}</span><input type="number" min="1" value={rateDraft.perUserPerMinute} disabled={busy} onBlur={(event) => void setRate('perUserPerMinute', event.currentTarget.value)} onChange={(event) => changeRateDraft('perUserPerMinute', Number(event.currentTarget.value))} /></label>
              <label><span>{target.kind === 'global' ? '每个会话每分钟最多' : '整个群每分钟最多'}</span><input type="number" min="1" value={rateDraft.perSessionPerMinute} disabled={busy} onBlur={(event) => void setRate('perSessionPerMinute', event.currentTarget.value)} onChange={(event) => changeRateDraft('perSessionPerMinute', Number(event.currentTarget.value))} /></label>
            </>}
          <label><span>两次回复至少间隔（秒）</span><input type="number" min="0.1" step="0.1" value={rateDraft.minIntervalSec} disabled={busy} onBlur={(event) => void setRate('minIntervalSec', event.currentTarget.value)} onChange={(event) => changeRateDraft('minIntervalSec', Number(event.currentTarget.value))} /></label>
          <label><span>{target.kind === 'group' ? '参考最近几条' : '回复时参考最近几条'}</span><input type="number" min="1" value={contextMessagesDraft} disabled={busy} onBlur={() => void update({ contextMessages: Number(contextMessagesDraft) })} onChange={(event) => setContextMessagesDraft(Number(event.currentTarget.value))} /></label>
        </div>
      </SettingGroup>
      {target.kind !== 'private' && <SettingGroup>
        <FieldHeading title="主动回复冷却" help="范围 0–3600 秒；设为 0 可关闭主动冷却，现有频率限制仍生效。" fields={['proactiveCooldownSec']} target={target} onReset={restore} onNavigateToDefaults={onNavigateToDefaults} />
        <div className="number-grid">
          <label><span>两次主动回复至少间隔（秒）</span><input type="number" min="0" max="3600" step="1" value={proactiveCooldownDraft} disabled={busy} onBlur={(event) => void setProactiveCooldown(event.currentTarget.value)} onChange={(event) => setProactiveCooldownDraft(event.currentTarget.value)} /></label>
        </div>
      </SettingGroup>}
      <div className="save-state" aria-live="polite">{busy ? '正在保存…' : scheduleIsDirty ? '时间段尚未写入配置' : savedAt ? `已保存 · ${savedAt}` : '其他设置自动保存；时间段需点击“保存时段”'}</div>
    </>
  );
}
