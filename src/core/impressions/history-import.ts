import { randomUUID } from 'node:crypto';
import type { ProtocolAdapter } from '../../adapters/types.ts';
import type { AquariumConfig } from '../../config/schema.ts';
import { sessionId, type IncomingMessage, type SessionKey } from '../events.ts';
import type { ExtractTagsPromptTemplate } from '../prompt-templates.ts';
import type { StoreRepository } from '../../store/repository.ts';
import type { ImpressionsService } from './service.ts';

const PAGE_SIZE = 50;
const WINDOW_SIZE = 80;
const PAGE_DELAY_MS = 500;
const WINDOW_DELAY_MS = 1_000;
const MAX_CONSECUTIVE_ERRORS = 3;
const TARGETS = new Set([200, 500, 1_000, 2_000]);

export type HistoryImportPhase = 'fetching' | 'extracting' | 'done' | 'cancelled' | 'error';

export interface HistoryImportJob {
  id: string;
  sessionId: string;
  phase: HistoryImportPhase;
  fetched: number;
  inserted: number;
  windowsDone: number;
  windowsTotal: number;
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
  start(input: { session: SessionKey; target: number; adapter: ProtocolAdapter }): HistoryImportJob | undefined;
  get(jobId: string): HistoryImportJob | undefined;
  cancel(jobId: string): HistoryImportJob | undefined;
  isRunning(sessionId: string): boolean;
  idle(): Promise<void>;
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
  const runningSessions = new Map<string, string>();
  const tasks = new Set<Promise<void>>();

  async function run(
    job: HistoryImportJob,
    session: SessionKey,
    target: number,
    adapter: ProtocolAdapter,
    releaseSession: () => void,
  ): Promise<void> {
    const imported = new Map<string, number>();
    let beforeMessageId: string | undefined;
    let consecutiveErrors = 0;

    try {
      while (job.fetched < target && !job.cancelRequested) {
        let page: IncomingMessage[];
        try {
          page = await adapter.history(session, {
            count: Math.min(PAGE_SIZE, target - job.fetched),
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
        const newMessages = pageMessages.filter((message) => !imported.has(message.messageId));
        for (const message of newMessages) {
          imported.set(message.messageId, message.time);
          const inserted = options.repository.saveMessage({
            sessionId: job.sessionId,
            messageId: message.messageId,
            senderId: message.senderId,
            senderName: message.senderName,
            isSelf: message.senderId === session.account,
            plainText: message.plainText,
            segments: message.segments,
            time: message.time,
          });
          if (inserted) job.inserted += 1;
        }
        job.fetched = imported.size;
        if (newMessages.length > 0) beforeMessageId = newMessages[0]?.messageId;
        if (job.cancelRequested || newMessages.length < 2 || job.fetched >= target) break;
        await wait(PAGE_DELAY_MS);
      }

      if (job.cancelRequested) {
        job.phase = 'cancelled';
        return;
      }

      const times = [...imported.values()];
      if (times.length === 0) {
        const previous = options.repository.getTagRun(session.account, job.sessionId);
        options.repository.saveTagRun({
          account: session.account,
          sessionId: job.sessionId,
          lastRunAt: now(),
          lastMessageTime: previous?.lastMessageTime ?? null,
        });
        job.phase = 'done';
        return;
      }

      const fromTime = Math.min(...times);
      const toTime = Math.max(...times);
      const records = options.repository.messagesInRange(job.sessionId, fromTime, toTime);
      const windows: typeof records[] = [];
      for (let start = 0; start < records.length; start += WINDOW_SIZE) {
        windows.push(records.slice(start, start + WINDOW_SIZE));
      }
      job.windowsTotal = windows.length;
      job.phase = 'extracting';

      for (const [index, window] of windows.entries()) {
        if (job.cancelRequested) break;
        const summary = await options.impressionsService.extractWindowUnderSessionLock({
          session,
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
        if (summary.status !== 'done') {
          job.phase = 'error';
          job.error = '印象提取失败';
          return;
        }
        job.windowsDone += 1;
        if (job.cancelRequested) break;
        if (index < windows.length - 1) await wait(WINDOW_DELAY_MS);
      }

      if (job.cancelRequested) {
        job.phase = 'cancelled';
        return;
      }

      const latestMessageTime = records.reduce((latest, record) => Math.max(latest, record.time), 0);
      options.repository.saveTagRun({
        account: session.account,
        sessionId: job.sessionId,
        lastRunAt: now(),
        lastMessageTime: latestMessageTime > 0 ? latestMessageTime : null,
      });
      job.phase = 'done';
    } catch {
      job.phase = 'error';
      job.error = '历史导入失败';
    } finally {
      job.cancelRequested = undefined;
      runningSessions.delete(job.sessionId);
      releaseSession();
    }
  }

  return {
    start(input) {
      if (input.session.kind !== 'group' || !TARGETS.has(input.target)) return undefined;
      const key = sessionId(input.session);
      if (input.adapter.account !== input.session.account || runningSessions.has(key)) return undefined;
      const release = options.impressionsService.tryAcquireSession(key);
      if (!release) return undefined;
      const job: HistoryImportJob = {
        id: randomUUID(),
        sessionId: key,
        phase: 'fetching',
        fetched: 0,
        inserted: 0,
        windowsDone: 0,
        windowsTotal: 0,
        tagsInserted: 0,
        tagsObserved: 0,
        costCny: 0,
      };
      runningSessions.set(key, job.id);
      jobs.set(job.id, job);
      const task = run(job, input.session, input.target, input.adapter, release);
      tasks.add(task);
      void task.finally(() => tasks.delete(task));
      return snapshot(job);
    },

    get(jobId) {
      const job = jobs.get(jobId);
      return job ? snapshot(job) : undefined;
    },

    cancel(jobId) {
      const job = jobs.get(jobId);
      if (!job || job.phase === 'done' || job.phase === 'cancelled' || job.phase === 'error') return undefined;
      job.cancelRequested = true;
      return snapshot(job);
    },

    isRunning(key) {
      return runningSessions.has(key);
    },

    async idle() {
      while (tasks.size > 0) await Promise.all([...tasks]);
    },
  };
}
