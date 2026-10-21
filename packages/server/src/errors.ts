import type { ErrorCode } from '@browser-bridge/protocol';

export class BridgeToolError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'BridgeToolError';
    this.code = code;
  }
}
