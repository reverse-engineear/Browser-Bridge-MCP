import {
  fetchState,
  sendCommand,
  type CommandReply,
  type PopupState,
} from '../../lib/popup-messages.js';

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}

const loadingView = byId<HTMLParagraphElement>('loading-view');
const statusRow = byId<HTMLElement>('status-row');
const statusDot = byId<HTMLSpanElement>('status-dot');
const statusText = byId<HTMLSpanElement>('status-text');
const tabRow = byId<HTMLParagraphElement>('tab-row');
const errorPanel = byId<HTMLDivElement>('error-panel');
const errorText = byId<HTMLParagraphElement>('error-text');

const idleView = byId<HTMLElement>('idle-view');
const connectButton = byId<HTMLButtonElement>('connect');

const connectingView = byId<HTMLElement>('connecting-view');

const connectedView = byId<HTMLElement>('connected-view');
const disconnectButton = byId<HTMLButtonElement>('disconnect');
const clearCaptureButton = byId<HTMLButtonElement>('clear-captures');
const clearNote = byId<HTMLParagraphElement>('clear-note');

const reconnectingView = byId<HTMLElement>('reconnecting-view');
const retryReconnect = byId<HTMLButtonElement>('retry-reconnect');
const stopReconnect = byId<HTMLButtonElement>('stop-reconnect');

const errorView = byId<HTMLElement>('error-view');
const retryButton = byId<HTMLButtonElement>('retry');
const disconnectError = byId<HTMLButtonElement>('disconnect-error');

let currentState: PopupState | null = null;
let lastView = '';
let commandActive = false;
let clearNoteTimer: ReturnType<typeof setTimeout> | null = null;

function setHidden(element: HTMLElement, hidden: boolean): void {
  element.hidden = hidden;
}

function setStatus(kind: 'success' | 'warning' | 'danger' | 'muted', text: string): void {
  statusRow.hidden = false;
  statusDot.className = `dot is-${kind}`;
  if (statusText.textContent !== text) statusText.textContent = text;
}

function setError(message: string | null): void {
  if (!message) {
    errorPanel.hidden = true;
    errorText.textContent = '';
    return;
  }
  errorPanel.hidden = false;
  if (errorText.textContent !== message) errorText.textContent = message;
}

function tabLabel(state: PopupState): string {
  if (!state.tab) return '';
  let host = '';
  try {
    host = new URL(state.tab.url).host;
  } catch {
    host = state.tab.url;
  }
  const title = state.tab.title || host;
  return host && host !== title ? `${host} — ${title}` : title;
}

function viewFor(state: PopupState): string {
  if (state.status === 'connected') return 'connected';
  if (state.status === 'connecting') return 'connecting';
  if (state.status === 'reconnecting') return 'reconnecting';
  if (state.status === 'error') return 'error';
  return 'idle';
}

function lostConnection(code: string | undefined): boolean {
  return (
    code === 'DETACHED' ||
    code === 'TAB_CLOSED' ||
    code === 'NOT_CONNECTED' ||
    code === 'SERVER_UNREACHABLE' ||
    code === 'SESSION_BUSY'
  );
}

function render(state: PopupState): void {
  currentState = state;
  loadingView.hidden = true;
  const view = viewFor(state);

  setHidden(idleView, view !== 'idle');
  setHidden(connectingView, view !== 'connecting');
  setHidden(connectedView, view !== 'connected');
  setHidden(reconnectingView, view !== 'reconnecting');
  setHidden(errorView, view !== 'error');
  if (view !== 'connected') clearNote.hidden = true;

  if (view === 'idle') {
    statusRow.hidden = true;
    tabRow.hidden = true;
    setError(null);
  } else {
    if (view === 'connected') {
      setStatus('success', 'Connected');
    } else if (view === 'connecting') {
      setStatus('warning', 'Waiting for the MCP server');
    } else if (view === 'reconnecting') {
      setStatus('warning', 'Reconnecting…');
    } else {
      setStatus('danger', lostConnection(state.error?.code) ? 'Connection lost' : 'Not connected');
    }

    const label = tabLabel(state);
    tabRow.hidden = !label;
    if (label && tabRow.textContent !== label) {
      tabRow.textContent = label;
      tabRow.title = state.tab ? `${state.tab.title} — ${state.tab.url}` : label;
    }

    if (view === 'connected') {
      setError(null);
    } else if (view === 'reconnecting') {
      setError(null);
    } else if (view === 'error') {
      setError(state.error?.message || 'The connection did not start.');
    } else {
      setError(state.error?.message ?? null);
    }
  }

  disconnectError.hidden = !state.canDisconnect;
  retryReconnect.disabled = commandActive;
  stopReconnect.disabled = commandActive;
  connectButton.disabled = commandActive;
  retryButton.disabled = commandActive;
  disconnectButton.disabled = commandActive;
  clearCaptureButton.disabled = commandActive;
  disconnectError.disabled = commandActive;

  if (lastView !== view) {
    lastView = view;
    if (view === 'idle') {
      requestAnimationFrame(() => connectButton.focus());
    } else if (view === 'error') {
      requestAnimationFrame(() => retryButton.focus());
    } else if (view === 'connected') {
      requestAnimationFrame(() => disconnectButton.focus());
    }
  }
}

async function refreshState(): Promise<void> {
  try {
    render(await fetchState());
  } catch {
    loadingView.hidden = true;
    setError('The extension is not answering. Close this popup and open it again.');
  }
}

async function runCommand(
  button: HTMLButtonElement,
  command: Parameters<typeof sendCommand>[0],
): Promise<CommandReply> {
  if (commandActive) return { ok: false };
  commandActive = true;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');

  let reply: CommandReply;
  try {
    reply = await sendCommand(command);
  } catch {
    reply = { ok: false, message: 'The extension did not answer. Try again.' };
  }

  commandActive = false;
  button.disabled = false;
  button.removeAttribute('aria-busy');

  if (!reply.ok && reply.message) setError(reply.message);

  await refreshState();
  return reply;
}

connectButton.addEventListener('click', () => {
  void runCommand(connectButton, { type: 'connect' });
});

disconnectButton.addEventListener('click', () => {
  void runCommand(disconnectButton, { type: 'disconnect' });
});

clearCaptureButton.addEventListener('click', () => {
  void (async () => {
    const reply = await runCommand(clearCaptureButton, { type: 'clear_captures' });
    if (!reply.ok) return;
    clearNote.hidden = false;
    if (clearNoteTimer !== null) clearTimeout(clearNoteTimer);
    clearNoteTimer = setTimeout(() => {
      clearNote.hidden = true;
      clearNoteTimer = null;
    }, 3_000);
  })();
});

retryButton.addEventListener('click', () => {
  void runCommand(retryButton, { type: 'connect' });
});

retryReconnect.addEventListener('click', () => {
  void runCommand(retryReconnect, { type: 'connect' });
});

stopReconnect.addEventListener('click', () => {
  void runCommand(stopReconnect, { type: 'disconnect' });
});

disconnectError.addEventListener('click', () => {
  void runCommand(disconnectError, { type: 'disconnect' });
});

byId<HTMLButtonElement>('open-help').addEventListener('click', () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('help.html') });
});

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (!message || typeof message !== 'object') return;
  const typed = message as { type?: string; state?: PopupState };
  if (typed.type !== 'state' || !typed.state) return;
  render(typed.state);
});

chrome.tabs.onUpdated.addListener((tabId, _changeInfo, tab) => {
  if (!currentState?.tab || tabId !== currentState.tab.id) return;
  const title = tab.title ?? currentState.tab.title;
  const url = tab.url ?? currentState.tab.url;
  if (title === currentState.tab.title && url === currentState.tab.url) return;
  render({ ...currentState, tab: { ...currentState.tab, title, url } });
});

void refreshState();
