import type { AdapterStatus, ContactFriend, ContactGroup, ProtocolAdapter } from '../adapters/types.ts';

export interface PanelAccountRuntime {
  adapter: ProtocolAdapter;
  getStatus: () => AdapterStatus;
  getNickname: () => string;
  getConnectionHint?: () => string | undefined;
}

export interface ContactSnapshot {
  groups: ContactGroup[];
  friends: ContactFriend[];
  degraded: boolean;
}
