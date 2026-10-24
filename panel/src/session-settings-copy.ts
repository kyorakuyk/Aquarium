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
