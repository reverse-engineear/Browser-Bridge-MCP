import type { ErrorCode, TabInfo } from '@browser-bridge/protocol';

export type PopupStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export interface PopupState {
  status: PopupStatus;
  tab: TabInfo | null;
  error: { code: ErrorCode; message: string } | null;
  canDisconnect: boolean;
}

export type PopupCommand =
  | { type: 'get_state' }
  | { type: 'connect'; tabId?: number }
  | { type: 'disconnect' }
  | { type: 'retry'; tabId?: number };

export interface StateMessage {
  type: 'state';
  state: PopupState;
}

export interface CommandReply {
  ok: boolean;
  message?: string;
}

export interface GetStateReply extends CommandReply {
  state: PopupState;
}

export function sendCommand(command: PopupCommand): Promise<CommandReply> {
  return chrome.runtime.sendMessage(command) as Promise<CommandReply>;
}

export async function fetchState(): Promise<PopupState> {
  const reply = (await chrome.runtime.sendMessage({ type: 'get_state' })) as GetStateReply;
  if (!reply?.state) throw new Error('The extension did not report its state.');
  return reply.state;
}
