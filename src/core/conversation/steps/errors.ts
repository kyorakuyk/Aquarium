export function errorDetails(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== 'object') return { errorName: 'UnknownError' };
  const details = error as { name?: unknown; status?: unknown; code?: unknown };
  return {
    errorName: typeof details.name === 'string' ? details.name : 'Error',
    ...(typeof details.status === 'number' ? { status: details.status } : {}),
    ...(typeof details.code === 'string' ? { code: details.code } : {}),
  };
}
