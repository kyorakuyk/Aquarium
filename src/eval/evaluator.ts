import fs from 'node:fs';
import path from 'node:path';
import type { ProtocolAdapter } from '../adapters/types.ts';
import { AquariumConfigSchema, type AquariumConfig } from '../config/schema.ts';
import type { IncomingMessage } from '../core/events.ts';
import { createRateLimiter } from '../core/rate-limit.ts';
import { gateStep } from '../core/steps/gate.ts';
import type { PipelineModelCall, StepContext } from '../core/steps/types.ts';
import type { PromptTemplateSet } from '../core/prompt-templates.ts';
import type { StoreRepository } from '../store/repository.ts';
import { EvalSampleSchema, parseSessionId, type EvalSample } from './cli-args.ts';

export interface ConfusionMatrix {
  truePositive: number;
  falsePositive: number;
  trueNegative: number;
  falseNegative: number;
}

export interface EvaluationReport {
  sampleCount: number;
  confusionMatrix: ConfusionMatrix;
  precision: number;
  recall: number;
  f1: number;
}

export const EVALUATION_CONFIG_PROFILE = 'synthetic-gate-defaults';

function createEvaluationConfig(): AquariumConfig {
  return AquariumConfigSchema.parse({
    owner: 0,
    accounts: [],
    providers: {},
    slots: {},
    pricing: {},
    budget: { dailyCny: 0, warnRatio: 0 },
    defaults: {
      enabled: true,
      mode: 'mention_only',
      nicknames: ['Bot'],
      contextMessages: 1,
      rate: { perUserPerMinute: 100, perSessionPerMinute: 100, minIntervalSec: 1 },
      groupNote: '',
    },
    sessions: {},
    panel: { host: '127.0.0.1', port: 1, passwordEnv: 'EVAL_UNUSED_ENV' },
  });
}

function createUnusedTemplates(): PromptTemplateSet {
  return {
    replySystem: {
      source: '', version: '', system: '', groupNote: '', request: '',
      groupTags: '', memberTags: '', privateFacts: '', knownFacts: '', stickers: '',
    },
    judge: { source: '', version: '', system: '', user: '' },
    vision: { source: '', version: '', system: '', user: '' },
    stickerDescribe: { source: '', version: '', system: '', user: '' },
    appraise: { source: '', version: '', system: '', user: '' },
    affect: {
      source: '',
      version: '',
      mood: { low: '', annoyed: '', calm: '', happy: '', excited: '' },
      float: { arousalLow: '', arousalHigh: '', wrap: '{{floats}}' },
      affinity: { cold: '', cool: '', warm: '', close: '' },
    },
    traits: {
      source: '',
      version: '',
      order: { m2: '', m1: '', p1: '', p2: '' },
      morality: { m2: '', m1: '', p1: '', p2: '' },
      talk: { m2: '', m1: '', p1: '', p2: '' },
      mind: { m2: '', m1: '', p1: '', p2: '' },
      humor: { m2: '', m1: '', p1: '', p2: '' },
      openness: { m2: '', m1: '', p1: '', p2: '' },
      imitation: { m2: '', m1: '', p1: '', p2: '' },
    },
    sleep: { source: '', version: '', goodnight: [] },
    extractTags: { source: '', version: '', system: '', user: '{{context}}{{existing}}' },
    extractPrivate: { source: '', version: '', system: '', user: '{{context}}{{existing}}' },
    privacyGate: { source: '', version: '', system: '', user: '{{context}}{{facts}}' },
    privacyMention: { source: '', version: '', system: '', user: '{{message}}{{facts}}' },
    personaImport: { source: '', version: '', system: '', user: '{{text}}' },
  };
}

const unusedModelCall: PipelineModelCall = async () => {
  throw new Error('N1 gate evaluation must not call a model');
};

function createGateContext(sample: EvalSample, config: AquariumConfig): StepContext {
  const session = parseSessionId(sample.sessionId);
  const message: IncomingMessage = {
    session,
    messageId: 'synthetic-eval-target',
    senderId: sample.target.senderId,
    senderName: 'Synthetic evaluator',
    segments: [{ type: 'text', text: sample.target.plainText }],
    plainText: sample.target.plainText,
    mentionsSelf: sample.target.mentionsSelf,
    replyToSelf: false,
    time: 1_800_000_000_000,
  };
  const now = () => 1_800_000_000_000;
  const options = {
    getConfig: () => config,
    repository: {} as StoreRepository,
    adapter: {} as ProtocolAdapter,
    getNickname: () => 'Bot',
    callModel: unusedModelCall,
  };

  return {
    message,
    processOptions: {},
    currentSessionId: sample.sessionId,
    options,
    now,
    wait: async () => undefined,
    random: () => 0.5,
    modelCall: unusedModelCall,
    rateLimiter: createRateLimiter(now),
    trace: [],
    state: {
      sentMessageIds: [],
      promptFingerprints: [],
      promptTemplates: createUnusedTemplates(),
    },
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

export function parseDatasetJsonl(source: string): EvalSample[] {
  const samples: EvalSample[] = [];
  const lines = source.split(/\r?\n/u);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim() === '') continue;

    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      throw new Error(`Invalid JSONL at line ${index + 1}: malformed JSON`);
    }

    const parsed = EvalSampleSchema.safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue?.path.map(String).join('.') || 'sample';
      throw new Error(`Invalid evaluation sample at line ${index + 1}: ${field}`);
    }
    try {
      parseSessionId(parsed.data.sessionId);
    } catch {
      throw new Error(`Invalid evaluation sample at line ${index + 1}: sessionId`);
    }
    samples.push(parsed.data);
  }

  if (samples.length === 0) throw new Error('Dataset must contain at least one sample');
  return samples;
}

export async function evaluateDataset(samples: readonly EvalSample[]): Promise<EvaluationReport> {
  if (samples.length === 0) throw new Error('Dataset must contain at least one sample');

  const config = createEvaluationConfig();
  const confusionMatrix: ConfusionMatrix = {
    truePositive: 0,
    falsePositive: 0,
    trueNegative: 0,
    falseNegative: 0,
  };

  for (const sample of samples) {
    const result = await gateStep(createGateContext(sample, config));
    const predictedReply = result.next;
    if (sample.label === 'reply' && predictedReply) confusionMatrix.truePositive += 1;
    else if (sample.label === 'skip' && predictedReply) confusionMatrix.falsePositive += 1;
    else if (sample.label === 'skip') confusionMatrix.trueNegative += 1;
    else confusionMatrix.falseNegative += 1;
  }

  const precision = ratio(
    confusionMatrix.truePositive,
    confusionMatrix.truePositive + confusionMatrix.falsePositive,
  );
  const recall = ratio(
    confusionMatrix.truePositive,
    confusionMatrix.truePositive + confusionMatrix.falseNegative,
  );
  const f1 = ratio(2 * precision * recall, precision + recall);

  return { sampleCount: samples.length, confusionMatrix, precision, recall, f1 };
}

export function writeEvaluationReport(
  report: EvaluationReport,
  outputDirectory = path.resolve('data', 'eval'),
  generatedAt = new Date(),
): string {
  fs.mkdirSync(outputDirectory, { recursive: true });
  const timestamp = generatedAt.toISOString().replace(/[:.]/gu, '-');
  const body = `${JSON.stringify({
    generatedAt: generatedAt.toISOString(),
    configProfile: EVALUATION_CONFIG_PROFILE,
    sampleCount: report.sampleCount,
    confusionMatrix: report.confusionMatrix,
    precision: report.precision,
    recall: report.recall,
    f1: report.f1,
  }, null, 2)}\n`;

  for (let suffix = 0; ; suffix += 1) {
    const name = suffix === 0 ? `${timestamp}.json` : `${timestamp}-${suffix}.json`;
    const outputPath = path.join(outputDirectory, name);
    try {
      fs.writeFileSync(outputPath, body, { encoding: 'utf8', flag: 'wx' });
      return outputPath;
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') {
        continue;
      }
      throw error;
    }
  }
}
