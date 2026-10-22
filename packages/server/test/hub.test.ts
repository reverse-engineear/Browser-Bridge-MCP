import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, WS_CLOSE_CODES, type Hello, type ServerMessage } from '@browser-bridge/protocol';
import { BridgeHub } from '../src/hub.js';

const ORIGIN = `chrome-extension://${'a'.repeat(32)}`;

const hubs: BridgeHub[] = [];
const sockets: WebSocket[] = [];

async function startHub(): Promise<BridgeHub> {
  const hub = new BridgeHub({
    port: 0,
    serverVersion: '0.1.0-test',
    log: () => {},
  });
  await hub.listen();
  hubs.push(hub);
  return hub;
}

function connect(hub: BridgeHub, origin = ORIGIN): WebSocket {
  const port = hub.boundPort;
  if (!port) throw new Error('Hub is not listening');
  const socket = new WebSocket(`ws://127.0.0.1:${port}/extension`, { origin });
  sockets.push(socket);
  return socket;
}

function connectClient(hub: BridgeHub, origin?: string): WebSocket {
  const port = hub.boundPort;
  if (!port) throw new Error('Hub is not listening');
  const socket = new WebSocket(`ws://127.0.0.1:${port}/mcp-client`, origin ? { origin } : undefined);
  sockets.push(socket);
  return socket;
}

async function readyClient(hub: BridgeHub): Promise<WebSocket> {
  const socket = connectClient(hub);
  await opened(socket);
  socket.send(JSON.stringify({ type: 'client_hello', v: PROTOCOL_VERSION }));
  const ready = await nextJson(socket);
  expect(ready.type).toBe('client_ready');
  return socket;
}

function hello(): Hello {
  return {
    type: 'hello',
    v: PROTOCOL_VERSION,
    extensionVersion: '0.1.0-test',
    tab: { id: 7, windowId: 1, url: 'https://example.com/', title: 'Example' },
  };
}

function clientCall(name: string, args: Record<string, unknown>): Record<string, unknown> {
  return { type: 'client_call', v: PROTOCOL_VERSION, id: randomUUID(), name, args };
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
}

interface MessageReader {
  queue: Record<string, unknown>[];
  waiters: Array<(message: Record<string, unknown>) => void>;
  attached: boolean;
}

const readers = new WeakMap<WebSocket, MessageReader>();

function readerFor(socket: WebSocket): MessageReader {
  let reader = readers.get(socket);
  if (!reader) {
    reader = { queue: [], waiters: [], attached: false };
    readers.set(socket, reader);
  }
  if (!reader.attached) {
    reader.attached = true;
    socket.on('message', (raw) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      const waiter = reader?.waiters.shift();
      if (waiter) waiter(message);
      else reader?.queue.push(message);
    });
  }
  return reader;
}

function nextJson(socket: WebSocket): Promise<Record<string, unknown>> {
  const reader = readerFor(socket);
  const queued = reader.queue.shift();
  if (queued) return Promise.resolve(queued);
  return new Promise((resolve) => reader.waiters.push(resolve));
}

function nextMessage(socket: WebSocket): Promise<ServerMessage> {
  return nextJson(socket) as Promise<ServerMessage>;
}

function closed(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

async function openExtension(hub: BridgeHub): Promise<WebSocket> {
  const socket = connect(hub);
  await opened(socket);
  socket.send(JSON.stringify(hello()));
  const ack = await nextMessage(socket);
  expect(ack.type).toBe('hello_ack');
  return socket;
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const hub of hubs.splice(0)) await hub.close();
});

describe('BridgeHub', () => {
  it('answers plain HTTP with 426 instead of a web page', async () => {
    const hub = await startHub();
    const response = await fetch(`http://127.0.0.1:${hub.boundPort}/`);
    expect(response.status).toBe(426);
    expect(await response.text()).toMatch(/WebSocket/);
  });

  it('reports health with the extension and client counts', async () => {
    const hub = await startHub();
    await openExtension(hub);
    await readyClient(hub);

    const response = await fetch(`http://127.0.0.1:${hub.boundPort}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      service: 'browser-bridge',
      version: '0.1.0-test',
      extensionConnected: true,
      clients: 1,
    });
  });

  it('serves the blank page that parks internal tabs', async () => {
    const hub = await startHub();
    const response = await fetch(`http://127.0.0.1:${hub.boundPort}/blank`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/html/);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toMatch(/default-src 'none'/);
    const html = await response.text();
    expect(html).toContain('<title>Browser Bridge</title>');
    expect(html).toContain('Ready for Browser Bridge.');
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('refuses an extension upgrade from a web origin', async () => {
    const hub = await startHub();
    const socket = connect(hub, 'https://evil.example');
    const error = await new Promise<Error & { code?: string }>((resolve) => {
      socket.once('error', (reason) => resolve(reason));
    });
    expect(String(error.message)).toMatch(/403/);
  });

  it('refuses a browser origin on the MCP client channel', async () => {
    const hub = await startHub();
    const socket = connectClient(hub, 'https://evil.example');
    const error = await new Promise<Error & { code?: string }>((resolve) => {
      socket.once('error', (reason) => resolve(reason));
    });
    expect(String(error.message)).toMatch(/403/);
  });

  it('completes the handshake and exposes the connected tab', async () => {
    const hub = await startHub();
    const socket = connect(hub);
    await opened(socket);
    socket.send(JSON.stringify(hello()));

    const ack = await nextMessage(socket);
    expect(ack).toMatchObject({
      type: 'hello_ack',
      v: PROTOCOL_VERSION,
      serverVersion: '0.1.0-test',
    });
    expect(hub.connected).toBe(true);
    expect(hub.sessionTab).toMatchObject({ id: 7, title: 'Example' });
  });

  it('closes a socket that never says hello', async () => {
    const hub = await startHub();
    const socket = connect(hub);
    await opened(socket);
    await expect(closed(socket)).resolves.toMatchObject({ code: WS_CLOSE_CODES.BAD_MESSAGE });
  }, 10_000);

  it('round-trips a tool call and its result', async () => {
    const hub = await startHub();
    const socket = await openExtension(hub);

    const callPromise = hub.callTool('click', { ref: 's1e42' });
    const call = await nextMessage(socket);
    if (call.type !== 'tool_call') throw new Error(`Expected tool_call, got ${call.type}`);

    expect(call.name).toBe('click');
    expect(call.args).toEqual({ ref: 's1e42' });
    expect(call.deadlineMs).toBeGreaterThan(0);

    socket.send(
      JSON.stringify({
        type: 'tool_result',
        v: PROTOCOL_VERSION,
        id: call.id,
        ok: true,
        data: { ok: true },
      }),
    );
    await expect(callPromise).resolves.toEqual({ ok: true });
  });

  it('rejects a tool result with the wrong shape', async () => {
    const hub = await startHub();
    const socket = await openExtension(hub);

    const callPromise = hub.callTool('click', { ref: 's1e42' });
    const call = await nextMessage(socket);
    if (call.type !== 'tool_call') throw new Error('Expected tool_call');

    socket.send(
      JSON.stringify({
        type: 'tool_result',
        v: PROTOCOL_VERSION,
        id: call.id,
        ok: true,
        data: { clicked: 'yes' },
      }),
    );
    await expect(callPromise).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('surfaces a tool failure from the extension', async () => {
    const hub = await startHub();
    const socket = await openExtension(hub);

    const callPromise = hub.callTool('click', { ref: 's9e1' });
    const call = await nextMessage(socket);
    if (call.type !== 'tool_call') throw new Error('Expected tool_call');

    socket.send(
      JSON.stringify({
        type: 'tool_result',
        v: PROTOCOL_VERSION,
        id: call.id,
        ok: false,
        error: { code: 'REF_STALE', message: 'Take a fresh snapshot.' },
      }),
    );
    await expect(callPromise).rejects.toMatchObject({ code: 'REF_STALE' });
  });

  it('shares one tab between two MCP clients', async () => {
    const hub = await startHub();
    const extension = await openExtension(hub);
    const first = await readyClient(hub);
    const second = await readyClient(hub);
    expect(hub.clientCount).toBe(2);

    const firstCall = clientCall('click', { ref: 's1e1' });
    const secondCall = clientCall('snapshot', {});
    first.send(JSON.stringify(firstCall));
    second.send(JSON.stringify(secondCall));

    const received = new Map<string, { id: string }>();
    for (let i = 0; i < 2; i += 1) {
      const message = await nextMessage(extension);
      if (message.type !== 'tool_call') throw new Error('Expected a tool call from the bridge');
      received.set(message.name, message);
    }

    const click = received.get('click');
    const snapshot = received.get('snapshot');
    if (!click || !snapshot) throw new Error('Both tool calls should reach the extension');

    extension.send(
      JSON.stringify({ type: 'tool_result', v: PROTOCOL_VERSION, id: click.id, ok: true, data: { ok: true } }),
    );
    extension.send(
      JSON.stringify({
        type: 'tool_result',
        v: PROTOCOL_VERSION,
        id: snapshot.id,
        ok: true,
        data: { text: 'page', nodes: 1, truncated: false, snapshotId: 1 },
      }),
    );

    await expect(nextJson(first)).resolves.toMatchObject({
      type: 'client_result',
      id: firstCall.id,
      ok: true,
      data: { ok: true },
    });
    await expect(nextJson(second)).resolves.toMatchObject({
      type: 'client_result',
      id: secondCall.id,
      ok: true,
      data: { snapshotId: 1 },
    });
  });

  it('broadcasts extension state to MCP clients', async () => {
    const hub = await startHub();
    const client = await readyClient(hub);

    const socket = connect(hub);
    await opened(socket);
    socket.send(JSON.stringify(hello()));

    await expect(nextJson(client)).resolves.toMatchObject({
      type: 'client_state',
      connected: true,
      tab: { id: 7 },
    });

    socket.terminate();
    await expect(nextJson(client)).resolves.toMatchObject({ type: 'client_state', connected: false });
  });

  it('refuses a second extension while one session is active', async () => {
    const hub = await startHub();
    const first = await openExtension(hub);

    const second = connect(hub);
    const closing = closed(second);
    await opened(second).catch(() => undefined);
    try {
      second.send(JSON.stringify(hello()));
    } catch {
      // The server may already have closed the socket.
    }
    await expect(closing).resolves.toMatchObject({ code: WS_CLOSE_CODES.SESSION_BUSY });
    expect(hub.connected).toBe(true);
    expect(first.readyState).toBe(WebSocket.OPEN);
  });

  it('answers ping with a pong carrying the same timestamp', async () => {
    const hub = await startHub();
    const socket = await openExtension(hub);

    socket.send(JSON.stringify({ type: 'ping', v: PROTOCOL_VERSION, t: 1234 }));
    const pong = await nextMessage(socket);
    expect(pong).toEqual({ type: 'pong', v: PROTOCOL_VERSION, t: 1234 });
  });

  it('fails pending calls when the extension disconnects', async () => {
    const hub = await startHub();
    const socket = await openExtension(hub);

    const callPromise = hub.callTool('click', { ref: 's1e1' });
    const call = await nextMessage(socket);
    if (call.type !== 'tool_call') throw new Error('Expected tool_call');

    socket.terminate();
    await expect(callPromise).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    expect(hub.connected).toBe(false);
  });

  it('will not call a tool with no session', async () => {
    const hub = await startHub();
    await expect(hub.callTool('snapshot', {})).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  });
});
