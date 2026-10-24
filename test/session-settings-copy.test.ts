import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionSettingsPanelCopy } from '../panel/src/session-settings-copy.ts';

test('global session settings avoid duplicate headings and label shared fields', () => {
  assert.deepEqual(sessionSettingsPanelCopy('global', '__global-defaults__'), {
    noteTitle: '补充说明（全部会话）',
    nicknameTitle: '触发昵称（全部会话）',
  });
  assert.deepEqual(sessionSettingsPanelCopy('group', '900000001:group:123456'), {
    eyebrow: '群聊',
    identifier: '900000001:group:123456',
    noteTitle: '在这个群里的补充说明',
    nicknameTitle: '叫它的名字',
  });
});
