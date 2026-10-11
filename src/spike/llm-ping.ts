import { loadConfig } from '../config/load.ts';
import { openDatabase } from '../store/db.ts';
import { createRepository } from '../store/repository.ts';
import { callSlot } from '../llm/slots.ts';

const config = loadConfig();
const database = openDatabase();
const repository = createRepository(database);

try {
  const result = await callSlot('reply', [{ role: 'user', content: '你好' }], {
    config,
    costToday: () => repository.costToday(),
    recordUsage: (usage) => repository.recordUsage(usage),
  });

  console.log(`模型：${result.provider}/${result.model}`);
  console.log(`回复：${result.text}`);
  console.log(`用量：输入 ${result.usage.inputTokens}，缓存 ${result.usage.cachedTokens}，输出 ${result.usage.outputTokens}，估算 ¥${result.usage.costCny}`);
} catch (error) {
  const message = error instanceof Error ? error.message : '未知错误';
  console.error(`模型测试失败：${message}`);
  process.exitCode = 1;
} finally {
  database.close();
}
