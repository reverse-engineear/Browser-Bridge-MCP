import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import {
  PROTOCOL_VERSION,
  type TabInfo,
  type ToolArgsMap,
  type ToolName,
  type ToolResultDataMap,
} from '@browser-bridge/protocol';
import { ClientServerMessageSchema, type ClientServerMessage } from './control.js';
import { ensureDaemon } from './daemon.js';
import { BridgeToolError } from './errors.js';

const CONNECT_TIMEOUT_MS = 3_000;
const MAX_CALL_MS = 125_000;

interface PendingCall {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class BridgeClient {
  private socket: WebSocket | null = null;
  private ready = false;
  private connecting: Promise<void> | null = null;
  private tab: TabInfo | undefined;
  private extensionConnected = false;
  private readonly pending = new Map<string, PendingCall>();
  private closing = false;

  constructor(
    private readonly port: number,
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  get connected(): boolean {
    return this.extensionConnected;
  }

  get sessionTab(): TabInfo | undefined {
    return this.tab;
  }

  async connect(): Promise<void> {
    if (this.ready) return;
    if (!this.connecting) {
      this.connecting = this.open().finally(() => {
        this.connecting = null;
      });
    }
    await this.connecting;
  }

  close(): void {
    this.closing = true;
    const socket = this.socket;
    this.socket = null;
    this.ready = false;
    if (!socket) return;
    try {
      socket.close(1000, 'MCP client closing.');
    } catch {
      socket.terminate();
    }
    this.rejectPending(new BridgeToolError('NOT_CONNECTED', 'The MCP client closed the bridge connection.'));
  }

  async callTool<K extends ToolName>(name: K, args: ToolArgsMap[K]): Promise<ToolResultDataMap[K]> {
    await this.connect();
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || !this.ready) {
      throw new BridgeToolError('NOT_CONNECTED', 'The shared bridge is not reachable.');
    }

    const id = randomUUID();
    return new Promise<ToolResultDataMap[K]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new BridgeToolError(
            'TIMEOUT',
            'The shared bridge did not answer. The page may still be working; take a snapshot before retrying.',
          ),
        );
      }, MAX_CALL_MS);
      this.pending.set(id, { resolve: (data) => resolve(data as ToolResultDataMap[K]), reject, timer });

      try {
        socket.send(JSON.stringify({ type: 'client_call', v: PROTOCOL_VERSION, id, name, args }), (error) => {
          if (!error) return;
          const pending = this.pending.get(id);
          if (!pending) return;
          this.pending.delete(id);
          clearTimeout(pending.timer);
          pending.reject(new BridgeToolError('NOT_CONNECTED', 'The shared bridge closed before the call was sent.'));
        });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(
          new BridgeToolError(
            'NOT_CONNECTED',
            error instanceof Error ? error.message : 'The shared bridge is not available.',
          ),
        );
      }
    });
  }

  private async open(): Promise<void> {
    if (this.closing) throw new BridgeToolError('NOT_CONNECTED', 'The MCP client is shutting down.');
    try {
      await this.openSocket();
    } catch {
      await ensureDaemon(this.port, this.log);
      await this.openSocket();
    }
  }

  private openSocket(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${this.port}/mcp-client`);
      this.socket = socket;
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (this.socket === socket) this.socket = null;
        try {
          socket.terminate();
        } catch {
          // Already gone.
        }
        reject(new BridgeToolError('SERVER_UNREACHABLE', 'The shared bridge did not answer the client handshake.'));
      }, CONNECT_TIMEOUT_MS);

      socket.on('open', () => {
        try {
          socket.send(JSON.stringify({ type: 'client_hello', v: PROTOCOL_VERSION }));
        } catch (error) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });

      socket.on('message', (raw) => {
        const message = this.parseMessage(raw);
        if (!message) return;

        if (message.type === 'client_ready') {
          this.ready = true;
          this.extensionConnected = message.connected;
          this.tab = message.tab;
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
          return;
        }

        if (message.type === 'client_state') {
          this.extensionConnected = message.connected;
          this.tab = message.tab;
          return;
        }

        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.ok) {
          pending.resolve(message.data);
        } else {
          pending.reject(
            new BridgeToolError(
              message.error?.code ?? 'INTERNAL',
              message.error?.message ?? 'The bridge reported an unknown failure.',
            ),
          );
        }
      });

      socket.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });

      socket.on('close', () => {
        if (this.socket === socket) {
          this.socket = null;
          this.ready = false;
        }
        this.extensionConnected = false;
        this.tab = undefined;
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(new BridgeToolError('SERVER_UNREACHABLE', 'The shared bridge closed the client connection.'));
        }
        this.rejectPending(new BridgeToolError('NOT_CONNECTED', 'The shared bridge connection closed.'));
      });
    });
  }

  private parseMessage(raw: unknown): ClientServerMessage | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      this.log('The shared bridge sent a message that was not JSON.');
      return null;
    }
    const message = ClientServerMessageSchema.safeParse(parsed);
    if (!message.success) {
      this.log(`The shared bridge sent an invalid message: ${message.error.issues[0]?.message ?? 'unknown'}.`);
      return null;
    }
    return message.data;
  }

  private rejectPending(error: BridgeToolError): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
