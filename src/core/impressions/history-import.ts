import { randomUUID } from 'node:crypto';
import type { ProtocolAdapter } from '../../adapters/types.ts';
import type { AquariumConfig } from '../../config/schema.ts';
import { sessionId, type IncomingMessage, type SessionKey } from '../shared/events.ts';
import type { ExtractTagsPromptTemplate } from '../prompt/templates.ts';
import type { MessageStorageRecord, StoreRepository } from '../../store/repository.ts';
import type { ImpressionsService } from './service.ts';
import { extractFailureLabel, type ExtractFailureType } from './extract-error.ts';

const PAGE_SIZE = 50;
const WINDOW_SIZE = 80;
const PAGE_DELAY_MS = 500;
const WINDOW_DELAY_MS = 1_000;
const MAX_CONSECUTIVE_ERRORS = 3;
const CONFIRMATION_TTL_MS = 15 * 60_000;
const TARGETS = new Set([200, 500, 1_000, 2_000]);

export type HistoryImportMode = 'incremental' | 'full';
export type HistoryImportPhase = 'fetching' | 'awaiting_confirmation' | 'extracting' | 'done' | 'cancelled' | 'expired' | 'error';

export interface HistoryImportJob {
  id: string;
  sessionId: string;
  mode: HistoryImportMode;
  phase: HistoryImportPhase;
  fetched: number;
  inserted: number;
  newMessages: number;
  waterlineTime: number | null;
  estimatedCostCny?: number;
  confirmationExpiresAt?: number;
  previewChanged?: boolean;
  windowsDone: number;
  windowsTotal: number;
  windowsFailed: number;
  failureReason?: ExtractFailureType;
  failureHttpStatus?: number;
  tagsInserted: number;
  tagsObserved: number;
  costCny: number;
  error?: string;
  cancelRequested?: boolean;
}

export interface HistoryImportServiceOptions {
  repository: StoreRepository;
  getConfig: () => AquariumConfig;
  impressionsService: ImpressionsService;
  getTemplate: () => ExtractTagsPromptTemplate;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}

export interface HistoryImportService {
  start(input: { session: SessionKey; target: number; adapter: ProtocolAdapter; mode?: HistoryImportMode }): HistoryImportJob | undefined;
  confirm(jobId: string): HistoryImportJob | undefined;
  get(jobId: string): HistoryImportJob | undefined;
  cancel(jobId: string): HistoryImportJob | undefined;
  isRunning(sessionId: string): boolean;
  idle(): Promise<void>;
}

interface HistoryImportRuntime {
  session: SessionKey;
  adapter: ProtocolAdapter;
  target: number;
  imported: Map<string, number>;
  records: MessageStorageRecord[];
  previewWaterline: number | null;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function snapshot(job: HistoryImportJob): HistoryImportJob {
  return { ...job };
}

export function createHistoryImportService(options: HistoryImportServiceOptions): HistoryImportService {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? delay;
  const jobs = new Map<string, HistoryImportJob>();
  const runtimes = new Map<string, HistoryImportRuntime>();
  const runningSessions = new Map<string, string>();
  const tasks = new Set<Promise<void>>();

  function track(task: Promise<void>): void {
    tasks.add(task);
    void task.finally(() => tasks.delete(task));
  }

  function finish(job: HistoryImportJob): void {
    job.cancelRequested = undefined;
    delete job.confirmationExpiresAt;
    if (runningSessions.get(job.sessionId) === job.id) runningSessions.delete(job.sessionId);
    runtimes.delete(job.id);
  }

  function expireConfirmation(job: HistoryImportJob): void {
    if (job.phase !== 'awaiting_confirmation'
      || job.confirmationExpiresAt === undefined
      || now() < job.confirmationExpiresAt) return;
    job.phase = 'expired';
    job.error = '等待确认超时，任务已释放';
    finish(job);
  }

  function expirePendingConfirmations(): void {
    for (const job of jobs.values()) expireConfirmation(job);
  }

  function preparePreview(job: HistoryImportJob, runtime: HistoryImportRuntime): void {
    const times = [...runtime.imported.values()];
    const allRecords = times.length === 0
      ? []
      : options.repository.messagesInRange(job.sessionId, Math.min(...times), Math.max(...times));
    const tagRun = options.repository.getTagRun(runtime.session.account, job.sessionId);
    const waterline = tagRun?.lastMessageTime ?? null;
    runtime.previewWaterline = waterline;
    runtime.records = job.mode === 'full'
      ? allRecords
      : allRecords.filter((record) => waterline === null || record.time > waterline);
    job.waterlineTime = waterline;
    job.newMessages = runtime.records.length;
    job.windowsTotal = Math.ceil(runtime.records.length / WINDOW_SIZE);
    const averageCost = options.repository.recentExtractAverageCost();
    if (averageCost === undefined) delete job.estimatedCostCny;
    else job.estimatedCostCny = job.windowsTotal * averageCost;
    job.previewChanged = false;
  }

  async function fetchHistory(job: HistoryImportJob, runtime: HistoryImportRuntime): Promise<void> {
    let beforeMessageId: string | undefined;
    let consecutiveErrors = 0;
    try {
      while (job.fetched < runtime.target && !job.cancelRequested) {
        let page: IncomingMessage[];
        try {
          page = await runtime.adapter.history(runtime.session, {
            count: Math.min(PAGE_SIZE, runtime.target - job.fetched),
            ...(beforeMessageId === undefined ? {} : { beforeMessageId }),
          });
          consecutiveErrors = 0;
        } catch {
          consecutiveErrors += 1;
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            job.phase = 'error';
            job.error = '连续三页拉取失败';
            return;
          }
          await wait(PAGE_DELAY_MS);
          continue;
        }

        const pageMessages = page.filter((message) => sessionId(message.session) === job.sessionId);
        const containsStoredMessage = pageMessages.some((message) =>
          options.repository.messageBySessionAndId(job.sessionId, message.messageId) !== undefined);
        const pageIds = new Set<string>();
        const newMessages = pageMessages.filter((message) => {
          if (runtime.imported.has(message.messageId) || pageIds.has(message.messageId)) return false;
          pageIds.add(message.messageId);
          return true;
        });
        for (const message of newMessages) {
          runtime.imported.set(message.messageId, message.time);
          const inserted = options.repository.saveMessage({
            sessionId: job.sessionId,
            messageId: message.messageId,
            senderId: message.senderId,
            senderName: message.senderName,
            isSelf: message.senderId === runtime.session.account,
            plainText: message.plainText,
            segments: message.segments,
            time: message.time,
          });
          if (inserted) job.inserted += 1;
        }
        job.fetched = runtime.imported.size;
        if (newMessages.length > 0) beforeMessageId = newMessages[0]?.messageId;
        if (job.cancelRequested || containsStoredMessage || newMessages.length < 2 || job.fetched >= runtime.target) break;
        await wait(PAGE_DELAY_MS);
      }

      if (job.cancelRequested) {
        job.phase = 'cancelled';
        return;
      }
      preparePreview(job, runtime);
      job.phase = 'awaiting_confirmation';
      job.confirmationExpiresAt = now() + CONFIRMATION_TTL_MS;
    } catch {
      job.phase = 'error';
      job.error = '历史导入失败';
    } finally {
      if (job.phase !== 'awaiting_confirmation') finish(job);
    }
  }

  async function extract(job: HistoryImportJob, runtime: HistoryImportRuntime, releaseSession: () => void): Promise<void> {
    let consecutiveWindowFailures = 0;
    try {
      if (runtime.records.length === 0) {
        const previous = options.repository.getTagRun(runtime.session.account, job.sessionId);
        options.repository.saveTagRun({
          account: runtime.session.account,
          sessionId: job.sessionId,
          lastRunAt: now(),
          lastMessageTime: previous?.lastMessageTime ?? null,
        });
        job.phase = 'done';
        return;
      }

      const windows: MessageStorageRecord[][] = [];
      for (let start = 0; start < runtime.records.length; start += WINDOW_SIZE) {
        windows.push(runtime.records.slice(start, start + WINDOW_SIZE));
      }
      for (const [index, window] of windows.entries()) {
        if (job.cancelRequested) break;
        let succeeded = false;
        let failureReason: ExtractFailureType = 'other';
        let failureHttpStatus: number | undefined;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const summary = await options.impressionsService.extractWindowUnderSessionLock({
            session: runtime.session,
            records: window,
            now: now(),
            template: options.getTemplate(),
          });
          job.tagsInserted += summary.inserted;
          job.tagsObserved += summary.observed;
          job.costCny += summary.costCny;
          if (summary.status === 'budget') {
            job.phase = 'error';
            job.error = '预算已用尽';
            return;
          }
          if (summary.status === 'done') {
            succeeded = true;
            break;
          }
          failureReason = summary.failureReason ?? 'other';
          failureHttpStatus = summary.failureHttpStatus;
          if (attempt === 0) await wait(5_000);
        }

        if (succeeded) {
          job.windowsDone += 1;
          consecutiveWindowFailures = 0;
        } else {
          job.windowsFailed += 1;
          consecutiveWindowFailures += 1;
          job.failureReason = failureReason;
          job.failureHttpStatus = failureHttpStatus;
        }
        const windowLatestTime = window.reduce((latest, record) => Math.max(latest, record.time), Number.NEGATIVE_INFINITY);
        const previousWaterline = options.repository.getTagRun(runtime.session.account, job.sessionId)?.lastMessageTime;
        options.repository.saveTagRun({
          account: runtime.session.account,
          sessionId: job.sessionId,
          lastRunAt: now(),
          lastMessageTime: previousWaterline === null || previousWaterline === undefined
            ? windowLatestTime
            : Math.max(previousWaterline, windowLatestTime),
        });
        if (consecutiveWindowFailures >= MAX_CONSECUTIVE_ERRORS) {
          job.phase = 'error';
          job.error = `提取失败：${extractFailureLabel({ type: failureReason, ...(failureHttpStatus !== undefined ? { httpStatus: failureHttpStatus } : {}) })}（${job.windowsFailed} 个窗口跳过）`;
          return;
        }
        if (job.cancelRequested) break;
        if (index < windows.length - 1) await wait(WINDOW_DELAY_MS);
      }

      job.phase = job.cancelRequested ? 'cancelled' : 'done';
    } catch {
      job.phase = 'error';
      job.error = '历史导入失败';
    } finally {
      finish(job);
      releaseSession();
    }
  }

  return {
    start(input) {
      if (input.session.kind !== 'group' || !TARGETS.has(input.target)) return undefined;
      const key = sessionId(input.session);
      const mode = input.mode ?? 'incremental';
      if (mode !== 'incremental' && mode !== 'full') return undefined;
      expirePendingConfirmations();
      if (input.adapter.account !== input.session.account || runningSessions.has(key)) return undefined;
      const job: HistoryImportJob = {
        id: randomUUID(),
        sessionId: key,
        mode,
        phase: 'fetching',
        fetched: 0,
        inserted: 0,
        newMessages: 0,
        waterlineTime: options.repository.getTagRun(input.session.account, key)?.lastMessageTime ?? null,
        windowsDone: 0,
        windowsTotal: 0,
        windowsFailed: 0,
        tagsInserted: 0,
        tagsObserved: 0,
        costCny: 0,
      };
      const runtime: HistoryImportRuntime = {
        session: input.session,
        adapter: input.adapter,
        target: input.target,
        imported: new Map(),
        records: [],
        previewWaterline: job.waterlineTime,
      };
      runningSessions.set(key, job.id);
      jobs.set(job.id, job);
      runtimes.set(job.id, runtime);
      track(fetchHistory(job, runtime));
      return snapshot(job);
    },

    confirm(jobId) {
      expirePendingConfirmations();
      const job = jobs.get(jobId);
      const runtime = runtimes.get(jobId);
      if (!job || !runtime || job.phase !== 'awaiting_confirmation') return undefined;
      const releaseSession = options.impressionsService.tryAcquireSession(job.sessionId);
      if (!releaseSession) return undefined;
      try {
        const currentWaterline = options.repository.getTagRun(runtime.session.account, job.sessionId)?.lastMessageTime ?? null;
        if (job.mode === 'incremental' && currentWaterline !== runtime.previewWaterline) {
          preparePreview(job, runtime);
          job.previewChanged = true;
          releaseSession();
          return snapshot(job);
        }
        job.previewChanged = undefined;
        job.phase = 'extracting';
        delete job.confirmationExpiresAt;
        track(extract(job, runtime, releaseSession));
        return snapshot(job);
      } catch {
        releaseSession();
        job.phase = 'error';
        job.error = '历史导入失败';
        finish(job);
        return snapshot(job);
      }
    },

    get(jobId) {
      const job = jobs.get(jobId);
      if (!job) return undefined;
      expireConfirmation(job);
      return snapshot(job);
    },

    cancel(jobId) {
      const job = jobs.get(jobId);
      if (!job) return undefined;
      expireConfirmation(job);
      if (['done', 'cancelled', 'expired', 'error'].includes(job.phase)) return undefined;
      if (job.phase === 'awaiting_confirmation') {
        job.phase = 'cancelled';
        finish(job);
      } else {
        job.cancelRequested = true;
      }
      return snapshot(job);
    },

    isRunning(key) {
      expirePendingConfirmations();
      return runningSessions.has(key);
    },

    async idle() {
      while (tasks.size > 0) await Promise.all([...tasks]);
    },
  };
}
