export function formatSavedAt(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function personalImpressionsErrorText(message: string): string {
  return /\b404\b|\bnot found\b/iu.test(message)
    ? '印象功能需要重启机器人后才能使用。'
    : message;
}

export function showEmptyPersonalImpressions(loading: boolean, error: string, groupCount: number): boolean {
  return !loading && !error && groupCount === 0;
}
