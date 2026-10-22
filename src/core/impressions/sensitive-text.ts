const REDACTION = '[敏感内容已隐藏]';

// Conservative ASCII-run masking favors confidentiality over quote fidelity.
const SENSITIVE_PATTERNS: RegExp[] = [
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/-]{8,}/gi,
  /\b(?:api[\s_-]?key|access[\s_-]?token|refresh[\s_-]?token|token|secret|password|credential)\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{6,}["']?/gi,
  /\b(?:sk|pk|rk|ghp|gho|github_pat|xox[baprs]|sg)[-_.][A-Za-z0-9._~+/-]{8,}/gi,
  /\b(?:akia|asia)[0-9A-Z]{16}\b/gi,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\bya29\.[0-9A-Za-z_-]{10,}\b/g,
];

export function redactSensitiveText(value: string): string {
  return SENSITIVE_PATTERNS.reduce((text, pattern) => text.replace(pattern, REDACTION), value);
}

export function containsSensitiveText(value: string): boolean {
  return redactSensitiveText(value) !== value;
}
