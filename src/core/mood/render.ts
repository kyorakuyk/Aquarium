import type { AffectPromptTemplate } from '../prompt-templates.ts';
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
): MoodPromptBlocks {
  const mood = template.mood[band];
  const floatWord = arousal < 0.3
    ? template.float.arousalLow
    : arousal > 0.7 ? template.float.arousalHigh : '';
  const float = floatWord ? template.float.wrap.replaceAll('{{floats}}', floatWord) : '';
  return {
    ...(mood ? { mood } : {}),
    ...(float ? { float } : {}),
  };
}
