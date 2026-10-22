import type { PersonaSectionBlock } from '../persona-sections.ts';
import { redactSensitiveText } from '../../../src/core/impressions/sensitive-text.ts';
import { PersonaEvolution } from './PersonaEvolution.tsx';

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
  previewAccounts,
  previewAccountId,
  onPreviewAccountChange,
  disabled,
  onTryChat,
  personaId,
  versionRefreshKey,
  onRestoreVersion,
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
  previewAccounts: Array<{ account: number; name: string }>;
  previewAccountId: number | null;
  onPreviewAccountChange: (account: number) => void;
  disabled: boolean;
  onTryChat: () => void;
  personaId: string;
  versionRefreshKey: number;
  onRestoreVersion: (markdown: string) => void;
}) {
  return (
    <div className="persona-preview-rail">
      <section className="persona-preview-card panel-card" aria-labelledby="persona-preview-title">
        <div className="persona-preview-heading">
          <div>
            <h2 id="persona-preview-title">实际注入</h2>
            <p className="muted">
              {previewAccounts.length === 0
                ? '没有可选账号，昵称占位符使用默认值。'
                : `按 QQ ${previewAccountId} 的昵称“${previewAccounts.find((item) => item.account === previewAccountId)?.name ?? '水族箱'}”预览；切换操作作用于此账号。`}
            </p>
          </div>
          <div className="persona-preview-controls">
            {previewAccounts.length > 1 && (
              <label className="persona-preview-account">
                <span>当前账号</span>
                <select value={previewAccountId ?? ''} onChange={(event) => onPreviewAccountChange(Number(event.currentTarget.value))}>
                  {previewAccounts.map((account) => <option key={account.account} value={account.account}>QQ {account.account} · {account.name}</option>)}
                </select>
              </label>
            )}
            <div className="persona-view-toggle" role="group" aria-label="人设内容视图">
              <button className={mode === 'preview' ? 'is-active' : ''} type="button" onClick={() => onModeChange('preview')}>预览</button>
              <button className={mode === 'source' ? 'is-active' : ''} type="button" onClick={() => onModeChange('source')}>源文件</button>
            </div>
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
      <PersonaEvolution personaId={personaId} refreshKey={versionRefreshKey} onRestore={onRestoreVersion} />
    </div>
  );
}
