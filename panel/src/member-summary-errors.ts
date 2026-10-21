export function memberSummaryErrorMessage(reason: unknown, operation: 'read' | 'save'): string {
  const message = reason instanceof Error ? reason.message : '';
  if (message === '登录已失效') return message;
  if (message === 'Member summary target not found') {
    return '该成员当前没有可编辑的印象标签，请刷新后重试。';
  }
  if (message === 'Member summary must be a single line of up to 50 characters') {
    return '一句话印象须为单行且不超过 50 个字符。';
  }
  return operation === 'read'
    ? '读取一句话印象失败，请稍后重试。'
    : '保存一句话印象失败，请检查内容后重试。';
}
