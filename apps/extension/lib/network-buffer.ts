import { MAX_NETWORK_ENTRIES, type NetworkEntry } from '@browser-bridge/protocol';

const MAX_URL_LENGTH = 4_096;
const MAX_LABEL_LENGTH = 256;
const MAX_ERROR_LENGTH = 1_000;
const DEFAULT_LIMIT = 100;

export interface NetworkRequestStartedEvent {
  requestId?: string;
  request?: { url?: string; method?: string };
  type?: string;
  timestamp?: number;
  wallTime?: number;
  redirectResponse?: { status?: number };
}

export interface NetworkResponseReceivedEvent {
  requestId?: string;
  response?: {
    status?: number;
    statusText?: string;
    mimeType?: string;
    fromDiskCache?: boolean;
    fromPrefetchCache?: boolean;
    fromServiceWorker?: boolean;
  };
}

export interface NetworkFinishedEvent {
  requestId?: string;
  timestamp?: number;
  encodedDataLength?: number;
}

export interface NetworkFailedEvent {
  requestId?: string;
  timestamp?: number;
  errorText?: string;
  canceled?: boolean;
  blockedReason?: string;
}

export interface NetworkSnapshotOptions {
  limit?: number;
  urlContains?: string;
}

function label(value: unknown, maxLength = MAX_LABEL_LENGTH): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/[\r\n\t]+/g, ' ').trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function integer(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number === undefined ? undefined : Math.trunc(number);
}

function startTime(wallTime: unknown): number {
  const seconds = finiteNumber(wallTime);
  return seconds !== undefined && seconds > 0 ? Math.round(seconds * 1_000) : Date.now();
}

function elapsed(startTimestamp: number | undefined, endTimestamp: unknown): number | null {
  const end = finiteNumber(endTimestamp);
  if (startTimestamp === undefined || end === undefined) return null;
  return Math.max(0, Math.round((end - startTimestamp) * 1_000));
}

export class NetworkBuffer {
  private entries = new Map<string, NetworkEntry>();
  private starts = new Map<string, number>();
  private received = 0;

  requestStarted(params: NetworkRequestStartedEvent): void {
    const requestId = label(params.requestId, 128);
    const url = label(params.request?.url, MAX_URL_LENGTH);
    const method = label(params.request?.method, 16)?.toUpperCase();
    if (!requestId || !url || !method) return;

    const previous = this.entries.get(requestId);
    const redirects = Math.min(100, (previous?.redirects ?? 0) + (params.redirectResponse ? 1 : 0));
    const entry: NetworkEntry = {
      url,
      method,
      resourceType: label(params.type, 24) ?? 'Other',
      status: null,
      startedAt: startTime(params.wallTime),
      durationMs: null,
      sizeBytes: null,
      failed: false,
      ...(redirects > 0 ? { redirects } : {}),
    };

    this.entries.set(requestId, entry);
    if (!previous) this.received += 1;

    const timestamp = finiteNumber(params.timestamp);
    if (timestamp !== undefined) this.starts.set(requestId, timestamp);
    this.trim();
  }

  responseReceived(params: NetworkResponseReceivedEvent): void {
    const requestId = label(params.requestId, 128);
    if (!requestId) return;
    const entry = this.entries.get(requestId);
    if (!entry) return;

    const response = params.response;
    const status = integer(response?.status);
    if (status !== undefined) entry.status = Math.max(0, Math.min(999, status));

    const statusText = label(response?.statusText);
    if (statusText) entry.statusText = statusText;
    const mimeType = label(response?.mimeType);
    if (mimeType) entry.mimeType = mimeType;
    if (response?.fromDiskCache || response?.fromPrefetchCache) entry.fromCache = true;
    if (response?.fromServiceWorker) entry.fromServiceWorker = true;
  }

  requestFinished(params: NetworkFinishedEvent): void {
    const requestId = label(params.requestId, 128);
    if (!requestId) return;
    const entry = this.entries.get(requestId);
    if (!entry) return;

    const duration = elapsed(this.starts.get(requestId), params.timestamp);
    if (duration !== null) entry.durationMs = duration;

    const size = finiteNumber(params.encodedDataLength);
    if (size !== undefined && size >= 0) entry.sizeBytes = Math.round(size);
  }

  requestFailed(params: NetworkFailedEvent): void {
    const requestId = label(params.requestId, 128);
    if (!requestId) return;
    const entry = this.entries.get(requestId);
    if (!entry) return;

    entry.failed = true;
    const duration = elapsed(this.starts.get(requestId), params.timestamp);
    if (duration !== null) entry.durationMs = duration;

    const reasons: string[] = [];
    const errorText = label(params.errorText, MAX_ERROR_LENGTH);
    if (errorText) reasons.push(errorText);
    const blockedReason = label(params.blockedReason);
    if (blockedReason) reasons.push(`blocked: ${blockedReason}`);
    if (params.canceled) reasons.push('canceled');
    if (reasons.length > 0) entry.errorText = reasons.join('; ').slice(0, MAX_ERROR_LENGTH);
  }

  snapshot(options: NetworkSnapshotOptions = {}): {
    entries: NetworkEntry[];
    total: number;
    dropped: number;
  } {
    const requestedLimit = integer(options.limit) ?? DEFAULT_LIMIT;
    const limit = Math.max(1, Math.min(MAX_NETWORK_ENTRIES, requestedLimit));
    const filter = label(options.urlContains)?.toLowerCase();
    const all = [...this.entries.values()];
    const matched = filter ? all.filter((entry) => entry.url.toLowerCase().includes(filter)) : all;

    return {
      entries: matched.slice(-limit).map((entry) => ({ ...entry })),
      total: this.received,
      dropped: Math.max(0, this.received - this.entries.size),
    };
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
    this.starts.clear();
    this.received = 0;
  }

  private trim(): void {
    while (this.entries.size > MAX_NETWORK_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) return;
      this.entries.delete(oldest);
      this.starts.delete(oldest);
    }
  }
}
