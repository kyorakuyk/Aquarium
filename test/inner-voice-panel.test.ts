import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionId } from '../src/core/shared/events.ts';
import { authHeaders, groupSession, withPanel } from './panel-test-helpers.ts';

function jsonHeaders(): HeadersInit {
  return { ...authHeaders(), 'Content-Type': 'application/json' };
}

test('决策记录把机器人实际正文和关联心声一起返回', async () => {
  await withPanel(async ({ app, repository }) => {
    const session = sessionId(groupSession);
    repository.saveMessage({
      sessionId: session,
      messageId: 'inner-voice-source',
      senderId: 42,
      senderName: '群友',
      isSelf: false,
      plainText: '刚才发生了什么？',
      segments: [{ type: 'text', text: '刚才发生了什么？' }],
      time: 100,
    });
    repository.saveMessage({
      sessionId: session,
      messageId: 'inner-voice-reply',
      senderId: groupSession.account,
      senderName: 'Bot',
      isSelf: true,
      plainText: '我确实记得这件事。',
      segments: [{ type: 'text', text: '我确实记得这件事。' }],
      time: 101,
    });
    repository.saveInnerVoiceForMessage(session, 'inner-voice-reply', ['（心里一直很在意）'], 101);
    repository.recordDecision({
      time: 102,
      sessionId: session,
      messageId: 'inner-voice-source',
      replied: true,
      reason: 'replied',
      detail: { sentMessageIds: ['inner-voice-reply'] },
    });

    const response = await app.request('/api/decisions?limit=10', { headers: authHeaders() });
    const rows = await response.json() as Array<{
      messageId: string;
      replyText?: string | null;
      innerVoice?: string[];
    }>;
    const decision = rows.find((row) => row.messageId === 'inner-voice-source');
    assert.equal(decision?.replyText, '我确实记得这件事。');
    assert.deepEqual(decision?.innerVoice, ['（心里一直很在意）']);
  });
});

test('会话括号心声可以覆盖为隐藏并恢复跟随人设', async () => {
  await withPanel(async ({ app }) => {
    const id = encodeURIComponent(sessionId(groupSession));
    const patch = (innerVoice: unknown) => app.request(`/api/sessions/${id}`, {
      method: 'PATCH',
      headers: jsonHeaders(),
      body: JSON.stringify({ innerVoice }),
    });

    const hidden = await patch('hidden');
    assert.equal(hidden.status, 200);
    const sessionsAfterOverride = await app.request('/api/sessions', { headers: authHeaders() });
    const hiddenSession = (await sessionsAfterOverride.json() as Array<{
      sessionId: string;
      overrides: string[];
      effective: { innerVoice?: string | null };
    }>).find((session) => session.sessionId === sessionId(groupSession));
    assert.equal(hiddenSession?.effective.innerVoice, 'hidden');
    assert.ok(hiddenSession?.overrides.includes('innerVoice'));

    const invalid = await patch('unknown');
    assert.equal(invalid.status, 400);
    assert.equal((await patch(null)).status, 200);
    const sessionsAfterRestore = await app.request('/api/sessions', { headers: authHeaders() });
    const restored = (await sessionsAfterRestore.json() as Array<{
      sessionId: string;
      overrides: string[];
      effective: { innerVoice?: string | null };
    }>).find((session) => session.sessionId === sessionId(groupSession));
    assert.equal(restored?.effective.innerVoice, null);
    assert.ok(!restored?.overrides.includes('innerVoice'));
  });
});
