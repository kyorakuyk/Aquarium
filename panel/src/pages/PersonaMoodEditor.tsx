import { useEffect, useMemo, useRef, useState } from 'react';
import { apiRequest, type MoodView } from '../api.ts';
import {
  buildEmotionLibrary,
  defaultEmotionEdge,
  resolveConfiguredMoodEmotions,
  type PadEmotion,
} from '../../../src/core/mood/emotions.ts';
import {
  DEFAULT_PERSONA_MOOD,
  PersonaMoodSchema,
  type PersonaMoodSettings,
} from '../../../src/persona/mood.ts';
import type { PersonaSectionsForm } from '../persona-sections.ts';
import {
  moodOutgoingTargets,
  resolveMoodEdge,
  selectMoodEdge,
  selectMoodSource,
  updateMoodCoordinate,
  updateMoodEdgeSetting,
  withPersonaMoodSettings,
  type EmotionEdgeSetting,
  type MoodEdgeSelection,
} from './persona-mood-utils.ts';
import { PersonaMoodEdgeMatrix } from './PersonaMoodEdgeMatrix.tsx';
import { PersonaMoodGraph } from './PersonaMoodGraph.tsx';
import {
  PersonaMoodLibraryCard,
  PersonaMoodOtherCard,
  PersonaMoodSubSettingsCard,
  SettingsRange,
} from './PersonaMoodCards.tsx';

interface MoodPreview {
  account: number;
  valence: number;
  arousal: number;
  dominance: number;
}

const DEFAULT_GLOBAL_MOOD_SETTINGS: MoodView['settings'] = {
  surfaceHalfLifeMin: 40,
  arousalHalfLifeMin: 40,
  baseline: { valence: 0.1, arousal: 0.4 },
  senderHourlyCap: 0.8,
};

function parseSettings(form: PersonaSectionsForm) {
  return PersonaMoodSchema.safeParse(form.metadata.mood ?? {});
}

function moodSettingsAreValid(settings: MoodView['settings']): boolean {
  return Number.isFinite(settings.surfaceHalfLifeMin) && settings.surfaceHalfLifeMin > 0
    && Number.isFinite(settings.arousalHalfLifeMin) && settings.arousalHalfLifeMin > 0
    && Number.isFinite(settings.baseline.valence) && settings.baseline.valence >= -1 && settings.baseline.valence <= 1
    && Number.isFinite(settings.baseline.arousal) && settings.baseline.arousal >= 0 && settings.baseline.arousal <= 1
    && Number.isFinite(settings.senderHourlyCap) && settings.senderHourlyCap >= 0;
}

function moodPreviewIsValid(value: MoodView, account: number): boolean {
  return value.account === account
    && Number.isFinite(value.valence) && value.valence >= -1 && value.valence <= 1
    && Number.isFinite(value.arousal) && value.arousal >= 0 && value.arousal <= 1
    && Number.isFinite(value.dominance) && value.dominance >= -1 && value.dominance <= 1
    && moodSettingsAreValid(value.settings);
}

function coordinateLabel(emotion: PadEmotion | undefined): string {
  if (!emotion) return '—';
  return `V ${emotion.valence.toFixed(2)} · A ${emotion.arousal.toFixed(2)} · D ${emotion.dominance.toFixed(2)}`;
}

export function PersonaMoodEditor({
  form,
  onChange,
  previewAccountId,
  disabled,
}: {
  form: PersonaSectionsForm;
  onChange: (form: PersonaSectionsForm) => void;
  previewAccountId: number | null;
  disabled: boolean;
}) {
  const parsed = useMemo(() => parseSettings(form), [form.metadata.mood]);
  const settings = parsed.success ? parsed.data : DEFAULT_PERSONA_MOOD;
  const [message, setMessage] = useState('');
  const [preview, setPreview] = useState<MoodPreview | null>(null);
  const [globalMoodSettings, setGlobalMoodSettings] = useState(DEFAULT_GLOBAL_MOOD_SETTINGS);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const edgeEditorRef = useRef<HTMLDivElement>(null);
  const emotionSignature = settings.emotions.join('\u0000');
  const [selection, setSelection] = useState<MoodEdgeSelection>(() => ({
    from: settings.emotions[0] ?? '',
    to: settings.emotions[1] ?? settings.emotions[0] ?? '',
  }));

  useEffect(() => {
    setSelection((current) => {
      if (settings.emotions.includes(current.from) && settings.emotions.includes(current.to) && current.from !== current.to) return current;
      const from = settings.emotions[0] ?? '';
      return { from, to: settings.emotions.find((name) => name !== from) ?? from };
    });
  }, [emotionSignature]);

  useEffect(() => {
    let active = true;
    if (previewAccountId === null) {
      setPreview(null);
      setPreviewError('');
      setPreviewBusy(true);
      void apiRequest<MoodView>('/api/mood')
        .then((value) => {
          if (!active) return;
          if (moodSettingsAreValid(value.settings)) setGlobalMoodSettings(value.settings);
          else setPreviewError('返回的全局心情设置无效。');
        })
        .catch((error: unknown) => {
          if (active) setPreviewError(error instanceof Error ? error.message : '读取全局心情设置失败');
        })
        .finally(() => { if (active) setPreviewBusy(false); });
      return () => { active = false; };
    }
    setPreview(null);
    setPreviewError('');
    setPreviewBusy(true);
    void apiRequest<MoodView>(`/api/mood?account=${previewAccountId}`)
      .then((value) => {
        if (!active) return;
        if (moodPreviewIsValid(value, previewAccountId)) {
          setPreview({
            account: value.account,
            valence: value.valence,
            arousal: value.arousal,
            dominance: value.dominance,
          });
          setGlobalMoodSettings(value.settings);
        } else setPreviewError('返回的预览账号或心情坐标无效，请重新读取。');
      })
      .catch((error: unknown) => {
        if (active) setPreviewError(error instanceof Error ? error.message : '读取当前心情失败');
      })
      .finally(() => { if (active) setPreviewBusy(false); });
    return () => { active = false; };
  }, [previewAccountId]);

  function commit(next: PersonaMoodSettings) {
    if (disabled || !parsed.success) return;
    onChange(withPersonaMoodSettings(form, next));
    setMessage('');
  }

  function changeSelectionFrom(from: string) {
    setSelection((current) => selectMoodSource(current, from, settings.emotions));
  }

  function changeSelectionTo(from: string, to: string) {
    setSelection((current) => selectMoodEdge(current, from, to, settings.emotions));
  }

  function changeEdge(key: EmotionEdgeSetting, value: number | boolean) {
    if (disabled || selection.from === selection.to) return;
    try {
      const next = key === 'jump'
        ? updateMoodEdgeSetting(settings, selection.from, selection.to, 'jump', value === true)
        : updateMoodEdgeSetting(settings, selection.from, selection.to, key, Number(value));
      commit(next);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存切换设置失败');
    }
  }

  function resetEdge() {
    if (disabled || selection.from === selection.to) return;
    const library = buildEmotionLibrary(settings.emotions, settings.coordinates);
    const source = library.find((emotion) => emotion.name === selection.from);
    const target = library.find((emotion) => emotion.name === selection.to);
    if (!source || !target) return;
    const edge = defaultEmotionEdge(source, target);
    const reset = updateMoodEdgeSetting(
      updateMoodEdgeSetting(
        updateMoodEdgeSetting(settings, selection.from, selection.to, 'margin', edge.margin),
        selection.from,
        selection.to,
        'dwell',
        edge.dwell,
      ),
      selection.from,
      selection.to,
      'jump',
      edge.jump,
    );
    commit(reset);
  }

  function changeCoordinates(name: string, valence: number, arousal: number) {
    const next = updateMoodCoordinate(
      updateMoodCoordinate(settings, name, 'valence', valence),
      name,
      'arousal',
      arousal,
    );
    commit(next);
  }

  const library = useMemo(
    () => buildEmotionLibrary(settings.emotions, settings.coordinates),
    [settings.emotions, settings.coordinates],
  );
  const selectedSource = library.find((emotion) => emotion.name === selection.from);
  const selectedTarget = library.find((emotion) => emotion.name === selection.to);
  const selectedEdge = selectedSource && selectedTarget && selectedSource.name !== selectedTarget.name
    ? resolveMoodEdge(settings, selection.from, selection.to)
    : null;
  const selectedPreview = preview?.account === previewAccountId ? preview : null;
  const emotionExample = resolveConfiguredMoodEmotions({
    state: selectedPreview ?? {
      valence: globalMoodSettings.baseline.valence,
      arousal: globalMoodSettings.baseline.arousal,
      dominance: 0,
    },
    settings,
    currentEmotion: null,
    emotionSince: null,
    lastEmotionChangeAt: null,
    now: Date.now(),
    messageId: 'persona-mood-preview',
  });


  return (
    <div className="persona-mood-editor">
      {!parsed.success && <p className="persona-mood-error" role="alert">人设 mood 配置无效，请在源文件中修复后再编辑。</p>}
      {message && <p className="persona-mood-message" role="status">{message}</p>}

      <PersonaMoodLibraryCard settings={settings} disabled={disabled || !parsed.success} onChange={commit} />

      <section className="persona-form-card persona-mood-card" aria-labelledby="persona-mood-graph-title">
        <header className="persona-mood-card-heading">
          <div><h3 id="persona-mood-graph-title">切换难度</h3><p>点一个情绪查看它的出边；拖动情绪点可调整愉悦度与唤醒度。</p></div>
          <span className="muted">愉悦 V × 唤醒 A</span>
        </header>
        <PersonaMoodGraph
          settings={settings}
          selectedFrom={selection.from}
          selectedTo={selection.to}
          onSelectFrom={changeSelectionFrom}
          onSelectTo={(to) => changeSelectionTo(selection.from, to)}
          onCoordinatesChange={changeCoordinates}
          disabled={disabled || !parsed.success}
        />
        {selectedEdge && selectedSource && selectedTarget ? (
          <div className="persona-mood-edge-editor" ref={edgeEditorRef}>
            <div className="persona-mood-edge-heading">
              <strong>{selection.from} → {selection.to}</strong>
              <span className={selectedEdge.modified ? 'is-custom' : ''}>{selectedEdge.modified ? '已修改' : '默认值'}</span>
            </div>
            <label className="persona-mood-slider" htmlFor="persona-mood-target">
              <span className="persona-mood-slider-heading"><span>到</span></span>
              <select
                id="persona-mood-target"
                value={selection.to}
                aria-label="选择切换目标情绪"
                disabled={disabled || settings.emotions.length < 2}
                onChange={(event) => changeSelectionTo(selection.from, event.currentTarget.value)}
              >
                {moodOutgoingTargets(settings, selection.from).map((name) => <option value={name} key={name}>{name}</option>)}
              </select>
            </label>
            <div className="persona-mood-edge-controls">
              <SettingsRange
                id="persona-mood-margin"
                label="切换门槛"
                value={selectedEdge.margin}
                min={0}
                max={0.5}
                step={0.01}
                display={selectedEdge.margin.toFixed(2)}
                disabled={disabled || !parsed.success}
                onChange={(value) => changeEdge('margin', value)}
              />
              <SettingsRange
                id="persona-mood-dwell"
                label="至少停留"
                value={selectedEdge.dwell}
                min={0}
                max={60}
                step={1}
                display={`${selectedEdge.dwell} 分钟`}
                disabled={disabled || !parsed.success}
                onChange={(value) => changeEdge('dwell', value)}
              />
              <label className="persona-mood-jump-toggle">
                <input
                  type="checkbox"
                  checked={selectedEdge.jump}
                  disabled={disabled || !parsed.success}
                  onChange={(event) => changeEdge('jump', event.currentTarget.checked)}
                />
                <span>允许直接切换（关掉就得先经过其他情绪）</span>
              </label>
              <button className="button button-secondary" type="button" disabled={disabled || !selectedEdge.modified} onClick={resetEdge}>这条边恢复默认</button>
            </div>
            <div className="persona-mood-coordinate-readout">
              <span>「{selection.from}」的坐标：{coordinateLabel(selectedSource)}</span>
              <SettingsRange
                id="persona-mood-dominance"
                label="掌控感 D"
                value={selectedSource.dominance}
                min={-1}
                max={1}
                step={0.05}
                display={selectedSource.dominance.toFixed(2)}
                disabled={disabled || !parsed.success}
                onChange={(value) => commit(updateMoodCoordinate(settings, selection.from, 'dominance', value))}
              />
            </div>
          </div>
        ) : (
          <p className="persona-mood-empty-edge">至少需要两种情绪，才能编辑情绪之间的切换。</p>
        )}
      </section>

      <section className="persona-form-card persona-mood-card" aria-labelledby="persona-mood-matrix-title">
        <header className="persona-mood-card-heading">
          <div><h3 id="persona-mood-matrix-title">全部切换一览</h3><p>行是来源，列是目标；斜线表示不允许直接切换，点格子可编辑。</p></div>
        </header>
        <PersonaMoodEdgeMatrix
          settings={settings}
          selectedFrom={selection.from}
          selectedTo={selection.to}
          onSelect={(from, to) => {
            setSelection(selectMoodEdge(selection, from, to, settings.emotions));
            edgeEditorRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
          }}
        />
      </section>

      <p className="persona-mood-preview-source">{selectedPreview ? `预览 QQ ${selectedPreview.account}` : '未选预览账号，使用心情底色'}</p>
      <PersonaMoodSubSettingsCard
        settings={settings}
        mainEmotion={emotionExample.mainEmotion}
        subEmotions={emotionExample.subEmotions}
        disabled={disabled || !parsed.success}
        onChange={commit}
      />
      {previewBusy && <p className="muted">正在读取预览 QQ 的心情…</p>}
      {previewError && <p className="persona-mood-error" role="alert">{previewError}</p>}

      <PersonaMoodOtherCard settings={globalMoodSettings} />
    </div>
  );
}
