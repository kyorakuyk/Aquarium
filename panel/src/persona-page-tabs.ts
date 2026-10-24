export type PersonaEditorTab = 'who' | 'deal' | 'parameters' | 'other';
export type PersonaParameterTab = 'affinity' | 'energy' | 'mood' | 'sleep' | 'initiative' | 'memory';
export type PersonaPreviewTab = 'injected' | 'evolution' | 'versions';

export interface PersonaTabStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface PersonaPageTabsState {
  page: PersonaEditorTab;
  parameter: PersonaParameterTab;
}

export interface PersonaParameterPlaceholder {
  title: string;
  description: string;
  items: ReadonlyArray<{ name: string; note: string; current: string }>;
  dependency: string;
}

export const PERSONA_PAGE_TABS_STORAGE_KEY = 'aquarium.persona-page-tabs.v1';

export const PERSONA_EDITOR_TABS = [
  { id: 'who', label: '我是谁' },
  { id: 'deal', label: '待人接物' },
  { id: 'parameters', label: '参数' },
  { id: 'other', label: '其他小节' },
] as const satisfies ReadonlyArray<{ id: PersonaEditorTab; label: string }>;

export const PERSONA_PARAMETER_TABS = [
  { id: 'affinity', label: '好感' },
  { id: 'energy', label: '心灵能量' },
  { id: 'mood', label: '心情' },
  { id: 'sleep', label: '作息', badge: '占位' },
  { id: 'initiative', label: '主动性', badge: '占位' },
  { id: 'memory', label: '记忆', badge: '占位' },
] as const satisfies ReadonlyArray<{ id: PersonaParameterTab; label: string; badge?: string }>;

export const PERSONA_PREVIEW_TABS = [
  { id: 'injected', label: '实际注入' },
  { id: 'evolution', label: '性格的变化' },
  { id: 'versions', label: '版本' },
] as const satisfies ReadonlyArray<{ id: PersonaPreviewTab; label: string }>;

export const PERSONA_PARAMETER_PLACEHOLDERS: Record<Exclude<PersonaParameterTab, 'affinity'>, PersonaParameterPlaceholder> = {
  // TODO（阶段 4）：将心灵能量获得、消耗与界限倍率放入人设 frontmatter。
  energy: {
    title: '心灵能量',
    description: '获得、消耗和单人影响上限将由人设倍率分别调节。',
    items: [
      { name: '恢复来源', note: '影响独处或有人陪伴时的能量恢复', current: '在「我是谁」中设置' },
      { name: '倍率', note: '未来每项倍率以 ×1 为当前行为基准', current: '人设倍率尚未开放' },
    ],
    dependency: '依赖：阶段 4 增加人设 energy 配置，并按既有心灵能量计算顺序接入。',
  },
  // TODO（阶段 5）：用人设情绪集合、PAD 坐标与逐边规则替换此说明卡。
  mood: {
    title: '心情',
    description: '心情的回落速度、底色和各档的门槛决定我情绪起伏有多大。和心灵能量是同一套系统，放在它旁边。',
    items: [
      { name: '回落速度', note: '心情多久回到底色；心灵能量越满回得越快', current: '半衰期 40 分钟' },
      { name: '心情底色', note: '没人说话时我默认的心情和兴奋度', current: '愉悦 0.1 · 兴奋 0.4' },
      { name: '变档难度', note: '多难从「平静」变成「烦躁」或「开心」，以及至少停留多久', current: '静摩擦 0.05 · 停留 10 分钟' },
      { name: '单人影响上限', note: '同一个人一小时内最多能把我的心情拉动多少', current: '0.8 / 小时' },
    ],
    dependency: '依赖：心情振幅调整（MOOD-AMPLITUDE-TUNING）先落地，这里的默认值以它为准。代码在 src/core/mood/core.ts。',
  },
  // TODO：确认作息归属（全局还是按账号）后，再决定是否移入人设。
  sleep: {
    title: '作息',
    description: '人有困的时候。几点犯困、几点睡、睡着后回不回消息，会让我更像一个活人。',
    items: [
      { name: '犯困 / 入睡', note: '几点开始困、几点睡着；困的时候回复变短变慢', current: '总览「作息」卡片里的值' },
      { name: '起床', note: '几点醒；周末可以单独设晚起', current: '同上' },
      { name: '睡着后', note: '被叫醒的概率、要被叫几次才回、回完会不会继续睡', current: '待查代码' },
      { name: '睡前整理', note: '睡着时整理记忆和写日记，几点开始', current: '见知识与印象拆分' },
    ],
    dependency: '依赖：先确认作息现在存在哪里（全局还是按账号），再决定要不要挪进人设。',
  },
  // TODO：从全局配置迁入人设；未配置时继续沿用全局默认。
  initiative: {
    title: '主动性',
    description: '多久主动开口、被冷落后退多远、一次回几句，这几项最影响「像不像真人」的第一感觉。现在是所有人设共用一套，挪进人设后文静和话痨才真的不一样。',
    items: [
      { name: '主动开口', note: '主动判断分值的门槛，越低越爱插话', current: '决策页「主动判断分值」' },
      { name: '被冷落后退避', note: '主动说话没人理之后，隔多久再试、每次加倍多少', current: 'src/core/activity/backoff.ts' },
      { name: '一次回几句', note: '现在由「话量」决定 1–3 句，这里可以单独覆盖', current: '话量 -2→1 句 · -1→2 句 · 其余 3 句' },
      { name: '打字停顿', note: '每句之间停多久，按字数算还是固定', current: '待查代码' },
    ],
    dependency: '依赖：先把这些值从全局配置（src/config/schema.ts）挪到人设，没写的人设沿用全局默认。',
  },
  // TODO：等知识与印象拆分（KNOWLEDGE-IMPRESSION-SPLIT / CHIPS）落地后再实现。
  memory: {
    title: '记忆',
    description: '记得多快、忘得多快，决定我是「过目不忘」还是「有点迷糊」。',
    items: [
      { name: '记住的门槛', note: '一条知识要被提到几次、置信度到多少才进提示词', current: '带滞回的阈值' },
      { name: '淡忘速度', note: '多久不提开始降低置信度', current: '待定' },
      { name: '印象转正', note: '印象从「不确定（?）」变成「确定」的门槛', current: '待定' },
      { name: '转述可信度', note: '从别人那里听来的事，打几折相信', current: '眷属组转述规则' },
    ],
    dependency: '依赖：知识与印象拆分（KNOWLEDGE-IMPRESSION-SPLIT / CHIPS）落地之后再做，这些阈值现在还在变。',
  },
};

function browserStorage(): PersonaTabStorage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function isEditorTab(value: unknown): value is PersonaEditorTab {
  return PERSONA_EDITOR_TABS.some((tab) => tab.id === value);
}

function isParameterTab(value: unknown): value is PersonaParameterTab {
  return PERSONA_PARAMETER_TABS.some((tab) => tab.id === value);
}

export function readPersonaPageTabs(storage: PersonaTabStorage | undefined = browserStorage()): PersonaPageTabsState {
  if (!storage) return { page: 'who', parameter: 'affinity' };
  try {
    const serialized = storage.getItem(PERSONA_PAGE_TABS_STORAGE_KEY);
    if (!serialized) return { page: 'who', parameter: 'affinity' };
    const value: unknown = JSON.parse(serialized);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { page: 'who', parameter: 'affinity' };
    }
    const state = value as Record<string, unknown>;
    return {
      page: isEditorTab(state.page) ? state.page : 'who',
      parameter: isParameterTab(state.parameter) ? state.parameter : 'affinity',
    };
  } catch {
    return { page: 'who', parameter: 'affinity' };
  }
}

export function writePersonaPageTabs(
  state: PersonaPageTabsState,
  storage: PersonaTabStorage | undefined = browserStorage(),
): void {
  if (!storage) return;
  const safeState = {
    page: isEditorTab(state.page) ? state.page : 'who',
    parameter: isParameterTab(state.parameter) ? state.parameter : 'affinity',
  };
  try {
    storage.setItem(PERSONA_PAGE_TABS_STORAGE_KEY, JSON.stringify(safeState));
  } catch {
    // 标签页记忆失败不应阻止当前人设编辑。
  }
}
