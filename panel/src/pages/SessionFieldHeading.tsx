import { InfoTip } from '../components/InfoTip.tsx';
import { sessionSettingsInheritanceCopy, type SessionSettingsPanelKind } from '../session-settings-copy.ts';

type SessionKind = SessionSettingsPanelKind;

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
  const inheritance = sessionSettingsInheritanceCopy(kind, overridden);
  return (
    <div className="field-heading">
      <div className="field-heading-title">
        <h3>{title}</h3>
        {help && <InfoTip label={`${title}说明`} text={help} />}
      </div>
      {inheritance && <div className="field-inheritance-state" data-overridden={overridden}>
        <span>{inheritance.statusLabel}</span>
        {inheritance.restoreLabel && <button className="text-button" type="button" aria-label={`${title}恢复继承`} onClick={onRestore}>{inheritance.restoreLabel}</button>}
      </div>}
    </div>
  );
}
