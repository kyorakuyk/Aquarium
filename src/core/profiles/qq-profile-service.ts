import type {
  QqGroupHonorHolder,
  QqGroupInfo,
  QqGroupMember,
  QqGroupRole,
  QqProfileActions,
  QqSex,
} from '../../adapters/types.ts';
import type { StoreRepository } from '../../store/repository.ts';
import { normalizeTagText } from '../impressions/tags.ts';

const PROFILE_TTL_MS = 24 * 60 * 60_000;
const STRANGER_CONCURRENCY = 8;
const HONOR_KINDS = new Set(['dragon_king', 'performer', 'legend', 'emotion', 'strong_newbie']);
const ROLES = new Set(['owner', 'admin', 'member']);
const SEXES = new Set(['male', 'female', 'unknown']);
const MBTI_PATTERN = /(?<![A-Za-z0-9])[IE][NS][TF][JP](?![A-Za-z0-9])/iu;

export interface QqMemberProfile extends QqGroupMember {
  longNick?: string;
  qage?: number;
}

export interface QqGroupProfileSnapshot {
  groupInfo: QqGroupInfo | null;
  honors: QqGroupHonorHolder[] | null;
  latestNotice: string | null;
  essenceCount: number | null;
  membersAvailable: boolean;
}

export interface QqGroupProfileResult {
  profile: QqGroupProfileSnapshot;
  membersAvailable: boolean;
  members: QqMemberProfile[];
  fetchedAt: number | null;
}

interface QqProfileServiceOptions {
  repository: StoreRepository;
  now?: () => number;
}

interface ReadGroupInput {
  account: number;
  groupId: number;
  adapter?: QqProfileActions;
  force?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function integer(value: unknown, minimum = Number.MIN_SAFE_INTEGER): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function roleValue(value: unknown): QqGroupRole | undefined {
  return typeof value === 'string' && ROLES.has(value) ? value as QqGroupRole : undefined;
}

function sexValue(value: unknown): QqSex | undefined {
  return typeof value === 'string' && SEXES.has(value) ? value as QqSex : undefined;
}

function groupInfoValue(value: unknown): QqGroupInfo | null {
  if (!isRecord(value)) return null;
  const info: QqGroupInfo = {};
  const fields = [
    ['groupName', stringValue(value.groupName)],
    ['memberCount', integer(value.memberCount, 0)],
    ['maxMemberCount', integer(value.maxMemberCount, 0)],
    ['groupCreateTime', integer(value.groupCreateTime, 0)],
    ['groupLevel', integer(value.groupLevel, 0)],
    ['groupDescription', stringValue(value.groupDescription)],
  ] as const;
  for (const [key, field] of fields) if (field !== undefined) Object.assign(info, { [key]: field });
  return info;
}

function memberValue(value: unknown): QqGroupMember | undefined {
  if (!isRecord(value)) return undefined;
  const userId = integer(value.userId, 1);
  if (userId === undefined) return undefined;
  const member: QqGroupMember = { userId };
  const fields = [
    ['nickname', stringValue(value.nickname)], ['card', stringValue(value.card)],
    ['role', roleValue(value.role)], ['title', stringValue(value.title)],
    ['joinTime', integer(value.joinTime, 0)], ['lastSentTime', integer(value.lastSentTime, 0)],
    ['level', stringValue(value.level)], ['sex', sexValue(value.sex)], ['age', integer(value.age, 0)],
  ] as const;
  for (const [key, field] of fields) if (field !== undefined) Object.assign(member, { [key]: field });
  if (typeof value.isRobot === 'boolean') member.isRobot = value.isRobot;
  return member;
}

function honorValues(value: unknown): QqGroupHonorHolder[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.kind !== 'string' || !HONOR_KINDS.has(item.kind)) return [];
    const holder: QqGroupHonorHolder = { kind: item.kind as QqGroupHonorHolder['kind'] };
    const userId = integer(item.userId, 1);
    const nickname = stringValue(item.nickname);
    if (userId !== undefined) holder.userId = userId;
    if (nickname !== undefined) holder.nickname = nickname;
    return holder.userId === undefined && holder.nickname === undefined ? [] : [holder];
  });
}

function snapshotValue(value: unknown): QqGroupProfileSnapshot | undefined {
  if (!isRecord(value) || typeof value.membersAvailable !== 'boolean') return undefined;
  if (value.groupInfo !== null && !isRecord(value.groupInfo)) return undefined;
  if (value.honors !== null && !Array.isArray(value.honors)) return undefined;
  if (value.latestNotice !== null && typeof value.latestNotice !== 'string') return undefined;
  if (value.essenceCount !== null && integer(value.essenceCount, 0) === undefined) return undefined;
  return {
    groupInfo: value.groupInfo === null ? null : groupInfoValue(value.groupInfo),
    honors: value.honors === null ? null : honorValues(value.honors),
    latestNotice: value.latestNotice as string | null,
    essenceCount: value.essenceCount as number | null,
    membersAvailable: value.membersAvailable,
  };
}

function memberProfileValue(value: unknown, userId: number): QqMemberProfile | undefined {
  if (!isRecord(value)) return undefined;
  const member = memberValue(value);
  if (!member || member.userId !== userId) return undefined;
  const profile: QqMemberProfile = { ...member };
  const longNick = stringValue(value.longNick);
  const qage = integer(value.qage, 0);
  if (longNick !== undefined) profile.longNick = longNick;
  if (qage !== undefined) profile.qage = qage;
  return profile;
}

function qageFromRegTime(regTime: number, now: number): number | undefined {
  const registered = new Date(regTime * 1_000);
  const current = new Date(now);
  if (!Number.isSafeInteger(regTime) || regTime < 0 || !Number.isFinite(registered.getTime())
    || !Number.isFinite(current.getTime()) || registered.getTime() > current.getTime()) return undefined;
  let years = current.getUTCFullYear() - registered.getUTCFullYear();
  if (current.getUTCMonth() < registered.getUTCMonth()
    || (current.getUTCMonth() === registered.getUTCMonth() && current.getUTCDate() < registered.getUTCDate())) years -= 1;
  return years >= 0 ? years : undefined;
}

async function safeCall<T>(run: () => Promise<T>): Promise<T | undefined> {
  try { return await run(); } catch { return undefined; }
}

async function mapLimited<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index];
      if (item !== undefined) results[index] = await task(item);
    }
  }));
  return results;
}

function emptySnapshot(): QqGroupProfileSnapshot {
  return { groupInfo: null, honors: null, latestNotice: null, essenceCount: null, membersAvailable: false };
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value) as unknown; } catch { return undefined; }
}

export function createQqProfileService(options: QqProfileServiceOptions) {
  const now = options.now ?? Date.now;
  const refreshes = new Map<string, Promise<void>>();

  function syncSignatureTag(account: number, groupId: number, userId: number, signature: string, fetchedAt: number): void {
    const sessionKey = `${account}:group:${groupId}`;
    const tags = options.repository.listTagsForSubject(account, sessionKey, userId);
    const signatureTags = tags.filter((tag) => tag.category === 'identity'
      && tag.origin === 'self_report'
      && tag.evidence.some((evidence) => evidence.kind === 'signature'));
    const mbti = MBTI_PATTERN.exec(signature)?.[0]?.toUpperCase();
    if (!mbti) {
      for (const tag of signatureTags) if (!tag.locked) options.repository.deleteTag(tag.id);
      return;
    }

    const norm = normalizeTagText(mbti);
    const evidence = { kind: 'signature' as const, text: signature, fetchedAt };
    if (options.repository.isTagVetoed({
      account,
      sessionId: sessionKey,
      userId,
      category: 'identity',
      subject: null,
      textNorm: norm,
    })) {
      for (const tag of signatureTags) if (!tag.locked) options.repository.deleteTag(tag.id);
      return;
    }

    const signatureTag = signatureTags[0];
    if (signatureTag) {
      if (signatureTag.locked || signatureTag.status === 'rejected' || signatureTag.status === 'superseded') return;
      options.repository.updateTag(signatureTag.id, {
        text: mbti,
        norm,
        subject: null,
        polarity: null,
        origin: 'self_report',
        status: 'confirmed',
        samples: 1,
        evidence: [evidence],
        lastSeen: fetchedAt,
        updatedAt: fetchedAt,
      });
      for (const tag of signatureTags.slice(1)) if (!tag.locked) options.repository.deleteTag(tag.id);
      return;
    }

    const existing = tags.find((tag) => tag.category === 'identity' && tag.norm === norm);
    if (existing) {
      if (existing.locked || existing.status === 'rejected' || existing.status === 'superseded') return;
      options.repository.updateTag(existing.id, {
        text: mbti,
        norm,
        subject: null,
        polarity: null,
        origin: 'self_report',
        status: 'confirmed',
        samples: Math.max(1, existing.samples),
        evidence: [evidence],
        lastSeen: fetchedAt,
        updatedAt: fetchedAt,
      });
      return;
    }

    options.repository.insertTag({
      account,
      sessionId: sessionKey,
      userId,
      text: mbti,
      norm,
      category: 'identity',
      subject: null,
      polarity: null,
      origin: 'self_report',
      locked: false,
      status: 'confirmed',
      source: 'auto',
      samples: 1,
      evidence: [evidence],
      firstSeen: fetchedAt,
      lastSeen: fetchedAt,
      supersededBy: null,
      updatedAt: fetchedAt,
    });
  }

  async function refresh(input: ReadGroupInput): Promise<void> {
    const key = `${input.account}:${input.groupId}`;
    const running = refreshes.get(key);
    if (running) return running;
    const adapter = input.adapter;
    if (!adapter) return;

    const pending = (async () => {
      const fetchedAt = now();
      const [groupRaw, membersRaw, honorsRaw, noticeRaw, essenceRaw] = await Promise.all([
        safeCall(() => adapter.getGroupInfo(input.groupId)),
        safeCall(() => adapter.getGroupMembers(input.groupId)),
        safeCall(() => adapter.getGroupHonors(input.groupId)),
        safeCall(() => adapter.getGroupNoticeLatest(input.groupId)),
        safeCall(() => adapter.getEssenceCount(input.groupId)),
      ]);
      const membersAvailable = Array.isArray(membersRaw);
      const unique = new Map<number, QqGroupMember>();
      if (membersAvailable) {
        for (const value of membersRaw) {
          const member = memberValue(value);
          if (member) unique.set(member.userId, member);
        }
      }
      const memberProfiles = membersAvailable
        ? await mapLimited([...unique.values()], STRANGER_CONCURRENCY, async (member): Promise<QqMemberProfile> => {
          const raw = await safeCall(() => adapter.getStrangerInfo(member.userId));
          const stranger = isRecord(raw) ? raw as Record<string, unknown> : undefined;
          const profile: QqMemberProfile = { ...member };
          const longNick = stringValue(stranger?.longNick);
          const qage = integer(stranger?.qage, 0)
            ?? (integer(stranger?.regTime, 0) === undefined
              ? undefined
              : qageFromRegTime(stranger?.regTime as number, fetchedAt));
          if (longNick !== undefined) {
            profile.longNick = longNick;
            syncSignatureTag(input.account, input.groupId, member.userId, longNick, fetchedAt);
          }
          if (qage !== undefined) profile.qage = qage;
          return profile;
        })
        : [];
      const profile: QqGroupProfileSnapshot = {
        groupInfo: groupInfoValue(groupRaw),
        honors: honorValues(honorsRaw),
        latestNotice: typeof noticeRaw === 'string' && noticeRaw.trim() !== '' ? noticeRaw : null,
        essenceCount: integer(essenceRaw, 0) ?? null,
        membersAvailable,
      };
      options.repository.replaceQqMemberProfiles(input.account, input.groupId, memberProfiles.map((member) => ({
        account: input.account,
        groupId: input.groupId,
        userId: member.userId,
        json: JSON.stringify(member),
        fetchedAt,
      })));
      options.repository.saveQqGroupProfile({
        account: input.account,
        groupId: input.groupId,
        json: JSON.stringify(profile),
        fetchedAt,
      });
    })();
    refreshes.set(key, pending);
    try { await pending; } finally { if (refreshes.get(key) === pending) refreshes.delete(key); }
  }

  function readCached(input: ReadGroupInput): QqGroupProfileResult {
    const cache = options.repository.getQqGroupProfile(input.account, input.groupId);
    const profile = cache ? snapshotValue(parseJson(cache.json)) : undefined;
    const members = options.repository.listQqMemberProfiles(input.account, input.groupId)
      .flatMap((record) => {
        const member = memberProfileValue(parseJson(record.json), record.userId);
        return member ? [member] : [];
      });
    return {
      profile: profile ?? emptySnapshot(),
      membersAvailable: profile?.membersAvailable ?? false,
      members: profile?.membersAvailable ? members : [],
      fetchedAt: profile && cache ? cache.fetchedAt : null,
    };
  }

  return {
    getCachedMemberProfile(account: number, groupId: number, userId: number): QqMemberProfile | undefined {
      if (![account, groupId, userId].every((value) => Number.isSafeInteger(value) && value > 0)) return undefined;
      const at = now();
      const groupCache = options.repository.getQqGroupProfile(account, groupId);
      const groupProfile = groupCache ? snapshotValue(parseJson(groupCache.json)) : undefined;
      if (!groupCache || !groupProfile?.membersAvailable || at < groupCache.fetchedAt
        || at - groupCache.fetchedAt >= PROFILE_TTL_MS) return undefined;
      const memberCache = options.repository.getQqMemberProfile(account, groupId, userId);
      if (!memberCache || at < memberCache.fetchedAt || at - memberCache.fetchedAt >= PROFILE_TTL_MS) return undefined;
      return memberProfileValue(parseJson(memberCache.json), userId);
    },

    async readGroup(input: ReadGroupInput): Promise<QqGroupProfileResult> {
      if (!Number.isSafeInteger(input.account) || input.account <= 0
        || !Number.isSafeInteger(input.groupId) || input.groupId <= 0) {
        return { profile: emptySnapshot(), membersAvailable: false, members: [], fetchedAt: null };
      }
      const cache = options.repository.getQqGroupProfile(input.account, input.groupId);
      const profile = cache ? snapshotValue(parseJson(cache.json)) : undefined;
      const at = now();
      const fresh = cache !== undefined && profile !== undefined && at >= cache.fetchedAt
        && at - cache.fetchedAt < PROFILE_TTL_MS;
      if (input.adapter && (input.force === true || !fresh)) await refresh(input);
      return readCached(input);
    },
  };
}
