export type PrivacyLevel = 'L0' | 'L1' | 'L2';
export type PrivacyPurpose = 'prompt' | 'gate' | 'third_party';
export type PrivacyDecision = 'allow' | 'gate_only' | 'deny';

export interface PrivacyInfo {
  origin: 'private' | 'group';
  sessionId: string;
  ownerId: number | null;
  level?: PrivacyLevel;
}

export interface PrivacyTarget {
  kind: 'private' | 'group';
  sessionId: string;
  peerId?: number;
}

export interface PrivacyDecisionInput {
  info: PrivacyInfo;
  target: PrivacyTarget;
  purpose: PrivacyPurpose;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function validInput(value: unknown): value is PrivacyDecisionInput {
  if (!isRecord(value) || !isRecord(value.info) || !isRecord(value.target)) return false;
  const info = value.info;
  const target = value.target;
  if ((info.origin !== 'private' && info.origin !== 'group')
    || typeof info.sessionId !== 'string' || info.sessionId.length === 0
    || (info.ownerId !== null && !isPositiveId(info.ownerId))
    || (info.origin === 'private' && !isPositiveId(info.ownerId))
    || (target.kind !== 'private' && target.kind !== 'group')
    || typeof target.sessionId !== 'string' || target.sessionId.length === 0
    || !['prompt', 'gate', 'third_party'].includes(String(value.purpose))) return false;
  if (target.peerId !== undefined && !isPositiveId(target.peerId)) return false;
  if (info.level !== undefined && !['L0', 'L1', 'L2'].includes(String(info.level))) return false;
  return true;
}

export function decide(input: PrivacyDecisionInput): PrivacyDecision {
  if (!validInput(input)) return 'deny';
  const { info, target, purpose } = input;

  if (info.sessionId === target.sessionId) return purpose === 'third_party' ? 'deny' : 'allow';

  if (info.origin === 'private' && target.kind === 'group') {
    if (purpose === 'gate') return 'gate_only';
    if (purpose === 'prompt' && (info.level === 'L1' || info.level === 'L2')) return 'allow';
    return 'deny';
  }

  if (info.origin === 'private' && target.kind === 'private') return 'deny';

  if (info.origin === 'group' && target.kind === 'private'
    && info.ownerId !== null && info.ownerId === target.peerId && purpose === 'prompt') {
    return 'allow';
  }

  return 'deny';
}
