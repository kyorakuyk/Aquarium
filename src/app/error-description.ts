export function describeError(error: unknown, stage?: string): string {
  const safeStage = stage?.replace(/[\r\n\t]+/gu, ' ').trim().slice(0, 120);
  const details = error && typeof error === 'object'
    ? error as {
      name?: unknown;
      status?: unknown;
      code?: unknown;
      hostname?: unknown;
      constructor?: { name?: unknown };
      cause?: unknown;
    }
    : undefined;
  const cause = details?.cause && typeof details.cause === 'object'
    ? details.cause as { name?: unknown; code?: unknown }
    : undefined;
  const errorName = details
    ? typeof details.name === 'string' ? details.name : 'Error'
    : '未知错误';
  return [
    errorName,
    ...(safeStage ? [`stage=${safeStage}`] : []),
    ...(details && typeof details.status === 'number' ? [`status=${details.status}`] : []),
    ...(details && typeof details.code === 'string' ? [`code=${details.code}`] : []),
    ...(typeof details?.constructor?.name === 'string' ? [`constructor=${details.constructor.name}`] : []),
    ...(typeof cause?.name === 'string' ? [`causeName=${cause.name}`] : []),
    ...(typeof cause?.code === 'string' ? [`causeCode=${cause.code}`] : []),
    ...(details && typeof details.hostname === 'string' ? [`host=${details.hostname}`] : []),
  ].join(' ');
}
