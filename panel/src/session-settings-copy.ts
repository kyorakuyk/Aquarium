export type SessionSettingsPanelKind = 'global' | 'group' | 'private';

export interface SessionSettingsPanelCopy {
  eyebrow?: string;
  identifier?: string;
  noteTitle: string;
  nicknameTitle: string;
}

export function sessionSettingsPanelCopy(kind: SessionSettingsPanelKind, id: string): SessionSettingsPanelCopy {
  if (kind === 'global') {
    return {
      noteTitle: '补充说明（全部会话）',
      nicknameTitle: '触发昵称（全部会话）',
    };
  }
  return {
    eyebrow: kind === 'group' ? '群聊' : '好友',
    identifier: id,
    noteTitle: kind === 'private' ? '对这个人的补充说明' : '在这个群里的补充说明',
    nicknameTitle: '叫它的名字',
  };
}

export interface SessionSettingsInheritanceCopy {
  statusLabel: string;
  restoreLabel?: string;
}

export function sessionSettingsInheritanceCopy(kind: SessionSettingsPanelKind, overridden: boolean): SessionSettingsInheritanceCopy | undefined {
  if (kind === 'global') return undefined;
  const scopeLabel = kind === 'group' ? '本群' : '本会话';
  return {
    statusLabel: overridden ? `${scopeLabel}覆盖` : '继承全局',
    ...(overridden ? { restoreLabel: '恢复继承' } : {}),
  };
}

export function sessionNoteSummary(value: string, kind: SessionSettingsPanelKind, overridden: boolean): string {
  const note = value.trim();
  if (note) return note.slice(0, 20);
  if (kind === 'global') return '未填写';
  if (overridden) return '已清空';
  return '未填写 · 继承全局';
}
