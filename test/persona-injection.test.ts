import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parsePersonaMarkdown } from '../src/persona/load.ts';
import { prepareSandboxPersona } from '../src/panel-server/sandbox-persona.ts';
import { promptTemplateStore } from '../src/core/prompt/templates.ts';
import {
  matchesPersonaMustReply,
  personaAudienceTierFromAffinity,
  personaSegmentingLimits,
  renderPersonaPrompt,
} from '../src/persona/injection.ts';

function personaSource(options: {
  name?: string;
  speechMode?: 'normal' | 'restricted';
  hard?: string;
  body?: string;
} = {}): string {
  return [
    '---',
    `name: ${options.name ?? '小鲸鱼妈妈精简版'}`,
    'aliases: [测试鱼]',
    'identity:',
    '  kind: 群聊角色',
    '  selfAwareness: 知道自己是 AI',
    '  nameRule: user-assigned',
    'appearance:',
    '  immutable: [APPEARANCE_NOT_INJECTED]',
    'traits: { order: 0, morality: 0, talk: 0, mind: 0 }',
    'speech:',
    '  firstPerson: SPEECH_KEEP',
    '  length: { min: 1, max: 150 }',
    '  segmenting: multi',
    '  catchphrases: [CATCHPHRASE_KEEP]',
    '  forbidden: [MARKDOWN_KEEP]',
    '  vocabulary: [嘎嘎, 咕咕]',
    `speechMode: ${options.speechMode ?? 'normal'}`,
    'audience:',
    '  stranger: AUDIENCE_STRANGER',
    '  acquaintance: AUDIENCE_ACQUAINTANCE',
    '  close: AUDIENCE_CLOSE',
    'modes:',
    '  - name: 闲聊',
    '    trigger: 默认',
    '    behavior: MODE_CASUAL',
    '  - name: 认真',
    '    trigger: [身体不适, 正经求助]',
    '    behavior: MODE_SERIOUS',
    'reactions:',
    '  - { trigger: 妈妈, response: REACTION_SHORT }',
    '  - { trigger: 蓝色大肥鱼, response: REACTION_LONG }',
    'reply:',
    '  mustReply: [被@, 身体不适]',
    'boundaries:',
    `  hard: ["${options.hard ?? 'HARD_KEEP 不编造查询结果'}"]`,
    'examples:',
    '  - scene: 熬夜',
    '    input: 还没睡？',
    '    bad: BAD_EXAMPLE',
    '    good: MATCHED_EXAMPLE',
    '  - scene: 晚饭',
    '    input: 今晚吃什么？',
    '    bad: OTHER_BAD_EXAMPLE',
    '    good: OTHER_EXAMPLE',
    '---',
    options.body ?? '简短背景。',
  ].join('\n');
}

test('人设注入只选当前 audience、命中模式、单条 reaction 与场景 top-k 示例', () => {
  const persona = parsePersonaMarkdown(personaSource());
  const rendered = renderPersonaPrompt(persona, {
    audienceTier: 'acquaintance',
    messageText: '身体不适，还没睡？妈妈，蓝色大肥鱼',
    exampleTopK: 1,
  });

  assert.ok(rendered.includes('AUDIENCE_ACQUAINTANCE'));
  assert.ok(!rendered.includes('AUDIENCE_STRANGER'));
  assert.ok(!rendered.includes('AUDIENCE_CLOSE'));
  assert.ok(rendered.includes('MODE_SERIOUS'));
  assert.ok(!rendered.includes('MODE_CASUAL'));
  assert.ok(rendered.includes('REACTION_LONG'));
  assert.ok(!rendered.includes('REACTION_SHORT'));
  assert.ok(rendered.includes('MATCHED_EXAMPLE'));
  assert.ok(!rendered.includes('OTHER_EXAMPLE'));
  assert.ok(!rendered.includes('APPEARANCE_NOT_INJECTED'));
});

test('restricted 人设只注入词表，不注入自然语言分条和长度规则', () => {
  const persona = parsePersonaMarkdown(personaSource({ name: '高松灯', speechMode: 'restricted' }));
  const rendered = renderPersonaPrompt(persona, { messageText: '普通消息' });

  assert.ok(rendered.includes('嘎嘎'));
  assert.ok(rendered.includes('咕咕'));
  assert.ok(!rendered.includes('分条'));
  assert.ok(!rendered.includes('长度'));
  assert.ok(!rendered.includes('SPEECH_KEEP'));
  assert.ok(!rendered.includes('MARKDOWN_KEEP'));
});

test('总注入不超 6000 字符，截断优先保留 hard boundaries 与 speech', () => {
  const persona = parsePersonaMarkdown(personaSource({
    name: '祀（温柔版）',
    hard: `祀硬底线保留${'硬'.repeat(7000)}`,
    body: `BACKGROUND_START${'背景'.repeat(3000)}BACKGROUND_TAIL`,
  }));
  const rendered = renderPersonaPrompt(persona, { messageText: '普通消息' });

  assert.ok(Array.from(rendered).length <= 6000);
  assert.ok(rendered.includes('祀硬底线保留'));
  assert.ok(rendered.includes('SPEECH_KEEP'));
  assert.ok(rendered.includes('BACKGROUND_START'));
  assert.ok(!rendered.includes('BACKGROUND_TAIL'));
});

test('旧式纯正文人设仍原样返回', () => {
  const legacyText = '\n  旧人设正文  \n';
  const persona = parsePersonaMarkdown(legacyText);
  assert.equal(renderPersonaPrompt(persona), legacyText);
});

test('好感等级映射到 stranger、acquaintance、close 三个 audience 层', () => {
  assert.equal(personaAudienceTierFromAffinity('cold'), 'stranger');
  assert.equal(personaAudienceTierFromAffinity('cool'), 'stranger');
  assert.equal(personaAudienceTierFromAffinity('neutral'), 'acquaintance');
  assert.equal(personaAudienceTierFromAffinity('warm'), 'acquaintance');
  assert.equal(personaAudienceTierFromAffinity('close'), 'close');
  assert.equal(personaAudienceTierFromAffinity(undefined), undefined);
});

test('mustReply 按声明短语或真实的 @ 触发匹配', () => {
  const persona = parsePersonaMarkdown(personaSource());
  assert.equal(matchesPersonaMustReply(persona.profile, { plainText: '身体不适', mentionsSelf: false }), true);
  assert.equal(matchesPersonaMustReply(persona.profile, { plainText: '普通闲聊', mentionsSelf: false }), false);
  assert.equal(matchesPersonaMustReply(persona.profile, { plainText: '普通闲聊', mentionsSelf: true }), true);
});

test('结构化 segmenting 和 length 覆盖旧分条限制', () => {
  const persona = parsePersonaMarkdown(personaSource());
  assert.deepEqual(personaSegmentingLimits(persona.profile, { maxParts: 1, maxPartLength: 80 }), {
    maxParts: 3,
    maxPartLength: 150,
  });
  const single = parsePersonaMarkdown(personaSource()).profile;
  if (!single) assert.fail('结构化人设应加载 profile');
  single.speech.segmenting = 'one_message';
  assert.deepEqual(personaSegmentingLimits(single, { maxParts: 3, maxPartLength: 80 }), {
    maxParts: 1,
    maxPartLength: 150,
  });
});

test('panel sandbox 使用结构化人设注入和发送分段设置', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-persona-sandbox-'));
  fs.mkdirSync(path.join(root, 'personas'), { recursive: true });
  fs.writeFileSync(path.join(root, 'personas', 'sandbox.md'), personaSource(), 'utf8');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const sandboxPersona = prepareSandboxPersona({
    personaId: 'sandbox',
    nickname: '测试鱼',
    root,
    asOwner: true,
    settings: { talkOffset: 0 },
    traitsTemplate: promptTemplateStore.get().traits,
    body: { text: '普通消息', history: [] },
  });

  assert.ok(sandboxPersona.prompt.includes('AUDIENCE_CLOSE'));
  assert.deepEqual(
    { maxParts: sandboxPersona.maxParts, maxPartLength: sandboxPersona.maxPartLength },
    { maxParts: 3, maxPartLength: 150 },
  );
});
