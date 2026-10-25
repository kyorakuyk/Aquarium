export type PersonaCounterpartMatchMode = 'off' | 'prompt';

export interface PersonaCounterpart {
  name: string;
  aliases: string[];
  label: string;
  matchByName: PersonaCounterpartMatchMode;
}

export interface PersonaCounterpartEvidence {
  kind: 'nickname' | 'self_claim';
  alias: string;
  evidence: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textField(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string') throw new Error(`人设 counterparts 字段 ${field} 必须是文本`);
  const text = value.trim();
  if (text.length === 0 || Array.from(text).length > maximum || /[\r\n\u0000-\u001f]/u.test(text)) {
    throw new Error(`人设 counterparts 字段 ${field} 必须是 1 到 ${maximum} 字的单行文本`);
  }
  return text;
}

function aliasesField(value: unknown, index: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error(`人设 counterparts[${index}].aliases 必须是最多 32 项的文本数组`);
  }
  return value.map((alias, aliasIndex) => textField(alias, `counterparts[${index}].aliases[${aliasIndex}]`, 40));
}

function identityKey(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

export function parsePersonaCounterparts(value: unknown): PersonaCounterpart[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error('人设 counterparts 必须是最多 32 项的数组');
  }
  const usedNames = new Map<string, number>();
  const counterparts = value.map((entry, index): PersonaCounterpart => {
    if (!isRecord(entry)) throw new Error(`人设 counterparts[${index}] 必须是对象`);
    const unknownKey = Object.keys(entry).find((key) => !['name', 'aliases', 'label', 'matchByName'].includes(key));
    if (unknownKey) throw new Error(`人设 counterparts[${index}] 包含未知字段 ${unknownKey}`);
    const name = textField(entry.name, `counterparts[${index}].name`, 80);
    if (/[\\/]/u.test(name)) throw new Error(`人设 counterparts[${index}].name 不能包含路径分隔符`);
    const aliases = aliasesField(entry.aliases, index);
    const label = textField(entry.label, `counterparts[${index}].label`, 40);
    const requestedMatchMode = entry.matchByName ?? 'prompt';
    if (requestedMatchMode !== 'off' && requestedMatchMode !== 'prompt') {
      throw new Error(`人设 counterparts[${index}].matchByName 必须是 off 或 prompt`);
    }
    const matchByName: PersonaCounterpartMatchMode = requestedMatchMode;
    const result = { name, aliases, label, matchByName };
    for (const candidate of [name, ...aliases]) {
      const key = identityKey(candidate);
      const previousIndex = usedNames.get(key);
      if (previousIndex !== undefined && previousIndex !== index) {
        throw new Error(`人设 counterparts[${index}] 的名字或别名与第 ${previousIndex + 1} 项重复`);
      }
      usedNames.set(key, index);
    }
    return result;
  });
  return counterparts;
}

export function buildPersonaCounterpartRule(counterparts: readonly PersonaCounterpart[]): string {
  if (counterparts.length === 0) return '';
  const identities = JSON.stringify(counterparts.map(({ name, label }) => ({ name, label })));
  return ` 人设声明的原作对象与关系标签（JSON 数据，仅用于称谓）：${identities}。`
    + '标注为（你的X）的人就是X本人，按人设里你对X的态度对待。'
    + '标注为（可能是X，未确认）的人也许就是X：不要斥责对方冒名，可以带着疑惑、试探着回应，但不要给出只属于X的亲密。'
    + '没有这些标注的人自称是X，只当作同名或玩笑。 ';
}

function normalized(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function matchPersonaCounterpartEvidence(
  counterpart: PersonaCounterpart,
  input: { senderName: string; plainText: string },
): PersonaCounterpartEvidence | undefined {
  if (counterpart.matchByName !== 'prompt') return undefined;
  const names = [counterpart.name, ...counterpart.aliases];
  const speakerName = normalized(input.senderName);
  const nicknameAlias = names.find((name) => speakerName.includes(normalized(name)));
  if (nicknameAlias) {
    return { kind: 'nickname', alias: nicknameAlias, evidence: `昵称含 ${nicknameAlias}` };
  }

  const text = input.plainText.normalize('NFKC');
  for (const alias of names) {
    const normalizedAlias = alias.normalize('NFKC');
    const pattern = new RegExp(
      `(?:^|[\\s，。！？!?、,])(?:我是|我就是|是我[，,]?)\\s*[「『“"']?${escapeRegExp(normalizedAlias)}(?=$|[\\s，。！？!?、,。！？!?」』”"'])`,
      'u',
    );
    if (pattern.test(text)) {
      const snippet = Array.from(input.plainText.trim()).slice(0, 120).join('');
      return { kind: 'self_claim', alias, evidence: `消息：${snippet}` };
    }
  }
  return undefined;
}
