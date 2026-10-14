// 控制台必须在 OneBot connect 等待小号登录期间仍可访问。
export function startPanelWhileAccountStartupRuns(
  accountStartup: Promise<void>,
  startPanel: () => void,
): Promise<void> {
  startPanel();
  return accountStartup;
}
