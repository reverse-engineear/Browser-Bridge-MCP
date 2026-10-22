import { randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import {
  ClientMessageSchema,
  DEFAULT_DEADLINE_MS,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  HELLO_TIMEOUT_MS,
  HelloSchema,
  MAX_WS_PAYLOAD,
  PROTOCOL_VERSION,
  ToolResultDataSchemas,
  WS_CLOSE_CODES,
  type ClientMessage,
  type Hello,
  type HelloAck,
  type Ping,
  type Pong,
  type ServerMessage,
  type TabInfo,
  type ToolArgsMap,
  type ToolCall,
  type ToolName,
  type ToolResult,
  type ToolResultDataMap,
} from '@browser-bridge/protocol';
import {
  BRIDGE_SERVICE,
  CLIENT_HELLO_TIMEOUT_MS,
  ClientCallSchema,
  ClientHelloSchema,
  type ClientReady,
  type ClientResult,
  type ClientState,
  type ClientServerMessage,
} from './control.js';
import { BridgeToolError } from './errors.js';

interface Session {
  socket: WebSocket;
  sessionId: string;
  extensionVersion: string;
  tab: TabInfo;
  connectedAt: number;
  lastSeenAt: number;
  heartbeat: NodeJS.Timeout;
}

interface ClientConnection {
  ready: boolean;
  helloTimer: NodeJS.Timeout;
}

interface PendingCall {
  id: string;
  name: ToolName;
  resolve: (result: ToolResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface BridgeHubOptions {
  port: number;
  serverVersion: string;
  log: (message: string) => void;
}

function isExtensionOrigin(origin: string | undefined): boolean {
  return typeof origin === 'string' && /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason.slice(0, 120));
  } catch {
    socket.terminate();
    return;
  }
  const timer = setTimeout(() => socket.terminate(), 1_000);
  timer.unref?.();
}

function rejectUpgrade(socket: import('node:stream').Duplex, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function toolDeadlineMs(name: ToolName, args: ToolArgsMap[ToolName]): number {
  if (name === 'wait') {
    const waitArgs = args as ToolArgsMap['wait'];
    return Math.min(120_000, Math.ceil(waitArgs.seconds * 1_000) + 5_000);
  }
  return DEFAULT_DEADLINE_MS;
}

const BLANK_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Browser Bridge</title>
<link rel="icon" href="data:,">
<style>
:root { color-scheme: light dark; }
html, body { height: 100%; margin: 0; }
body {
  display: grid;
  place-items: center;
  padding: 24px;
  background: Canvas;
  color: CanvasText;
  font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
  text-align: center;
}
p { margin: 0; }
p + p { margin-top: 6px; font-size: 13px; opacity: 0.72; }
</style>
</head>
<body>
<main>
<p>Ready for Browser Bridge.</p>
<p>Your MCP client can drive this tab. Navigate somewhere to get started.</p>
</main>
</body>
</html>
`;

function serveBlankPage(response: import('node:http').ServerResponse): void {
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy':
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
  response.end(BLANK_PAGE_HTML);
}

export class BridgeHub {
  private readonly port: number;
  private readonly serverVersion: string;
  private readonly log: (message: string) => void;
  private httpServer?: HttpServer;
  private extensionWss?: WebSocketServer;
  private clientWss?: WebSocketServer;
  private active?: Session;
  private readonly clients = new Map<WebSocket, ClientConnection>();
  private readonly pending = new Map<string, PendingCall>();
  private closing = false;

  constructor(options: BridgeHubOptions) {
    this.port = options.port;
    this.serverVersion = options.serverVersion;
    this.log = options.log;
  }

  async listen(): Promise<void> {
    this.httpServer = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/health') {
        const body = {
          service: BRIDGE_SERVICE,
          version: this.serverVersion,
          pid: process.pid,
          extensionConnected: this.connected,
          clients: this.clientCount,
        };
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
        response.end(`${JSON.stringify(body)}\n`);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/blank') {
        serveBlankPage(response);
        return;
      }

      response.writeHead(url.pathname === '/' ? 426 : 404, {
        'content-type': 'text/plain; charset=utf-8',
      });
      response.end('Browser Bridge listens for a WebSocket connection on this port.\n');
    });

    this.extensionWss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD });
    this.extensionWss.on('connection', (socket) => this.onExtensionConnection(socket));

    this.clientWss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD });
    this.clientWss.on('connection', (socket) => this.onClientConnection(socket));

    this.httpServer.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');

      if (url.pathname === '/extension') {
        if (!isExtensionOrigin(request.headers.origin)) {
          rejectUpgrade(socket, '403 Forbidden');
          return;
        }
        this.extensionWss?.handleUpgrade(request, socket, head, (webSocket) => {
          this.extensionWss?.emit('connection', webSocket, request);
        });
        return;
      }

      if (url.pathname === '/mcp-client') {
        if (request.headers.origin) {
          rejectUpgrade(socket, '403 Forbidden');
          return;
        }
        this.clientWss?.handleUpgrade(request, socket, head, (webSocket) => {
          this.clientWss?.emit('connection', webSocket, request);
        });
        return;
      }

      rejectUpgrade(socket, '404 Not Found');
    });

    await new Promise<void>((resolve, reject) => {
      const httpServer = this.httpServer;
      if (!httpServer) {
        reject(new Error('HTTP server was not created.'));
        return;
      }

      const cleanup = () => {
        httpServer.off('error', onError);
        httpServer.off('listening', onListening);
      };
      const onError = (error: NodeJS.ErrnoException) => {
        cleanup();
        if (error.code === 'EADDRINUSE') {
          reject(
            new BridgeToolError(
              'INTERNAL',
              `Port ${this.port} is already in use. Stop the other Browser Bridge server or the program using it.`,
            ),
          );
          return;
        }
        reject(error);
      };
      const onListening = () => {
        cleanup();
        const address = httpServer.address();
        const actualPort = typeof address === 'object' && address ? address.port : this.port;
        this.log(`Listening on ws://127.0.0.1:${actualPort}`);
        resolve();
      };

      httpServer.once('error', onError);
      httpServer.once('listening', onListening);
      httpServer.listen(this.port, '127.0.0.1');
    });
  }

  get connected(): boolean {
    return this.active?.socket.readyState === WebSocket.OPEN;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  get boundPort(): number | undefined {
    const address = this.httpServer?.address();
    return typeof address === 'object' && address ? address.port : undefined;
  }

  get sessionTab(): TabInfo | undefined {
    return this.active?.tab;
  }

  async callTool<K extends ToolName>(name: K, args: ToolArgsMap[K]): Promise<ToolResultDataMap[K]> {
    const session = this.active;
    if (!session || session.socket.readyState !== WebSocket.OPEN) {
      throw new BridgeToolError(
        'NOT_CONNECTED',
        'No tab is connected. Open the extension popup and choose Connect tab.',
      );
    }

    const id = randomUUID();
    const deadlineMs = toolDeadlineMs(name, args);
    const call: ToolCall = {
      type: 'tool_call',
      v: PROTOCOL_VERSION,
      id,
      name,
      args: args as Record<string, unknown>,
      deadlineMs,
    };

    const result = await new Promise<ToolResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new BridgeToolError(
            'TIMEOUT',
            'The extension did not answer before the call deadline. The page may still be working; take a snapshot before retrying.',
          ),
        );
      }, deadlineMs + 2_000);

      this.pending.set(id, { id, name, resolve, reject, timer });

      try {
        session.socket.send(JSON.stringify(call), (error) => {
          if (!error) return;
          const pending = this.pending.get(id);
          if (!pending) return;
          this.pending.delete(id);
          clearTimeout(pending.timer);
          pending.reject(
            new BridgeToolError('NOT_CONNECTED', 'The extension connection closed before the call was sent.'),
          );
        });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(
          new BridgeToolError(
            'NOT_CONNECTED',
            error instanceof Error ? error.message : 'The extension connection is not available.',
          ),
        );
      }
    });

    if (!result.ok) {
      throw new BridgeToolError(
        result.error?.code ?? 'INTERNAL',
        result.error?.message ?? 'The extension reported an unknown failure.',
      );
    }

    const dataSchema = ToolResultDataSchemas[name];
    const parsedData = dataSchema.safeParse(result.data);
    if (!parsedData.success) {
      throw new BridgeToolError('INTERNAL', 'The extension returned a result with an unexpected shape.');
    }

    return parsedData.data as ToolResultDataMap[K];
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;

    this.rejectPending(new BridgeToolError('NOT_CONNECTED', 'The Browser Bridge server is shutting down.'));

    for (const [socket, client] of this.clients) {
      clearTimeout(client.helloTimer);
      closeSocket(socket, 1001, 'Bridge shutting down.');
    }
    this.clients.clear();

    if (this.active) {
      clearInterval(this.active.heartbeat);
      closeSocket(this.active.socket, 1001, 'Server shutting down.');
      this.active = undefined;
    }

    this.extensionWss?.clients.forEach((socket) => socket.terminate());
    this.extensionWss?.close();
    this.clientWss?.clients.forEach((socket) => socket.terminate());
    this.clientWss?.close();

    await new Promise<void>((resolve) => {
      if (!this.httpServer) {
        resolve();
        return;
      }
      this.httpServer.close(() => resolve());
      const timer = setTimeout(resolve, 1_500);
      timer.unref?.();
    });
  }

  private onExtensionConnection(socket: WebSocket): void {
    if (this.active && this.active.socket.readyState === WebSocket.OPEN) {
      closeSocket(socket, WS_CLOSE_CODES.SESSION_BUSY, 'Another browser session is already connected.');
      return;
    }

    this.log('Extension socket opened; waiting for hello.');
    let session: Session | null = null;
    let helloReceived = false;

    const helloTimer = setTimeout(() => {
      if (helloReceived) return;
      closeSocket(socket, WS_CLOSE_CODES.BAD_MESSAGE, 'Expected hello within two seconds.');
    }, HELLO_TIMEOUT_MS);
    helloTimer.unref?.();

    socket.on('error', (error) => {
      this.log(`Extension socket error: ${error.message}`);
    });

    socket.on('message', (raw) => {
      if (!session) {
        if (helloReceived) return;

        const hello = this.parseHello(raw);
        if (!hello) {
          closeSocket(socket, WS_CLOSE_CODES.BAD_MESSAGE, 'The first message must be a valid hello.');
          return;
        }

        if (this.active && this.active.socket.readyState === WebSocket.OPEN) {
          closeSocket(socket, WS_CLOSE_CODES.SESSION_BUSY, 'Another browser session is already connected.');
          return;
        }

        helloReceived = true;
        clearTimeout(helloTimer);
        session = this.startSession(socket, hello);
        return;
      }

      this.onSessionMessage(session, raw);
    });

    socket.on('close', () => {
      clearTimeout(helloTimer);
      if (session) this.detachSession(session);
    });
  }

  private onClientConnection(socket: WebSocket): void {
    const helloTimer = setTimeout(() => {
      closeSocket(socket, WS_CLOSE_CODES.BAD_MESSAGE, 'Expected client hello within two seconds.');
    }, CLIENT_HELLO_TIMEOUT_MS);
    helloTimer.unref?.();

    this.clients.set(socket, { ready: false, helloTimer });
    this.log('MCP client socket opened; waiting for hello.');

    socket.on('error', (error) => {
      this.log(`MCP client socket error: ${error.message}`);
    });

    socket.on('message', (raw) => {
      this.onClientMessage(socket, raw);
    });

    socket.on('close', () => {
      const client = this.clients.get(socket);
      if (!client) return;
      clearTimeout(client.helloTimer);
      this.clients.delete(socket);
      this.log(`MCP client disconnected (${this.clientCount} active).`);
    });
  }

  private onClientMessage(socket: WebSocket, raw: RawData): void {
    const client = this.clients.get(socket);
    if (!client) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      closeSocket(socket, WS_CLOSE_CODES.BAD_MESSAGE, 'Messages must be JSON.');
      return;
    }

    if (!client.ready) {
      const hello = ClientHelloSchema.safeParse(parsed);
      if (!hello.success) {
        closeSocket(socket, WS_CLOSE_CODES.BAD_MESSAGE, 'The first client message must be a valid hello.');
        return;
      }

      client.ready = true;
      clearTimeout(client.helloTimer);
      const ready: ClientReady = {
        type: 'client_ready',
        v: PROTOCOL_VERSION,
        serverVersion: this.serverVersion,
        connected: this.connected,
        ...(this.sessionTab ? { tab: this.sessionTab } : {}),
      };
      this.sendClient(socket, ready);
      this.log(`MCP client connected (${this.clientCount} active).`);
      return;
    }

    const message = ClientCallSchema.safeParse(parsed);
    if (!message.success) {
      closeSocket(socket, WS_CLOSE_CODES.BAD_MESSAGE, 'Invalid client message.');
      return;
    }

    void this.handleClientCall(socket, message.data.id, message.data.name, message.data.args);
  }

  private async handleClientCall(
    socket: WebSocket,
    id: string,
    name: ToolName,
    args: Record<string, unknown>,
  ): Promise<void> {
    let reply: ClientResult;
    try {
      const data = await this.callTool(name, args as ToolArgsMap[ToolName]);
      reply = { type: 'client_result', v: PROTOCOL_VERSION, id, ok: true, data };
    } catch (error) {
      const failure =
        error instanceof BridgeToolError
          ? error
          : new BridgeToolError(
              'INTERNAL',
              error instanceof Error ? error.message : 'The bridge could not complete this call.',
            );
      reply = {
        type: 'client_result',
        v: PROTOCOL_VERSION,
        id,
        ok: false,
        error: { code: failure.code, message: failure.message },
      };
    }
    this.sendClient(socket, reply);
  }

  private sendClient(socket: WebSocket, message: ClientServerMessage): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 1_000_000) {
      closeSocket(socket, WS_CLOSE_CODES.BAD_MESSAGE, 'The client is not reading its results.');
      return;
    }
    try {
      socket.send(JSON.stringify(message));
    } catch (error) {
      this.log(`Could not send to the MCP client: ${String(error)}`);
    }
  }

  private broadcastClientState(): void {
    const state: ClientState = {
      type: 'client_state',
      v: PROTOCOL_VERSION,
      connected: this.connected,
      ...(this.sessionTab ? { tab: this.sessionTab } : {}),
    };
    for (const [socket, client] of this.clients) {
      if (client.ready) this.sendClient(socket, state);
    }
  }

  private parseHello(raw: RawData): Hello | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return null;
    }
    const hello = HelloSchema.safeParse(parsed);
    return hello.success ? hello.data : null;
  }

  private startSession(socket: WebSocket, hello: Hello): Session {
    const now = Date.now();
    const session: Session = {
      socket,
      sessionId: randomUUID(),
      extensionVersion: hello.extensionVersion,
      tab: hello.tab,
      connectedAt: now,
      lastSeenAt: now,
      heartbeat: undefined as unknown as NodeJS.Timeout,
    };
    session.heartbeat = setInterval(() => this.heartbeat(session), HEARTBEAT_INTERVAL_MS);
    session.heartbeat.unref?.();
    this.active = session;

    const ack: HelloAck = {
      type: 'hello_ack',
      v: PROTOCOL_VERSION,
      sessionId: session.sessionId,
      serverVersion: this.serverVersion,
    };

    try {
      socket.send(JSON.stringify(ack));
    } catch (error) {
      this.log(`Could not acknowledge the extension: ${String(error)}`);
      closeSocket(socket, WS_CLOSE_CODES.BAD_MESSAGE, 'Could not complete the handshake.');
      return session;
    }

    this.log(
      `Extension ${hello.extensionVersion} connected to tab ${hello.tab.id} (${hello.tab.url || 'no url'}).`,
    );
    this.broadcastClientState();
    return session;
  }

  private onSessionMessage(session: Session, raw: RawData): void {
    session.lastSeenAt = Date.now();

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      closeSocket(session.socket, WS_CLOSE_CODES.BAD_MESSAGE, 'Messages must be JSON.');
      return;
    }

    const message = ClientMessageSchema.safeParse(parsed);
    if (!message.success) {
      this.log(`Closing extension connection: invalid message (${message.error.issues[0]?.message ?? 'unknown'}).`);
      closeSocket(session.socket, WS_CLOSE_CODES.BAD_MESSAGE, 'Invalid message.');
      return;
    }

    this.dispatch(session, message.data);
  }

  private dispatch(session: Session, message: ClientMessage): void {
    switch (message.type) {
      case 'ping': {
        const pong: Pong = { type: 'pong', v: PROTOCOL_VERSION, t: message.t };
        this.send(session, pong);
        return;
      }
      case 'pong':
        return;
      case 'tool_result':
        this.resolveToolResult(message);
        return;
      case 'event':
        if (message.tab) {
          session.tab = message.tab;
          this.broadcastClientState();
        }
        if (message.kind === 'detached') {
          this.log(`Extension reported a detached debugger: ${message.reason ?? 'no reason given'}.`);
        }
        return;
      case 'hello':
        closeSocket(session.socket, WS_CLOSE_CODES.BAD_MESSAGE, 'The session is already established.');
        return;
      default:
        return;
    }
  }

  private send(session: Session, message: ServerMessage): void {
    if (session.socket.readyState !== WebSocket.OPEN) return;
    try {
      session.socket.send(JSON.stringify(message));
    } catch (error) {
      this.log(`Could not send to the extension: ${String(error)}`);
    }
  }

  private resolveToolResult(result: ToolResult): void {
    const pending = this.pending.get(result.id);
    if (!pending) {
      this.log(`Ignoring a result for unknown tool call ${result.id}.`);
      return;
    }

    this.pending.delete(result.id);
    clearTimeout(pending.timer);
    pending.resolve(result);
  }

  private detachSession(session: Session): void {
    if (this.active !== session) return;
    clearInterval(session.heartbeat);
    this.active = undefined;
    this.log(`Extension disconnected from tab ${session.tab.id}.`);
    this.broadcastClientState();
    this.rejectPending(
      new BridgeToolError('NOT_CONNECTED', 'The extension disconnected before answering. Connect the tab again.'),
    );
  }

  private rejectPending(error: BridgeToolError): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private heartbeat(session: Session): void {
    if (this.active !== session) return;
    if (Date.now() - session.lastSeenAt > HEARTBEAT_TIMEOUT_MS) {
      this.log('Extension missed heartbeats; closing the socket.');
      session.socket.terminate();
      return;
    }
    if (session.socket.readyState !== WebSocket.OPEN) return;
    if (session.socket.bufferedAmount > 1_000_000) return;
    const ping: Ping = { type: 'ping', v: PROTOCOL_VERSION, t: Date.now() };
    this.send(session, ping);
  }
}
