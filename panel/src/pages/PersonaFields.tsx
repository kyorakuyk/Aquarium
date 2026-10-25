import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PersonaTraits } from '../api.ts';
import type { PersonaEditorTab, PersonaParameterTab } from '../persona-page-tabs.ts';
import { PersonaParametersPanel } from './PersonaParametersPanel.tsx';
import {
  PERSONA_TRAIT_LABELS,
  personaNameFromTitle,
  personaTitleFromName,
  type PersonaEnergySource,
  type PersonaSectionFields,
  type PersonaSectionsForm,
} from '../persona-sections.ts';

type TextHeading = '身份' | '年龄' | '背景' | '说话方式' | '对熟人' | '对陌生人' | '对主人';
type ListHeading = '口头禅' | '常用表情' | '底线';

function useTextareaAutoHeight(value: string, active: boolean) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const textarea = ref.current;
    if (!active || !textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [active, value]);
  return ref;
}

function AutoGrowTextarea({
  id,
  value,
  rows,
  active,
  disabled,
  onFocus,
  onChange,
}: {
  id: string;
  value: string;
  rows: 2 | 3;
  active: boolean;
  disabled: boolean;
  onFocus: () => void;
  onChange: (value: string) => void;
}) {
  const ref = useTextareaAutoHeight(value, active);
  return (
    <textarea
      ref={ref}
      className="persona-auto-textarea"
      id={id}
      value={value}
      rows={rows}
      disabled={disabled}
      onFocus={onFocus}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  );
}

function FieldLabel({ id, title, reference, hidden = false }: { id: string; title: string; reference?: string; hidden?: boolean }) {
  return <div className={hidden ? 'persona-field-heading visually-hidden' : 'persona-field-heading'}><label htmlFor={id}>{title}</label>{reference && <span className="persona-reference">{reference}</span>}</div>;
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
  rows = 3,
  active = true,
  hideLabel = false,
}: {
  id: string;
  title: string;
  reference: string;
  value: string;
  onChange: (value: string) => void;
  onFocus: () => void;
  disabled: boolean;
  multiline?: boolean;
  rows?: 2 | 3;
  active?: boolean;
  hideLabel?: boolean;
}) {
  return (
    <div className="persona-field">
      <FieldLabel id={id} title={title} reference={reference} hidden={hideLabel} />
      {multiline
        ? <AutoGrowTextarea id={id} value={value} rows={rows} active={active} disabled={disabled} onFocus={onFocus} onChange={onChange} />
        : <input id={id} value={value} disabled={disabled} onFocus={onFocus} onChange={(event) => onChange(event.currentTarget.value)} />}
    </div>
  );
}

function TagListField({
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
    <div className="persona-field persona-tag-field">
      <FieldLabel id={`persona-list-${heading}`} title={heading} reference={`## ${heading}`} hidden />
      <div className="persona-tag-list">
        {items.map((item, index) => (
          <span className="persona-tag" key={`${heading}-${index}`}>
            <input
              aria-label={`${heading}第${index + 1}项`}
              value={item}
              disabled={disabled}
              onFocus={onFocus}
              onChange={(event) => onChange(items.map((current, itemIndex) => itemIndex === index ? event.currentTarget.value : current))}
            />
            <button
              className="persona-tag-remove"
              type="button"
              aria-label={`移除${heading}第${index + 1}项`}
              disabled={disabled}
              onFocus={onFocus}
              onClick={() => onChange(items.filter((_, itemIndex) => itemIndex !== index))}
            >×</button>
          </span>
        ))}
        <input
          id={`persona-list-${heading}`}
          className="persona-tag-draft"
          value={draft}
          placeholder="+ 添加"
          aria-label={`添加${heading}`}
          disabled={disabled}
          onFocus={onFocus}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              addItem();
            }
          }}
        />
        <button className="persona-add-circle" type="button" aria-label={`添加${heading}`} disabled={disabled || !draft.trim()} onFocus={onFocus} onClick={addItem}>＋</button>
      </div>
    </div>
  );
}

function RuleListField({
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
  return (
    <div className="persona-field persona-rule-field">
      <FieldLabel id={`persona-list-${heading}`} title={heading} reference={`## ${heading}`} hidden />
      <div className="persona-rule-list">
        {items.map((item, index) => (
          <div className="persona-rule-entry" key={`${heading}-${index}`}>
            <span className="persona-rule-dot" aria-hidden="true" />
            <input
              id={index === 0 ? `persona-list-${heading}` : undefined}
              aria-label={`${heading}第${index + 1}项`}
              value={item}
              disabled={disabled}
              onFocus={onFocus}
              onChange={(event) => onChange(items.map((current, itemIndex) => itemIndex === index ? event.currentTarget.value : current))}
            />
            <button
              className="persona-rule-remove"
              type="button"
              aria-label={`删除${heading}第${index + 1}项`}
              disabled={disabled}
              onFocus={onFocus}
              onClick={() => onChange(items.filter((_, itemIndex) => itemIndex !== index))}
            >×</button>
          </div>
        ))}
        <button className="persona-rule-add" type="button" disabled={disabled} onFocus={onFocus} onClick={() => onChange([...items, ''])}>+ 添加底线</button>
      </div>
    </div>
  );
}

export function PersonaFields({
  form,
  onChange,
  onFocus,
  disabled,
  activeTab,
  parameterTab,
  onParameterTabChange,
  personaId,
  previewAccountId,
}: {
  form: PersonaSectionsForm;
  onChange: (form: PersonaSectionsForm) => void;
  onFocus: (blockId: string) => void;
  disabled: boolean;
  activeTab: PersonaEditorTab;
  parameterTab: PersonaParameterTab;
  onParameterTabChange: (tab: PersonaParameterTab) => void;
  personaId: string;
  previewAccountId: number | null;
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
  function setEnergySource(value: PersonaEnergySource) {
    onChange({ ...form, metadata: { ...form.metadata, energySource: value } });
  }
  function setOther(index: number, change: Partial<PersonaSectionsForm['other'][number]>) {
    onChange({ ...form, other: form.other.map((section, itemIndex) => itemIndex === index ? { ...section, ...change } : section) });
  }

  const whoFields = (
    <div className="persona-form-grid">
      <section className="persona-form-card">
        <h3>我是谁</h3>
        <div className="persona-short-fields">
          <TextField id="persona-身份" title="身份" reference="## 身份" value={form.fields.身份} multiline={false} active={activeTab === 'who'} disabled={disabled} onFocus={() => onFocus('persona-section-身份')} onChange={(value) => setText('身份', value)} />
          <TextField id="persona-年龄" title="年龄" reference="## 年龄" value={form.fields.年龄} multiline={false} active={activeTab === 'who'} disabled={disabled} onFocus={() => onFocus('persona-section-年龄')} onChange={(value) => setText('年龄', value)} />
        </div>
        <div className="persona-field">
          <FieldLabel id="persona-name" title="名字 / 称呼" />
          <input
            id="persona-name"
            value={personaNameFromTitle(form.title)}
            placeholder="跟随 QQ 昵称"
            disabled={disabled}
            onFocus={() => onFocus('persona-opening')}
            onChange={(event) => onChange({ ...form, title: personaTitleFromName(event.currentTarget.value) })}
          />
          <p className="persona-field-hint">留空时跟随 QQ 昵称；填写后固定显示该名字</p>
        </div>
        <TextField id="persona-opening" title="开头说明" reference="开头说明" value={form.introduction} rows={3} active={activeTab === 'who'} disabled={disabled} onFocus={() => onFocus('persona-opening')} onChange={(value) => onChange({ ...form, introduction: value })} />
        <TextField id="persona-背景" title="背景" reference="## 背景" value={form.fields.背景} rows={3} active={activeTab === 'who'} disabled={disabled} onFocus={() => onFocus('persona-section-背景')} onChange={(value) => setText('背景', value)} />
      </section>

      <section className="persona-form-card">
        <h3>性格底色</h3>
        <p className="persona-form-hint">0 表示不额外强调；共五档。</p>
        <div className="persona-field">
          <FieldLabel id="persona-energy-source" title="心灵能量来源" />
          <select
            id="persona-energy-source"
            className="persona-energy-source"
            value={form.metadata.energySource === 'inner' || form.metadata.energySource === 'outer' ? form.metadata.energySource : 'mixed'}
            disabled={disabled}
            onFocus={() => onFocus('traits')}
            onChange={(event) => setEnergySource(event.currentTarget.value as PersonaEnergySource)}
          >
            <option value="inner">向内（I）</option>
            <option value="outer">向外（E）</option>
            <option value="mixed">混合（默认）</option>
          </select>
          <p className="persona-field-hint">向内独处时回能，向外有人陪时回能；下一次读取状态时生效。</p>
        </div>
        <div className="persona-trait-grid">
          {PERSONA_TRAIT_LABELS.map((field) => {
            const traitValue = form.traits[field.key];
            return (
              <div className="persona-trait-field" key={field.key}>
                <div className="persona-trait-label">
                  <strong>{field.title}{'locked' in field && field.locked ? ' · 锁定' : ''}</strong>
                  <output>{traitValue > 0 ? `+${traitValue.toFixed(1)}` : traitValue.toFixed(1)}</output>
                </div>
                <input
                  className="persona-trait-range"
                  type="range"
                  min={-2}
                  max={2}
                  step={0.1}
                  value={traitValue}
                  aria-label={`${field.title}${'locked' in field && field.locked ? '，锁定' : ''}，${field.low}到${field.high}`}
                  disabled={disabled}
                  onFocus={() => onFocus('traits')}
                  onChange={(event) => setTrait(field.key, Number(event.currentTarget.value))}
                />
                <div className="persona-trait-endpoints"><span>{field.low}</span><span>{field.high}</span></div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );

  const relationshipFields = (
    <div className="persona-deal-columns">
      <div className="persona-deal-column">
        <section className="persona-form-card">
          <h3>说话方式</h3>
          <TextField id="persona-说话方式" title="说话方式" reference="## 说话方式" value={form.fields.说话方式} rows={3} hideLabel active={activeTab === 'deal'} disabled={disabled} onFocus={() => onFocus('persona-section-说话方式')} onChange={(value) => setText('说话方式', value)} />
        </section>
        <section className="persona-form-card">
          <h3>口头禅</h3>
          <TagListField heading="口头禅" items={form.fields.口头禅} disabled={disabled} onFocus={() => onFocus('persona-section-口头禅')} onChange={(value) => setList('口头禅', value)} />
        </section>
        <section className="persona-form-card">
          <h3>常用表情</h3>
          <TagListField heading="常用表情" items={form.fields.常用表情} disabled={disabled} onFocus={() => onFocus('persona-section-常用表情')} onChange={(value) => setList('常用表情', value)} />
        </section>
      </div>
      <div className="persona-deal-column">
        <section className="persona-form-card">
          <h3>对人</h3>
          {(['对熟人', '对陌生人'] as const).map((heading) => (
            <TextField key={heading} id={`persona-${heading}`} title={heading} reference={`## ${heading}`} value={form.fields[heading]} rows={3} active={activeTab === 'deal'} disabled={disabled} onFocus={() => onFocus(`persona-section-${heading}`)} onChange={(value) => setText(heading, value)} />
          ))}
          <TextField id="persona-对主人" title="对主人" reference="## 对主人" value={form.fields.对主人} rows={2} active={activeTab === 'deal'} disabled={disabled} onFocus={() => onFocus('persona-section-对主人')} onChange={(value) => setText('对主人', value)} />
        </section>
        <section className="persona-form-card">
          <h3>底线</h3>
          <RuleListField heading="底线" items={form.fields.底线} disabled={disabled} onFocus={() => onFocus('persona-section-底线')} onChange={(value) => setList('底线', value)} />
        </section>
      </div>
    </div>
  );

  const otherFields = (
    <div className="persona-form-grid">
      <section className="persona-form-card persona-other-card">
        <div className="persona-parameter-placeholder-heading">
          <h3>其他小节</h3><span className="muted">{form.other.length} 段</span>
        </div>
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
              <AutoGrowTextarea
                id={`persona-other-text-${index}`}
                value={section.text}
                rows={3}
                active={activeTab === 'other'}
                disabled={disabled}
                onFocus={() => onFocus(`persona-other-section-${index}`)}
                onChange={(value) => setOther(index, { text: value })}
              />
              <button className="text-button persona-remove-other" type="button" disabled={disabled} onClick={() => onChange({ ...form, other: form.other.filter((_, itemIndex) => itemIndex !== index) })}>删除小节</button>
            </div>
          ))}
          <button className="persona-rule-add" type="button" disabled={disabled} onClick={() => onChange({ ...form, other: [...form.other, { heading: '', text: '' }] })}>+ 添加小节</button>
        </div>
      </section>
    </div>
  );

  return (
    <div className="persona-fields-panels">
      <section className="persona-fields-panel" role="tabpanel" aria-labelledby="persona-editor-tab-who" hidden={activeTab !== 'who'}>
        {whoFields}
      </section>
      <section className="persona-fields-panel" role="tabpanel" aria-labelledby="persona-editor-tab-deal" hidden={activeTab !== 'deal'}>
        {relationshipFields}
      </section>
      <section className="persona-fields-panel" role="tabpanel" aria-labelledby="persona-editor-tab-parameters" hidden={activeTab !== 'parameters'}>
        <PersonaParametersPanel parameterTab={parameterTab} onParameterTabChange={onParameterTabChange} form={form} onChange={onChange} personaId={personaId} previewAccountId={previewAccountId} disabled={disabled} active={activeTab === 'parameters'} />
      </section>
      <section className="persona-fields-panel" role="tabpanel" aria-labelledby="persona-editor-tab-other" hidden={activeTab !== 'other'}>
        {otherFields}
      </section>
    </div>
  );
}
