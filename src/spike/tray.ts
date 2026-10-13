import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Icon, MenuItem, TrayOptions as LibraryTrayOptions } from '@trayjs/trayjs';

interface TrayHandle {
  on(event: 'close', listener: (code: number | null) => void): unknown;
  setIcon(icon: Icon): void;
  quit(): void;
}

type TrayConstructor = new (options: LibraryTrayOptions) => TrayHandle;
type ExitProcess = (code: number) => void;

const colors = ['teal', 'yellow', 'red'] as const;

export function createTraySpike(
  Tray: TrayConstructor,
  assetsDirectory: string,
  exit: ExitProcess,
): { tray: TrayHandle; dispose: () => void } {
  let colorIndex = 0;
  let exitCalled = false;
  let quitRequested = false;
  const icon = (color: (typeof colors)[number]): Icon => ({
    // 本 spike 只在 Windows 使用 ICO；png 字段是跨平台库接口要求但不会被 Windows helper 使用。
    png: '',
    ico: path.join(assetsDirectory, `${color}.ico`),
  });

  let tray: TrayHandle;
  tray = new Tray({
    tooltip: '水族箱',
    icon: icon(colors[colorIndex]),
    onMenuRequested: (): MenuItem[] => [
      { id: 'status', title: '状态：测试中', enabled: false },
      { id: 'switch-color', title: '切换颜色' },
      { id: 'quit', title: '退出' },
    ],
    onClicked: (id) => {
      if (id === 'switch-color') {
        colorIndex = (colorIndex + 1) % colors.length;
        tray.setIcon(icon(colors[colorIndex]));
      } else if (id === 'quit') {
        quitRequested = true;
        tray.quit();
      }
    },
  });
  tray.on('close', (code) => {
    if (exitCalled) return;
    exitCalled = true;
    exit(quitRequested && code === 0 ? 0 : code && code !== 0 ? code : 1);
  });

  return {
    tray,
    dispose: () => {
      quitRequested = true;
      tray.quit();
    },
  };
}

async function startTraySpike(): Promise<void> {
  const { Tray } = await import('@trayjs/trayjs');
  const assetsDirectory = fileURLToPath(new URL('../../assets/tray/', import.meta.url));
  createTraySpike(Tray, assetsDirectory, (code) => {
    process.exit(code);
  });
}

const entryPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (entryPath === import.meta.url) {
  void startTraySpike().catch((error: unknown) => {
    console.error(`托盘 spike 启动失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
