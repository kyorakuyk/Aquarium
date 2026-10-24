import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionNoteSummary, sessionSettingsInheritanceCopy, sessionSettingsPanelCopy } from '../panel/src/session-settings-copy.ts';

test('global session settings avoid duplicate headings and label shared fields', () => {
  assert.deepEqual(sessionSettingsPanelCopy('global', '__global-defaults__'), {
    noteTitle: '补充说明（全部会话）',
    nicknameTitle: '触发昵称（全部会话）',
  });
  assert.deepEqual(sessionSettingsPanelCopy('group', '900000001:group:123456', 17), {
    eyebrow: '群聊',
    identifier: '123456 · 17 人',
    noteTitle: '在这个群里的补充说明',
    nicknameTitle: '叫它的名字',
  });
  assert.deepEqual(sessionSettingsPanelCopy('private', '900000001:private:654321'), {
    eyebrow: '好友',
    identifier: '654321',
    noteTitle: '对这个人的补充说明',
    nicknameTitle: '叫它的名字',
  });
});

test('session settings expose inheritance state with a direct restore action', () => {
  assert.deepEqual(sessionSettingsInheritanceCopy('group', false), { statusLabel: '继承全局' });
  assert.deepEqual(sessionSettingsInheritanceCopy('group', true), { statusLabel: '本群覆盖', restoreLabel: '恢复继承' });
  assert.deepEqual(sessionSettingsInheritanceCopy('private', true), { statusLabel: '本会话覆盖', restoreLabel: '恢复继承' });
  assert.equal(sessionSettingsInheritanceCopy('global', true), undefined);
});

test('empty session notes distinguish inheritance from an explicit cleared override', () => {
  assert.equal(sessionNoteSummary('', 'global', false), '未填写');
  assert.equal(sessionNoteSummary('', 'group', false), '未填写 · 继承全局');
  assert.equal(sessionNoteSummary('', 'group', true), '已清空');
  assert.equal(sessionNoteSummary('', 'private', true), '已清空');
});
