import { useEffect, useMemo, useRef, useState } from 'react';
import { apiRequest, type MoodView } from '../api.ts';
import {
  DEFAULT_EMOTION_LIBRARY,
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
  PERSONA_MOOD_PREVIEW_ERRORS,
  resolveMoodEdge,
  selectMoodEdge,
  selectMoodSource,
  updateMoodCoordinate,
  updateMoodEdgeSetting,
  withPersonaMoodSettings,
  type EmotionEdgeSetting,
  type MoodGraphSelection,
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

function edgeLibraryNote(from: string, to: string): string {
  const known = new Set(DEFAULT_EMOTION_LIBRARY.map((emotion) => emotion.name));
  return known.has(from) && known.has(to)
    ? '两个都是情绪库里的情绪，默认值来自情绪库。'
    : '其中有自定义情绪，默认值按两者的坐标估算。';
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
  const [selection, setSelection] = useState<MoodGraphSelection>({ from: null, to: null });

  useEffect(() => {
    setSelection((current) => (
      current.from === null && settings.emotions.length > 0 ? { from: settings.emotions[0] ?? null, to: null } : current
    ));
  }, []);

  useEffect(() => {
    setSelection((current) => {
      if (current.from === null) return current;
      if (!settings.emotions.includes(current.from)) return { from: settings.emotions[0] ?? null, to: null };
      if (current.to === null || settings.emotions.includes(current.to) && current.to !== current.from) return current;
      return { from: current.from, to: null };
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
          else setPreviewError(PERSONA_MOOD_PREVIEW_ERRORS.globalInvalid);
        })
        .catch(() => {
          if (active) setPreviewError(PERSONA_MOOD_PREVIEW_ERRORS.global);
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
        } else setPreviewError(PERSONA_MOOD_PREVIEW_ERRORS.invalid);
      })
      .catch(() => {
        if (active) setPreviewError(PERSONA_MOOD_PREVIEW_ERRORS.account);
      })
      .finally(() => { if (active) setPreviewBusy(false); });
    return () => { active = false; };
  }, [previewAccountId]);

  function commit(next: PersonaMoodSettings) {
    if (disabled || !parsed.success) return;
    onChange(withPersonaMoodSettings(form, next));
    setMessage('');
  }

  function changePointSelection(name: string) {
    setSelection((current) => selectMoodSource(current, name, settings.emotions));
  }

  function changeSelectionTo(from: string, to: string) {
    setSelection((current) => selectMoodEdge(current, from, to, settings.emotions));
  }

  function changeEdge(key: EmotionEdgeSetting, value: number | boolean) {
    if (disabled || selection.from === null || selection.to === null) return;
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
    if (disabled || selection.from === null || selection.to === null) return;
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
  const selectedSource = selection.from === null ? undefined : library.find((emotion) => emotion.name === selection.from);
  const selectedTarget = selection.to === null ? undefined : library.find((emotion) => emotion.name === selection.to);
  const selectedEdge = selection.from !== null && selection.to !== null && selectedSource && selectedTarget
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

      <PersonaMoodLibraryCard
        settings={settings}
        selectedName={selection.from}
        onSelectEmotion={(name) => setSelection((current) => ({ from: name, to: current.to !== null && current.to !== name && settings.emotions.includes(current.to) ? current.to : null }))}
        disabled={disabled || !parsed.success} onChange={commit} />

      <section className="persona-form-card persona-mood-card" aria-labelledby="persona-mood-graph-title">
        <header className="persona-mood-card-heading">
          <div><h3 id="persona-mood-graph-title">切换难度</h3><span className="muted">点来源，再点目标；再点来源可取消；拖动超过 4px 才会调整坐标</span></div>
        </header>
        <PersonaMoodGraph
          settings={settings}
          selectedFrom={selection.from}
          selectedTo={selection.to}
          onSelectPoint={changePointSelection}
          onSelectTo={(to) => { if (selection.from !== null) changeSelectionTo(selection.from, to); }}
          onCoordinatesChange={changeCoordinates}
          disabled={disabled || !parsed.success}
        />
        {selectedEdge && selectedSource && selectedTarget ? (
          <div className="persona-mood-edge-editor" ref={edgeEditorRef}>
            <div className="persona-mood-edge-heading">
              <h4 className="persona-mood-edge-title">{selection.from ?? ''}<span className="persona-mood-edge-arrow">→</span>{selection.to ?? ''}</h4>
              <p className="persona-mood-edge-note">
                {edgeLibraryNote(selection.from ?? '', selection.to ?? '')}
                {selectedEdge.modified && <span className="is-custom"> · 已修改</span>}
              </p>
            </div>
            <div className="persona-mood-edge-controls">
              <div className="persona-mood-edge-column">
                <SettingsRange
                  id="persona-mood-margin"
                  label="切换门槛"
                  hint={`越大越难从「${selection.from}」变成「${selection.to}」`}
                  value={selectedEdge.margin}
                  min={0}
                  max={0.5}
                  step={0.01}
                  display={selectedEdge.margin.toFixed(2)}
                  disabled={disabled || !parsed.success}
                  onChange={(value) => changeEdge('margin', value)}
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
              </div>
              <div className="persona-mood-edge-column">
                <SettingsRange
                  id="persona-mood-dwell"
                  label="至少停留"
                  hint={`在「${selection.from}」待够这么久才会自然转过去`}
                  value={selectedEdge.dwell}
                  min={0}
                  max={60}
                  step={1}
                  display={`${selectedEdge.dwell} 分钟`}
                  disabled={disabled || !parsed.success}
                  onChange={(value) => changeEdge('dwell', value)}
                />
                <button className="persona-mood-small-button persona-mood-edge-reset" type="button" disabled={disabled || !selectedEdge.modified} onClick={resetEdge}>这条边恢复默认</button>
              </div>
            </div>
            <div className="persona-mood-coordinate-readout">
              <span>「{selection.from}」的坐标：{coordinateLabel(selectedSource)}</span>
              <SettingsRange
                id="persona-mood-dominance"
                label="掌控感 D"
                hint="图上看不到的第三维，拉开生气和委屈"
                value={selectedSource.dominance}
                min={-1}
                max={1}
                step={0.05}
                display={selectedSource.dominance.toFixed(2)}
                disabled={disabled || !parsed.success}
                onChange={(value) => selection.from !== null && commit(updateMoodCoordinate(settings, selection.from, 'dominance', value))}
              />
            </div>
          </div>
        ) : (
          <p className="persona-mood-empty-edge">{settings.emotions.length < 2 ? '至少需要两种情绪，才能编辑切换。' : selection.from === null ? '先点一个情绪作为来源。' : '再点一个目标情绪，或选下方出边标签。'}</p>
        )}
      </section>

      <section className="persona-form-card persona-mood-card" aria-labelledby="persona-mood-matrix-title">
        <header className="persona-mood-card-heading">
          <div><h3 id="persona-mood-matrix-title">全部切换一览</h3><span className="muted">行是来源，列是目标；颜色越深越难，斜线表示不允许直接切换，点格子编辑</span></div>
        </header>
        <PersonaMoodEdgeMatrix
          settings={settings}
          selectedFrom={selection.from}
          selectedTo={selection.to}
          onSelect={(from, to) => {
            setSelection((current) => selectMoodEdge(current, from, to, settings.emotions));
            requestAnimationFrame(() => edgeEditorRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
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
