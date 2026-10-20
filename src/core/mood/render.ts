import type { AffectPromptTemplate } from '../prompt/templates.ts';
import type { MoodBand } from '../../store/affect-repo.ts';

export interface MoodPromptBlocks {
  mood?: string;
  float?: string;
}

// 渲染情绪块与浮动值块：浮动值不做防抖，直接按当前 arousal 取词。
export function renderMoodBlocks(
  template: AffectPromptTemplate,
  band: MoodBand,
  arousal: number,
  energy = 1,
): MoodPromptBlocks {
  const mood = template.mood[band];
  const float = renderFloatBlock(template, arousal, energy);
  return {
    ...(mood ? { mood } : {}),
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
