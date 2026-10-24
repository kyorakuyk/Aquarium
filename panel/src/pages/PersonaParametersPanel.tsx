import { PERSONA_PARAMETER_PLACEHOLDERS, PERSONA_PARAMETER_TABS, type PersonaParameterTab } from '../persona-page-tabs.ts';
import type { PersonaSectionsForm } from '../persona-sections.ts';
import { PersonaAffinityEditor } from './PersonaAffinityEditor.tsx';
import { PersonaEnergyEditor } from './PersonaEnergyEditor.tsx';

export function PersonaParametersPanel({
  parameterTab,
  onParameterTabChange,
  form,
  onChange,
  personaId,
  previewAccountId,
  disabled,
  active,
}: {
  parameterTab: PersonaParameterTab;
  onParameterTabChange: (tab: PersonaParameterTab) => void;
  form: PersonaSectionsForm;
  onChange: (form: PersonaSectionsForm) => void;
  personaId: string;
  previewAccountId: number | null;
  disabled: boolean;
  active: boolean;
}) {
  const placeholder = parameterTab === 'affinity' || parameterTab === 'energy'
    ? undefined
    : PERSONA_PARAMETER_PLACEHOLDERS[parameterTab];

  return (
    <div className="persona-form-grid">
      <nav className="persona-parameter-tabs" aria-label="参数子页签">
        {PERSONA_PARAMETER_TABS.map((tab) => (
          <button
            className={parameterTab === tab.id ? 'is-active' : ''}
            type="button"
            aria-pressed={parameterTab === tab.id}
            key={tab.id}
            onClick={() => onParameterTabChange(tab.id)}
          >
            {tab.label}{'badge' in tab && tab.badge && <small>{tab.badge}</small>}
          </button>
        ))}
      </nav>
      {parameterTab === 'affinity'
        ? active && <PersonaAffinityEditor form={form} onChange={onChange} personaId={personaId} previewAccountId={previewAccountId} disabled={disabled} />
        : parameterTab === 'energy'
          ? active && <PersonaEnergyEditor form={form} onChange={onChange} previewAccountId={previewAccountId} disabled={disabled} />
          : placeholder && <section className="persona-form-card persona-parameter-placeholder" aria-labelledby="persona-parameter-placeholder-title">
          <header className="persona-parameter-placeholder-heading">
            <h3 id="persona-parameter-placeholder-title">{placeholder.title}</h3>
            <span className="muted">占位 · 还没做</span>
          </header>
          <p className="persona-form-hint">{placeholder.description}</p>
          <p className="persona-form-hint">以后放在这里</p>
          <div className="persona-placeholder-rows">
            {placeholder.items.map((item) => (
              <div className="persona-placeholder-row" key={item.name}>
                <strong>{item.name}</strong><span>{item.note}</span><span className="persona-placeholder-current">{item.current}</span>
              </div>
            ))}
          </div>
          <div className="persona-placeholder-dependency">{placeholder.dependency}</div>
        </section>}
    </div>
  );
}
