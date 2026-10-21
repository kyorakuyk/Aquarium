import type {
  QqGroupHonorHolder,
  QqGroupHonorKind,
  QqGroupInfo,
  QqGroupMember,
  QqGroupRole,
  QqProfileActions,
  QqSex,
  QqStrangerInfo,
} from '../types.ts';
import { numericField, stringField, type OneBotClient } from './client.ts';

export type OneBotActionRunner = <T>(action: string, run: () => Promise<T>) => Promise<T>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertPositiveId(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
}

function groupInfoFromUnknown(value: unknown): QqGroupInfo | undefined {
  if (!isRecord(value)) return undefined;
  const info: QqGroupInfo = {};
  const groupName = stringField(value, 'group_name');
  const memberCount = numericField(value, 'member_count');
  const maxMemberCount = numericField(value, 'max_member_count');
  const groupCreateTime = numericField(value, 'group_create_time');
  const groupLevel = numericField(value, 'group_level');
  const groupDescription = stringField(value, 'group_description');
  if (groupName !== undefined) info.groupName = groupName;
  if (memberCount !== undefined) info.memberCount = memberCount;
  if (maxMemberCount !== undefined) info.maxMemberCount = maxMemberCount;
  if (groupCreateTime !== undefined) info.groupCreateTime = groupCreateTime;
  if (groupLevel !== undefined) info.groupLevel = groupLevel;
  if (groupDescription !== undefined) info.groupDescription = groupDescription;
  return info;
}

function roleValue(value: unknown): QqGroupRole | undefined {
  return value === 'owner' || value === 'admin' || value === 'member' ? value : undefined;
}

function sexValue(value: unknown): QqSex | undefined {
  return value === 'male' || value === 'female' || value === 'unknown' ? value : undefined;
}

function groupMemberFromUnknown(value: unknown): QqGroupMember | undefined {
  if (!isRecord(value)) return undefined;
  const userId = numericField(value, 'user_id');
  if (userId === undefined || userId <= 0) return undefined;
  const member: QqGroupMember = { userId };
  const nickname = stringField(value, 'nickname');
  const card = stringField(value, 'card');
  const role = roleValue(value.role);
  const title = stringField(value, 'title');
  const joinTime = numericField(value, 'join_time');
  const lastSentTime = numericField(value, 'last_sent_time');
  const level = stringField(value, 'level');
  const sex = sexValue(value.sex);
  const age = numericField(value, 'age');
  if (nickname !== undefined) member.nickname = nickname;
  if (card !== undefined) member.card = card;
  if (role !== undefined) member.role = role;
  if (title !== undefined) member.title = title;
  if (joinTime !== undefined) member.joinTime = joinTime;
  if (lastSentTime !== undefined) member.lastSentTime = lastSentTime;
  if (level !== undefined) member.level = level;
  if (sex !== undefined) member.sex = sex;
  if (age !== undefined && age >= 0) member.age = age;
  if (typeof value.is_robot === 'boolean') member.isRobot = value.is_robot;
  return member;
}

function honorHolder(
  kind: QqGroupHonorKind,
  value: unknown,
): QqGroupHonorHolder | undefined {
  if (!isRecord(value)) return undefined;
  const holder: QqGroupHonorHolder = { kind };
  const userId = numericField(value, 'user_id');
  const nickname = stringField(value, 'nickname');
  if (userId !== undefined && userId > 0) holder.userId = userId;
  if (nickname !== undefined) holder.nickname = nickname;
  return holder.userId === undefined && holder.nickname === undefined ? undefined : holder;
}

function firstHonor(
  kind: QqGroupHonorKind,
  value: unknown,
): QqGroupHonorHolder | undefined {
  if (!Array.isArray(value)) return undefined;
  return honorHolder(kind, value[0]);
}

function honorsFromUnknown(value: unknown): QqGroupHonorHolder[] | undefined {
  if (!isRecord(value)) return undefined;
  const talkative = honorHolder('dragon_king', value.current_talkative)
    ?? firstHonor('dragon_king', value.talkative_list);
  const holders = [
    talkative,
    firstHonor('performer', value.performer_list),
    firstHonor('legend', value.legend_list),
    firstHonor('emotion', value.emotion_list),
    firstHonor('strong_newbie', value.strong_newbie_list),
  ];
  return holders.filter((holder): holder is QqGroupHonorHolder => holder !== undefined);
}

function strangerInfoFromUnknown(value: unknown): QqStrangerInfo | undefined {
  if (!isRecord(value)) return undefined;
  const info: QqStrangerInfo = {};
  const longNick = stringField(value, 'long_nick');
  const qage = numericField(value, 'qage');
  const regTime = numericField(value, 'reg_time');
  if (longNick !== undefined) info.longNick = longNick;
  if (qage !== undefined && qage >= 0) info.qage = qage;
  if (regTime !== undefined && regTime >= 0) info.regTime = regTime;
  return info;
}

function latestNoticeFromUnknown(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const notices = value.flatMap((item, index) => {
    if (!isRecord(item) || !isRecord(item.message)) return [];
    const text = stringField(item.message, 'text');
    if (text === undefined || text.trim() === '') return [];
    return [{ text, publishTime: numericField(item, 'publish_time') ?? Number.NEGATIVE_INFINITY, index }];
  });
  notices.sort((first, second) => second.publishTime - first.publishTime || first.index - second.index);
  return notices[0]?.text;
}

export function createOneBotQqProfileActions(
  getClient: () => OneBotClient,
  runAction: OneBotActionRunner,
): QqProfileActions {
  return {
    async getGroupInfo(groupId) {
      assertPositiveId(groupId, 'groupId');
      const result = await runAction('get_group_info', () => getClient().raw('get_group_info', { group_id: groupId }));
      return groupInfoFromUnknown(result);
    },

    async getGroupMembers(groupId) {
      assertPositiveId(groupId, 'groupId');
      const result = await runAction('get_group_member_list', () => getClient().raw('get_group_member_list', { group_id: groupId }));
      if (!Array.isArray(result)) return undefined;
      return result.flatMap((item) => {
        const member = groupMemberFromUnknown(item);
        return member ? [member] : [];
      });
    },

    async getGroupHonors(groupId) {
      assertPositiveId(groupId, 'groupId');
      const result = await runAction('get_group_honor_info', () => getClient().raw('get_group_honor_info', {
        group_id: groupId,
        type: 'all',
      }));
      return honorsFromUnknown(result);
    },

    async getStrangerInfo(userId) {
      assertPositiveId(userId, 'userId');
      const result = await runAction('get_stranger_info', () => getClient().raw('get_stranger_info', { user_id: userId }));
      return strangerInfoFromUnknown(result);
    },

    async getGroupNoticeLatest(groupId) {
      assertPositiveId(groupId, 'groupId');
      const result = await runAction('_get_group_notice', () => getClient().raw('_get_group_notice', { group_id: groupId }));
      return latestNoticeFromUnknown(result);
    },

    async getEssenceCount(groupId) {
      assertPositiveId(groupId, 'groupId');
      const result = await runAction('get_essence_msg_list', () => getClient().raw('get_essence_msg_list', { group_id: groupId }));
      return Array.isArray(result) ? result.length : undefined;
    },
  };
}
