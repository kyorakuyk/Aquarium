import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseEvalArgs } from '../src/eval/cli-args.ts';
import { runEvalCli } from '../src/eval/cli.ts';
import {
  evaluateDataset,
  parseDatasetJsonl,
  writeEvaluationReport,
} from '../src/eval/evaluator.ts';

const fixturePath = path.resolve('test/fixtures/eval-sample.jsonl');
const fixtureText = fs.readFileSync(fixturePath, 'utf8');

test('synthetic evaluation fixture contains ten valid samples', () => {
  const samples = parseDatasetJsonl(fixtureText);
  assert.equal(samples.length, 10);
  assert.ok(samples.every((sample) => sample.messages.length === 0));
});

test('evaluation runs only the N1 gate and reports binary metrics', async () => {
  const report = await evaluateDataset(parseDatasetJsonl(fixtureText));
  assert.deepEqual(report, {
    sampleCount: 10,
    confusionMatrix: { truePositive: 4, falsePositive: 2, trueNegative: 3, falseNegative: 1 },
    precision: 4 / 6,
    recall: 4 / 5,
    f1: 2 * (4 / 6) * (4 / 5) / ((4 / 6) + (4 / 5)),
  });
});

test('evaluation metrics do not depend on dataset row order', async () => {
  const samples = parseDatasetJsonl(fixtureText);
  const forward = await evaluateDataset(samples);
  const reverse = await evaluateDataset([...samples].reverse());
  assert.deepEqual(reverse, forward);
});

test('invalid JSONL reports the row number without echoing message text', () => {
  const privateLikeMarker = 'SYNTHETIC_PRIVATE_MARKER_NOT_FOR_OUTPUT';
  const invalid = JSON.stringify({
    sessionId: '1:group:1',
    messages: [],
    target: { senderId: 2, plainText: privateLikeMarker, mentionsSelf: false },
    label: 'maybe',
  });
  assert.throws(() => parseDatasetJsonl(`${invalid}\n`), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /line 1/u);
    assert.equal(error.message.includes(privateLikeMarker), false);
    return true;
  });
});

test('CLI parses the dataset and reserves --with-judge without enabling it', () => {
  assert.deepEqual(parseEvalArgs(['--dataset', 'fixture.jsonl', '--with-judge']), {
    datasetPath: 'fixture.jsonl',
    withJudge: true,
  });
  assert.throws(() => parseEvalArgs(['--with-judge']), /--dataset/u);
  assert.throws(() => parseEvalArgs(['--dataset', 'fixture.jsonl', '--unknown']), /--unknown/u);
});

test('CLI reports the exact deferred judge message and writes aggregate output', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-eval-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'fixture.jsonl'), fixtureText, 'utf8');
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...parts: unknown[]) => output.push(parts.map(String).join(' '));

  try {
    await runEvalCli(['--dataset', 'fixture.jsonl', '--with-judge'], directory);
  } finally {
    console.log = originalLog;
  }

  assert.ok(output.includes('--with-judge 已解析；将在 M2 实现。本次仍只运行 gate。'));
  assert.ok(output.includes('Precision (reply): 0.6667'));
  assert.ok(output.includes('Recall (reply): 0.8000'));
  assert.ok(output.includes('F1 (reply): 0.7273'));
  assert.ok(output.includes('actual reply       4      1'));
  assert.ok(output.includes('actual skip        2      3'));

  const reportDirectory = path.join(directory, 'data', 'eval');
  const reportFiles = fs.readdirSync(reportDirectory);
  assert.equal(reportFiles.length, 1);
  const report = JSON.parse(fs.readFileSync(path.join(reportDirectory, reportFiles[0]!), 'utf8')) as Record<string, unknown>;
  assert.equal(report.sampleCount, 10);
  assert.equal('samples' in report, false);
});

test('evaluation report writes only aggregate metrics to a timestamped JSON file', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-eval-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const report = await evaluateDataset(parseDatasetJsonl(fixtureText));
  const generatedAt = new Date('2026-10-15T00:00:00.000Z');
  const outputPath = writeEvaluationReport(report, directory, generatedAt);
  const output = JSON.parse(fs.readFileSync(outputPath, 'utf8')) as Record<string, unknown>;

  assert.equal(path.dirname(outputPath), directory);
  assert.equal(path.basename(outputPath), '2026-10-15T00-00-00-000Z.json');
  assert.equal(output.generatedAt, generatedAt.toISOString());
  assert.equal(output.configProfile, 'synthetic-gate-defaults');
  assert.equal(output.sampleCount, 10);
  assert.equal('samples' in output, false);
  assert.equal(JSON.stringify(output).includes('Bot, hello!'), false);
});
