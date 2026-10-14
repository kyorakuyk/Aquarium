import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const AUTOSTART_MARKER = "' Aquarium managed autostart script v1";

function escapeVbsString(value) {
  if (value.includes('\r') || value.includes('\n') || value.includes('\0')) {
    throw new TypeError('VBS string contains a forbidden control character');
  }
  return value.replaceAll('"', '""');
}

export function buildAutostartVbs({ nodePath, repoDir }) {
  const command = `"${nodePath}" --env-file-if-exists=.env src\\app\\main.ts`;
  return [
    AUTOSTART_MARKER,
    'Set WshShell = CreateObject("WScript.Shell")',
    `WshShell.CurrentDirectory = "${escapeVbsString(repoDir)}"`,
    `WshShell.Run "${escapeVbsString(command)}", 0, False`,
    '',
  ].join('\r\n');
}

export function resolveStartupScriptPath(appDataDir = process.env.APPDATA) {
  if (!appDataDir) throw new Error('APPDATA is not set');
  return path.join(appDataDir, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Aquarium.vbs');
}

function fileStatsOrUndefined(scriptPath) {
  try {
    return lstatSync(scriptPath);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function assertAquariumOwnedFile(scriptPath) {
  const stats = lstatSync(scriptPath);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('Startup file is not managed by Aquarium');
  const content = readFileSync(scriptPath, 'utf8');
  if (!content.startsWith(AUTOSTART_MARKER)) throw new Error('Startup file is not managed by Aquarium');
}

export function installAutostartScript(scriptPath, content) {
  if (typeof content !== 'string' || !content.startsWith(AUTOSTART_MARKER)) {
    throw new TypeError('Autostart content is missing the Aquarium ownership marker');
  }
  mkdirSync(path.dirname(scriptPath), { recursive: true });
  let stats = fileStatsOrUndefined(scriptPath);
  if (!stats) {
    try {
      writeFileSync(scriptPath, content, { encoding: 'utf8', flag: 'wx' });
      return 'created';
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error;
      stats = fileStatsOrUndefined(scriptPath);
      if (!stats) throw error;
    }
  }
  assertAquariumOwnedFile(scriptPath);
  writeFileSync(scriptPath, content, 'utf8');
  return 'updated';
}

export function uninstallAutostartScript(scriptPath) {
  if (!fileStatsOrUndefined(scriptPath)) return false;
  assertAquariumOwnedFile(scriptPath);
  rmSync(scriptPath);
  return true;
}

function installAutostart() {
  const scriptPath = resolveStartupScriptPath();
  const outcome = installAutostartScript(
    scriptPath,
    buildAutostartVbs({ nodePath: process.execPath, repoDir: process.cwd() }),
  );
  console.info(`${outcome === 'created' ? '已安装' : '已更新'}启动脚本：${scriptPath}`);
}

function uninstallAutostart() {
  const scriptPath = resolveStartupScriptPath();
  const existed = uninstallAutostartScript(scriptPath);
  console.info(existed ? `已移除启动脚本：${scriptPath}` : `启动脚本不存在：${scriptPath}`);
}

function main() {
  const action = process.argv[2];
  if (action !== 'install' && action !== 'uninstall') {
    console.error('用法：node scripts/autostart.mjs <install|uninstall>');
    process.exitCode = 2;
    return;
  }
  try {
    if (action === 'install') installAutostart();
    else uninstallAutostart();
  } catch (error) {
    const name = error instanceof Error ? error.name : 'UnknownError';
    console.error(`自启动操作失败：${name}`);
    process.exitCode = 1;
  }
}

const isDirectInvocation = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isDirectInvocation) main();
