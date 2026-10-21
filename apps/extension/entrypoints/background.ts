import { defineBackground } from 'wxt/utils/define-background';
import {
  DEFAULT_PORT,
  PROTOCOL_VERSION,
  ServerMessageSchema,
  isAutomatableUrl,
  validateToolArgs,
  type ErrorCode,
  type TabInfo,
  type ToolArgs,
  type ToolArgsMap,
  type ToolCall,
  type ToolName,
} from '@browser-bridge/protocol';
import { AutomationError, toAutomationError } from '../lib/errors.js';
import { CdpSession } from '../lib/cdp.js';
import { ConsoleBuffer } from '../lib/console-buffer.js';
import {
  clearSession,
  readSession,
  writeSession,
  type StoredSession,
} from '../lib/storage.js';
import type { PopupCommand, PopupState, StateMessage } from '../lib/popup-messages.js';

const BRIDGE_URL = `ws://127.0.0.1:${DEFAULT_PORT}/extension`;
const HEARTBEAT_MS = 25_000;
const SILENCE_LIMIT_MS = 55_000;
const RECONNECT_DELAYS = [1_000, 2_000, 5_000, 10_000, 30_000];
const ALARM_NAME = 'bridge-maintenance';

const consoleBuffer = new ConsoleBuffer();
let bufferTabId: number | null = null;
let desiredSession: StoredSession | null = null;
let socket: WebSocket | null = null;
let cdp: CdpSession | null = null;
let connecting = false;
let initializing: Promise<void> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let lastSocketMessage = 0;
let state: PopupState = {
  status: 'idle',
  tab: null,
  error: null,
  canDisconnect: false,
};

function tabInfoFromSession(session: StoredSession): TabInfo {
  return {
    id: session.tabId,
    windowId: session.windowId,
    url: session.url,
    title: session.title,
  };
}

function tabInfoFromTab(tab: chrome.tabs.Tab): TabInfo {
  return {
    id: tab.id ?? -1,
    windowId: tab.windowId,
    url: tab.url ?? '',
    title: tab.title ?? '',
  };
}

function setState(patch: Partial<PopupState>): void {
  state = { ...state, ...patch };
  void broadcast();
}

async function broadcast(): Promise<void> {
  const message: StateMessage = { type: 'state', state };
  try {
    await chrome.runtime.sendMessage(message);
  } catch {
    // No popup is open; the next get_state answers with the current state.
  }
}

function closeHttpError(code: number): AutomationError {
  switch (code) {
    case 4002:
      return new AutomationError(
        'SESSION_BUSY',
        'Another browser session is already connected to this bridge. Disconnect it first.',
      );
    case 4004:
      return new AutomationError(
        'INTERNAL',
        'The bridge rejected this extension. Restart the bridge and try again.',
      );
    case 4003:
      return new AutomationError('INTERNAL', 'The server could not read the handshake. Restart it and try again.');
    default:
      return new AutomationError(
        'SERVER_UNREACHABLE',
        "The MCP server didn't answer. Start it and try again.",
      );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new AutomationError('TIMEOUT', message));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function ensureInitialized(): Promise<void> {
  if (!initializing) {
    initializing = (async () => {
      const saved = await readSession();
      desiredSession = saved;
      state = {
        ...state,
        tab: saved ? tabInfoFromSession(saved) : null,
      };
      if (saved) {
        setTimeout(() => {
          void connectToTab(saved.tabId);
        }, 0);
      }
    })();
  }
  return initializing;
}

function sendToSocket(payload: unknown): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

function sendEvent(kind: 'tab_updated' | 'page_committed' | 'detached', tab?: TabInfo, reason?: string): void {
  sendToSocket({
    type: 'event',
    v: PROTOCOL_VERSION,
    kind,
    ...(tab ? { tab } : {}),
    ...(reason ? { reason } : {}),
  });
}

function stopHeartbeat(): void {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function startHeartbeat(): void {
  stopHeartbeat();
  lastSocketMessage = Date.now();
  heartbeatTimer = setInterval(() => {
    const ws = socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - lastSocketMessage > SILENCE_LIMIT_MS) {
      socket = null;
      try {
        ws.close();
      } catch {
        // The socket is already gone.
      }
      if (desiredSession) {
        setState({ status: 'reconnecting', error: null, canDisconnect: true });
        scheduleReconnect();
      }
      return;
    }
    try {
      ws.send(JSON.stringify({ type: 'ping', v: PROTOCOL_VERSION, t: Date.now() }));
    } catch {
      // The close handler will notice.
    }
  }, HEARTBEAT_MS);
}

function clearReconnectTimer(): void {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null) return;
  if (!desiredSession || connecting) return;

  const delayMs = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)];
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!desiredSession || socket || connecting) return;
    setState({ status: 'reconnecting', error: null, canDisconnect: true });
    void connectToTab(desiredSession.tabId).catch(() => undefined);
  }, delayMs);
}

async function stopConnection(): Promise<void> {
  stopHeartbeat();
  clearReconnectTimer();

  const ws = socket;
  socket = null;
  if (ws) {
    try {
      ws.close(1000, 'Closing the connection');
    } catch {
      // The socket is already closed.
    }
  }

  const current = cdp;
  cdp = null;
  if (current) await current.dispose();
}

async function onPageCommit(tab: TabInfo): Promise<void> {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const windowId = tab.windowId || desiredSession?.windowId || 0;
  const info: TabInfo = { ...tab, windowId };
  desiredSession = {
    tabId: info.id,
    windowId,
    url: info.url,
    title: info.title,
  };
  await writeSession(info);
  setState({ tab: info });
  sendEvent('page_committed', info);
}

async function handleDetach(message: string, code: ErrorCode): Promise<void> {
  if (!desiredSession && !socket && !cdp) return;

  const current = cdp;
  cdp = null;
  if (current) void current.dispose();

  stopHeartbeat();
  clearReconnectTimer();

  const ws = socket;
  socket = null;
  if (ws) {
    try {
      ws.close(1000, 'Automation detached');
    } catch {
      // Already closed.
    }
  }

  desiredSession = null;
  await clearSession();
  setState({
    status: 'error',
    tab: null,
    error: { code, message },
    canDisconnect: false,
  });
}

async function ensureCdp(info: TabInfo): Promise<void> {
  if (cdp && cdp.isAlive() && cdp.tabId === info.id) return;

  const previous = cdp;
  cdp = null;
  if (previous) await previous.dispose();

  if (bufferTabId !== info.id) {
    consoleBuffer.clear();
    bufferTabId = info.id;
  }

  cdp = await CdpSession.attach(info.id, consoleBuffer, {
    onPageCommit: (tab) => {
      void onPageCommit(tab);
    },
    onDetach: (message, code) => {
      void handleDetach(message, code);
    },
  });
}

async function resolveTab(tabId?: number): Promise<chrome.tabs.Tab> {
  if (tabId !== undefined) {
    try {
      return await chrome.tabs.get(tabId);
    } catch {
      throw new AutomationError('TAB_CLOSED', 'That tab is gone. Pick another tab and try again.');
    }
  }

  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!active || active.id === undefined) {
    throw new AutomationError('TAB_CLOSED', 'No active tab was found. Open a web page and try again.');
  }
  return active;
}

async function handleConnectFailure(failure: AutomationError): Promise<void> {
  const current = cdp;
  cdp = null;
  if (current) void current.dispose();

  const terminal = failure.code === 'TAB_CLOSED' || failure.code === 'NOT_AUTOMATABLE';
  if (terminal) {
    desiredSession = null;
    await clearSession();
  }

  setState({
    status: 'error',
    error: { code: failure.code, message: failure.message },
    canDisconnect: desiredSession !== null && !terminal,
  });

  if (
    !terminal &&
    desiredSession &&
    reconnectAttempt > 0 &&
    (failure.code === 'SERVER_UNREACHABLE' || failure.code === 'NOT_CONNECTED')
  ) {
    setState({ status: 'reconnecting', error: null, canDisconnect: true });
    scheduleReconnect();
  }
}

function openBridgeConnection(info: TabInfo): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let acknowledged = false;
    const ws = new WebSocket(BRIDGE_URL);
    socket = ws;

    const timer = setTimeout(() => {
      if (settled) return;
      if (socket === ws) socket = null;
      try {
        ws.close();
      } catch {
        // Ignore.
      }
      settled = true;
      reject(
        new AutomationError(
          'SERVER_UNREACHABLE',
          "The MCP server didn't answer. Start it and try again.",
        ),
      );
    }, 6_000);

    const failOnce = (error: AutomationError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };

    ws.onopen = () => {
      if (socket !== ws) return;
      ws.send(
        JSON.stringify({
          type: 'hello',
          v: PROTOCOL_VERSION,
          extensionVersion: chrome.runtime.getManifest().version,
          tab: info,
        }),
      );
    };

    ws.onerror = () => {
      // onclose carries the reason that matters.
    };

    ws.onclose = (event) => {
      if (socket !== ws) {
        failOnce(new AutomationError('NOT_CONNECTED', 'The connection attempt was cancelled.'));
        return;
      }

      socket = null;
      stopHeartbeat();

      if (!acknowledged) {
        failOnce(closeHttpError(event.code));
        return;
      }

      if (!settled) {
        failOnce(new AutomationError('NOT_CONNECTED', 'The connection closed while the tab was starting.'));
        return;
      }

      if (!desiredSession) {
        setState({ status: 'idle', error: null, canDisconnect: false });
        return;
      }

      setState({ status: 'reconnecting', error: null, canDisconnect: true });
      scheduleReconnect();
    };

    ws.onmessage = (event) => {
      if (socket !== ws) return;
      lastSocketMessage = Date.now();

      void (async () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(event.data));
        } catch {
          return;
        }

        const incoming = ServerMessageSchema.safeParse(parsed);
        if (!incoming.success) return;
        const message = incoming.data;

        if (message.type === 'hello_ack') {
          if (acknowledged) return;
          acknowledged = true;

          try {
            await ensureCdp(info);
            desiredSession = {
              tabId: info.id,
              windowId: info.windowId,
              url: info.url,
              title: info.title,
            };
            await writeSession(info);
            startHeartbeat();
            reconnectAttempt = 0;
            clearReconnectTimer();
            setState({
              status: 'connected',
              tab: info,
              error: null,
              canDisconnect: true,
            });

            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve();
            }
          } catch (error) {
            const failure = toAutomationError(error);
            if (socket === ws) {
              socket = null;
              try {
                ws.close(1000, 'Could not start automation');
              } catch {
                // Ignore.
              }
            }
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              reject(failure);
            } else {
              await handleConnectFailure(failure);
            }
          }
          return;
        }

        if (message.type === 'ping') {
          sendToSocket({ type: 'pong', v: PROTOCOL_VERSION, t: message.t });
          return;
        }

        if (message.type === 'tool_call') {
          void handleToolCall(message);
        }
      })();
    };
  });
}

async function connectToTab(tabId?: number): Promise<{ ok: boolean; message?: string }> {
  await ensureInitialized();

  if (connecting) {
    return { ok: false, message: 'Another connection attempt is already running.' };
  }

  connecting = true;
  try {
    const tab = await resolveTab(tabId);
    const info = tabInfoFromTab(tab);
    if (info.id < 0) {
      throw new AutomationError('TAB_CLOSED', 'That tab is no longer available.');
    }

    const guard = isAutomatableUrl(info.url);
    if (!guard.ok) {
      throw new AutomationError('NOT_AUTOMATABLE', guard.reason);
    }

    await stopConnection();

    desiredSession = {
      tabId: info.id,
      windowId: info.windowId,
      url: info.url,
      title: info.title,
    };
    await writeSession(info);

    setState({
      status: 'connecting',
      tab: info,
      error: null,
      canDisconnect: false,
    });

    await openBridgeConnection(info);
    return { ok: true };
  } catch (error) {
    const failure = toAutomationError(error);
    await handleConnectFailure(failure);
    return { ok: false, message: failure.message };
  } finally {
    connecting = false;
  }
}

async function disconnect(): Promise<void> {
  await stopConnection();
  desiredSession = null;
  await clearSession();
  consoleBuffer.clear();
  bufferTabId = null;
  reconnectAttempt = 0;
  setState({
    status: 'idle',
    tab: null,
    error: null,
    canDisconnect: false,
  });
}

async function runTool(name: ToolName, args: ToolArgs): Promise<unknown> {
  const session = cdp;
  if (!session || !session.isAlive()) {
    throw new AutomationError('NOT_CONNECTED', 'The tab is not ready yet. Try again in a moment.');
  }

  switch (name) {
    case 'navigate': {
      const page = await session.navigate((args as ToolArgsMap['navigate']).url);
      await session.refreshTabFromBrowser();
      return page;
    }
    case 'go_back': {
      const page = await session.goBack();
      await session.refreshTabFromBrowser();
      return page;
    }
    case 'go_forward': {
      const page = await session.goForward();
      await session.refreshTabFromBrowser();
      return page;
    }
    case 'snapshot':
      return session.snapshot();
    case 'click':
      await session.click((args as ToolArgsMap['click']).ref);
      return { ok: true };
    case 'type': {
      const typeArgs = args as ToolArgsMap['type'];
      await session.type(typeArgs.ref, typeArgs.text, typeArgs.submit === true);
      return { ok: true };
    }
    case 'hover':
      await session.hover((args as ToolArgsMap['hover']).ref);
      return { ok: true };
    case 'select_option': {
      const selectArgs = args as ToolArgsMap['select_option'];
      const values = await session.selectOption(selectArgs.ref, selectArgs.values);
      return { ok: true, values };
    }
    case 'press_key':
      await session.pressKey((args as ToolArgsMap['press_key']).key);
      return { ok: true };
    case 'wait':
      await delay((args as ToolArgsMap['wait']).seconds * 1_000);
      return { ok: true };
    case 'get_console_logs':
      return session.consoleLogs();
    case 'screenshot':
      return session.screenshot();
    case 'drag': {
      const dragArgs = args as ToolArgsMap['drag'];
      await session.drag(dragArgs.fromRef, dragArgs.toRef);
      return { ok: true };
    }
    default:
      throw new AutomationError('BAD_REQUEST', `Unknown tool "${String(name)}".`);
  }
}

async function handleToolCall(call: ToolCall): Promise<void> {
  const replyBase = { type: 'tool_result' as const, v: PROTOCOL_VERSION, id: call.id };

  try {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new AutomationError('NOT_CONNECTED', 'The server connection is not open.');
    }

    const validated = validateToolArgs(call.name, call.args);
    if (!validated.ok) {
      throw new AutomationError('BAD_REQUEST', validated.message);
    }

    const timeoutMs = Math.max(500, call.deadlineMs - 250);
    const data = await withTimeout(
      runTool(call.name, validated.args),
      timeoutMs,
      'The page did not answer before the call deadline. Take a snapshot to see the current state.',
    );

    sendToSocket({ ...replyBase, ok: true, data });
  } catch (error) {
    const failure = toAutomationError(error);
    if (failure.code === 'REF_STALE' || failure.code === 'REF_NOT_FOUND') {
      failure.message = `${failure.message} Take a new snapshot before the next action.`;
    }
    sendToSocket({
      ...replyBase,
      ok: false,
      error: { code: failure.code, message: failure.message },
    });
  }
}

function isPopupCommand(message: unknown): message is PopupCommand {
  if (!message || typeof message !== 'object') return false;
  const type = (message as { type?: unknown }).type;
  return type === 'get_state' || type === 'connect' || type === 'disconnect' || type === 'retry';
}

async function handleCommand(command: PopupCommand): Promise<{ ok: boolean; message?: string; state?: PopupState }> {
  await ensureInitialized();

  switch (command.type) {
    case 'get_state':
      return { ok: true, state };
    case 'connect':
      return connectToTab(command.tabId);
    case 'retry':
      return connectToTab(command.tabId ?? state.tab?.id);
    case 'disconnect':
      await disconnect();
      return { ok: true };
    default:
      return { ok: false, message: 'Unknown command.' };
  }
}

export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (!isPopupCommand(message)) return false;

    void handleCommand(message).then(
      (reply) => sendResponse(reply),
      (error: unknown) => sendResponse({ ok: false, message: toAutomationError(error).message }),
    );
    return true;
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    if (desiredSession?.tabId !== tabId && cdp?.tabId !== tabId) return;
    void handleDetach('That tab was closed. Open the popup on another tab to connect it.', 'TAB_CLOSED');
  });

  chrome.tabs.onUpdated.addListener((tabId, _changeInfo, tab) => {
    if (!cdp || cdp.tabId !== tabId || !socket || socket.readyState !== WebSocket.OPEN) return;
    const info = tabInfoFromTab(tab);
    if (!info.url) return;
    desiredSession = {
      tabId: info.id,
      windowId: info.windowId,
      url: info.url,
      title: info.title,
    };
    setState({ tab: info });
    sendEvent('tab_updated', info);
    void writeSession(info);
  });

  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== ALARM_NAME) return;
    void (async () => {
      await ensureInitialized();
      if (socket && socket.readyState === WebSocket.OPEN) {
        sendToSocket({ type: 'ping', v: PROTOCOL_VERSION, t: Date.now() });
        return;
      }
      if (!connecting && desiredSession && state.status === 'reconnecting') {
        void connectToTab(desiredSession.tabId).catch(() => undefined);
      }
    })();
  });

  chrome.runtime.onStartup.addListener(() => {
    void ensureInitialized();
  });

  void ensureInitialized();
});
