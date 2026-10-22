import { useEffect, useRef } from 'react';
import { redactSensitiveText } from '../../../src/core/impressions/sensitive-text.ts';
import {
  PERSONA_SECTION_HEADINGS,
  personaSourceForEditor,
  personaTitleForDisplay,
  type PersonaSectionsForm,
} from '../persona-sections.ts';

export function PersonaComparisonDialog({
  open,
  filename,
  source,
  form,
  onClose,
}: {
  open: boolean;
  filename: string;
  source: string;
  form: PersonaSectionsForm;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog ref={dialogRef} className="persona-compare-dialog" aria-labelledby="persona-compare-title" onClose={onClose}>
      <div className="persona-compare-heading">
        <div><h2 id="persona-compare-title">逐项对照</h2><p className="muted">“{redactSensitiveText(filename)}” · 原文与整理结果</p></div>
        <button className="button button-secondary" type="button" onClick={onClose}>关闭</button>
      </div>
      <div className="persona-compare-columns">
        <section className="persona-compare-column">
          <h3>原文</h3>
          <pre>{redactSensitiveText(personaSourceForEditor(source))}</pre>
        </section>
        <section className="persona-compare-column">
          <h3>整理后的字段</h3>
          <div className="persona-compare-fields">
            <section><h4>开头说明</h4><p>{redactSensitiveText([personaTitleForDisplay(form.title), form.introduction].filter(Boolean).join('\n')) || '—'}</p></section>
            {PERSONA_SECTION_HEADINGS.map((heading) => {
              const value = form.fields[heading];
              const text = redactSensitiveText(Array.isArray(value) ? value.join('\n') : value);
              return <section key={heading}><h4>{heading}</h4><p>{text || '—'}</p></section>;
            })}
            <section><h4>性格底色</h4><p>{`规矩 ${form.traits.order} · 善意 ${form.traits.morality} · 话量 ${form.traits.talk} · 思维 ${form.traits.mind} · 脱线 ${form.traits.humor} · 好奇 ${form.traits.openness} · 模仿 ${form.traits.imitation}`}</p></section>
            {form.other.map((section, index) => (
              <section key={index}><h4>{redactSensitiveText(section.heading || '其他小节')}</h4><p>{redactSensitiveText(section.text) || '—'}</p></section>
            ))}
          </div>
        </section>
      </div>
    </dialog>
  );
}
