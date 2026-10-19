import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  bindPromptTemplateReload,
  createPromptTemplateStore,
  promptTemplateStore,
} from '../src/core/prompt-templates.ts';

function copyPromptTemplates(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-prompt-templates-'));
  fs.copyFileSync(path.resolve('prompts/reply-system.md'), path.join(root, 'reply-system.md'));
  fs.copyFileSync(path.resolve('prompts/judge.md'), path.join(root, 'judge.md'));
  fs.copyFileSync(path.resolve('prompts/vision.md'), path.join(root, 'vision.md'));
  fs.copyFileSync(path.resolve('prompts/sticker-describe.md'), path.join(root, 'sticker-describe.md'));
  fs.copyFileSync(path.resolve('prompts/appraise.md'), path.join(root, 'appraise.md'));
  fs.copyFileSync(path.resolve('prompts/affect.md'), path.join(root, 'affect.md'));
  fs.copyFileSync(path.resolve('prompts/traits.md'), path.join(root, 'traits.md'));
  fs.copyFileSync(path.resolve('prompts/sleep.md'), path.join(root, 'sleep.md'));
  fs.copyFileSync(path.resolve('prompts/extract-tags.md'), path.join(root, 'extract-tags.md'));
  fs.copyFileSync(path.resolve('prompts/persona-import.md'), path.join(root, 'persona-import.md'));
  return root;
}

test('startup template load hashes raw bytes and parses the exact vision and judge prompts', () => {
  const templates = promptTemplateStore.get();
  const replyBytes = fs.readFileSync(path.resolve('prompts/reply-system.md'));
  const judgeBytes = fs.readFileSync(path.resolve('prompts/judge.md'));
  const visionBytes = fs.readFileSync(path.resolve('prompts/vision.md'));

  assert.equal(templates.replySystem.version, createHash('sha256').update(replyBytes).digest('hex').slice(0, 8));
  assert.equal(templates.judge.version, createHash('sha256').update(judgeBytes).digest('hex').slice(0, 8));
  assert.equal(templates.vision.version, createHash('sha256').update(visionBytes).digest('hex').slice(0, 8));
  assert.ok(templates.vision.system.includes('{"kind": "sticker|photo|screenshot|other", "desc": "...", "text": "...", "legible": true}'));
  assert.ok(templates.vision.system.includes('不超过60字'));
  assert.ok(templates.vision.system.includes('最多200字'));
  assert.ok(templates.vision.system.includes('必须逐字转写'));
  assert.ok(templates.vision.system.includes('不要翻译或概括'));
  assert.ok(templates.vision.system.includes('看不清的字不要猜'));
  assert.ok(templates.vision.system.includes('legible'));
  assert.ok(templates.vision.user.includes('只输出 JSON'));
  assert.ok(templates.judge.system.includes('严格 JSON'));
  assert.ok(templates.judge.user.includes('{{context}}'));
  assert.equal(templates.traits.order.m2, '你很讲规矩，说话做事有条理，不爱乱开话题。');
  assert.equal(templates.traits.talk.p2, '你是个话痨，什么都想插一句。');
  assert.deepEqual({ humor: templates.traits.humor, openness: templates.traits.openness, imitation: templates.traits.imitation }, {
    humor: {
      m2: '你很正经，几乎不开玩笑，说话一板一眼。',
      m1: '你偏正经，偶尔才开个玩笑。',
      p1: '你有点脱线，时不时冒出奇怪的点子。',
      p2: '你很脱线，脑回路清奇，常常一本正经地胡说八道。',
    },
    openness: {
      m2: '你很保守，只聊熟悉的话题，对新东西提不起兴趣。',
      m1: '你偏保守，新话题要观察一阵才接。',
      p1: '你挺好奇，对新东西愿意多问一句。',
      p2: '你非常好奇，看到新东西就想刨根问底。',
    },
    imitation: {
      m2: '你说话有自己的一套，很少跟着别人的说法走。',
      m1: '你偏向保持自己的说话方式。',
      p1: '你挺容易被群里的说法带跑，会跟着用大家的梗。',
      p2: '你很爱学群里的说话方式，新梗听一次就会用。',
    },
  });
  assert.equal(templates.sleep.goodnight.length, 3);
  assert.ok(Object.isFrozen(templates.sleep.goodnight));
  assert.ok(templates.personaImport.system.includes('不得推断、补全或编造'));
  assert.ok(templates.personaImport.user.includes('{{text}}'));
  const stickerBytes = fs.readFileSync(path.resolve('prompts/sticker-describe.md'));
  const stickerDescribe = (templates as unknown as { stickerDescribe?: { version: string; system: string; user: string } }).stickerDescribe;
  assert.ok(stickerDescribe);
  assert.equal(stickerDescribe.version, createHash('sha256').update(stickerBytes).digest('hex').slice(0, 8));
  assert.ok(stickerDescribe.system.includes('JSON'));
  assert.ok(stickerDescribe.user.length > 0);
});

test('persona-import 模板必须声明 text 占位符', () => {
  const root = copyPromptTemplates();
  try {
    const templatePath = path.join(root, 'persona-import.md');
    const source = fs.readFileSync(templatePath, 'utf8');
    fs.writeFileSync(templatePath, source.replace('{{text}}', '{{unknown}}'), 'utf8');
    assert.throws(() => createPromptTemplateStore(root), /未知占位符：unknown/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sleep 模板拒绝空的晚安列表', () => {
  const root = copyPromptTemplates();
  try {
    fs.writeFileSync(path.join(root, 'sleep.md'), '---\ngoodnight: []\n---', 'utf8');
    assert.throws(() => createPromptTemplateStore(root), /goodnight 文本列表/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('配置变更重载模板且无效版本不会替换上一个有效快照', () => {
  const root = copyPromptTemplates();
  try {
    const store = createPromptTemplateStore(root);
    const source = new EventEmitter();
    const errors: unknown[] = [];
    const unsubscribe = bindPromptTemplateReload(source, store, (error) => errors.push(error));
    const initial = store.get();
    const replyPath = path.join(root, 'reply-system.md');
    const originalReply = fs.readFileSync(replyPath, 'utf8');
    const changedReply = originalReply.replace('用口语短句', '用口语短句，表达清晰');
    fs.writeFileSync(replyPath, changedReply, 'utf8');

    source.emit('changed');
    const updated = store.get();
    assert.notEqual(updated.replySystem.version, initial.replySystem.version);
    assert.equal(
      updated.replySystem.version,
      createHash('sha256').update(fs.readFileSync(replyPath)).digest('hex').slice(0, 8),
    );

    fs.writeFileSync(path.join(root, 'vision.md'), 'invalid template', 'utf8');
    source.emit('changed');
    assert.equal(errors.length, 1);
    assert.equal(store.get(), updated);

    fs.writeFileSync(path.join(root, 'judge.md'), "---\nsystem: judge\nuser: '{{other}}'\n---", 'utf8');
    source.emit('changed');
    assert.equal(errors.length, 2);
    assert.equal(store.get(), updated);

    unsubscribe();
    fs.writeFileSync(replyPath, originalReply, 'utf8');
    source.emit('changed');
    assert.equal(store.get(), updated);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('judge 模板热重载更新解析文本和原始文件哈希', () => {
  const root = copyPromptTemplates();
  let unsubscribe = () => {};
  try {
    const store = createPromptTemplateStore(root);
    const source = new EventEmitter();
    const errors: unknown[] = [];
    unsubscribe = bindPromptTemplateReload(source, store, (error) => errors.push(error));
    const initial = store.get().judge;
    const judgePath = path.join(root, 'judge.md');
    const original = fs.readFileSync(judgePath, 'utf8');
    const changed = original.replace(
      '不要输出 Markdown、代码围栏或其他文字。',
      '不要输出 Markdown、代码围栏、前后缀或其他文字。',
    );
    assert.notEqual(changed, original);
    fs.writeFileSync(judgePath, changed, 'utf8');

    source.emit('changed');

    const updated = store.get().judge;
    assert.notEqual(updated.version, initial.version);
    assert.equal(updated.version, createHash('sha256').update(fs.readFileSync(judgePath)).digest('hex').slice(0, 8));
    assert.ok(updated.system.includes('前后缀'));
    assert.equal(errors.length, 0);
  } finally {
    unsubscribe();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reply-system 模板必须声明 modeHint 占位符', () => {
  const root = copyPromptTemplates();
  try {
    const store = createPromptTemplateStore(root);
    const valid = store.get();
    const replyPath = path.join(root, 'reply-system.md');
    const source = fs.readFileSync(replyPath, 'utf8');
    fs.writeFileSync(replyPath, source.replace('{{modeHint}}', ''), 'utf8');

    assert.throws(() => store.reload(), /缺少占位符 \{\{modeHint\}\}/);
    assert.equal(store.get(), valid);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('judge 模板必须声明 context 占位符', () => {
  const root = copyPromptTemplates();
  try {
    const store = createPromptTemplateStore(root);
    const valid = store.get();
    const judgePath = path.join(root, 'judge.md');
    const source = fs.readFileSync(judgePath, 'utf8');
    fs.writeFileSync(judgePath, source.replace('{{context}}', ''), 'utf8');

    assert.throws(() => store.reload(), /缺少占位符 \{\{context\}\}/);
    assert.equal(store.get(), valid);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
