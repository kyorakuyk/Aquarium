import { PERSONA_EDITOR_TABS, type PersonaEditorTab } from '../persona-page-tabs.ts';

export function PersonaEditorToolbar({
  title,
  detail,
  saveLabel,
  dirty,
  busy,
  canRestore,
  canBind,
  canSave,
  activeTab,
  onRestore,
  onTryChat,
  onBind,
  onSave,
  onTabChange,
}: {
  title: string;
  detail: string;
  saveLabel: string;
  dirty: boolean;
  busy: boolean;
  canRestore: boolean;
  canBind: boolean;
  canSave: boolean;
  activeTab: PersonaEditorTab;
  onRestore: () => void;
  onTryChat: () => void;
  onBind: () => void;
  onSave: () => void;
  onTabChange: (tab: PersonaEditorTab) => void;
}) {
  return (
    <div className="persona-editor-sticky">
      <div className="persona-editor-heading">
        <div><h2>{title}</h2><p className="muted">{detail}</p></div>
        <div className="persona-save-actions">
          <span className={dirty ? 'is-dirty' : ''}>{saveLabel}</span>
          <button className="text-button" type="button" disabled={busy || !canRestore} onClick={onRestore}>还原</button>
          <button className="text-button" type="button" onClick={onTryChat}>去试聊</button>
          <button className="button button-secondary" type="button" disabled={busy || !canBind} onClick={onBind}>切换为此人设</button>
          <button className="button button-primary" type="button" disabled={busy || !canSave} onClick={onSave}>保存</button>
        </div>
      </div>
      <nav className="persona-editor-tabs" aria-label="人设编辑页签">
        {PERSONA_EDITOR_TABS.map((tab) => (
          <button
            className={activeTab === tab.id ? 'is-active' : ''}
            id={`persona-editor-tab-${tab.id}`}
            type="button"
            aria-pressed={activeTab === tab.id}
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
          >{tab.label}</button>
        ))}
      </nav>
    </div>
  );
}
