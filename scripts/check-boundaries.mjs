import fs from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const sourceRoot = path.join(projectRoot, 'src');

function walk(directory, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(fullPath, files);
    else if (entry.isFile() && fullPath.endsWith('.ts')) files.push(fullPath);
  }
  return files.sort();
}

function tokenize(source) {
  const tokens = [];
  let index = 0;
  let line = 1;

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (/\s/.test(char)) {
      if (char === '\n') line += 1;
      index += 1;
      continue;
    }
    if (char === '/' && next === '/') {
      index += 2;
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] === '\n') line += 1;
        index += 1;
      }
      index = Math.min(source.length, index + 2);
      continue;
    }
    if (char === '\'' || char === '"') {
      const quote = char;
      const startLine = line;
      let value = '';
      index += 1;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === '\\' && index + 1 < source.length) {
          value += source[index + 1];
          if (source[index + 1] === '\n') line += 1;
          index += 2;
        } else {
          if (source[index] === '\n') line += 1;
          value += source[index];
          index += 1;
        }
      }
      if (source[index] === quote) index += 1;
      tokens.push({ kind: 'string', value, line: startLine });
      continue;
    }
    if (char === '`') {
      index += 1;
      while (index < source.length && source[index] !== '`') {
        if (source[index] === '\\' && index + 1 < source.length) {
          if (source[index + 1] === '\n') line += 1;
          index += 2;
        } else {
          if (source[index] === '\n') line += 1;
          index += 1;
        }
      }
      if (source[index] === '`') index += 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      const start = index;
      while (index < source.length && /[A-Za-z0-9_$]/.test(source[index])) index += 1;
      tokens.push({ kind: 'identifier', value: source.slice(start, index), line });
      continue;
    }

    tokens.push({ kind: 'punctuation', value: char, line });
    index += 1;
  }

  return tokens;
}

function moduleReferences(source) {
  const tokens = tokenize(source);
  const references = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const next = tokens[index + 1];

    if (token.value === 'require' && next?.value === '(' && tokens[index + 2]?.kind === 'string') {
      references.push(tokens[index + 2].value);
      continue;
    }
    if (token.value !== 'import' && token.value !== 'export') continue;

    if (token.value === 'import' && next?.value === '(' && tokens[index + 2]?.kind === 'string') {
      references.push(tokens[index + 2].value);
      continue;
    }
    if (token.value === 'import' && next?.kind === 'string') {
      references.push(next.value);
      continue;
    }
    if (next?.value === '.') continue;

    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      const current = tokens[cursor];
      if (current.value === ';') break;
      if (cursor > index + 1 && current.line > token.line && (current.value === 'import' || current.value === 'export')) break;
      if (current.value === 'from' && tokens[cursor + 1]?.kind === 'string') {
        references.push(tokens[cursor + 1].value);
        break;
      }
    }
  }

  return references;
}

function sourceTarget(file, specifier) {
  if (!specifier.startsWith('.')) return undefined;
  const absolute = path.resolve(path.dirname(file), specifier);
  return path.relative(sourceRoot, absolute).split(path.sep).join('/');
}

function isWithin(target, directory) {
  return target === directory || target.startsWith(`${directory}/`);
}

function checkImport(file, relativeFile, specifier) {
  const issues = [];
  const normalizedFile = relativeFile.split(path.sep).join('/');
  const fromCore = isWithin(normalizedFile, 'core');
  const fromStore = isWithin(normalizedFile, 'store');
  const fromOnebot = isWithin(normalizedFile, 'adapters/onebot');
  const source = sourceTarget(file, specifier);
  const sdkImport = specifier === '@snowluma/sdk' || specifier.startsWith('@snowluma/sdk/');

  // T0 spike 是一次性验证入口；T2 的适配器版本完成后应删除此临时豁免。
  const temporarySpike = normalizedFile === 'spike/ping.ts';
  if (sdkImport && !fromOnebot && !temporarySpike) {
    issues.push('只有 OneBot 适配器可依赖 @snowluma/sdk');
  }

  if (fromCore) {
    if (specifier === 'node:child_process' || specifier === 'child_process') {
      issues.push('core 不得依赖 child_process');
    }
    if (source && isWithin(source, 'adapters/onebot')) {
      issues.push('core 不得依赖 adapters/onebot');
    }
    if (source && isWithin(source, 'host/windows')) {
      issues.push('core 不得依赖 host/windows');
    }
    if (source) {
      const allowed = ['core', 'config', 'llm', 'store', 'persona'];
      if (!(source === 'adapters/types.ts' || source === 'adapters/types')
        && !allowed.some((directory) => isWithin(source, directory))) {
        issues.push('core 只能依赖自身、adapters/types、config、llm、store 与 persona');
      }
    }
  }

  if (fromStore && source && isWithin(source, 'core') && source !== 'core/impressions/tag-model.ts') {
    issues.push('store 只能依赖 core/impressions/tag-model.ts');
  }

  if (isWithin(normalizedFile, 'host') && source && isWithin(source, 'core')) {
    issues.push('host 不得依赖 core');
  }

  if (fromOnebot && source) {
    const allowed = isWithin(source, 'adapters/onebot')
      || source === 'adapters/types.ts'
      || source === 'adapters/types'
      || source === 'core/events.ts'
      || source === 'core/events';
    if (!allowed) issues.push('OneBot 适配器只能依赖自身、adapters/types 与 core/events');
  }

  return issues;
}

if (!fs.existsSync(sourceRoot)) {
  console.error('依赖边界检查失败：src/ 目录不存在');
  process.exit(1);
}

const violations = [];
for (const file of walk(sourceRoot)) {
  const relativeFile = path.relative(sourceRoot, file).split(path.sep).join('/');
  const source = fs.readFileSync(file, 'utf8');
  for (const specifier of moduleReferences(source)) {
    for (const reason of checkImport(file, relativeFile, specifier)) {
      violations.push(`src/${relativeFile} -> ${specifier}（${reason}）`);
    }
  }
}

if (violations.length > 0) {
  console.error(`发现 ${violations.length} 条依赖边界违规：`);
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log('依赖边界检查通过');
