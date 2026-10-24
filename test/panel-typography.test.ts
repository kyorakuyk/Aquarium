import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const tokens = readFileSync(new URL('../panel/src/styles/tokens.css', import.meta.url), 'utf8');
const layout = readFileSync(new URL('../panel/src/styles/layout.css', import.meta.url), 'utf8');

function token(name: string): string | undefined {
  return tokens.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1].trim();
}

function ruleFontSize(selector: string): string | undefined {
  const declarations = layout.match(new RegExp(`${selector}\\s*\\{([^}]+)\\}`))?.[1];
  return declarations?.match(/font-size:\s*([^;]+);/)?.[1].trim();
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16) / 255);
  const linear = channels.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function contrastRatio(first: string, second: string): number {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test('panel typography defines readable body/support/control sizes and muted contrast', () => {
  assert.equal(token('type-body'), '14px');
  assert.equal(token('type-support'), '12px');
  assert.equal(token('type-control'), '13px');
  assert.equal(ruleFontSize('body'), 'var(--type-body)');
  assert.equal(ruleFontSize('\\.muted'), 'var(--type-support)');
  assert.equal(ruleFontSize('\\.field-label'), 'var(--type-control)');

  const muted = token('muted');
  const placeholder = token('placeholder');
  const surface = token('surface');
  assert.match(muted ?? '', /^#[\da-f]{6}$/i);
  assert.match(placeholder ?? '', /^#[\da-f]{6}$/i);
  assert.match(surface ?? '', /^#[\da-f]{6}$/i);
  assert.ok(contrastRatio(muted!, surface!) >= 4.5);
  assert.ok(contrastRatio(placeholder!, surface!) >= 4.5);
});
