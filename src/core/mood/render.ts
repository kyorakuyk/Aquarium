import type { AffectPromptTemplate } from '../prompt/templates.ts';
import type { ReserveBand } from '../../store/affect-repo.ts';
import type { EnergySource } from './core.ts';

export interface MoodPromptBlocks {
  mood?: string;
  reserve?: string;
  float?: string;
}

// 渲染情绪块与浮动值块：浮动值不做防抖，直接按当前 arousal 取词。
export function renderMoodBlocks(
  template: AffectPromptTemplate,
  emotions: { mainEmotion: string; subEmotions: readonly string[] },
  arousal: number,
  energy = 1,
  reserveBand: ReserveBand = 'full',
  energySource: EnergySource = 'mixed',
): MoodPromptBlocks {
  const mood = template.mood.wrap
    .replaceAll('{{mainEmotion}}', emotions.mainEmotion)
    .replaceAll('{{subEmotions}}', emotions.subEmotions.length > 0 ? emotions.subEmotions.join('、') : '无明显副情绪');
  const float = renderFloatBlock(template, arousal, energy);
  const reserve = reserveBand === 'full' ? undefined : template.reserve[energySource][reserveBand];
  return {
    ...(mood ? { mood } : {}),
    ...(reserve ? { reserve } : {}),
    ...(float ? { float } : {}),
  };
}

export function renderFloatBlock(template: AffectPromptTemplate, arousal: number, energy = 1): string {
  const floatWord = arousal < 0.3
    ? template.float.arousalLow
    : arousal > 0.7 ? template.float.arousalHigh : '';
  const floatWords = [floatWord, ...(energy < 0.35 ? ['有点困'] : [])].filter(Boolean);
  return floatWords.length > 0
    ? template.float.wrap.replaceAll('{{floats}}', floatWords.join('、'))
    : '';
}
