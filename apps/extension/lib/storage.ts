import type { TabInfo } from '@browser-bridge/protocol';

export interface StoredSession {
  tabId: number;
  windowId: number;
  url: string;
  title: string;
}

const SESSION_KEY = 'bridgeSession';
const CURSOR_KEY = 'agentCursorVisible';

export async function readSession(): Promise<StoredSession | null> {
  const stored = await chrome.storage.session.get(SESSION_KEY);
  const value = stored[SESSION_KEY] as Partial<StoredSession> | undefined;
  if (
    !value ||
    typeof value.tabId !== 'number' ||
    typeof value.windowId !== 'number' ||
    typeof value.url !== 'string' ||
    typeof value.title !== 'string'
  ) {
    return null;
  }
  return { tabId: value.tabId, windowId: value.windowId, url: value.url, title: value.title };
}

export async function writeSession(tab: TabInfo): Promise<void> {
  const stored: StoredSession = {
    tabId: tab.id,
    windowId: tab.windowId,
    url: tab.url,
    title: tab.title,
  };
  await chrome.storage.session.set({ [SESSION_KEY]: stored });
}

export async function clearSession(): Promise<void> {
  await chrome.storage.session.remove(SESSION_KEY);
}

export async function readCursorVisible(): Promise<boolean> {
  const stored = await chrome.storage.local.get(CURSOR_KEY);
  return stored[CURSOR_KEY] !== false;
}

export async function writeCursorVisible(visible: boolean): Promise<void> {
  await chrome.storage.local.set({ [CURSOR_KEY]: visible });
}

export async function readTabInfo(tabId: number): Promise<TabInfo | null> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.id === undefined || tab.windowId === undefined) return null;
    return {
      id: tab.id,
      windowId: tab.windowId,
      url: tab.url ?? '',
      title: tab.title ?? '',
    };
  } catch {
    return null;
  }
}
