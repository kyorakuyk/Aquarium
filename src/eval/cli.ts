import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEvalArgs } from './cli-args.ts';
import { evaluateDataset, parseDatasetJsonl, writeEvaluationReport } from './evaluator.ts';

export async function runEvalCli(args: readonly string[], cwd = process.cwd()): Promise<void> {
  const options = parseEvalArgs(args);
  if (options.withJudge) {
    console.log('--with-judge 已解析；将在 M2 实现。本次仍只运行 gate。');
  }

  let source: string;
  try {
    source = fs.readFileSync(path.resolve(cwd, options.datasetPath), 'utf8');
  } catch {
    throw new Error('Unable to read the --dataset JSONL file');
  }
  const samples = parseDatasetJsonl(source);
  const report = await evaluateDataset(samples);
  const outputPath = writeEvaluationReport(report, path.join(cwd, 'data', 'eval'));
  const { truePositive, falsePositive, trueNegative, falseNegative } = report.confusionMatrix;

  console.log(`Samples: ${report.sampleCount}`);
  console.log(`Precision (reply): ${report.precision.toFixed(4)}`);
  console.log(`Recall (reply): ${report.recall.toFixed(4)}`);
  console.log(`F1 (reply): ${report.f1.toFixed(4)}`);
  console.log('Confusion matrix (actual rows × predicted columns):');
  console.log('                 reply  skip');
  console.log(`actual reply       ${truePositive}      ${falseNegative}`);
  console.log(`actual skip        ${falsePositive}      ${trueNegative}`);
  console.log(`Output: ${path.relative(cwd, outputPath)}`);
}

function isDirectExecution(): boolean {
  const invokedPath = process.argv[1];
  return invokedPath !== undefined
    && pathToFileURL(path.resolve(invokedPath)).href === import.meta.url;
}

if (isDirectExecution()) {
  void runEvalCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Evaluation failed');
    process.exitCode = 1;
  });
}
