import { z } from 'zod';

export interface EvalCliOptions {
  datasetPath: string;
  withJudge: boolean;
}

export function parseEvalArgs(args: readonly string[]): EvalCliOptions {
  let datasetPath: string | undefined;
  let withJudge = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--dataset') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--dataset requires a JSONL path');
      if (datasetPath !== undefined) throw new Error('--dataset may only be provided once');
      datasetPath = value;
      index += 1;
    } else if (argument === '--with-judge') {
      withJudge = true;
    } else {
      throw new Error(`Unknown eval argument: ${argument}`);
    }
  }

  if (datasetPath === undefined) throw new Error('Missing required --dataset <path.jsonl>');
  return { datasetPath, withJudge };
}

export const EvalTargetSchema = z.object({
  senderId: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(1),
  plainText: z.string(),
  mentionsSelf: z.boolean().default(false),
}).passthrough();

export const EvalSampleSchema = z.object({
  sessionId: z.string().min(1),
  messages: z.array(z.unknown()),
  target: EvalTargetSchema,
  label: z.enum(['reply', 'skip']),
}).strict();

export type EvalSample = z.infer<typeof EvalSampleSchema>;

export function parseSessionId(value: string): { account: number; kind: 'group' | 'private'; peer: number } {
  const match = /^(0|[1-9]\d*):(group|private):([1-9]\d*)$/u.exec(value);
  if (!match) throw new Error('invalid session id');

  const account = Number(match[1]);
  const peer = Number(match[3]);
  const kind = match[2];
  if (!Number.isSafeInteger(account) || !Number.isSafeInteger(peer)
    || (kind !== 'group' && kind !== 'private')) {
    throw new Error('invalid session id');
  }
  return { account, kind, peer };
}
