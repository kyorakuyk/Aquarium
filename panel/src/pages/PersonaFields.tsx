import { useEffect, useState } from 'react';
import type { PersonaTraits } from '../api.ts';
import type { PersonaSectionFields, PersonaSectionsForm } from '../persona-sections.ts';

const TRAIT_FIELDS: Array<{ key: keyof PersonaTraits; title: string; low: string; high: string }> = [
  { key: 'order', title: '规矩', low: '守序', high: '随性' },
  { key: 'morality', title: '善意', low: '善良', high: '淘气' },
  { key: 'talk', title: '话量', low: '文静', high: '话多' },
  { key: 'mind', title: '思维', low: '理性', high: '感性' },
];

type TextHeading = '身份' | '年龄' | '背景' | '说话方式' | '对熟人' | '对陌生人' | '对主人';
type ListHeading = '口头禅' | '常用表情' | '底线';

function FieldLabel({ id, title, reference }: { id: string; title: string; reference: string }) {
  return <div className="persona-field-heading"><label htmlFor={id}>{title}</label><span>{reference}</span></div>;
}

function TextField({
  id,
  title,
  reference,
  value,
  onChange,
  onFocus,
  disabled,
  multiline = true,
}: {
  id: string;
  title: string;
  reference: string;
  value: string;
  onChange: (value: string) => void;
  onFocus: () => void;
  disabled: boolean;
  multiline?: boolean;
}) {
  return (
    <div className="persona-field">
      <FieldLabel id={id} title={title} reference={reference} />
      {multiline
        ? <textarea id={id} value={value} rows={3} disabled={disabled} onFocus={onFocus} onChange={(event) => onChange(event.currentTarget.value)} />
        : <input id={id} value={value} disabled={disabled} onFocus={onFocus} onChange={(event) => onChange(event.currentTarget.value)} />}
    </div>
  );
}

function ListField({
  heading,
  items,
  onChange,
  onFocus,
  disabled,
}: {
  heading: ListHeading;
  items: string[];
  onChange: (items: string[]) => void;
  onFocus: () => void;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState('');
  useEffect(() => setDraft(''), [items]);
  function addItem() {
    const value = draft.trim();
    if (!value) return;
    onChange([...items, value]);
    setDraft('');
  }
  return (
    <div className="persona-field persona-list-field">
      <FieldLabel id={`persona-list-${heading}`} title={heading} reference={`## ${heading}`} />
      <div className="persona-list-items">
        {items.map((item, index) => (
          <div className="persona-list-entry" key={`${heading}-${index}`}>
            <input
              aria-label={`${heading}第${index + 1}项`}
              value={item}
              disabled={disabled}
              onFocus={onFocus}
              onChange={(event) => onChange(items.map((current, itemIndex) => itemIndex === index ? event.currentTarget.value : current))}
            />
            <button
              className="text-button"
              type="button"
              aria-label={`移除${heading}第${index + 1}项`}
              disabled={disabled}
              onClick={() => onChange(items.filter((_, itemIndex) => itemIndex !== index))}
            >移除</button>
          </div>
        ))}
      </div>
      <div className="persona-list-add">
        <input
          id={`persona-list-${heading}`}
          value={draft}
          placeholder={`添加${heading}`}
          disabled={disabled}
          onFocus={onFocus}
          onChange={(event) => setDraft(event.currentTarget.value)}
        />
        <button className="button button-secondary" type="button" disabled={disabled || !draft.trim()} onClick={addItem}>＋ 添加</button>
      </div>
    </div>
  );
}

export function PersonaFields({
  form,
  onChange,
  onFocus,
  disabled,
}: {
  form: PersonaSectionsForm;
  onChange: (form: PersonaSectionsForm) => void;
  onFocus: (blockId: string) => void;
  disabled: boolean;
}) {
  function setText(heading: TextHeading, value: string) {
    onChange({ ...form, fields: { ...form.fields, [heading]: value } as PersonaSectionFields });
  }
  function setList(heading: ListHeading, value: string[]) {
    onChange({ ...form, fields: { ...form.fields, [heading]: value } as PersonaSectionFields });
  }
  function setTrait(key: keyof PersonaTraits, value: number) {
    onChange({ ...form, traits: { ...form.traits, [key]: value } });
  }
  function setOther(index: number, change: Partial<PersonaSectionsForm['other'][number]>) {
    onChange({ ...form, other: form.other.map((section, itemIndex) => itemIndex === index ? { ...section, ...change } : section) });
  }

  return (
    <div className="persona-form-grid">
      <section className="persona-form-card">
        <h3>它是谁</h3>
        <TextField
          id="persona-title"
          title="标题行"
          reference="开头说明"
          value={form.title.replace(/^#[ \t]*/u, '')}
          multiline={false}
          disabled={disabled}
          onFocus={() => onFocus('persona-opening')}
          onChange={(value) => onChange({ ...form, title: value ? `# ${value}` : '' })}
        />
        <TextField
          id="persona-opening"
          title="开头说明"
          reference="开头说明"
          value={form.introduction}
          disabled={disabled}
          onFocus={() => onFocus('persona-opening')}
          onChange={(value) => onChange({ ...form, introduction: value })}
        />
        {(['身份', '年龄', '背景'] as const).map((heading) => (
          <TextField key={heading} id={`persona-${heading}`} title={heading} reference={`## ${heading}`} value={form.fields[heading]} disabled={disabled} onFocus={() => onFocus(`persona-section-${heading}`)} onChange={(value) => setText(heading, value)} />
        ))}
      </section>

      <section className="persona-form-card">
        <h3>性格底色</h3>
        <p className="persona-form-hint">0 表示不额外强调；共五档。</p>
        <div className="persona-trait-grid">
          {TRAIT_FIELDS.map((field) => (
            <div className="persona-trait-field" key={field.key}>
              <div className="persona-trait-label"><strong>{field.title}</strong><span>{field.low} ←　→ {field.high}</span></div>
              <div className="trait-segments" role="radiogroup" aria-label={`${field.title}：${field.low} 到 ${field.high}`} onFocus={() => onFocus('traits')}>
                {[-2, -1, 0, 1, 2].map((value) => (
                  <button
                    className={form.traits[field.key] === value ? 'is-selected' : ''}
                    type="button"
                    role="radio"
                    aria-checked={form.traits[field.key] === value}
                    aria-label={`${field.title} ${value > 0 ? `+${value}` : value}`}
                    key={value}
                    disabled={disabled}
                    onClick={() => setTrait(field.key, value)}
                  >{value > 0 ? `+${value}` : value}</button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="persona-form-card">
        <h3>它怎么说话</h3>
        <TextField id="persona-说话方式" title="说话方式" reference="## 说话方式" value={form.fields.说话方式} disabled={disabled} onFocus={() => onFocus('persona-section-说话方式')} onChange={(value) => setText('说话方式', value)} />
        <ListField heading="口头禅" items={form.fields.口头禅} disabled={disabled} onFocus={() => onFocus('persona-section-口头禅')} onChange={(value) => setList('口头禅', value)} />
        <ListField heading="常用表情" items={form.fields.常用表情} disabled={disabled} onFocus={() => onFocus('persona-section-常用表情')} onChange={(value) => setList('常用表情', value)} />
      </section>

      <section className="persona-form-card">
        <h3>它怎么对人</h3>
        {(['对熟人', '对陌生人', '对主人'] as const).map((heading) => (
          <TextField key={heading} id={`persona-${heading}`} title={heading} reference={`## ${heading}`} value={form.fields[heading]} disabled={disabled} onFocus={() => onFocus(`persona-section-${heading}`)} onChange={(value) => setText(heading, value)} />
        ))}
      </section>

      <section className="persona-form-card">
        <h3>底线</h3>
        <ListField heading="底线" items={form.fields.底线} disabled={disabled} onFocus={() => onFocus('persona-section-底线')} onChange={(value) => setList('底线', value)} />
      </section>

      <section className="persona-form-card persona-other-card">
        <details>
          <summary>其他小节 <span className="muted">{form.other.length} 段</span></summary>
          <div className="persona-other-list">
            {form.other.map((section, index) => (
              <div className="persona-other-entry" key={index}>
                <div className="persona-field-heading"><label htmlFor={`persona-other-heading-${index}`}>小节标题</label><span>自定义小节</span></div>
                <input
                  id={`persona-other-heading-${index}`}
                  value={section.heading}
                  disabled={disabled}
                  onFocus={() => onFocus(`persona-other-section-${index}`)}
                  onChange={(event) => setOther(index, { heading: event.currentTarget.value })}
                />
                <div className="persona-field-heading"><label htmlFor={`persona-other-text-${index}`}>小节内容</label><span>原文保留</span></div>
                <textarea
                  id={`persona-other-text-${index}`}
                  value={section.text}
                  rows={3}
                  disabled={disabled}
                  onFocus={() => onFocus(`persona-other-section-${index}`)}
                  onChange={(event) => setOther(index, { text: event.currentTarget.value })}
                />
                <button className="text-button persona-remove-other" type="button" disabled={disabled} onClick={() => onChange({ ...form, other: form.other.filter((_, itemIndex) => itemIndex !== index) })}>删除小节</button>
              </div>
            ))}
            <button className="button button-secondary" type="button" disabled={disabled} onClick={() => onChange({ ...form, other: [...form.other, { heading: '', text: '' }] })}>＋ 添加小节</button>
          </div>
        </details>
      </section>
    </div>
  );
}
