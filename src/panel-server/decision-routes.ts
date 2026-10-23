import type { Hono } from 'hono';
import type { PipelineResult } from '../core/conversation/pipeline.ts';
import { parseSessionId } from '../core/conversation/sessions.ts';
import { sessionId, type IncomingMessage, type Segment } from '../core/shared/events.ts';
import type { InteractionLogRepository } from '../store/interaction-log-repo.ts';
import type { StoreRepository } from '../store/repository.ts';
import type { ContactSnapshot, PanelAccountRuntime } from './types.ts';

export interface DecisionRouteOptions {
  repository: StoreRepository;
  interactionLogRepository?: InteractionLogRepository;
  accounts: () => PanelAccountRuntime[];
  loadContacts: (runtime: PanelAccountRuntime) => Promise<ContactSnapshot>;
  replayMessage?: (message: IncomingMessage) => Promise<PipelineResult | undefined>;
}

function decisionCostCny(detail: unknown): number | null {
  if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) return null;
  const costCny = (detail as Record<string, unknown>).costCny;
  return typeof costCny === 'number' && Number.isFinite(costCny) ? costCny : null;
}

export function registerDecisionRoutes(app: Hono, options: DecisionRouteOptions): void {
  app.get('/api/decisions', async (context) => {
    const rawLimit = context.req.query('limit');
    const requested = rawLimit === undefined ? 50 : Number(rawLimit);
    if (!Number.isSafeInteger(requested) || requested < 1) {
      return context.json({ error: 'Invalid limit' }, 400);
    }
    const decisions = options.repository.recentDecisions(Math.min(requested, 200));
    const sessionNames = new Map<string, string>();
    const runtimes = options.accounts();
    const snapshots = await Promise.all(runtimes.map(options.loadContacts));
    for (const [index, runtime] of runtimes.entries()) {
      const snapshot = snapshots[index] ?? { groups: [], friends: [], degraded: true };
      for (const group of snapshot.groups) {
        const id = sessionId({ account: runtime.adapter.account, kind: 'group', peer: group.groupId });
        sessionNames.set(id, group.name || id);
      }
      for (const friend of snapshot.friends) {
        const id = sessionId({ account: runtime.adapter.account, kind: 'private', peer: friend.userId });
        sessionNames.set(id, friend.remark || friend.nickname || id);
      }
    }
    return context.json(decisions.map((decision) => ({
      ...decision,
      sessionName: sessionNames.get(decision.sessionId) ?? decision.sessionId,
      messageText: options.repository.decisionMessageText(decision.sessionId, decision.messageId) ?? null,
      costCny: decisionCostCny(decision.detail),
      hasDebugTrace: options.repository.hasDebugTrace(decision.sessionId, decision.messageId),
      hasPipelineTrace: options.repository.hasPipelineTrace(decision.sessionId, decision.messageId),
      interactionTrace: options.interactionLogRepository
        ?.interactionLogsForMessage(decision.sessionId, decision.messageId)
        .map(({ id, time, actionKind, target, details, source, verdict, reason }) => ({
          id, time, actionKind, ...(target === undefined ? {} : { target }),
          ...(details === undefined ? {} : { details }), source, verdict, reason,
        })) ?? [],
    })));
  });

  app.get('/api/decisions/:id/trace', (context) => {
    const id = Number(context.req.param('id'));
    if (!Number.isSafeInteger(id) || id < 1) return context.json({ error: 'Invalid decision ID' }, 400);
    const decision = options.repository.decisionById(id);
    if (!decision) return context.json({ error: 'Decision not found' }, 404);
    return context.json({
      decisionId: id,
      traces: options.repository.debugTracesFor(decision.sessionId, decision.messageId),
    });
  });

  app.get('/api/decisions/:id/pipeline-trace', (context) => {
    const id = Number(context.req.param('id'));
    if (!Number.isSafeInteger(id) || id < 1) return context.json({ error: 'Invalid decision ID' }, 400);
    const decision = options.repository.decisionById(id);
    if (!decision) return context.json({ error: 'Decision not found' }, 404);
    const stored = options.repository.pipelineTraceFor(decision.sessionId, decision.messageId);
    return context.json({ decisionId: id, trace: stored?.trace ?? [] });
  });

  app.post('/api/decisions/:id/replay', async (context) => {
    const id = Number(context.req.param('id'));
    if (!Number.isSafeInteger(id) || id < 1) return context.json({ error: 'Invalid decision ID' }, 400);
    const decision = options.repository.decisionById(id);
    if (!decision) return context.json({ error: 'Decision not found' }, 404);
    if (!options.replayMessage) return context.json({ error: 'Replay is unavailable' }, 501);

    const key = parseSessionId(decision.sessionId);
    if (!key) return context.json({ error: 'Decision session is invalid' }, 409);
    const storedMessage = options.repository.messageBySessionAndId(decision.sessionId, decision.messageId);
    if (!storedMessage || !Array.isArray(storedMessage.segments)) {
      return context.json({ error: 'Original message is unavailable' }, 409);
    }
    const segments = storedMessage.segments as Segment[];
    const message: IncomingMessage = {
      session: key,
      messageId: storedMessage.messageId,
      senderId: storedMessage.senderId,
      senderName: storedMessage.senderName,
      segments,
      plainText: storedMessage.plainText,
      mentionsSelf: segments.some((segment) => {
        if (typeof segment !== 'object' || segment === null || Array.isArray(segment)) return false;
        const candidate = segment as Record<string, unknown>;
        return candidate.type === 'at' && candidate.target === key.account;
      }),
      replyToSelf: false,
      time: storedMessage.time,
    };
    const result = await options.replayMessage(message);
    if (!result) return context.json({ error: 'Replay account is unavailable' }, 409);
    if (!result.replay) return context.json({ error: 'Replay result is unavailable' }, 500);

    const originalTrace = options.repository.pipelineTraceFor(decision.sessionId, decision.messageId);
    return context.json({
      decisionId: id,
      original: {
        replied: decision.replied,
        reason: decision.reason,
        replyCostCny: decisionCostCny(decision.detail),
        trace: originalTrace?.trace ?? [],
      },
      replay: result.replay,
    });
  });
}
