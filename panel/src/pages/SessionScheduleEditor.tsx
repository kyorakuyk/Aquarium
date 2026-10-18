import { useEffect, useRef, useState } from 'react';
import type { ModeScheduleEntry } from '../api.ts';
import { PersistedDetails } from '../components/PersistedDetails.tsx';
import {
  addModeScheduleEntry,
  changeModeScheduleDraft,
  createModeScheduleEntryChangeFromInput,
  discardModeScheduleDraft,
  getModeScheduleDraft,
  getModeScheduleRowKeys,
  modeScheduleSummary,
  modeScheduleTimeline,
  readModeScheduleDrafts,
  removeModeScheduleEntry,
  saveModeScheduleDraft,
  SESSION_MODE_OPTIONS,
  writeModeScheduleDrafts,
  type ModeScheduleDrafts,
  type ModeScheduleRowKeys,
} from '../session-mode.ts';
import { SessionFieldHeading } from './SessionFieldHeading.tsx';
import type { SessionSettingsTarget } from './SessionSettingsPanel.tsx';

const DRAFT_STORAGE_ERROR = '当前标签页无法保留未提交的时段草稿；请在关闭前点“完成”保存。';

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

export function SessionScheduleEditor({
  target,
  busy,
  onPatch,
  onRefresh,
  onError,
  onRestore,
  onDirtyChange,
  onSaved,
}: {
  target: SessionSettingsTarget;
  busy: boolean;
  onPatch: (target: SessionSettingsTarget, values: Record<string, unknown>) => Promise<void>;
  onRefresh: (target: SessionSettingsTarget) => Promise<void>;
  onError: (error: unknown) => void;
  onRestore: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: () => void;
}) {
  const [drafts, setDrafts] = useState<ModeScheduleDrafts>(readModeScheduleDraftSnapshot);
  const draftsRef = useRef(drafts);
  const [rowKeys, setRowKeys] = useState<ModeScheduleRowKeys>(() => new Map());
  const [draftPersistenceError, setDraftPersistenceError] = useState('');
  const nextRowKey = useRef(0);
  const dialogRef = useRef<HTMLDialogElement>(null);

  const entries = getModeScheduleDraft(drafts, target.id, target.settings.modeSchedule);
  const entryKeys = getModeScheduleRowKeys(rowKeys, target.id, entries);
  const dirty = JSON.stringify(entries) !== JSON.stringify(target.settings.modeSchedule);
  const summary = modeScheduleSummary(entries, target.settings.mode);
  const timeline = modeScheduleTimeline(entries, target.settings.mode);

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  function replaceDrafts(next: ModeScheduleDrafts, storageError: string) {
    draftsRef.current = next;
    setDrafts(next);
    setDraftPersistenceError(writeModeScheduleDraftSnapshot(next) ? '' : storageError);
  }

  function updateDraft(change: (current: readonly ModeScheduleEntry[]) => ModeScheduleEntry[]) {
    replaceDrafts(changeModeScheduleDraft(
      draftsRef.current,
      target.id,
      target.settings.modeSchedule,
      change,
    ), DRAFT_STORAGE_ERROR);
  }

  function addEntry() {
    const nextKeys = [...getModeScheduleRowKeys(rowKeys, target.id, entries), `${target.id}:new:${nextRowKey.current++}`];
    updateDraft(addModeScheduleEntry);
    setRowKeys((current) => new Map(current).set(target.id, nextKeys));
  }

  function removeEntry(index: number) {
    updateDraft((current) => removeModeScheduleEntry(current, index));
    setRowKeys((current) => new Map(current).set(
      target.id,
      getModeScheduleRowKeys(current, target.id, entries).filter((_, currentIndex) => currentIndex !== index),
    ));
  }

  async function saveSchedule(): Promise<boolean> {
    try {
      await saveModeScheduleDraft(
        () => onPatch(target, { modeSchedule: entries }),
        () => replaceDrafts(discardModeScheduleDraft(draftsRef.current, target.id), '时段已保存，但无法清理当前标签页的草稿副本。'),
        () => onRefresh(target),
      );
      onSaved();
      return true;
    } catch (error) {
      onError(error);
      return false;
    }
  }

  function openEditor() {
    dialogRef.current?.showModal();
  }

  async function finishEditing() {
    if (await saveSchedule()) dialogRef.current?.close();
  }

  return (
    <>
      <div className="session-details-row">
        <SessionFieldHeading
          title="时间表"
          help="按列表顺序首个匹配项生效，支持跨午夜；未保存的草稿保存在当前标签页，点“完成”才写入配置。"
          kind={target.kind}
          overridden={target.overrides.includes('modeSchedule')}
          onRestore={onRestore}
        />
        <PersistedDetails
          className="session-persisted-details"
          sessionId={target.id}
          section="schedule"
          summary={<span className="details-summary-copy">{summary}</span>}
        >
          <div className="schedule-details-content">
            <div className="schedule-timeline" role="img" aria-label="全天 24 小时时段模式分布">
              {timeline.map((segment) => <span
                className="schedule-segment"
                data-mode={segment.mode}
                key={`${segment.startMinute}:${segment.endMinute}:${segment.mode}`}
                title={`${String(Math.floor(segment.startMinute / 60)).padStart(2, '0')}:${String(segment.startMinute % 60).padStart(2, '0')}–${String(Math.floor(segment.endMinute / 60)).padStart(2, '0')}:${String(segment.endMinute % 60).padStart(2, '0')} ${SESSION_MODE_OPTIONS.find((option) => option.mode === segment.mode)?.title ?? segment.mode}`}
                style={{ width: `${((segment.endMinute - segment.startMinute) / 1440) * 100}%` }}
              />)}
            </div>
            <div className="schedule-timeline-labels mono"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span></div>
            <div className="mode-legend" aria-label="模式图例">
              {SESSION_MODE_OPTIONS.map((option) => <span className="mode-legend-item" key={option.mode}><i data-mode={option.mode} />{option.title}</span>)}
            </div>
            {draftPersistenceError && <p className="schedule-help" role="alert">{draftPersistenceError}</p>}
            <button className="button button-secondary schedule-edit-button" type="button" onClick={openEditor}>编辑时段</button>
          </div>
        </PersistedDetails>
      </div>

      <dialog className="schedule-dialog" ref={dialogRef} aria-labelledby="schedule-dialog-title">
        <div className="schedule-dialog-heading"><h3 id="schedule-dialog-title">编辑时间段</h3><button className="text-button" type="button" onClick={() => dialogRef.current?.close()}>关闭</button></div>
        {draftPersistenceError && <p className="notice notice-warn" role="alert">{draftPersistenceError}</p>}
        {entries.length > 0
          ? <div className="schedule-list">
            {entries.map((entry, index) => <div className="schedule-row" key={entryKeys[index]}>
              <label><span>开始</span><input type="time" value={entry.from} aria-label={`第 ${index + 1} 个时段开始时间`} disabled={busy} onChange={(event) => updateDraft(createModeScheduleEntryChangeFromInput(event, index, 'from'))} /></label>
              <label><span>结束</span><input type="time" value={entry.to} aria-label={`第 ${index + 1} 个时段结束时间`} disabled={busy} onChange={(event) => updateDraft(createModeScheduleEntryChangeFromInput(event, index, 'to'))} /></label>
              <label className="schedule-mode"><span>模式</span><select value={entry.mode} aria-label={`第 ${index + 1} 个时段模式`} disabled={busy} onChange={(event) => updateDraft(createModeScheduleEntryChangeFromInput(event, index, 'mode'))}>{SESSION_MODE_OPTIONS.map((option) => <option value={option.mode} key={option.mode}>{option.title}</option>)}</select></label>
              <button className="text-button schedule-remove" type="button" aria-label={`删除第 ${index + 1} 个时段`} disabled={busy} onClick={() => removeEntry(index)}>删除</button>
            </div>)}
          </div>
          : <p className="empty-state schedule-empty">尚未设置时段，将始终使用上方默认模式。</p>}
        <div className="schedule-dialog-footer">
          <button className="text-button" type="button" disabled={busy} onClick={addEntry}>添加时段</button>
          <div><button className="button button-secondary" type="button" disabled={busy} onClick={() => dialogRef.current?.close()}>取消</button><button className="button button-primary" type="button" disabled={busy} onClick={() => void finishEditing()}>{busy ? '保存中…' : '完成'}</button></div>
        </div>
      </dialog>
    </>
  );
}
