import type { ErrorCode } from '@browser-bridge/protocol';

export class AutomationError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'AutomationError';
    this.code = code;
  }
}

export function toAutomationError(error: unknown, fallbackCode: ErrorCode = 'INTERNAL'): AutomationError {
  if (error instanceof AutomationError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new AutomationError(fallbackCode, message);
}

export function chromeErrorMessage(lastError: chrome.runtime.LastError | undefined): string {
  return lastError?.message ?? 'Chrome did not answer the command.';
}
