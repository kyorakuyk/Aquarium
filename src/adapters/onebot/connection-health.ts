const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class OneBotConnectionHealth {
  private connectionOpenedAt: number | undefined;
  private lastEventAt: number | undefined;
  private heartbeatInterval = DEFAULT_HEARTBEAT_INTERVAL_MS;
  private heartbeatOnline: boolean | undefined;
  private heartbeatGood: boolean | undefined;
  private readonly options: {
    account: number;
    now: () => number;
    onDebug?: (message: string) => void;
  };

  constructor(options: {
    account: number;
    now: () => number;
    onDebug?: (message: string) => void;
  }) {
    this.options = options;
  }

  get intervalMs(): number {
    return this.heartbeatInterval;
  }

  get lastPacketAt(): number | undefined {
    return this.lastEventAt ?? this.connectionOpenedAt;
  }

  get hint(): string | undefined {
    if (this.heartbeatOnline === false) {
      return 'SnowLuma 心跳报告 status.online=false；QQ 会话未在线，Aquarium 保持 WebSocket 连接。';
    }
    if (this.heartbeatGood === false) {
      return 'SnowLuma 心跳报告 good=false；QQ 接收链路异常，Aquarium 不会自动重连。';
    }
    return undefined;
  }

  opened(): void {
    this.reset();
    this.connectionOpenedAt = this.options.now();
  }

  reset(): void {
    this.connectionOpenedAt = undefined;
    this.lastEventAt = undefined;
    this.heartbeatInterval = DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.heartbeatOnline = undefined;
    this.heartbeatGood = undefined;
  }

  recordPacket(event: unknown): void {
    this.lastEventAt = this.options.now();
    if (!isRecord(event) || event.post_type !== 'meta_event' || event.meta_event_type !== 'heartbeat') return;

    this.heartbeatInterval = typeof event.interval === 'number'
      && Number.isSafeInteger(event.interval)
      && event.interval > 0
      ? event.interval
      : DEFAULT_HEARTBEAT_INTERVAL_MS;
    const status = isRecord(event.status) ? event.status : undefined;
    if (status) {
      this.updateStatus(
        typeof status.online === 'boolean' ? status.online : undefined,
        typeof status.good === 'boolean' ? status.good : undefined,
      );
    }
  }

  recordStatus(status: { online: boolean; good: boolean }): void {
    this.updateStatus(status.online, status.good);
  }

  private updateStatus(online: boolean | undefined, good: boolean | undefined): void {
    if (online !== undefined) this.heartbeatOnline = online;
    if (good !== undefined) this.heartbeatGood = good;
    if (online === false) {
      this.options.onDebug?.(`账号 ${this.options.account} SnowLuma 心跳报告 status.online=false；保持 WebSocket 连接。`);
    } else if (good === false) {
      this.options.onDebug?.(`账号 ${this.options.account} SnowLuma 心跳报告 good=false；接收链路异常，不触发重连。`);
    }
  }
}
