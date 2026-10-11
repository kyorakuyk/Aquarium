/**
 * Spike：验证 Node + @snowluma/sdk 能否通过 SnowLuma 收发消息。
 *
 * 行为（刻意做得很“安静”，不会打扰真实群聊）：
 *   1. 从 SnowLuma 的 config/onebot_<BOT_UIN>.json 读取 WebSocket 端口与 token（不复制密钥）。
 *   2. 连接后校验登录账号必须是 BOT_UIN，否则立即退出（防止误接主号）。
 *   3. 打印收到的每条消息（只打印摘要）。
 *   4. 只有收到内容恰好为 “/aq ping” 的消息时，才回复一句 pong。
 *
 * 运行：npm run spike:ping   （Ctrl+C 退出）
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SnowLumaWebSocketClient, text } from '@snowluma/sdk';

const snowlumaDir = process.env.SNOWLUMA_DIR;
const botUin = Number(process.env.BOT_UIN);
if (!snowlumaDir || !botUin) {
  console.error('请先在 .env 中设置 SNOWLUMA_DIR 与 BOT_UIN（可参考 .env.example）');
  process.exit(1);
}

interface WsServerConfig {
  host: string;
  port: number;
  path: string;
  accessToken?: string;
}

const configPath = join(snowlumaDir, 'config', `onebot_${botUin}.json`);
const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
  networks: { wsServers: WsServerConfig[] };
};
const ws = config.networks.wsServers[0];
if (!ws) {
  console.error(`${configPath} 中没有配置 WebSocket 服务端（wsServers），请在 SnowLuma WebUI 里添加一个`);
  process.exit(1);
}
const url = `ws://${ws.host}:${ws.port}${ws.path || '/'}`;

const bot = new SnowLumaWebSocketClient({
  url,
  accessToken: ws.accessToken || undefined,
  reconnect: true,
});

bot.onMessage(async (event, ctx) => {
  const where = event.message_type === 'group' ? `群 ${event.group_id}` : '私聊';
  const who = `${event.sender?.nickname ?? '?'}(${event.user_id})`;
  const preview = event.raw_message.length > 60 ? `${event.raw_message.slice(0, 60)}…` : event.raw_message;
  console.log(`[${new Date().toLocaleTimeString()}] ${where} ${who}: ${preview}`);

  if (event.raw_message.trim() === '/aq ping') {
    await ctx.reply(text('pong 🐟 水族箱已连接'));
    console.log('  → 已回复 pong');
  }
});

console.log(`正在连接 ${url} ...`);
await bot.connect();

const login = await bot.getLoginInfo();
if (Number(login.user_id) !== botUin) {
  console.error(`登录账号是 ${login.user_id}，与 BOT_UIN=${botUin} 不一致，拒绝工作。`);
  bot.close();
  process.exit(1);
}
console.log(`已连接：${login.nickname}(${login.user_id})。在任意已开启的会话里发送 “/aq ping” 测试回复，Ctrl+C 退出。`);

process.on('SIGINT', () => {
  console.log('\n断开连接');
  bot.close();
  process.exit(0);
});
