import {
  MAX_SCREENSHOT_BYTES,
  isAutomatableUrl,
  parseRef,
  type ConsoleEntry,
  type ErrorCode,
  type TabInfo,
} from '@browser-bridge/protocol';
import { AutomationError, chromeErrorMessage } from './errors.js';
import type { ConsoleBuffer } from './console-buffer.js';
import type {
  NetworkBuffer,
  NetworkFailedEvent,
  NetworkFinishedEvent,
  NetworkRequestStartedEvent,
  NetworkResponseReceivedEvent,
  NetworkSnapshotOptions,
} from './network-buffer.js';
import { parseKeyChord, type KeyStroke } from './keys.js';
import { buildSnapshot, type AxNode, type SnapshotResult } from './snapshot.js';

interface CdpSessionHandlers {
  onPageCommit: (tab: TabInfo) => void;
  onDetach: (reason: string, code: ErrorCode) => void;
}

interface RemoteObject {
  type?: string;
  subtype?: string;
  value?: unknown;
  description?: string;
  preview?: {
    description?: string;
    properties?: Array<{ name: string; type?: string; value?: string }>;
  };
}

interface FramePayload {
  frame?: { id?: string; parentId?: string; url?: string };
}

interface LoadWaiter {
  resolve: () => void;
  reject: (error: AutomationError) => void;
  timer: ReturnType<typeof setTimeout>;
}

function mapAttachError(message: string): AutomationError {
  if (/another debugger is already attached/i.test(message)) {
    return new AutomationError(
      'ATTACH_FAILED',
      'Chrome is already debugging this tab. Close DevTools for it, then connect again.',
    );
  }
  if (/cannot access|cannot attach|chrome:\/\/|extension:\/\//i.test(message)) {
    return new AutomationError('NOT_AUTOMATABLE', 'Chrome does not allow automation on this page.');
  }
  if (/no tab with given id|tab closed|target closed/i.test(message)) {
    return new AutomationError('TAB_CLOSED', 'That tab is gone. Pick another tab.');
  }
  return new AutomationError('ATTACH_FAILED', `Chrome could not start debugging this tab: ${message}`);
}

function mapDomError(message: string, fallback: ErrorCode = 'REF_NOT_FOUND'): AutomationError {
  if (/no node with given id|could not find node|node is detached/i.test(message)) {
    return new AutomationError('REF_NOT_FOUND', 'That element is no longer on the page. Take a new snapshot.');
  }
  if (/not visible|empty quads|could not compute/i.test(message)) {
    return new AutomationError('REF_NOT_FOUND', 'That element is not visible right now. Take a new snapshot.');
  }
  return new AutomationError(fallback, message);
}

function remoteValue(object: RemoteObject): string {
  if (!object) return 'undefined';
  if (object.type === 'string') return String(object.value ?? '');
  if (object.type === 'number' || object.type === 'boolean') return String(object.value);
  if (object.type === 'undefined') return 'undefined';
  if (object.subtype === 'null') return 'null';
  if (object.type === 'bigint' || object.type === 'symbol') return object.description ?? String(object.value ?? '');
  if (object.preview?.properties?.length) {
    const body = object.preview.properties
      .slice(0, 8)
      .map((entry) => `${entry.name}: ${entry.value ?? entry.type ?? '…'}`)
      .join(', ');
    return `${object.preview.description ?? object.description ?? 'Object'} {${body}}`;
  }
  if (object.description) return object.description;
  return 'Object';
}

function consoleEntry(type: string, text: string, timestamp: number, source?: string): ConsoleEntry {
  const normalizedTime = timestamp > 0 && timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp || Date.now();
  return {
    type,
    text: text.replace(/\s+/g, ' ').trim().slice(0, 8_000) || '(empty)',
    timestamp: normalizedTime,
    ...(source ? { source: source.slice(0, 2_048) } : {}),
  };
}

function pngDimensions(base64: string): { width: number; height: number; bytes: number } {
  const bytes = Math.floor((base64.length * 3) / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
  if (base64.length < 32 || !base64.startsWith('iVBOR')) {
    return { width: 0, height: 0, bytes };
  }
  const header = atob(base64.slice(0, 32));
  const width = ((header.charCodeAt(16) << 24) | (header.charCodeAt(17) << 16) | (header.charCodeAt(18) << 8) | header.charCodeAt(19)) >>> 0;
  const height = ((header.charCodeAt(20) << 24) | (header.charCodeAt(21) << 16) | (header.charCodeAt(22) << 8) | header.charCodeAt(23)) >>> 0;
  return { width, height, bytes };
}

export class CdpSession {
  readonly tabId: number;
  private readonly consoleBuffer: ConsoleBuffer;
  private readonly networkBuffer: NetworkBuffer;
  private readonly handlers: CdpSessionHandlers;
  private readonly eventListener: (
    source: chrome.debugger.Debuggee,
    method: string,
    params?: object,
  ) => void;
  private readonly detachListener: (source: chrome.debugger.Debuggee, reason: string) => void;
  private readonly loadWaiters = new Set<LoadWaiter>();
  private snapshotId = 1;
  private pageUrl = '';
  private pageTitle = '';
  private disposed = false;

  private constructor(
    tabId: number,
    consoleBuffer: ConsoleBuffer,
    networkBuffer: NetworkBuffer,
    handlers: CdpSessionHandlers,
  ) {
    this.tabId = tabId;
    this.consoleBuffer = consoleBuffer;
    this.networkBuffer = networkBuffer;
    this.handlers = handlers;

    this.eventListener = (source, method, params) => {
      if (source.tabId !== this.tabId) return;
      this.onEvent(method, (params ?? {}) as Record<string, unknown>);
    };
    this.detachListener = (source, reason) => {
      if (source.tabId !== this.tabId || this.disposed) return;
      const code: ErrorCode = /target_closed|tab closed/i.test(reason) ? 'TAB_CLOSED' : 'DETACHED';
      const message =
        code === 'TAB_CLOSED'
          ? 'That tab was closed.'
          : 'Chrome stopped the debugging session. Close DevTools for this tab and connect again.';
      this.handlers.onDetach(message, code);
    };

    chrome.debugger.onEvent.addListener(this.eventListener);
    chrome.debugger.onDetach.addListener(this.detachListener);
  }

  static async attach(
    tabId: number,
    consoleBuffer: ConsoleBuffer,
    networkBuffer: NetworkBuffer,
    handlers: CdpSessionHandlers,
  ): Promise<CdpSession> {
    await new Promise<void>((resolve) => {
      chrome.debugger.detach({ tabId }, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    });

    await new Promise<void>((resolve, reject) => {
      chrome.debugger.attach({ tabId }, '1.3', () => {
        const error = chrome.runtime.lastError;
        if (error) reject(mapAttachError(chromeErrorMessage(error)));
        else resolve();
      });
    });

    const session = new CdpSession(tabId, consoleBuffer, networkBuffer, handlers);
    try {
      await session.initialize();
      return session;
    } catch (error) {
      await session.dispose();
      throw error;
    }
  }

  private async initialize(): Promise<void> {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Log.enable');
    await this.send('Network.enable');
    await this.send('DOM.enable');
    const info = await this.pageInfo();
    this.pageUrl = info.url;
    this.pageTitle = info.title;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    chrome.debugger.onEvent.removeListener(this.eventListener);
    chrome.debugger.onDetach.removeListener(this.detachListener);
    for (const waiter of this.loadWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    this.loadWaiters.clear();

    await new Promise<void>((resolve) => {
      chrome.debugger.detach({ tabId: this.tabId }, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    });
  }

  async send<T = Record<string, unknown>>(method: string, params?: object): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      try {
        chrome.debugger.sendCommand({ tabId: this.tabId }, method, params ?? {}, (result) => {
          const error = chrome.runtime.lastError;
          if (error) {
            reject(new AutomationError('INTERNAL', chromeErrorMessage(error)));
            return;
          }
          resolve(result as T);
        });
      } catch (error) {
        reject(new AutomationError('INTERNAL', error instanceof Error ? error.message : String(error)));
      }
    });
  }

  private onEvent(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case 'Page.frameNavigated': {
        const frame = (params as FramePayload).frame;
        if (frame?.parentId) return;
        this.snapshotId += 1;
        this.pageUrl = frame?.url ?? this.pageUrl;
        void this.refreshTabInfo();
        return;
      }
      case 'Page.navigatedWithinDocument':
        this.snapshotId += 1;
        this.resolveLoadWaiters();
        return;
      case 'Page.loadEventFired':
      case 'Page.frameStoppedLoading':
        this.resolveLoadWaiters();
        return;
      case 'Runtime.consoleAPICalled': {
        const args = (params.args as RemoteObject[] | undefined) ?? [];
        const type = String(params.type ?? 'log');
        const stack = params.stackTrace as
          | { callFrames?: Array<{ url?: string; lineNumber?: number }> }
          | undefined;
        const frame = stack?.callFrames?.[0];
        const source = frame?.url ? `${frame.url}:${(frame.lineNumber ?? 0) + 1}` : undefined;
        this.consoleBuffer.add(
          consoleEntry(type, args.map(remoteValue).join(' '), Number(params.timestamp ?? Date.now()), source),
        );
        return;
      }
      case 'Log.entryAdded': {
        const entry = params.entry as
          | { level?: string; text?: string; url?: string; lineNumber?: number; timestamp?: number }
          | undefined;
        if (!entry?.text) return;
        const level = entry.level === 'warning' ? 'warn' : entry.level === 'verbose' ? 'debug' : entry.level ?? 'info';
        const source = entry.url ? `${entry.url}${entry.lineNumber ? `:${entry.lineNumber}` : ''}` : undefined;
        this.consoleBuffer.add(
          consoleEntry(level, entry.text, Number(entry.timestamp ?? Date.now()), source),
        );
        return;
      }
      case 'Runtime.exceptionThrown': {
        const details = params.exceptionDetails as
          | {
              text?: string;
              url?: string;
              lineNumber?: number;
              exception?: { description?: string };
            }
          | undefined;
        const text = details?.exception?.description ?? details?.text ?? 'Uncaught exception';
        const source = details?.url ? `${details.url}:${(details.lineNumber ?? 0) + 1}` : undefined;
        this.consoleBuffer.add(consoleEntry('error', text, Date.now(), source));
        return;
      }
      case 'Network.requestWillBeSent':
        this.networkBuffer.requestStarted(params as NetworkRequestStartedEvent);
        return;
      case 'Network.responseReceived':
        this.networkBuffer.responseReceived(params as NetworkResponseReceivedEvent);
        return;
      case 'Network.loadingFinished':
        this.networkBuffer.requestFinished(params as NetworkFinishedEvent);
        return;
      case 'Network.loadingFailed':
        this.networkBuffer.requestFailed(params as NetworkFailedEvent);
        return;
      default:
        return;
    }
  }

  private resolveLoadWaiters(): void {
    for (const waiter of this.loadWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    this.loadWaiters.clear();
  }

  private async refreshTabInfo(): Promise<void> {
    const info = await this.pageInfo();
    this.pageUrl = info.url;
    this.pageTitle = info.title;
    let windowId = 0;
    try {
      const tab = await chrome.tabs.get(this.tabId);
      windowId = tab.windowId ?? 0;
    } catch {
      // The tab may already be gone; the detach listener handles that.
    }
    this.handlers.onPageCommit({
      id: this.tabId,
      windowId,
      url: info.url,
      title: info.title,
    });
  }

  async pageInfo(): Promise<{ url: string; title: string }> {
    try {
      const evaluated = await this.send<{
        result?: { value?: { title?: string; url?: string } };
      }>('Runtime.evaluate', {
        expression: '({ title: document.title, url: location.href })',
        returnByValue: true,
        awaitPromise: false,
      });
      const value = evaluated.result?.value;
      return {
        url: value?.url || this.pageUrl || '',
        title: value?.title || this.pageTitle || '',
      };
    } catch {
      return { url: this.pageUrl, title: this.pageTitle };
    }
  }

  async refreshTabFromBrowser(): Promise<TabInfo | null> {
    try {
      const tab = await chrome.tabs.get(this.tabId);
      if (tab.id === undefined || tab.windowId === undefined) return null;
      const info: TabInfo = {
        id: tab.id,
        windowId: tab.windowId,
        url: tab.url ?? this.pageUrl,
        title: tab.title ?? this.pageTitle,
      };
      this.handlers.onPageCommit(info);
      return info;
    } catch {
      return null;
    }
  }

  private waitForLoad(timeoutMs = 20_000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const waiter: LoadWaiter = {
        resolve: () => {
          this.loadWaiters.delete(waiter);
          resolve();
        },
        reject: (error) => {
          this.loadWaiters.delete(waiter);
          reject(error);
        },
        timer: setTimeout(() => {
          this.loadWaiters.delete(waiter);
          reject(
            new AutomationError(
              'NAVIGATION_TIMEOUT',
              'The page did not finish loading in time. Take a snapshot to see the current state.',
            ),
          );
        }, timeoutMs),
      };
      this.loadWaiters.add(waiter);
    });
  }

  async navigate(url: string): Promise<{ url: string; title: string }> {
    const guard = isAutomatableUrl(url);
    if (!guard.ok) throw new AutomationError('NOT_AUTOMATABLE', guard.reason);

    const result = await this.send<{ errorText?: string; loaderId?: string }>('Page.navigate', { url });
    if (result.errorText) {
      throw new AutomationError(
        'NAVIGATION_TIMEOUT',
        `Chrome could not open that address: ${result.errorText}`,
      );
    }

    await this.waitForLoad();
    return this.pageInfo();
  }

  private async moveInHistory(offset: -1 | 1): Promise<{ url: string; title: string }> {
    const history = await this.send<{
      currentIndex: number;
      entries: Array<{ id: number; url: string }>;
    }>('Page.getNavigationHistory');

    const target = history.entries[history.currentIndex + offset];
    if (!target) {
      throw new AutomationError(
        'BAD_REQUEST',
        offset === -1 ? 'There is no earlier page in this tab.' : 'There is no later page in this tab.',
      );
    }

    await this.send('Page.navigateToHistoryEntry', { entryId: target.id });
    await this.waitForLoad(15_000);
    return this.pageInfo();
  }

  goBack(): Promise<{ url: string; title: string }> {
    return this.moveInHistory(-1);
  }

  goForward(): Promise<{ url: string; title: string }> {
    return this.moveInHistory(1);
  }

  async snapshot(): Promise<SnapshotResult> {
    this.snapshotId += 1;
    const tree = await this.send<{ nodes?: AxNode[] }>('Accessibility.getFullAXTree');
    const info = await this.pageInfo();
    return buildSnapshot(tree.nodes ?? [], {
      title: info.title,
      snapshotId: this.snapshotId,
    });
  }

  private backendNodeFor(ref: unknown): number {
    if (typeof ref !== 'string') {
      throw new AutomationError('BAD_REQUEST', 'A ref from the latest snapshot is required.');
    }
    const parsed = parseRef(ref);
    if (!parsed) {
      throw new AutomationError('BAD_REQUEST', `"${ref}" is not a valid element ref.`);
    }
    if (parsed.snapshotId !== this.snapshotId) {
      throw new AutomationError(
        'REF_STALE',
        'That ref came from an older snapshot. Take a new snapshot and use its refs.',
      );
    }
    return parsed.backendNodeId;
  }

  private async quadsFor(backendNodeId: number): Promise<number[] | null> {
    try {
      await this.send('DOM.scrollIntoViewIfNeeded', { backendNodeId });
      const quads = await this.send<{ quads?: number[][] }>('DOM.getContentQuads', { backendNodeId });
      const best = this.largestQuad(quads.quads ?? []);
      if (best) return best;
    } catch {
      // Text nodes have no scroll target of their own; resolve them to their element below.
    }
    return this.elementQuad(backendNodeId);
  }

  private largestQuad(quads: number[][]): number[] | null {
    const candidates = quads.filter((quad) => quad.length >= 8);
    let best: number[] | null = null;
    let bestArea = 0;
    for (const quad of candidates) {
      const width = Math.max(quad[0], quad[2], quad[4], quad[6]) - Math.min(quad[0], quad[2], quad[4], quad[6]);
      const height = Math.max(quad[1], quad[3], quad[5], quad[7]) - Math.min(quad[1], quad[3], quad[5], quad[7]);
      const area = width * height;
      if (area > bestArea) {
        bestArea = area;
        best = quad;
      }
    }
    return bestArea > 0 ? best : null;
  }

  private async elementQuad(backendNodeId: number): Promise<number[] | null> {
    let objectId: string | undefined;
    try {
      const resolved = await this.send<{ object?: { objectId?: string } }>('DOM.resolveNode', {
        backendNodeId,
      });
      objectId = resolved.object?.objectId;
    } catch (error) {
      throw mapDomError(error instanceof Error ? error.message : String(error));
    }
    if (!objectId) {
      throw new AutomationError('REF_NOT_FOUND', 'That element is gone from the page. Take a new snapshot.');
    }

    try {
      const result = await this.send<{
        result?: { value?: number[] | null };
        exceptionDetails?: { text?: string };
      }>('Runtime.callFunctionOn', {
        objectId,
        returnByValue: true,
        functionDeclaration: `function() {
          const element = this.nodeType === Node.TEXT_NODE ? this.parentElement : this;
          if (!element) return null;
          element.scrollIntoView({ block: 'center', inline: 'center' });
          const rect = element.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return null;
          return [rect.left, rect.top, rect.right, rect.top, rect.right, rect.bottom, rect.left, rect.bottom];
        }`,
      });
      if (result.exceptionDetails) {
        throw new AutomationError('REF_NOT_FOUND', 'That element could not be measured. Take a new snapshot.');
      }
      const value = result.result?.value;
      return Array.isArray(value) && value.length === 8 ? value : null;
    } finally {
      void chrome.debugger.sendCommand({ tabId: this.tabId }, 'Runtime.releaseObject', { objectId }, () => {
        void chrome.runtime.lastError;
      });
    }
  }

  private centerOf(quad: number[]): { x: number; y: number } {
    const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
    const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
    return { x, y };
  }

  private async dispatchMouse(type: string, x: number, y: number, button: string, buttons: number, clickCount = 0): Promise<void> {
    await this.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button,
      buttons,
      clickCount,
      pointerType: 'mouse',
    });
  }

  private async pointFor(ref: unknown): Promise<{ x: number; y: number }> {
    const backendNodeId = this.backendNodeFor(ref);
    const quad = await this.quadsFor(backendNodeId);
    if (!quad) {
      throw new AutomationError('REF_NOT_FOUND', 'That element has no clickable area. Take a new snapshot.');
    }
    return this.centerOf(quad);
  }

  async click(ref: unknown): Promise<void> {
    const { x, y } = await this.pointFor(ref);
    await this.dispatchMouse('mouseMoved', x, y, 'none', 0);
    await this.dispatchMouse('mousePressed', x, y, 'left', 1, 1);
    await this.dispatchMouse('mouseReleased', x, y, 'left', 0, 1);
  }

  async hover(ref: unknown): Promise<void> {
    const { x, y } = await this.pointFor(ref);
    await this.dispatchMouse('mouseMoved', x, y, 'none', 0);
  }

  private async dispatchKeyStroke(stroke: KeyStroke): Promise<void> {
    const base = {
      key: stroke.key,
      code: stroke.code,
      windowsVirtualKeyCode: stroke.windowsVirtualKeyCode,
      nativeVirtualKeyCode: stroke.windowsVirtualKeyCode,
      modifiers: stroke.modifiers,
    };
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    if (stroke.text) {
      await this.send('Input.dispatchKeyEvent', {
        type: 'char',
        ...base,
        text: stroke.text,
        unmodifiedText: stroke.text,
      });
    }
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  async type(ref: unknown, text: string, submit: boolean): Promise<void> {
    const backendNodeId = this.backendNodeFor(ref);
    try {
      await this.send('DOM.focus', { backendNodeId });
    } catch {
      const point = await this.pointFor(ref);
      await this.dispatchMouse('mouseMoved', point.x, point.y, 'none', 0);
      await this.dispatchMouse('mousePressed', point.x, point.y, 'left', 1, 1);
      await this.dispatchMouse('mouseReleased', point.x, point.y, 'left', 0, 1);
    }

    const selectAll = /Mac/i.test(navigator.userAgent) ? 'Meta+A' : 'Control+A';
    await this.dispatchKeyStroke(parseKeyChord(selectAll));

    if (!text) {
      await this.dispatchKeyStroke(parseKeyChord('Backspace'));
    } else {
      await this.send('Input.insertText', { text });
    }

    if (submit) {
      await this.dispatchKeyStroke(parseKeyChord('Enter'));
    }
  }

  async pressKey(key: string): Promise<void> {
    await this.dispatchKeyStroke(parseKeyChord(key));
  }

  async selectOption(ref: unknown, values: string[]): Promise<string[]> {
    const backendNodeId = this.backendNodeFor(ref);
    let objectId: string | undefined;
    try {
      const resolved = await this.send<{ object?: { objectId?: string } }>('DOM.resolveNode', {
        backendNodeId,
      });
      objectId = resolved.object?.objectId;
    } catch (error) {
      throw mapDomError(error instanceof Error ? error.message : String(error));
    }

    if (!objectId) {
      throw new AutomationError('REF_NOT_FOUND', 'That element is gone from the page. Take a new snapshot.');
    }

    const result = await this.send<{
      result?: { value?: { ok?: boolean; reason?: string; values?: string[] } };
      exceptionDetails?: { text?: string };
    }>('Runtime.callFunctionOn', {
      objectId,
      returnByValue: true,
      awaitPromise: false,
      functionDeclaration: `function(values) {
        if (!(this instanceof HTMLSelectElement)) return { ok: false, reason: 'not-select' };
        const wanted = new Set(values.map((value) => String(value).toLowerCase()));
        const matched = [];
        for (const option of this.options) {
          const hit = wanted.has(option.value.toLowerCase()) || wanted.has(option.text.trim().toLowerCase());
          option.selected = hit;
          if (hit) matched.push(option.value);
        }
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, values: matched };
      }`,
      arguments: [{ value: values }],
    });

    if (result.exceptionDetails) {
      throw new AutomationError('INTERNAL', result.exceptionDetails.text ?? 'The select element rejected the command.');
    }

    const outcome = result.result?.value;
    if (!outcome?.ok) {
      throw new AutomationError(
        'BAD_REQUEST',
        outcome?.reason === 'not-select' ? 'That element is not a native select.' : 'The option could not be selected.',
      );
    }

    void chrome.debugger.sendCommand({ tabId: this.tabId }, 'Runtime.releaseObject', { objectId }, () => {
      void chrome.runtime.lastError;
    });

    return outcome.values ?? [];
  }

  async drag(fromRef: unknown, toRef: unknown): Promise<void> {
    const from = await this.pointFor(fromRef);
    const to = await this.pointFor(toRef);

    await this.dispatchMouse('mouseMoved', from.x, from.y, 'none', 0);
    await this.dispatchMouse('mousePressed', from.x, from.y, 'left', 1, 1);
    for (let step = 1; step <= 6; step += 1) {
      const x = from.x + ((to.x - from.x) * step) / 6;
      const y = from.y + ((to.y - from.y) * step) / 6;
      await this.dispatchMouse('mouseMoved', x, y, 'left', 1);
    }
    await this.dispatchMouse('mouseReleased', to.x, to.y, 'left', 0, 1);
  }

  async screenshot(): Promise<{ base64: string; mimeType: 'image/png'; width: number; height: number; bytes: number }> {
    const shot = await this.send<{ data?: string }>('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    });
    if (!shot.data) {
      throw new AutomationError('INTERNAL', 'Chrome returned an empty screenshot.');
    }
    const size = pngDimensions(shot.data);
    if (size.bytes > MAX_SCREENSHOT_BYTES) {
      throw new AutomationError('INTERNAL', 'The screenshot was too large to return. Narrow the window and try again.');
    }
    return { base64: shot.data, mimeType: 'image/png', ...size };
  }

  async consoleLogs(): Promise<{ entries: ConsoleEntry[]; total: number; dropped: number }> {
    return this.consoleBuffer.snapshot();
  }

  async networkRequests(options: NetworkSnapshotOptions = {}): Promise<{
    entries: ReturnType<NetworkBuffer['snapshot']>['entries'];
    total: number;
    dropped: number;
  }> {
    return this.networkBuffer.snapshot(options);
  }

  isAlive(): boolean {
    return !this.disposed;
  }

  get cachedUrl(): string {
    return this.pageUrl;
  }
}
