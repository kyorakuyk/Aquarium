import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { sessionSettingsPanelCopy } from '../panel/src/session-settings-copy.ts';

const sessionSettingsPanel = readFileSync(new URL('../panel/src/pages/SessionSettingsPanel.tsx', import.meta.url), 'utf8');

test('session detail header uses the shared peer label and carries group member count', () => {
  assert.deepEqual(sessionSettingsPanelCopy('group', '2718002251:group:1004200446', 17), {
    eyebrow: '群聊',
    identifier: '1004200446 · 17 人',
    noteTitle: '在这个群里的补充说明',
    nicknameTitle: '叫它的名字',
  });
  assert.deepEqual(sessionSettingsPanelCopy('private', '2718002251:private:123456789'), {
    eyebrow: '好友',
    identifier: '123456789',
    noteTitle: '对这个人的补充说明',
    nicknameTitle: '叫它的名字',
  });
  assert.match(sessionSettingsPanel, /memberCount: session\.memberCount/u);
  assert.match(sessionSettingsPanel, /sessionSettingsPanelCopy\(target\.kind, target\.id, target\.memberCount\)/u);
});
