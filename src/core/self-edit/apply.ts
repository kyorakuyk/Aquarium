import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { serializeConfigWrite } from '../../config/write.ts';
import { parsePersonaMarkdown } from '../../persona/load.ts';
import type { IncomingMessage } from '../shared/events.ts';
import { sessionId } from '../shared/events.ts';

import {
  applyConfigChanges,
  applyPersonaChanges,
  assertSelfEditChangesCurrent,
  configurationChangeContext,
  formatSelfEditDiff,
  readPersonaSource,
  selectedPersonaId,
  serializeSelfEditChanges,
  selfEditTarget,
  type PreparedSelfEditChange,
} from './tools.ts';
import type { SelfEditHandlerDependencies } from './types.ts';

function writeTextAtomically(filePath: string, text: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, text, { encoding: 'utf8', flag: 'wx' });
    renameSync(temporaryPath, filePath);
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch { /* 临时文件可能尚未创建。 */ }
    throw error;
  }
}

function eventInput(
  dependencies: SelfEditHandlerDependencies,
  message: IncomingMessage,
  changes: readonly PreparedSelfEditChange[],
  personaId?: string,
) {
  const action = changes.every(({ operation }) => operation === 'restore') ? '撤回：' : '';
  const summary = `来自对话的设置修改：${action}${formatSelfEditDiff(changes, (dependencies.now ?? Date.now)())}`;
  return {
    account: message.session.account,
    ownerId: message.senderId,
    sessionId: sessionId(message.session),
    ...(personaId === undefined ? {} : { personaId }),
    time: (dependencies.now ?? Date.now)(),
    messageId: message.messageId,
    summary,
    changes: serializeSelfEditChanges(changes),
  };
}

function contextFor(
  dependencies: SelfEditHandlerDependencies,
  message: IncomingMessage,
  config = dependencies.getConfig(),
) {
  return configurationChangeContext(
    config,
    message.session,
    dependencies.root,
    dependencies.muteState,
    (dependencies.now ?? Date.now)(),
  );
}

function recordEvent(
  dependencies: SelfEditHandlerDependencies,
  message: IncomingMessage,
  changes: readonly PreparedSelfEditChange[],
  personaId?: string,
): number {
  return dependencies.repository.recordSelfEditEvent(
    eventInput(dependencies, message, changes, personaId),
  );
}

function applyPersonaProposal(
  dependencies: SelfEditHandlerDependencies,
  message: IncomingMessage,
  changes: readonly PreparedSelfEditChange[],
): string {
  const config = dependencies.getConfig();
  const personaId = selectedPersonaId(config, message.session.account);
  const source = readPersonaSource(dependencies.root, personaId);
  const context = contextFor(dependencies, message, config);
  assertSelfEditChangesCurrent(changes, context);
  const updated = applyPersonaChanges(source.source, changes);
  const parsed = parsePersonaMarkdown(updated);
  const versions = dependencies.repository.personaVersions(personaId, 50);
  if (versions.length === 0) {
    dependencies.repository.recordPersonaVersion(personaId, source.source, JSON.stringify(parsePersonaMarkdown(source.source).traits));
  }
  try {
    writeTextAtomically(source.path, updated);
    dependencies.repository.recordPersonaVersion(personaId, updated, JSON.stringify(parsed.traits));
    recordEvent(dependencies, message, changes, personaId);
  } catch (error) {
    try {
      if (source.existed) writeTextAtomically(source.path, source.source);
      else if (existsSync(source.path)) unlinkSync(source.path);
      if (dependencies.repository.personaVersions(personaId, 50).at(-1)?.markdown !== source.source) {
        dependencies.repository.recordPersonaVersion(
          personaId,
          source.source,
          JSON.stringify(parsePersonaMarkdown(source.source).traits),
        );
      }
    } catch {
      throw new AggregateError([error], '人设写入失败，且自动恢复原文件也失败。');
    }
    throw error;
  }
  return `已保存并记录人设版本。${formatSelfEditDiff(changes, (dependencies.now ?? Date.now)())}`;
}

function applySessionProposal(
  dependencies: SelfEditHandlerDependencies,
  message: IncomingMessage,
  changes: readonly PreparedSelfEditChange[],
): string {
  if (message.session.kind !== 'group') throw new Error('闭嘴时长只适用于群聊会话。');
  const context = contextFor(dependencies, message);
  assertSelfEditChangesCurrent(changes, context);
  const change = changes[0];
  if (!change || change.key !== 'session.muteMinutes') throw new Error('会话设置类型无效。');
  const previous = dependencies.muteState.getUntil(message.session);
  try {
    dependencies.repository.transaction(() => {
      recordEvent(dependencies, message, changes);
      const until = typeof change.after === 'number' && change.after > context.now ? change.after : undefined;
      dependencies.muteState.setUntil(message.session, until);
    });
  } catch (error) {
    dependencies.muteState.setUntil(message.session, previous);
    throw error;
  }
  return `已更新本群设置并记录到事件簿。${formatSelfEditDiff(changes, (dependencies.now ?? Date.now)())}`;
}

async function applyConfigProposal(
  dependencies: SelfEditHandlerDependencies,
  message: IncomingMessage,
  changes: readonly PreparedSelfEditChange[],
): Promise<string> {
  return serializeConfigWrite(async () => {
    const current = dependencies.getConfig();
    const context = contextFor(dependencies, message, current);
    assertSelfEditChangesCurrent(changes, context);
    const next = applyConfigChanges(current, changes);
    let saveAttempted = false;
    try {
      dependencies.repository.transaction(() => {
        recordEvent(dependencies, message, changes);
        saveAttempted = true;
        dependencies.saveConfig(next);
      });
    } catch (error) {
      if (saveAttempted) {
        try { dependencies.saveConfig(current); }
        catch (restoreError) {
          throw new AggregateError([error, restoreError], '设置写入失败，自动恢复旧配置也失败。');
        }
      }
      throw error;
    }
    return `已保存并记录到事件簿。${formatSelfEditDiff(changes, (dependencies.now ?? Date.now)())}`;
  });
}

export async function applySelfEditProposal(
  dependencies: SelfEditHandlerDependencies,
  message: IncomingMessage,
  changes: readonly PreparedSelfEditChange[],
): Promise<string> {
  const target = selfEditTarget(changes);
  if (target === 'persona') return applyPersonaProposal(dependencies, message, changes);
  if (target === 'session') return applySessionProposal(dependencies, message, changes);
  return applyConfigProposal(dependencies, message, changes);
}
