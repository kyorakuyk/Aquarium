import { useEffect, useRef } from 'react';
import type { PersonaTraits } from '../api.ts';
import { PERSONA_SECTION_HEADINGS, PERSONA_TRAIT_LABELS, parseSections } from '../persona-sections.ts';
import { redactSensitiveText } from '../../../src/core/impressions/sensitive-text.ts';

interface SectionRow {
  key: string;
  heading: string;
  text: string;
}

function textForField(value: string | string[]): string {
  return Array.isArray(value) ? value.map((item) => `- ${item}`).join('\n') : value;
}

function sectionRows(markdown: string): { sections: SectionRow[]; traits: PersonaTraits } {
  const form = parseSections(markdown);
  const opening = [form.title, form.introduction].filter(Boolean).join('\n');
  const sections: SectionRow[] = [{ key: 'opening', heading: '开头说明', text: opening }];
  for (const heading of PERSONA_SECTION_HEADINGS) {
    sections.push({ key: `standard:${heading}`, heading, text: textForField(form.fields[heading]) });
  }
  form.other.forEach((section, index) => {
    sections.push({
      key: `other:${section.heading}:${index}`,
      heading: section.heading || `其他小节 ${index + 1}`,
      text: section.text,
    });
  });
  return { sections, traits: form.traits };
}

export function PersonaVersionDiffDialog({
  open,
  previousMarkdown,
  currentMarkdown,
  onClose,
}: {
  open: boolean;
  previousMarkdown: string | null;
  currentMarkdown: string;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const hasPrevious = previousMarkdown !== null;
  const before = (() => {
    try { return sectionRows(previousMarkdown ?? ''); } catch { return null; }
  })();
  const after = (() => {
    try { return sectionRows(currentMarkdown); } catch { return null; }
  })();
  const rows = before && after
    ? [...new Map([...before.sections, ...after.sections].map((row) => [row.key, row])).values()]
    : [];

  return (
    <dialog
      ref={dialogRef}
      className="persona-version-diff-dialog"
      aria-labelledby="persona-version-diff-title"
      onClose={onClose}
      onCancel={onClose}
    >
      <div className="persona-version-diff-heading">
        <div><h2 id="persona-version-diff-title">版本差异</h2><p className="muted">按小节对照保存前后的内容。</p></div>
        <button className="button button-secondary" type="button" onClick={onClose}>关闭</button>
      </div>
      <div className="persona-version-diff-scroll">
        {before && after ? (
          <>
            <section className="persona-version-trait-diff" aria-label="性格底色变化">
              <h3>性格底色</h3>
              <div className="persona-version-trait-grid">
                {PERSONA_TRAIT_LABELS.map((field) => {
                  const from = hasPrevious ? before.traits[field.key] : 0;
                  const to = after.traits[field.key];
                  return (
                    <p key={field.key}>
                      <strong>{field.title}</strong>
                      <span className="mono">{from} → {to}</span>
                    </p>
                  );
                })}
              </div>
            </section>
            {!hasPrevious && <p className="muted">没有可对比的上一版本；左侧为空。</p>}
            <div className="persona-version-diff-column-headings"><span>{hasPrevious ? '上一版本' : '空白底稿'}</span><span>当前版本</span></div>
            {rows.map((row) => {
              const oldText = before.sections.find((item) => item.key === row.key)?.text ?? '';
              const newText = after.sections.find((item) => item.key === row.key)?.text ?? '';
              const changed = oldText !== newText;
              return (
                <section className={`persona-version-diff-row ${changed ? 'is-changed' : ''}`} key={row.key}>
                  <h3>{redactSensitiveText(row.heading)}{changed ? <span>已变化</span> : <span>未变化</span>}</h3>
                  <div>
                    <pre>{redactSensitiveText(oldText) || '—'}</pre>
                    <pre>{redactSensitiveText(newText) || '—'}</pre>
                  </div>
                </section>
              );
            })}
          </>
        ) : (
          <div className="persona-version-diff-raw">
            <p className="muted">至少一个版本的 Markdown/YAML 无法按小节解析，改为显示原文。</p>
            <div>
              <pre>{redactSensitiveText(previousMarkdown ?? '—')}</pre>
              <pre>{redactSensitiveText(currentMarkdown)}</pre>
            </div>
          </div>
        )}
      </div>
    </dialog>
  );
}
