import { Tray } from '@trayjs/trayjs';
import { parentPort, workerData } from 'node:worker_threads';
import { startTrayWorker, type TrayWorkerData } from './tray-worker-runtime.ts';

if (!parentPort) throw new Error('托盘 worker 必须在 Worker 线程内运行。');

const trayWorkerData = workerData as TrayWorkerData;
if (typeof trayWorkerData?.assetsDirectory !== 'string' || typeof trayWorkerData.qqExePath !== 'string') {
  throw new Error('托盘 worker 配置无效。');
}

startTrayWorker(Tray, parentPort, trayWorkerData);
