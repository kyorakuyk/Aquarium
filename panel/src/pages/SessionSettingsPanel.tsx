import { useEffect, useState, type ReactNode } from 'react';
import type { DefaultsView, SessionSettings, SessionView } from '../api.ts';
import { PersistedDetails } from '../components/PersistedDetails.tsx';
import { SESSION_MODE_OPTIONS } from '../session-mode.ts';
import { formatSavedAt } from '../panel-feedback.ts';
import { sessionNoteSummary, sessionSettingsPanelCopy } from '../session-settings-copy.ts';
import { SessionFieldHeading } from './SessionFieldHeading.tsx';
import { SessionScheduleEditor } from './SessionScheduleEditor.tsx';
import { InnerVoiceModeSelect } from '../components/InnerVoiceModeSelect.tsx';

export const GLOBAL_DEFAULT_ID = '__global-defaults__';

type SessionField = 'enabled' | 'mode' | 'modeSchedule' | 'nicknames' | 'contextMessages' | 'proactiveCooldownSec' | 'talkOffset' | 'rate' | 'groupNote' | 'innerVoice';
type RateField = keyof SessionSettings['rate'];

export interface SessionSettingsTarget {
  id: string;
  name: string;
  kind: 'global' | 'group' | 'private';
  memberCount?: number;
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
}

function SettingGroup({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`setting-group ${className}`}>{children}</section>;
}

export function createSessionSettingsTarget(session: SessionView): SessionSettingsTarget {
  return {
    id: session.sessionId,
    name: session.name,
    kind: session.kind,
    memberCount: session.memberCount,
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
}: SessionSettingsPanelProps) {
  const [nicknames, setNicknames] = useState(target.settings.nicknames);
  const [nicknameDraft, setNicknameDraft] = useState('');
  const [nicknameInputOpen, setNicknameInputOpen] = useState(false);
  const [talkOffsetDraft, setTalkOffsetDraft] = useState(target.settings.talkOffset);
  const [groupNote, setGroupNote] = useState(target.settings.groupNote);
  const [rateDraft, setRateDraft] = useState(target.settings.rate);
  const [contextMessagesDraft, setContextMessagesDraft] = useState(target.settings.contextMessages);
  const [proactiveCooldownDraft, setProactiveCooldownDraft] = useState(String(target.settings.proactiveCooldownSec));
  const [savedAt, setSavedAt] = useState('');
  const [scheduleIsDirty, setScheduleIsDirty] = useState(false);
  const restoreFields: SessionField[] = ['enabled', 'mode', 'modeSchedule', 'nicknames', 'contextMessages', 'proactiveCooldownSec', 'talkOffset', 'rate', 'groupNote', 'innerVoice'];

  useEffect(() => {
    setNicknames(target.settings.nicknames);
    setTalkOffsetDraft(target.settings.talkOffset);
    setGroupNote(target.settings.groupNote);
    setRateDraft(target.settings.rate);
    setContextMessagesDraft(target.settings.contextMessages);
    setProactiveCooldownDraft(String(target.settings.proactiveCooldownSec));
  }, [target.id, target.settings.nicknames, target.settings.talkOffset, target.settings.groupNote, target.settings.rate, target.settings.contextMessages, target.settings.proactiveCooldownSec]);

  async function update(values: Record<string, unknown>): Promise<boolean> {
    try {
      await onPatch(target, values);
      await onRefresh(target);
      setSavedAt(formatSavedAt(new Date()));
      return true;
    } catch (error) {
      onError(error);
      return false;
    }
  }

  function restore(fields: SessionField[]) {
    void update(Object.fromEntries(fields.map((field) => [field, null])));
  }

  function restoreAll() {
    void update(Object.fromEntries(restoreFields.map((field) => [field, null])));
  }

  function commitTalkOffset() {
    if (talkOffsetDraft !== target.settings.talkOffset) void update({ talkOffset: talkOffsetDraft });
  }

  function heading(title: string, fields: SessionField[], help?: string) {
    return <SessionFieldHeading
      title={title}
      help={help}
      kind={target.kind}
      overridden={fields.some((field) => target.overrides.includes(field))}
      onRestore={() => restore(fields)}
    />;
  }

  async function addNickname() {
    const nickname = nicknameDraft.trim();
    if (!nickname) return;
    if (await update({ nicknames: [...nicknames, nickname] })) {
      setNicknameDraft('');
      setNicknameInputOpen(false);
    }
  }

  async function removeNickname(index: number) {
    await update({ nicknames: nicknames.filter((_, currentIndex) => currentIndex !== index) });
  }

  function noteSummary(): string {
    return sessionNoteSummary(groupNote, target.kind, target.overrides.includes('groupNote'));
  }

  function rateSummary(): string {
    if (target.kind === 'private') {
      return `每人 ${rateDraft.perUserPerMinute}/分 · 间隔 ${rateDraft.minIntervalSec} 秒 · 参考 ${contextMessagesDraft} 条`;
    }
    return `每人 ${rateDraft.perUserPerMinute}/分 · 全群 ${rateDraft.perSessionPerMinute}/分 · 间隔 ${rateDraft.minIntervalSec} 秒 · 主动冷却 ${proactiveCooldownDraft} 秒 · 参考 ${contextMessagesDraft} 条`;
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

  const selectedMode = SESSION_MODE_OPTIONS.find((option) => option.mode === target.settings.mode);
  const copy = sessionSettingsPanelCopy(target.kind, target.id, target.memberCount);

  return (
    <>
      <div className="detail-title-row">
        <div className="detail-title-main">
          <span className="detail-avatar">{Array.from(target.name)[0] ?? '全'}</span>
          <div className="detail-title-copy">
            {copy.eyebrow && <div className="eyebrow">{copy.eyebrow}</div>}
            <h2>{target.name}</h2>
            {copy.identifier && <span className="mono muted">{copy.identifier}</span>}
          </div>
        </div>
        <div className="detail-title-actions">
          {target.kind !== 'global' && <button className="inherit-button" type="button" disabled={busy || target.overrides.length === 0} onClick={restoreAll}>恢复全部继承</button>}
          {target.kind !== 'global' && <button className={`switch switch-large ${target.enabled ? 'is-on' : ''}`} type="button" role="switch" aria-checked={target.enabled} aria-label="启用会话" disabled={busy} onClick={() => void update({ enabled: !target.enabled })}><span /></button>}
        </div>
      </div>

      {target.kind === 'private'
        ? <SettingGroup className="private-mode-note"><p>私聊里每条消息都会回复。</p></SettingGroup>
        : <>
          <SettingGroup>
            {heading('什么时候说话', ['mode'])}
            <div className="mode-segmented" role="group" aria-label="什么时候说话">
              {SESSION_MODE_OPTIONS.map((option) => <button
                className={target.settings.mode === option.mode ? 'is-current' : ''}
                key={option.mode}
                type="button"
                disabled={busy}
                aria-pressed={target.settings.mode === option.mode}
                onClick={() => void update({ mode: option.mode })}
              >{option.title}</button>)}
            </div>
            <p className="mode-description">{selectedMode?.note}</p>
          </SettingGroup>

          <SettingGroup>
            {heading('在这里的话量', ['talkOffset'], '群聊可单独覆盖全局默认；私聊不显示。')}
            <input className="talk-offset-slider" id="session-talk-offset" type="range" min={-2} max={2} step={1} value={talkOffsetDraft} disabled={busy} aria-label="在这里的话量" onChange={(event) => setTalkOffsetDraft(Number(event.currentTarget.value))} onPointerUp={commitTalkOffset} onKeyUp={commitTalkOffset} onBlur={commitTalkOffset} />
            <div className="talk-offset-labels"><span>更安静</span><span>不变</span><span>更话痨</span></div>
          </SettingGroup>

          <SettingGroup>
            <SessionScheduleEditor
              target={target}
              busy={busy}
              onPatch={onPatch}
              onRefresh={onRefresh}
              onError={onError}
              onRestore={() => restore(['modeSchedule'])}
              onDirtyChange={setScheduleIsDirty}
              onSaved={() => setSavedAt(formatSavedAt(new Date()))}
            />
          </SettingGroup>

          <SettingGroup>
            {heading(copy.nicknameTitle, ['nicknames'])}
            <div className="nickname-tags">
              {nicknames.map((nickname, index) => <span className="nickname-chip" key={`${index}:${nickname}`}>
                <span>{nickname}</span>
                <button type="button" aria-label={`删除名字 ${nickname}`} disabled={busy} onClick={() => void removeNickname(index)}>×</button>
              </span>)}
              {nicknameInputOpen
                ? <div className="nickname-add-editor">
                  <input autoFocus value={nicknameDraft} aria-label="输入要添加的名字" disabled={busy} onChange={(event) => setNicknameDraft(event.currentTarget.value)} onKeyDown={(event) => {
                    if (event.key === 'Enter') { event.preventDefault(); void addNickname(); }
                    if (event.key === 'Escape') { setNicknameDraft(''); setNicknameInputOpen(false); }
                  }} />
                  <button className="button button-primary" type="button" disabled={busy || !nicknameDraft.trim()} onClick={() => void addNickname()}>添加</button>
                  <button className="text-button" type="button" disabled={busy} onClick={() => { setNicknameDraft(''); setNicknameInputOpen(false); }}>取消</button>
                </div>
                : <button className="nickname-add-button" type="button" aria-label="添加名字" title="添加名字" disabled={busy} onClick={() => setNicknameInputOpen(true)}>＋</button>}
            </div>
          </SettingGroup>
        </>}

      {target.kind !== 'global' && <SettingGroup>
        {heading('括号心声', ['innerVoice'], '默认跟随当前人设，也可以在本会话单独覆盖。')}
        <InnerVoiceModeSelect
          id="session-inner-voice"
          value={target.settings.innerVoice ?? 'inherit'}
          allowInherit
          disabled={busy}
          className="session-inner-voice-select"
          ariaLabel="括号心声"
          onChange={(value) => void update({ innerVoice: value === 'inherit' ? null : value })}
        />
        <p className="mode-description">完整会把一段旁白单独发出；轻量只留一个短动作；隐藏不发送括号内容。</p>
      </SettingGroup>}

      <SettingGroup>
        <div className="session-details-row">
          {heading(copy.noteTitle, ['groupNote'])}
          <PersistedDetails className="session-persisted-details" sessionId={target.id} section="note" summary={<span className="details-summary-copy">{noteSummary()}</span>}>
            <textarea rows={3} value={groupNote} onChange={(event) => setGroupNote(event.currentTarget.value)} onBlur={() => void update({ groupNote })} aria-label={copy.noteTitle} />
          </PersistedDetails>
        </div>
      </SettingGroup>

      <SettingGroup>
        <div className="session-details-row">
          {heading('节奏与限制', target.kind === 'private' ? ['rate', 'contextMessages'] : ['rate', 'contextMessages', 'proactiveCooldownSec'], '主动冷却设为 0 可关闭主动冷却；常规频率限制仍生效。')}
          <PersistedDetails className="session-persisted-details" sessionId={target.id} section="rhythm" summary={<span className="details-summary-copy">{rateSummary()}</span>}>
            <div className="number-grid">
              {target.kind === 'private'
                ? <label><span>每分钟最多</span><input type="number" min="1" value={rateDraft.perUserPerMinute} disabled={busy} onBlur={(event) => void setRateLimit(event.currentTarget.value)} onChange={(event) => changeRateLimitDraft(Number(event.currentTarget.value))} /></label>
                : <>
                  <label><span>每人每分钟最多</span><input type="number" min="1" value={rateDraft.perUserPerMinute} disabled={busy} onBlur={(event) => void setRate('perUserPerMinute', event.currentTarget.value)} onChange={(event) => changeRateDraft('perUserPerMinute', Number(event.currentTarget.value))} /></label>
                  <label><span>整个群每分钟最多</span><input type="number" min="1" value={rateDraft.perSessionPerMinute} disabled={busy} onBlur={(event) => void setRate('perSessionPerMinute', event.currentTarget.value)} onChange={(event) => changeRateDraft('perSessionPerMinute', Number(event.currentTarget.value))} /></label>
                </>}
              <label><span>两次回复至少间隔（秒）</span><input type="number" min="0.1" step="0.1" value={rateDraft.minIntervalSec} disabled={busy} onBlur={(event) => void setRate('minIntervalSec', event.currentTarget.value)} onChange={(event) => changeRateDraft('minIntervalSec', Number(event.currentTarget.value))} /></label>
              <label><span>{target.kind === 'group' ? '参考最近几条' : '回复时参考最近几条'}</span><input type="number" min="1" value={contextMessagesDraft} disabled={busy} onBlur={() => void update({ contextMessages: Number(contextMessagesDraft) })} onChange={(event) => setContextMessagesDraft(Number(event.currentTarget.value))} /></label>
              {target.kind !== 'private' && <label><span>主动回复至少间隔（秒）</span><input type="number" min="0" max="3600" step="1" value={proactiveCooldownDraft} disabled={busy} onBlur={(event) => void setProactiveCooldown(event.currentTarget.value)} onChange={(event) => setProactiveCooldownDraft(event.currentTarget.value)} /></label>}
            </div>
          </PersistedDetails>
        </div>
      </SettingGroup>
      <div className="save-state" aria-live="polite">{busy ? '正在保存…' : scheduleIsDirty ? '时间段尚未完成保存' : savedAt ? `改动立刻生效 · ${savedAt} 已保存` : '改动立刻生效；时间段在“编辑时段”中点“完成”保存'}</div>
    </>
  );
}
