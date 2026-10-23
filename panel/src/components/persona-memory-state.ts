export function memoryForAccount<T extends { account: number }>(
  memory: T | undefined,
  account: number | undefined,
): T | undefined {
  if (account === undefined || memory?.account !== account) return undefined;
  return memory;
}
