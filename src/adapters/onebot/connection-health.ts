const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class OneBotConnectionHealth {
  private connectionOpenedAt: number | undefined;
  private lastEventAt: number | undefined;
  private lastHeartbeatAt: number | undefined;
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
    this.lastHeartbeatAt = undefined;
    this.heartbeatInterval = DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.heartbeatOnline = undefined;
    this.heartbeatGood = undefined;
  }

  recordPacket(event: unknown): void {
    const receivedAt = this.options.now();
    this.lastEventAt = receivedAt;
    if (!isRecord(event) || event.post_type !== 'meta_event' || event.meta_event_type !== 'heartbeat') return;

    const observedGapMs = this.lastHeartbeatAt === undefined ? undefined : receivedAt - this.lastHeartbeatAt;
    this.lastHeartbeatAt = receivedAt;
    this.heartbeatInterval = typeof event.interval === 'number'
      && Number.isSafeInteger(event.interval)
      && event.interval > 0
      ? event.interval
      : DEFAULT_HEARTBEAT_INTERVAL_MS;
    const status = isRecord(event.status) ? event.status : undefined;
    const online = typeof status?.online === 'boolean' ? status.online : undefined;
    const good = typeof status?.good === 'boolean' ? status.good : undefined;
    this.debug(
      `账号 ${this.options.account} SnowLuma 心跳：intervalMs=${this.heartbeatInterval}`
      + ` observedGapMs=${observedGapMs ?? 'first'} online=${online ?? 'unknown'} good=${good ?? 'unknown'}。`,
    );
    if (status) {
      this.updateStatus(online, good);
    }
  }

  recordStatus(status: { online: boolean; good: boolean }): void {
    this.updateStatus(status.online, status.good);
  }

  private updateStatus(online: boolean | undefined, good: boolean | undefined): void {
    if (online !== undefined) this.heartbeatOnline = online;
    if (good !== undefined) this.heartbeatGood = good;
    if (online === false) {
      this.debug(`账号 ${this.options.account} SnowLuma 心跳报告 status.online=false；保持 WebSocket 连接。`);
    } else if (good === false) {
      this.debug(`账号 ${this.options.account} SnowLuma 心跳报告 good=false；接收链路异常，不触发重连。`);
    }
  }

  private debug(message: string): void {
    try { this.options.onDebug?.(message); } catch { /* diagnostics must not alter connection health */ }
  }
}
