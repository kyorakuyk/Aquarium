import { OneBotAdapter } from '../adapters/onebot/adapter.ts';
import type { Segment } from '../core/shared/events.ts';

const snowlumaDir = process.env.SNOWLUMA_DIR;
const account = Number(process.env.BOT_UIN);
if (!snowlumaDir || !Number.isSafeInteger(account) || account <= 0) {
  console.error('请先在 .env 中设置 SNOWLUMA_DIR 与 BOT_UIN（可参考 .env.example）');
  process.exit(1);
}

const adapter = new OneBotAdapter({ account, snowlumaDir });
adapter.onStatus((status) => console.log(`OneBot 状态：${status}`));
adapter.onMessage(async (incoming) => {
  const preview = incoming.plainText.length > 60
    ? `${incoming.plainText.slice(0, 60)}…`
    : incoming.plainText;
  console.log(`[${new Date().toLocaleTimeString()}] ${incoming.senderName}(${incoming.senderId}): ${preview}`);

  if (incoming.plainText.trim() !== '/aq ping') return;
  const response: Segment[] = incoming.session.kind === 'group'
    ? [
      { type: 'reply', messageId: incoming.messageId },
      { type: 'text', text: 'pong 🐟 水族箱已连接' },
    ]
    : [{ type: 'text', text: 'pong 🐟 水族箱已连接' }];
  await adapter.send(incoming.session, response);
  console.log('  → 已回复 pong');
});

console.log(`正在连接账号 ${account} ...`);
await adapter.connect();
console.log(`已连接：OneBot(${account})。私聊小号发送 “/aq ping” 验证回复，Ctrl+C 退出。`);

process.on('SIGINT', () => {
  console.log('\n断开连接');
  adapter.close();
  process.exit(0);
});
