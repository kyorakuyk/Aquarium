import type { PersonaImportWarning } from '../../../src/persona/persona-import.ts';

interface PersonaImportBannerProps {
  filename: string;
  mappedCount: number;
  otherCount: number;
  repairCount: number;
  fixedCount: number;
  warnings: PersonaImportWarning[];
  busy: boolean;
  canAccept: boolean;
  onCompare: () => void;
  onDiscard: () => void;
  onAccept: () => void;
}

export function PersonaImportBanner({
  filename,
  mappedCount,
  otherCount,
  repairCount,
  fixedCount,
  warnings,
  busy,
  canAccept,
  onCompare,
  onDiscard,
  onAccept,
}: PersonaImportBannerProps) {
  return (
    <section className="persona-import-banner" aria-label="人设导入草稿">
      <div className="persona-import-summary">
        <strong>“{filename}”已整理好</strong>
        <p>
          填充 {mappedCount} 个字段/性格维度，其他小节 {otherCount} 段；已尝试修复 {repairCount} 轮，
          修正 {fixedCount} 处，剩余警告 {warnings.length} 条。确认前不会保存。
        </p>
        {warnings.length > 0 ? (
          <div className="notice notice-warn persona-import-warning" role="status" aria-label="人设导入检查警告">
            <strong>请检查以下条目</strong>
            <ul>
              {warnings.map((warning, index) => (
                <li key={`${warning.code}-${index}`}>
                  {warning.field && <strong>{warning.field}：</strong>}
                  {warning.message}
                  {warning.excerpt && <mark className="persona-import-warning-mark">{warning.excerpt}</mark>}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="persona-import-check-ok" role="status">字段与出处检查通过。</p>
        )}
      </div>
      <div className="persona-import-actions">
        <button className="button button-secondary" type="button" disabled={busy} onClick={onCompare}>逐项对照</button>
        <button className="text-button" type="button" disabled={busy} onClick={onDiscard}>放弃</button>
        <button className="button button-primary" type="button" disabled={busy || !canAccept} onClick={onAccept}>接受</button>
      </div>
    </section>
  );
}
