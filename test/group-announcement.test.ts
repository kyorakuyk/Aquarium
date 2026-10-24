import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { decodeGroupAnnouncement } from '../panel/src/group-announcement.ts';

const panel = readFileSync(new URL('../panel/src/components/QqGroupProfilePanel.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../panel/src/styles/qq-profiles.css', import.meta.url), 'utf8');

test('QQ announcements decode named and numeric entities once and retain newlines', () => {
  const raw = 'Group&nbsp;notice|&#92;|&#10;next|&#039;|&amp;|&quot;x&quot;|&lt;img src=x onerror=alert(1)&gt;|&amp;#10;|&#x1F642;|&constructor;';
  assert.equal(decodeGroupAnnouncement(raw), 'Group\u00a0notice|\\|\nnext|\'|&|"x"|<img src=x onerror=alert(1)>|&#10;|🙂|&constructor;');
});

test('QQ announcement renders as text with preserved line breaks, not as HTML', () => {
  assert.equal(panel.includes("import { decodeGroupAnnouncement } from '../group-announcement.ts';"), true);
  assert.equal(panel.includes(`<p className="qq-profile-announcement">{profile?.latestNotice ? decodeGroupAnnouncement(profile.latestNotice) : '—'}</p>`), true);
  assert.equal(/dangerouslySetInnerHTML|innerHTML/u.test(panel), false);
  assert.equal(/\.qq-profile-announcement\s*\{[^}]*white-space:\s*pre-wrap/su.test(styles), true);
});
