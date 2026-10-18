import type { PersonaSectionBlock } from '../persona-sections.ts';
import { redactSensitiveText } from '../sensitive-text.ts';

export interface PersonaPreviewResult {
  blocks: PersonaSectionBlock[];
  chars: number;
  estTokens: number;
}

export function PersonaPreview({
  mode,
  onModeChange,
  preview,
  previewBusy,
  previewError,
  activeBlockId,
  sourceText,
  sourceError,
  onSourceChange,
  disabled,
  onTryChat,
}: {
  mode: 'preview' | 'source';
  onModeChange: (mode: 'preview' | 'source') => void;
  preview: PersonaPreviewResult | null;
  previewBusy: boolean;
  previewError: string;
  activeBlockId: string;
  sourceText: string;
  sourceError: string;
  onSourceChange: (text: string) => void;
  disabled: boolean;
  onTryChat: () => void;
}) {
  return (
    <section className="persona-preview-card panel-card" aria-labelledby="persona-preview-title">
      <div className="persona-preview-heading">
        <div><h2 id="persona-preview-title">实际注入</h2><p className="muted">按运行时顺序显示人设与性格底色。</p></div>
        <div className="persona-view-toggle" role="group" aria-label="人设内容视图">
          <button className={mode === 'preview' ? 'is-active' : ''} type="button" onClick={() => onModeChange('preview')}>预览</button>
          <button className={mode === 'source' ? 'is-active' : ''} type="button" onClick={() => onModeChange('source')}>源文件</button>
        </div>
      </div>
      {mode === 'preview' ? (
        <div className="persona-preview-blocks" aria-live="polite">
          {previewBusy && <p className="muted persona-preview-status">正在更新预览…</p>}
          {previewError && <p className="notice notice-warn" role="alert">{previewError}</p>}
          {!previewBusy && !previewError && preview?.blocks.length === 0 && <p className="empty-state">当前没有可注入的人设内容。</p>}
          {preview?.blocks.map((block) => (
            <section className={`persona-preview-block ${activeBlockId === block.id ? 'is-highlighted' : ''}`} key={block.id}>
              <span>{redactSensitiveText(block.label)}</span>
              <pre>{redactSensitiveText(block.text)}</pre>
            </section>
          ))}
        </div>
      ) : (
        <div className="persona-source-editor">
          {sourceError && <p className="notice notice-warn" role="alert">{sourceError}</p>}
          <textarea
            className="mono"
            aria-label="人设源文件 Markdown"
            value={sourceText}
            disabled={disabled}
            spellCheck={false}
            onChange={(event) => onSourceChange(event.currentTarget.value)}
          />
        </div>
      )}
      <div className="persona-preview-footer">
        <span className="mono">{sourceError ? '—' : preview ? `${preview.chars} 字 · 约 ${preview.estTokens} tokens` : '等待预览…'}</span>
        <button className="text-button" type="button" onClick={onTryChat}>用它试聊 →</button>
      </div>
    </section>
  );
}
