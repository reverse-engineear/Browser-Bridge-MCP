import { describe, expect, it } from 'vitest';
import { MAX_NETWORK_ENTRIES } from '@browser-bridge/protocol';
import { NetworkBuffer } from '../lib/network-buffer.js';

function start(
  buffer: NetworkBuffer,
  id: string,
  url: string,
  timestamp = 10,
  wallTime = 1_700_000_000,
  type = 'Fetch',
): void {
  buffer.requestStarted({
    requestId: id,
    request: { url, method: 'get' },
    type,
    timestamp,
    wallTime,
  });
}

describe('NetworkBuffer', () => {
  it('joins request, response and finish events into one entry', () => {
    const buffer = new NetworkBuffer();
    start(buffer, '1', 'https://example.com/api/items');
    buffer.responseReceived({
      requestId: '1',
      response: { status: 200, statusText: 'OK', mimeType: 'application/json' },
    });
    buffer.requestFinished({ requestId: '1', timestamp: 10.125, encodedDataLength: 2_048 });

    expect(buffer.snapshot().entries).toEqual([
      {
        url: 'https://example.com/api/items',
        method: 'GET',
        resourceType: 'Fetch',
        status: 200,
        statusText: 'OK',
        mimeType: 'application/json',
        startedAt: 1_700_000_000_000,
        durationMs: 125,
        sizeBytes: 2_048,
        failed: false,
      },
    ]);
  });

  it('marks cache and service-worker responses', () => {
    const buffer = new NetworkBuffer();
    start(buffer, '1', 'https://example.com/cached.js');
    buffer.responseReceived({
      requestId: '1',
      response: { status: 304, fromDiskCache: true, fromServiceWorker: true },
    });

    expect(buffer.snapshot().entries[0]).toMatchObject({
      status: 304,
      fromCache: true,
      fromServiceWorker: true,
    });
  });

  it('keeps a failed request with its reason and duration', () => {
    const buffer = new NetworkBuffer();
    start(buffer, '1', 'https://example.com/slow', 20);
    buffer.requestFailed({
      requestId: '1',
      timestamp: 20.5,
      errorText: 'net::ERR_CONNECTION_RESET',
      blockedReason: 'inspector',
      canceled: true,
    });

    const entry = buffer.snapshot().entries[0]!;
    expect(entry.failed).toBe(true);
    expect(entry.status).toBeNull();
    expect(entry.durationMs).toBe(500);
    expect(entry.errorText).toBe('net::ERR_CONNECTION_RESET; blocked: inspector; canceled');
  });

  it('counts redirects on a reused request id', () => {
    const buffer = new NetworkBuffer();
    start(buffer, '1', 'https://example.com/old', 1, 1_700_000_000);
    buffer.requestStarted({
      requestId: '1',
      request: { url: 'https://example.com/new', method: 'GET' },
      type: 'Document',
      timestamp: 2,
      wallTime: 1_700_000_001,
      redirectResponse: { status: 302 },
    });

    const snapshot = buffer.snapshot();
    expect(snapshot.total).toBe(1);
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0]).toMatchObject({ url: 'https://example.com/new', redirects: 1 });
  });

  it('drops the oldest entries past the cap', () => {
    const buffer = new NetworkBuffer();
    for (let index = 0; index < MAX_NETWORK_ENTRIES + 3; index += 1) {
      start(buffer, String(index), `https://example.com/${index}`);
    }

    const snapshot = buffer.snapshot({ limit: MAX_NETWORK_ENTRIES });
    expect(buffer.size).toBe(MAX_NETWORK_ENTRIES);
    expect(snapshot.total).toBe(MAX_NETWORK_ENTRIES + 3);
    expect(snapshot.dropped).toBe(3);
    expect(snapshot.entries[0]!.url).toBe('https://example.com/3');
    expect(snapshot.entries.at(-1)!.url).toBe(`https://example.com/${MAX_NETWORK_ENTRIES + 2}`);
  });

  it('returns the latest 100 by default and honours a limit', () => {
    const buffer = new NetworkBuffer();
    for (let index = 0; index < 150; index += 1) {
      start(buffer, String(index), `https://example.com/${index}`);
    }

    expect(buffer.snapshot().entries).toHaveLength(100);
    expect(buffer.snapshot().entries[0]!.url).toBe('https://example.com/50');
    expect(buffer.snapshot({ limit: 3 }).entries.map((entry) => entry.url)).toEqual([
      'https://example.com/147',
      'https://example.com/148',
      'https://example.com/149',
    ]);
  });

  it('filters URLs case-insensitively', () => {
    const buffer = new NetworkBuffer();
    start(buffer, '1', 'https://example.com/API/items');
    start(buffer, '2', 'https://example.com/static/app.js');
    start(buffer, '3', 'https://other.test/api/status');

    const snapshot = buffer.snapshot({ urlContains: 'api' });
    expect(snapshot.entries.map((entry) => entry.url)).toEqual([
      'https://example.com/API/items',
      'https://other.test/api/status',
    ]);
    expect(snapshot.total).toBe(3);
  });

  it('filters resource types case-insensitively and combines with the URL filter', () => {
    const buffer = new NetworkBuffer();
    start(buffer, '1', 'https://example.com/API/items', 10, 1_700_000_000, 'XHR');
    start(buffer, '2', 'https://example.com/static/app.js', 11, 1_700_000_000, 'Script');
    start(buffer, '3', 'https://other.test/api/status', 12, 1_700_000_000, 'Fetch');

    expect(buffer.snapshot({ resourceType: 'xhr' }).entries.map((entry) => entry.url)).toEqual([
      'https://example.com/API/items',
    ]);
    expect(
      buffer.snapshot({ resourceType: 'fetch', urlContains: 'api' }).entries.map((entry) => entry.url),
    ).toEqual(['https://other.test/api/status']);
    expect(buffer.snapshot({ resourceType: 'Fetch' }).total).toBe(3);
    expect(buffer.snapshot({ resourceType: 'Document' }).entries).toHaveLength(0);
  });

  it('returns copies and ignores malformed events', () => {
    const buffer = new NetworkBuffer();
    start(buffer, '1', 'https://example.com/');
    const copy = buffer.snapshot();
    copy.entries[0]!.url = 'mutated';
    buffer.requestStarted({ requestId: '', request: { url: 'https://example.com/x' } });

    expect(buffer.snapshot().entries[0]!.url).toBe('https://example.com/');
    expect(buffer.snapshot().total).toBe(1);
  });

  it('clears entries, starts and counters', () => {
    const buffer = new NetworkBuffer();
    start(buffer, '1', 'https://example.com/', 10);
    buffer.clear();

    expect(buffer.snapshot()).toEqual({ entries: [], total: 0, dropped: 0 });
    start(buffer, '2', 'https://example.com/again', 20);
    buffer.requestFinished({ requestId: '2', timestamp: 20.25, encodedDataLength: 10 });
    expect(buffer.snapshot().entries[0]).toMatchObject({ durationMs: 250, sizeBytes: 10 });
  });
});
