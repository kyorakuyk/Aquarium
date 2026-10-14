import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as autostart from '../scripts/autostart.mjs';

const { buildAutostartVbs, resolveStartupScriptPath } = autostart;

test('VBS 安全引用包含空格和双引号的 Node 与仓库路径', () => {
  const script = buildAutostartVbs({
    nodePath: String.raw`C:\Program Files\Node "Preview"\node.exe`,
    repoDir: String.raw`D:\Work\Aquarium "Night Build"`,
  });

  assert.equal(script, [
    "' Aquarium managed autostart script v1",
    'Set WshShell = CreateObject("WScript.Shell")',
    'WshShell.CurrentDirectory = "D:\\Work\\Aquarium ""Night Build"""',
    'WshShell.Run """C:\\Program Files\\Node ""Preview""\\node.exe"" --env-file-if-exists=.env src\\app\\main.ts", 0, False',
    '',
  ].join('\r\n'));
});

test('启动目录固定为 Windows Startup 下的 Aquarium.vbs', () => {
  const appData = String.raw`C:\Users\tester\AppData\Roaming`;
  assert.equal(
    resolveStartupScriptPath(appData),
    path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Aquarium.vbs'),
  );
});

test('package scripts 和 env 示例声明自启动命令及空 WebUI 密码项', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const envExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');

  assert.equal(packageJson.scripts['autostart:install'], 'node scripts/autostart.mjs install');
  assert.equal(packageJson.scripts['autostart:uninstall'], 'node scripts/autostart.mjs uninstall');
  assert.match(envExample, /^SNOWLUMA_WEBUI_PASSWORD=$/m);
});

test('install 和 uninstall 只更新或移除带 Aquarium 所有权标记的 Startup 文件', () => {
  assert.equal(typeof autostart.installAutostartScript, 'function');
  assert.equal(typeof autostart.uninstallAutostartScript, 'function');
  const root = mkdtempSync(path.join(os.tmpdir(), 'aquarium-autostart-'));
  const scriptPath = path.join(root, 'Startup', 'Aquarium.vbs');
  mkdirSync(path.dirname(scriptPath), { recursive: true });
  const existingContent = 'user-owned startup script\r\n';
  writeFileSync(scriptPath, existingContent, 'utf8');
  const generated = buildAutostartVbs({ nodePath: 'C:\\Node\\node.exe', repoDir: 'C:\\Aquarium' });

  try {
    assert.throws(() => autostart.installAutostartScript(scriptPath, generated), /not managed by Aquarium/u);
    assert.throws(() => autostart.uninstallAutostartScript(scriptPath), /not managed by Aquarium/u);
    assert.equal(readFileSync(scriptPath, 'utf8'), existingContent);

    writeFileSync(scriptPath, generated, 'utf8');
    const updated = buildAutostartVbs({ nodePath: 'C:\\Node\\node.exe', repoDir: 'C:\\Aquarium-new' });
    assert.equal(autostart.installAutostartScript(scriptPath, updated), 'updated');
    assert.equal(readFileSync(scriptPath, 'utf8'), updated);
    assert.equal(autostart.uninstallAutostartScript(scriptPath), true);
    assert.equal(existsSync(scriptPath), false);
    assert.equal(autostart.uninstallAutostartScript(scriptPath), false);
    assert.equal(autostart.installAutostartScript(scriptPath, generated), 'created');
    assert.equal(readFileSync(scriptPath, 'utf8'), generated);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
