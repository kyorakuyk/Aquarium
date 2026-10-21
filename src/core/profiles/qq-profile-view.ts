import type { QqGroupMember } from '../../adapters/types.ts';

export interface QqMemberComposition {
  sex: { male: number; female: number; unknown: number };
  joinDuration: { overThreeYears: number; oneToThreeYears: number; withinOneYear: number; unknown: number };
}

function completedYears(joinTime: number, now: number): number | undefined {
  if (!Number.isSafeInteger(joinTime) || joinTime < 0 || !Number.isFinite(now)) return undefined;
  const joinedAt = new Date(joinTime * 1_000);
  const currentAt = new Date(now);
  if (!Number.isFinite(joinedAt.getTime()) || !Number.isFinite(currentAt.getTime())
    || joinedAt.getTime() > currentAt.getTime()) return undefined;
  let years = currentAt.getUTCFullYear() - joinedAt.getUTCFullYear();
  if (currentAt.getUTCMonth() < joinedAt.getUTCMonth()
    || (currentAt.getUTCMonth() === joinedAt.getUTCMonth() && currentAt.getUTCDate() < joinedAt.getUTCDate())) years -= 1;
  return years >= 0 ? years : undefined;
}

export function summarizeQqMemberComposition(
  members: readonly Pick<QqGroupMember, 'sex' | 'joinTime'>[],
  now: number,
): QqMemberComposition {
  const result: QqMemberComposition = {
    sex: { male: 0, female: 0, unknown: 0 },
    joinDuration: { overThreeYears: 0, oneToThreeYears: 0, withinOneYear: 0, unknown: 0 },
  };
  for (const member of members) {
    if (member.sex === 'male') result.sex.male += 1;
    else if (member.sex === 'female') result.sex.female += 1;
    else result.sex.unknown += 1;
    const years = member.joinTime === undefined ? undefined : completedYears(member.joinTime, now);
    if (years === undefined) result.joinDuration.unknown += 1;
    else if (years >= 3) result.joinDuration.overThreeYears += 1;
    else if (years >= 1) result.joinDuration.oneToThreeYears += 1;
    else result.joinDuration.withinOneYear += 1;
  }
  return result;
}
