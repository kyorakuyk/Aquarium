import { InfoTip } from '../components/InfoTip.tsx';

type SessionKind = 'global' | 'group' | 'private';

export function SessionFieldHeading({
  title,
  help,
  kind,
  overridden,
  onRestore,
}: {
  title: string;
  help?: string;
  kind: SessionKind;
  overridden: boolean;
  onRestore: () => void;
}) {
  const scopeLabel = kind === 'group' ? '本群' : '本会话';
  return (
    <div className="field-heading">
      <div className="field-heading-title">
        <h3>{title}</h3>
        {help && <InfoTip label={`${title}说明`} text={help} />}
        {kind !== 'global' && overridden && (
          <details className="field-override-menu">
            <summary title={`${scopeLabel}有覆盖项`} aria-label={`${title}被${scopeLabel}覆盖；打开菜单恢复继承`}><span className="override-dot" /></summary>
            <div className="field-override-popover" role="menu">
              <button type="button" role="menuitem" onClick={(event) => { onRestore(); event.currentTarget.closest('details')?.removeAttribute('open'); }}>恢复继承</button>
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
