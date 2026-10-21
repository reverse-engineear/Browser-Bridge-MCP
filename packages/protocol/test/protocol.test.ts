import { describe, expect, it } from 'vitest';
import {
  ToolArgsSchemas,
  ToolResultDataSchemas,
  ToolResultSchema,
  HelloAckSchema,
  HelloSchema,
  ServerMessageSchema,
  isAutomatableUrl,
  makeRef,
  parseRef,
} from '../src/index';

describe('hello', () => {
  it('accepts an extension hello without a pairing token', () => {
    const result = HelloSchema.safeParse({
      type: 'hello',
      v: 1,
      extensionVersion: '1.0.0',
      tab: { id: 7, windowId: 1, url: 'https://example.com/', title: 'Example' },
    });
    expect(result.success).toBe(true);
    if (result.success) expect('token' in result.data).toBe(false);
  });

  it('rejects the removed token field', () => {
    expect(
      HelloSchema.safeParse({
        type: 'hello',
        v: 1,
        token: 'ABCD2345',
        extensionVersion: '1.0.0',
        tab: { id: 7, windowId: 1, url: 'https://example.com/', title: 'Example' },
      }).success,
    ).toBe(false);
  });
});

describe('URL guard', () => {
  it('accepts ordinary web pages', () => {
    expect(isAutomatableUrl('https://example.com/path')).toEqual({ ok: true });
    expect(isAutomatableUrl('http://127.0.0.1:8080/')).toEqual({ ok: true });
  });

  it('rejects restricted Chrome surfaces', () => {
    expect(isAutomatableUrl('chrome://settings').ok).toBe(false);
    expect(isAutomatableUrl('chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/popup.html').ok).toBe(false);
    expect(isAutomatableUrl('https://chromewebstore.google.com/detail/x').ok).toBe(false);
    expect(isAutomatableUrl('https://chrome.google.com/webstore/x').ok).toBe(false);
    expect(isAutomatableUrl('https://example.com/file.pdf').ok).toBe(false);
    expect(isAutomatableUrl('not a url').ok).toBe(false);
  });
});

describe('refs', () => {
  it('round-trips snapshot ids and backend node ids', () => {
    expect(makeRef(12, 456)).toBe('s12e456');
    expect(parseRef('s12e456')).toEqual({ snapshotId: 12, backendNodeId: 456 });
    expect(parseRef('s12')).toBeNull();
    expect(parseRef('e456')).toBeNull();
    expect(parseRef('s12e4x')).toBeNull();
  });
});

describe('tool arguments', () => {
  it('rejects non-http navigation targets', () => {
    expect(ToolArgsSchemas.navigate.safeParse({ url: 'javascript:alert(1)' }).success).toBe(false);
    expect(ToolArgsSchemas.navigate.safeParse({ url: 'file:///etc/passwd' }).success).toBe(false);
    expect(ToolArgsSchemas.navigate.safeParse({ url: 'https://example.com' }).success).toBe(true);
  });

  it('requires refs in the snapshot format', () => {
    expect(ToolArgsSchemas.click.safeParse({ ref: 'button-1' }).success).toBe(false);
    expect(ToolArgsSchemas.click.safeParse({ ref: 's3e9' }).success).toBe(true);
    expect(ToolArgsSchemas.click.safeParse({ ref: 's3e9', extra: true }).success).toBe(false);
  });

  it('limits wait time and requires a drag pair', () => {
    expect(ToolArgsSchemas.wait.safeParse({ seconds: 31 }).success).toBe(false);
    expect(ToolArgsSchemas.wait.safeParse({ seconds: 0 }).success).toBe(true);
    expect(ToolArgsSchemas.drag.safeParse({ fromRef: 's1e2' }).success).toBe(false);
    expect(ToolArgsSchemas.drag.safeParse({ fromRef: 's1e2', toRef: 's1e3' }).success).toBe(true);
  });

  it('bounds the network request query', () => {
    expect(ToolArgsSchemas.get_network_requests.safeParse({}).success).toBe(true);
    expect(ToolArgsSchemas.get_network_requests.safeParse({ limit: 20, urlContains: 'api' }).success).toBe(true);
    expect(ToolArgsSchemas.get_network_requests.safeParse({ resourceType: 'XHR' }).success).toBe(true);
    expect(ToolArgsSchemas.get_network_requests.safeParse({ resourceType: 'xhr' }).success).toBe(true);
    expect(ToolArgsSchemas.get_network_requests.safeParse({ resourceType: '   ' }).success).toBe(false);
    expect(ToolArgsSchemas.get_network_requests.safeParse({ limit: 0 }).success).toBe(false);
    expect(ToolArgsSchemas.get_network_requests.safeParse({ limit: 501 }).success).toBe(false);
    expect(ToolArgsSchemas.get_network_requests.safeParse({ urlContains: '   ' }).success).toBe(false);
    expect(ToolArgsSchemas.get_network_requests.safeParse({ headers: true }).success).toBe(false);
  });

  it('accepts no arguments for the network clear tool', () => {
    expect(ToolArgsSchemas.clear_network_requests.safeParse({}).success).toBe(true);
    expect(ToolArgsSchemas.clear_network_requests.safeParse({ all: true }).success).toBe(false);
  });
});

describe('result messages', () => {
  it('rejects a success carrying an error and a failure without one', () => {
    expect(
      ToolResultSchema.safeParse({
        type: 'tool_result',
        v: 1,
        id: '6f1a1f8e-4c5e-4d4a-9b1f-3f7d6a2b9c10',
        ok: true,
        error: { code: 'INTERNAL', message: 'bad' },
      }).success,
    ).toBe(false);

    expect(
      ToolResultSchema.safeParse({
        type: 'tool_result',
        v: 1,
        id: '6f1a1f8e-4c5e-4d4a-9b1f-3f7d6a2b9c10',
        ok: false,
      }).success,
    ).toBe(false);
  });

  it('parses a hello ack and a tool call', () => {
    expect(
      HelloAckSchema.safeParse({
        type: 'hello_ack',
        v: 1,
        sessionId: '6f1a1f8e-4c5e-4d4a-9b1f-3f7d6a2b9c10',
        serverVersion: '0.1.0',
      }).success,
    ).toBe(true);

    const call = ServerMessageSchema.safeParse({
      type: 'tool_call',
      v: 1,
      id: '6f1a1f8e-4c5e-4d4a-9b1f-3f7d6a2b9c10',
      name: 'snapshot',
      args: {},
      deadlineMs: 30_000,
    });
    expect(call.success).toBe(true);
  });

  it('checks screenshot and console result shapes', () => {
    expect(
      ToolResultDataSchemas.get_console_logs.safeParse({ entries: [], total: 0, dropped: 0 }).success,
    ).toBe(true);
    expect(
      ToolResultDataSchemas.screenshot.safeParse({
        base64: 'iVBORw0KGgo=',
        mimeType: 'image/png',
        width: 10,
        height: 20,
        bytes: 12,
      }).success,
    ).toBe(true);
  });

  it('checks network metadata shapes', () => {
    const entry = {
      url: 'https://example.com/',
      method: 'GET',
      resourceType: 'Document',
      status: 200,
      startedAt: 1_700_000_000_000,
      durationMs: 42,
      sizeBytes: 1_024,
      failed: false,
    };
    expect(
      ToolResultDataSchemas.get_network_requests.safeParse({ entries: [entry], total: 1, dropped: 0 }).success,
    ).toBe(true);
    expect(
      ToolResultDataSchemas.get_network_requests.safeParse({
        entries: [{ ...entry, status: null, durationMs: null, sizeBytes: null }],
        total: 1,
        dropped: 0,
      }).success,
    ).toBe(true);
    expect(
      ToolResultDataSchemas.get_network_requests.safeParse({
        entries: [{ ...entry, authorization: 'secret' }],
        total: 1,
        dropped: 0,
      }).success,
    ).toBe(false);
    expect(
      ToolResultDataSchemas.get_network_requests.safeParse({
        entries: [{ ...entry, sizeBytes: -1 }],
        total: 1,
        dropped: 0,
      }).success,
    ).toBe(false);
  });

  it('checks the network clear result shape', () => {
    expect(
      ToolResultDataSchemas.clear_network_requests.safeParse({ ok: true, cleared: 3 }).success,
    ).toBe(true);
    expect(
      ToolResultDataSchemas.clear_network_requests.safeParse({ ok: true, cleared: 0 }).success,
    ).toBe(true);
    expect(
      ToolResultDataSchemas.clear_network_requests.safeParse({ ok: true, cleared: -1 }).success,
    ).toBe(false);
    expect(
      ToolResultDataSchemas.clear_network_requests.safeParse({ ok: true }).success,
    ).toBe(false);
  });
});
