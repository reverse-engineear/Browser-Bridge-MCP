#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const EXTENSION_DIR = path.join(ROOT, 'apps', 'extension', '.output', 'chrome-mv3');
const SERVER_ENTRY = path.join(ROOT, 'packages', 'server', 'dist', 'index.js');
const FIXTURES = path.join(ROOT, 'fixtures');
const SCREENS = path.join(ROOT, 'replica', 'clone-screens');
const BRIDGE_PORT = 8787;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function line(message) {
  process.stdout.write(`${message}\n`);
}

function step(message) {
  line(`\n[e2e] ${message}`);
}

function check(condition, message) {
  if (!condition) throw new Error(`Check failed: ${message}`);
}

function checkMatch(value, pattern, message) {
  check(pattern.test(value), `${message} (got: ${String(value).slice(0, 400)})`);
}

async function poll(fn, label, timeoutMs = 15_000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}. Last state: ${String(last)}`);
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

async function bridgeHealth() {
  try {
    const response = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/health`);
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

function stopBridge() {
  const stopped = spawnSync(process.execPath, [SERVER_ENTRY, '--stop'], {
    cwd: ROOT,
    env: { ...process.env, BROWSER_BRIDGE_PORT: String(BRIDGE_PORT) },
    encoding: 'utf8',
    timeout: 10_000,
  });
  const output = `${stopped.stderr ?? ''}${stopped.stdout ?? ''}`.trim();
  if (output) line(`[e2e] ${output.split(/\r?\n/).join('\n[e2e] ')}`);
}

class Cdp {
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    return new Cdp(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    socket.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (message.id && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`));
        else entry.resolve(message.result);
      }
    });
    socket.on('close', () => {
      this.closed = true;
      for (const entry of this.pending.values()) entry.reject(new Error('CDP connection closed.'));
      this.pending.clear();
    });
  }

  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error(`CDP is closed; cannot send ${method}.`));
        return;
      }
      const id = this.nextId;
      this.nextId += 1;
      this.pending.set(id, { resolve, reject, method });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  async evaluate(expression, sessionId, awaitPromise = false) {
    const result = await this.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise },
      sessionId,
    );
    if (result.exceptionDetails) {
      throw new Error(
        `Page evaluate failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
      );
    }
    return result.result?.value;
  }

  async attach(targetId) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    await this.send('Runtime.enable', {}, sessionId);
    return sessionId;
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // Already closed.
    }
  }
}

class McpClient {
  static async start({ label }) {
    const child = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: ROOT,
      env: {
        ...process.env,
        BROWSER_BRIDGE_PORT: String(BRIDGE_PORT),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const client = new McpClient(child, label);
    await client.initialize();
    return client;
  }

  constructor(child, label) {
    this.child = child;
    this.label = label;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.stderr = '';
    this.exited = false;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      for (;;) {
        const index = this.buffer.indexOf('\n');
        if (index < 0) break;
        const raw = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (!raw) continue;
        let message;
        try {
          message = JSON.parse(raw);
        } catch {
          line(`[mcp:${label}] unreadable stdout: ${raw.slice(0, 300)}`);
          continue;
        }
        this.onMessage(message);
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      this.stderr += chunk;
      for (const text of chunk.split(/\r?\n/)) {
        if (text.trim()) line(`[server:${label}] ${text.trim()}`);
      }
    });

    child.on('exit', (code) => {
      this.exited = true;
      for (const entry of this.pending.values()) {
        entry.reject(new Error(`MCP server exited with code ${code}.`));
      }
      this.pending.clear();
    });
  }

  onMessage(message) {
    if (!message.id || !this.pending.has(message.id)) return;
    const entry = this.pending.get(message.id);
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`));
    else entry.resolve(message.result);
  }

  request(method, params = {}, timeoutMs = 60_000) {
    return new Promise((resolve, reject) => {
      if (this.exited) {
        reject(new Error(`MCP server ${this.label} is not running.`));
        return;
      }
      const id = this.nextId;
      this.nextId += 1;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request ${method} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, method, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async initialize() {
    const result = await this.request(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'browser-bridge-e2e', version: '0.1.0' },
      },
      20_000,
    );
    check(result?.serverInfo?.name, 'MCP initialize returned a server name');
    this.notify('notifications/initialized');
    return result;
  }

  async tool(name, args = {}, timeoutMs) {
    const result = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    const content = Array.isArray(result?.content) ? result.content : [];
    return {
      isError: result?.isError === true,
      text: content.filter((part) => part.type === 'text').map((part) => part.text).join('\n'),
      image: content.find((part) => part.type === 'image'),
      raw: result,
    };
  }

  async release() {
    if (this.exited) return;
    try {
      this.child.stdin.end();
    } catch {
      // Already closed.
    }
    for (let attempt = 0; attempt < 50 && !this.exited; attempt += 1) await sleep(100);
    if (!this.exited) this.child.kill();
  }
}

function refFor(snapshot, role, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`- ${role} "${escaped}"[^\\n]*\\[ref=(s\\d+e\\d+)\\]`).exec(snapshot);
  if (!match) throw new Error(`No ref for ${role} "${name}" in:\n${snapshot}`);
  return match[1];
}

function buildFixtureServer() {
  const server = createServer(async (request, response) => {
    const rawPath = (request.url ?? '/').split('?')[0];
    const relative = rawPath === '/' ? 'index.html' : rawPath.replace(/^\/+/, '');
    const filePath = path.resolve(FIXTURES, relative);
    if (!filePath.startsWith(FIXTURES + path.sep)) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    try {
      const body = await readFile(filePath);
      const extension = path.extname(filePath);
      const type =
        extension === '.html'
          ? 'text/html; charset=utf-8'
          : extension === '.js'
            ? 'text/javascript; charset=utf-8'
            : extension === '.css'
              ? 'text/css; charset=utf-8'
              : 'application/octet-stream';
      response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      response.end(body);
    } catch {
      response.writeHead(404).end('Not found');
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const state = {
  cdp: null,
  chrome: null,
  fixtureServer: null,
  tempRoot: null,
  mcp: null,
  mcpSecond: null,
};

async function cleanup() {
  state.cleaningUp = true;
  try {
    await state.mcp?.release();
  } catch {
    // Best effort.
  }
  try {
    await state.mcpSecond?.release();
  } catch {
    // Best effort.
  }
  try {
    stopBridge();
  } catch {
    // Best effort.
  }
  state.cdp?.close();
  if (state.chrome?.pid) {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(state.chrome.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      state.chrome.kill('SIGKILL');
    }
  }
  if (state.fixtureServer) {
    await new Promise((resolve) => state.fixtureServer.close(() => resolve()));
  }
  if (state.tempRoot) {
    await sleep(300);
    await rm(state.tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function run() {
  step('Checking prerequisites');
  check(existsSync(path.join(EXTENSION_DIR, 'manifest.json')), 'extension build exists (run npm run build)');
  check(existsSync(SERVER_ENTRY), 'server build exists (run npm run build)');
  check(await isPortFree(BRIDGE_PORT), `port ${BRIDGE_PORT} is free`);
  await mkdir(SCREENS, { recursive: true });

  const chromePath =
    process.env.CHROME_PATH ??
    path.join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe');
  check(existsSync(chromePath), `Chrome exists at ${chromePath} (set CHROME_PATH to override)`);

  state.fixtureServer = await buildFixtureServer();
  const fixturePort = state.fixtureServer.address().port;
  const indexUrl = `http://127.0.0.1:${fixturePort}/index.html`;
  const secondUrl = `http://127.0.0.1:${fixturePort}/second.html`;
  line(`[e2e] fixtures at ${indexUrl}`);

  const tempRoot = await mkdtemp(path.join(tmpdir(), 'browser-bridge-e2e-'));
  state.tempRoot = tempRoot;
  const profileDir = path.join(tempRoot, 'profile');

  step('Launching Chrome with a temporary profile');
  state.chrome = spawn(
    chromePath,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--enable-unsafe-extension-debugging',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--window-size=900,720',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let chromeErrors = '';
  state.chrome.stderr?.setEncoding('utf8');
  state.chrome.stderr?.on('data', (chunk) => {
    chromeErrors += chunk;
    if (chromeErrors.length > 20_000) chromeErrors = chromeErrors.slice(-20_000);
  });
  state.chrome.on('exit', (code) => {
    if (!state.cleaningUp && code !== 0 && code !== null) line(`[chrome] exited with ${code}`);
  });

  const debugPort = await poll(
    () => {
      try {
        const [first] = readFileSync(path.join(profileDir, 'DevToolsActivePort'), 'utf8').split(/\r?\n/);
        return first ? Number(first) : null;
      } catch {
        return null;
      }
    },
    'Chrome to open its debugging port',
    20_000,
  );
  const versionInfo = await poll(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      return response.ok ? await response.json() : null;
    } catch {
      return null;
    }
  }, 'the DevTools version endpoint', 10_000);
  state.cdp = await Cdp.connect(versionInfo.webSocketDebuggerUrl);
  line(`[e2e] ${versionInfo.Browser}`);

  step('Loading the unpacked extension and opening its popup');
  const loaded = await state.cdp.send('Extensions.loadUnpacked', { path: EXTENSION_DIR });
  check(loaded?.id, 'Extensions.loadUnpacked returned an extension id');
  const extensionId = loaded.id;
  line(`[e2e] extension ${extensionId}`);

  const fixtureTarget = (await state.cdp.send('Target.createTarget', { url: indexUrl })).targetId;

  const popupTarget = (
    await state.cdp.send('Target.createTarget', { url: `chrome-extension://${extensionId}/popup.html` })
  ).targetId;
  const popupSession = await state.cdp.attach(popupTarget);
  await poll(
    async () => {
      const view = await popupView(popupSession);
      return view !== 'loading' ? view : null;
    },
    'the popup to render its first state',
    15_000,
  );
  check((await popupView(popupSession)) === 'idle', 'a fresh profile starts on the idle screen');
  line('[e2e] popup is on the first-run idle screen');

  const swTarget = await poll(async () => {
    const { targetInfos } = await state.cdp.send('Target.getTargets', {});
    return targetInfos.find(
      (target) => target.type === 'service_worker' && target.url.includes(extensionId),
    );
  }, 'the extension service worker', 10_000);
  line(`[e2e] service worker ${swTarget.url}`);

  const capturePopup = async (file, { dark = false } = {}) => {
    await state.cdp.send('Target.activateTarget', { targetId: popupTarget });
    await state.cdp.send(
      'Emulation.setEmulatedMedia',
      { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] },
      popupSession,
    );
    await state.cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: 250, height: 520, deviceScaleFactor: 2, mobile: false },
      popupSession,
    );
    await sleep(200);
    const contentHeight = await state.cdp.evaluate(
      'Math.ceil(document.querySelector(".popup").getBoundingClientRect().height)',
      popupSession,
    );
    const height = Math.max(200, Math.min(640, Number(contentHeight) || 320));
    await state.cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: 250, height, deviceScaleFactor: 2, mobile: false },
      popupSession,
    );
    await sleep(250);
    const shot = await state.cdp.send('Page.captureScreenshot', { format: 'png' }, popupSession);
    await writeFile(path.join(SCREENS, file), Buffer.from(shot.data, 'base64'));
    line(`[e2e] saved replica/clone-screens/${file} (250x${height})`);
  };

  await capturePopup('S01-idle.png');

  const activeFixture = () =>
    poll(
      async () => {
        const tab = await state.cdp.evaluate(
          'new Promise((resolve) => chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs[0] ? { id: tabs[0].id, url: tabs[0].url, status: tabs[0].status } : null)))',
          popupSession,
          true,
        );
        return tab?.url === indexUrl && tab.status === 'complete' ? tab : null;
      },
      'the fixture to become the active, loaded tab',
      10_000,
    );

  step('Connecting before any MCP client exists');
  await state.cdp.send('Target.activateTarget', { targetId: fixtureTarget });
  const activeTab = await activeFixture();
  line(`[e2e] active tab before connecting: ${activeTab.url}`);
  await state.cdp.evaluate('document.getElementById("connect").click()', popupSession);
  const serverDown = await poll(async () => {
    if ((await popupView(popupSession)) !== 'error') return null;
    return (
      await state.cdp.evaluate('document.getElementById("error-text").textContent', popupSession)
    ) || null;
  }, 'the no-server error', 20_000);
  checkMatch(serverDown, /didn't answer|start it/i, 'a missing bridge produces a clear error');
  line(`[e2e] no-server message: ${serverDown}`);
  await capturePopup('S01-no-server.png');

  step('Starting two MCP clients on the shared bridge');
  state.mcp = await McpClient.start({ label: 'one' });
  state.mcpSecond = await McpClient.start({ label: 'two' });
  const health = await poll(
    async () => {
      const value = await bridgeHealth();
      return value?.service === 'browser-bridge' && value.clients === 2 ? value : null;
    },
    'both MCP clients on one bridge',
    20_000,
  );
  line(`[e2e] shared bridge pid ${health.pid}; clients ${health.clients}`);

  const expectedTools = [
    'navigate', 'go_back', 'go_forward', 'snapshot', 'click', 'type', 'hover',
    'select_option', 'press_key', 'wait', 'get_console_logs', 'get_network_requests',
    'clear_network_requests', 'screenshot', 'drag',
  ];
  for (const client of [state.mcp, state.mcpSecond]) {
    const tools = await client.request('tools/list', {}, 20_000);
    check(Array.isArray(tools.tools), `${client.label}: tools/list returned an array`);
    check(tools.tools.length === 15, `${client.label}: 15 tools are advertised (got ${tools.tools.length})`);
    for (const name of expectedTools) {
      check(tools.tools.some((tool) => tool.name === name), `${client.label}: tool ${name} is advertised`);
    }
  }
  line('[e2e] both clients advertise the same 15 tools');

  step('Retrying the tab connection against the running bridge');
  await state.cdp.send('Target.activateTarget', { targetId: fixtureTarget });
  await activeFixture();
  await state.cdp.evaluate('document.getElementById("retry").click()', popupSession);
  const connectedView = await poll(async () => {
    const view = await popupView(popupSession);
    if (view === 'error') {
      const error = await state.cdp.evaluate(
        'document.getElementById("error-text").textContent',
        popupSession,
      );
      if (error) throw new Error(error);
    }
    return view === 'connected' ? view : null;
  }, 'the popup to show a connected tab', 20_000);
  check(connectedView === 'connected', 'the popup reached the connected state');

  const connectedState = await popupSnapshot(popupSession);
  checkMatch(connectedState.status, /Connected/, 'the popup status says Connected');
  checkMatch(connectedState.tab, /Bridge fixture/, 'the popup names the bound tab');
  line(`[e2e] popup connected: ${connectedState.status} | ${connectedState.tab}`);
  await capturePopup('S02-connected.png');
  await capturePopup('S02-connected-dark.png', { dark: true });
  await state.cdp.send(
    'Emulation.setEmulatedMedia',
    { features: [{ name: 'prefers-color-scheme', value: 'light' }] },
    popupSession,
  );

  step('Disconnecting and reconnecting from the popup');
  await state.cdp.send('Target.activateTarget', { targetId: fixtureTarget });
  await state.cdp.evaluate('document.getElementById("disconnect").click()', popupSession);
  await poll(
    async () => (await popupView(popupSession)) === 'idle',
    'the popup to return to the disconnected screen',
    10_000,
  );

  await state.cdp.send('Target.activateTarget', { targetId: fixtureTarget });
  await state.cdp.evaluate('document.getElementById("connect").click()', popupSession);
  await poll(
    async () => (await popupView(popupSession)) === 'connected',
    'the popup to reconnect the tab',
    20_000,
  );
  line('[e2e] disconnect and connect both worked');

  step('Driving the same tab from the second MCP client');
  const secondClientSnapshot = await state.mcpSecond.tool('snapshot');
  check(!secondClientSnapshot.isError, 'the second client can take a snapshot');
  checkMatch(secondClientSnapshot.text, /Bridge fixture/, 'the second client sees the connected tab');
  line('[e2e] the second client read the same tab');

  step('Driving the page through the MCP tools');
  let result = await state.mcp.tool('navigate', { url: secondUrl });
  check(!result.isError, 'navigate to the second page succeeds');
  checkMatch(result.text, /Second page/, 'navigate reports the second page title');
  check(result.text.includes(secondUrl), 'navigate reports the new URL');
  line('[e2e] navigate -> second page');

  const followedLabel = await poll(async () => {
    const tab = (await popupSnapshot(popupSession)).tab;
    return /Second page/.test(tab) ? tab : null;
  }, 'the popup label to follow the new page', 10_000);
  line(`[e2e] popup label followed navigation: ${followedLabel}`);

  result = await state.mcp.tool('go_back');
  check(!result.isError, 'go_back succeeds');
  checkMatch(result.text, /Bridge fixture/, 'go_back returns the first page');

  const returnedLabel = await poll(async () => {
    const tab = (await popupSnapshot(popupSession)).tab;
    return /Bridge fixture/.test(tab) ? tab : null;
  }, 'the popup label to follow the back navigation', 10_000);
  line(`[e2e] popup label followed go_back: ${returnedLabel}`);

  result = await state.mcp.tool('go_forward');
  check(!result.isError, 'go_forward succeeds');
  checkMatch(result.text, /Second page/, 'go_forward returns the second page');

  result = await state.mcp.tool('go_back');
  checkMatch(result.text, /Bridge fixture/, 'the tab is back on the fixture');

  const firstSnapshot = await state.mcp.tool('snapshot');
  check(!firstSnapshot.isError, 'snapshot succeeds');
  const firstText = firstSnapshot.text;
  checkMatch(firstText, /- document "Bridge fixture"/, 'the snapshot names the document');
  checkMatch(firstText, /button "Say hello"/, 'the snapshot includes the hello button');
  checkMatch(firstText, /textbox "Name"/, 'the snapshot includes the name field');
  checkMatch(firstText, /textbox "Password" \[value hidden\]/, 'the password value is hidden');
  checkMatch(firstText, /combobox "Colour"/, 'the snapshot includes the colour select');
  checkMatch(firstText, /StaticText "Drag this card"/, 'plain drag sources get a ref');

  const helloRef = refFor(firstText, 'button', 'Say hello');
  const nameRef = refFor(firstText, 'textbox', 'Name');
  const passwordRef = refFor(firstText, 'textbox', 'Password');
  const colourRef = refFor(firstText, 'combobox', 'Colour');
  const saveRef = refFor(firstText, 'button', 'Save name');

  result = await state.mcp.tool('click', { ref: helloRef });
  check(!result.isError, 'click succeeds');
  checkMatch(result.text, /Clicked/, 'click reports success');

  step('Checking the agent cursor and its hide switch');
  const cursorAfterClick = await pageCursorState(popupSession, indexUrl);
  check(
    cursorAfterClick === 'active',
    `the click shows the internal cursor (got ${JSON.stringify(cursorAfterClick)})`,
  );
  line('[e2e] the agent cursor is active after a click');

  result = await state.mcp.tool('screenshot');
  check(!result.isError && Boolean(result.image?.data), 'the agent cursor is captured in a screenshot');
  await writeFile(path.join(SCREENS, 'agent-cursor.png'), Buffer.from(result.image.data, 'base64'));
  line('[e2e] saved replica/clone-screens/agent-cursor.png');

  await state.cdp.evaluate('document.getElementById("cursor-toggle").click()', popupSession);
  await poll(
    async () => {
      const value = await pageCursorState(popupSession, indexUrl);
      if (value && typeof value === 'object' && value.error) {
        throw new Error(`page cursor check failed: ${value.error}`);
      }
      return value === null ? 'removed' : null;
    },
    'the cursor switch to remove the page overlay',
    8_000,
  );
  const storedOff = await state.cdp.evaluate(
    'new Promise((resolve) => chrome.storage.local.get("agentCursorVisible", (value) => resolve(value.agentCursorVisible)))',
    popupSession,
    true,
  );
  check(storedOff === false, 'the cursor preference is persisted when switched off');

  result = await state.mcp.tool('click', { ref: helloRef });
  check(!result.isError, 'clicking still works with the agent cursor off');
  const cursorOff = await pageCursorState(popupSession, indexUrl);
  check(cursorOff === null, 'a click with the cursor off leaves the page without an overlay');
  line('[e2e] cursor off: actions still work and the overlay stays removed');

  await state.cdp.evaluate('document.getElementById("cursor-toggle").click()', popupSession);
  await poll(
    async () =>
      (await state.cdp.evaluate('document.getElementById("cursor-toggle").checked', popupSession)) === true
        ? 'on'
        : null,
    'the cursor switch to turn back on',
    8_000,
  );
  const storedOn = await state.cdp.evaluate(
    'new Promise((resolve) => chrome.storage.local.get("agentCursorVisible", (value) => resolve(value.agentCursorVisible)))',
    popupSession,
    true,
  );
  check(storedOn === true, 'the cursor preference is persisted when switched on');

  result = await state.mcp.tool('click', { ref: helloRef });
  check(!result.isError, 'clicking works after the agent cursor is switched back on');
  const cursorBack = await pageCursorState(popupSession, indexUrl);
  check(cursorBack === 'active', 'the overlay returns after the cursor is switched back on');

  const autoHidden = await poll(
    async () => ((await pageCursorState(popupSession, indexUrl)) === 'idle' ? 'idle' : null),
    'the agent cursor to fade out after inactivity',
    8_000,
  );
  check(autoHidden === 'idle', 'the agent cursor fades out on its own');
  line('[e2e] cursor on: overlay returned, persisted and auto-hid');

  result = await state.mcp.tool('type', { ref: nameRef, text: 'Ada', submit: true });
  check(!result.isError, 'type with submit succeeds');
  const cursorAfterType = await pageCursorState(popupSession, indexUrl);
  check(cursorAfterType === 'active', 'typing brings the agent cursor back');

  result = await state.mcp.tool('select_option', { ref: colourRef, values: ['green'] });
  check(!result.isError, 'select_option succeeds');
  checkMatch(result.text, /Selected: green/, 'select_option reports the chosen value');

  result = await state.mcp.tool('click', { ref: saveRef });
  check(!result.isError, 'clicking save succeeds');

  result = await state.mcp.tool('type', { ref: passwordRef, text: 'hunter2' });
  check(!result.isError, 'typing a password succeeds');

  result = await state.mcp.tool('hover', { ref: helloRef });
  check(!result.isError, 'hover succeeds');

  result = await state.mcp.tool('press_key', { key: 'Tab' });
  check(!result.isError, 'press_key succeeds');

  result = await state.mcp.tool('wait', { seconds: 0.1 });
  check(!result.isError, 'wait succeeds');

  result = await state.mcp.tool('get_console_logs');
  check(!result.isError, 'get_console_logs succeeds');
  checkMatch(result.text, /hello 1/, 'the click was logged');
  checkMatch(result.text, /saved Ada; colour green/, 'the submitted form was logged');
  line('[e2e] click, type, select, hover, key and wait verified');

  const secondSnapshot = await state.mcp.tool('snapshot');
  const secondText = secondSnapshot.text;
  checkMatch(secondText, /Saved Ada\./, 'the page shows the saved name');
  checkMatch(secondText, /\[value hidden\]/, 'the password is still hidden after typing');
  check(!secondText.includes('hunter2'), 'the password never reaches the snapshot');
  const dragFrom = refFor(secondText, 'StaticText', 'Drag this card');
  const dragTo = refFor(secondText, 'StaticText', 'Drop here');

  result = await state.mcp.tool('drag', { fromRef: dragFrom, toRef: dragTo });
  check(!result.isError, 'drag succeeds');
  result = await state.mcp.tool('snapshot');
  checkMatch(result.text, /Dropped: payload/, 'the drop target received the payload');
  const cursorAfterDrag = await pageCursorState(popupSession, indexUrl);
  check(cursorAfterDrag === 'active', 'dragging keeps the agent cursor at the drop point');
  const shadowRef = refFor(result.text, 'button', 'Shadow action');
  line('[e2e] drag completed with the cursor at the drop point');

  result = await state.mcp.tool('click', { ref: shadowRef });
  check(!result.isError, 'clicking inside shadow DOM succeeds');
  result = await state.mcp.tool('snapshot');
  checkMatch(result.text, /Shadow action pressed\./, 'the shadow DOM button ran its handler');
  line('[e2e] shadow DOM click verified');

  step('Input raises the connected tab when it is in the background');
  const raiseRef = refFor(result.text, 'button', 'Shadow action');
  await state.cdp.send('Target.activateTarget', { targetId: popupTarget });
  await sleep(400);
  const foregroundBefore = await state.cdp.evaluate(
    'new Promise((resolve) => chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs[0]?.url ?? null)))',
    popupSession,
  );
  check(foregroundBefore !== indexUrl, 'another tab is active before the action');
  result = await state.mcp.tool('click', { ref: raiseRef });
  check(!result.isError, 'clicking with the connected tab in the background succeeds');
  await activeFixture();
  line('[e2e] the click raised the connected tab to the front');

  result = await state.mcp.tool('screenshot');
  check(!result.isError, 'screenshot succeeds');
  check(Boolean(result.image?.data), 'screenshot returns PNG data');
  checkMatch(result.text, /Screenshot: \d+ x \d+px\./, 'screenshot reports its dimensions');
  await writeFile(path.join(SCREENS, 'tool-screenshot.png'), Buffer.from(result.image.data, 'base64'));
  line('[e2e] screenshot returned and saved as evidence');

  result = await state.mcp.tool('click', { ref: helloRef });
  check(result.isError, 'a ref from an older snapshot is rejected');
  checkMatch(result.text, /^REF_STALE:/, 'the stale ref returns REF_STALE');

  result = await state.mcp.tool('wait', { seconds: 31 });
  check(result.isError, 'wait above 30 seconds is rejected');
  checkMatch(result.text, /^BAD_REQUEST:/, 'wait validation returns BAD_REQUEST');

  step('Navigating again, then checking restricted URLs and log persistence');
  result = await state.mcp.tool('navigate', { url: secondUrl });
  checkMatch(result.text, /Second page/, 'the second navigation succeeds');
  const secondPageSnapshot = await state.mcp.tool('snapshot');
  const secondButton = refFor(secondPageSnapshot.text, 'button', 'Second page action');
  result = await state.mcp.tool('click', { ref: secondButton });
  check(!result.isError, 'clicking on the second page succeeds');
  result = await state.mcp.tool('get_console_logs');
  checkMatch(result.text, /second action pressed/, 'the second page action was logged');
  checkMatch(result.text, /hello 1/, 'logs survived the navigation');
  line('[e2e] console buffer survived navigation');

  const network = await poll(async () => {
    const response = await state.mcp.tool('get_network_requests', { urlContains: 'second.html', limit: 20 });
    if (response.isError) return response;
    return /GET\s+200\s+Document/.test(response.text) ? response : null;
  }, 'network metadata for the second-page document', 15_000);
  check(network.text.includes(secondUrl), 'network metadata includes the document URL');
  line(`[e2e] network metadata: ${network.text.split('\n').find((row) => row.includes('second.html'))}`);

  result = await state.mcp.tool('get_network_requests', { limit: 5 });
  const networkRows = result.text.split('\n').filter((row) => /^\d{2}:\d{2}:\d{2}\s/.test(row));
  check(!result.isError, 'get_network_requests with a limit succeeds');
  check(networkRows.length > 0 && networkRows.length <= 5, 'the limit caps the returned rows');

  result = await state.mcp.tool('get_network_requests', { urlContains: 'no-such-request-12345' });
  checkMatch(result.text, /No captured requests match/, 'an unmatched URL filter explains itself');

  result = await state.mcp.tool('get_network_requests', {
    resourceType: 'document',
    urlContains: 'second.html',
    limit: 10,
  });
  check(!result.isError, 'get_network_requests with a resourceType filter succeeds');
  checkMatch(result.text, /GET\s+200\s+Document/, 'the resourceType filter keeps the document row');

  result = await state.mcp.tool('get_network_requests', { resourceType: 'XHR' });
  check(!result.isError, 'get_network_requests accepts an XHR filter');
  checkMatch(result.text, /No captured requests match/, 'an unmatched resourceType explains itself');
  line('[e2e] resourceType filter verified');

  result = await state.mcp.tool('clear_network_requests');
  check(!result.isError, 'clear_network_requests succeeds');
  checkMatch(result.text, /Cleared \d+ captured request/, 'clear_network_requests reports the removed count');
  result = await state.mcp.tool('get_network_requests');
  checkMatch(result.text, /No network requests captured yet/, 'clear_network_requests empties the buffer');

  result = await state.mcp.tool('navigate', { url: `${indexUrl}?after-clear=1` });
  check(!result.isError, 'navigate after the clear succeeds');
  checkMatch(result.text, /Bridge fixture/, 'navigate after the clear reaches the fixture');
  await poll(
    async () => {
      const response = await state.mcp.tool('get_network_requests', { limit: 1 });
      return /No network requests captured yet/.test(response.text) ? null : response;
    },
    'capture to resume after clear_network_requests',
    10_000,
  );
  line('[e2e] clear_network_requests emptied the buffer and capture resumed');

  result = await state.mcp.tool('navigate', { url: 'chrome://version' });
  check(result.isError, 'navigating to chrome:// is rejected');
  checkMatch(result.text, /^BAD_REQUEST:/, 'a non-http page returns BAD_REQUEST');

  result = await state.mcp.tool('navigate', { url: 'https://chromewebstore.google.com/' });
  check(result.isError, 'navigating to the Web Store is rejected');
  checkMatch(result.text, /^NOT_AUTOMATABLE:/, 'the store page returns NOT_AUTOMATABLE');

  result = await state.mcp.tool('navigate', { url: 'file:///C:/Windows/win.ini' });
  check(result.isError, 'navigating to file:// is rejected');
  checkMatch(result.text, /^BAD_REQUEST:/, 'a file URL returns BAD_REQUEST');

  step('Stopping the shared bridge to test reconnect');
  await state.mcp.release();
  state.mcp = null;
  await state.mcpSecond.release();
  state.mcpSecond = null;
  stopBridge();
  await poll(async () => ((await bridgeHealth()) === null ? 'stopped' : null), 'the bridge to stop', 10_000);
  const reconnectingView = await poll(
    async () => ((await popupView(popupSession)) === 'reconnecting' ? 'reconnecting' : null),
    'the popup to show reconnecting after the bridge stops',
    12_000,
  );
  check(reconnectingView === 'reconnecting', 'the extension enters the reconnecting state');
  await capturePopup('S02-reconnecting.png');
  line('[e2e] reconnecting state captured');

  state.mcp = await McpClient.start({ label: 'three' });
  await poll(
    async () => (await popupView(popupSession)) === 'connected',
    'the popup to reconnect to the restarted bridge',
    25_000,
  );
  line('[e2e] extension reconnected to the restarted bridge');

  step('Closing the tab and checking the error state');
  await state.cdp.send('Target.closeTarget', { targetId: fixtureTarget });
  const errorView = await poll(
    async () => ((await popupView(popupSession)) === 'error' ? 'error' : null),
    'the popup to show the tab-closed error',
    15_000,
  );
  check(errorView === 'error', 'closing the tab moves the popup to the error state');
  const errorState = await popupSnapshot(popupSession);
  checkMatch(errorState.status, /Connection lost/, 'the status says the connection was lost');
  checkMatch(errorState.error, /closed/i, 'the error explains that the tab closed');
  await capturePopup('S02-error.png');
  line('[e2e] tab close produced the error state');

  result = await state.mcp.tool('snapshot');
  check(result.isError, 'tool calls fail after the tab closes');
  checkMatch(result.text, /^NOT_CONNECTED:/, 'the failure is NOT_CONNECTED');

  step('Connecting from a browser-internal page');
  const internalTarget = (
    await state.cdp.send('Target.createTarget', { url: 'chrome://version/' })
  ).targetId;
  await state.cdp.send('Target.activateTarget', { targetId: internalTarget });
  await sleep(300);
  await state.cdp.evaluate('document.getElementById("retry").click()', popupSession);
  const internalView = await poll(
    async () => ((await popupView(popupSession)) === 'connected' ? 'connected' : null),
    'the popup to connect from the internal page',
    20_000,
  );
  check(internalView === 'connected', 'Connect from a chrome:// tab succeeds');
  const parked = await state.cdp.send('Target.getTargetInfo', { targetId: internalTarget });
  check(
    parked.targetInfo.url === `http://127.0.0.1:${BRIDGE_PORT}/blank`,
    `the internal tab moved to the local blank page (got: ${parked.targetInfo.url})`,
  );
  const parkedState = await popupSnapshot(popupSession);
  line(`[e2e] parked tab label: ${parkedState.tab}`);
  checkMatch(parkedState.tab, /Browser Bridge/, 'the popup names the blank page');

  result = await state.mcp.tool('snapshot');
  check(!result.isError, 'snapshot works on the blank page');
  checkMatch(result.text, /Ready for Browser Bridge/, 'the snapshot sees the blank page');
  result = await state.mcp.tool('navigate', { url: indexUrl });
  check(!result.isError, 'navigate works after the fallback connection');
  checkMatch(result.text, /Bridge fixture/, 'the session can leave the blank page');
  line('[e2e] internal-page fallback verified');

  step('Keeping the restricted error for a PDF page');
  await state.cdp.evaluate('document.getElementById("disconnect").click()', popupSession);
  await poll(
    async () => ((await popupView(popupSession)) === 'idle' ? 'idle' : null),
    'the popup to disconnect before the PDF check',
    10_000,
  );
  const pdfTarget = (
    await state.cdp.send('Target.createTarget', {
      url: `http://127.0.0.1:${fixturePort}/missing.pdf`,
    })
  ).targetId;
  await state.cdp.send('Target.activateTarget', { targetId: pdfTarget });
  await sleep(300);
  await state.cdp.evaluate('document.getElementById("connect").click()', popupSession);
  const pdfError = await poll(async () => {
    if ((await popupView(popupSession)) !== 'error') return null;
    const text = await state.cdp.evaluate(
      'document.getElementById("error-text").textContent',
      popupSession,
    );
    return text || null;
  }, 'the PDF-page error', 15_000);
  checkMatch(pdfError, /does not allow automation/i, 'the popup still explains the restricted PDF page');
  line(`[e2e] PDF page message: ${pdfError}`);
  await capturePopup('S02-restricted.png');

  step('Retrying the fallback after a cold start');
  await state.mcp.release();
  state.mcp = null;
  stopBridge();
  await poll(
    async () => ((await bridgeHealth()) === null ? 'stopped' : null),
    'the bridge to stop before the cold-start retry',
    10_000,
  );
  const coldInternalTarget = (
    await state.cdp.send('Target.createTarget', { url: 'chrome://newtab/' })
  ).targetId;
  await state.cdp.send('Target.activateTarget', { targetId: coldInternalTarget });
  await sleep(300);
  await state.cdp.evaluate('document.getElementById("retry").click()', popupSession);
  const coldError = await poll(async () => {
    if ((await popupView(popupSession)) !== 'error') return null;
    const text = await state.cdp.evaluate(
      'document.getElementById("error-text").textContent',
      popupSession,
    );
    return /didn't answer/.test(text) ? text : null;
  }, 'the server-down error after parking the internal tab', 20_000);
  line(`[e2e] cold-start error: ${coldError}`);

  state.mcp = await McpClient.start({ label: 'four' });
  await poll(async () => ((await bridgeHealth()) !== null ? 'up' : null), 'the bridge to return', 15_000);
  await state.cdp.evaluate('document.getElementById("retry").click()', popupSession);
  const recoveredView = await poll(
    async () => ((await popupView(popupSession)) === 'connected' ? 'connected' : null),
    'the popup to recover on the parked page',
    20_000,
  );
  check(recoveredView === 'connected', 'Retry reloads the blank page and attaches');
  result = await state.mcp.tool('snapshot');
  check(!result.isError, 'snapshot works after the cold-start retry');
  checkMatch(result.text, /Ready for Browser Bridge/, 'the recovered tab shows the blank page');
  line('[e2e] cold-start fallback recovery verified');

  if (state.mcp) await state.mcp.release();
  state.mcp = null;
  line('\n[e2e] PASS: first run, shared bridge, reconnect, tab-close, agent cursor and all MCP tools verified');
}

function popupView(sessionId) {
  return state.cdp.evaluate(
    `(() => {
      const views = ['idle', 'connecting', 'connected', 'reconnecting', 'error'];
      const found = views.find((name) => {
        const element = document.getElementById(name + '-view');
        return element && !element.hidden;
      });
      return found ?? 'loading';
    })()`,
    sessionId,
  );
}

function pageCursorState(sessionId, url) {
  return state.cdp.evaluate(
    `new Promise((resolve) => {
      chrome.tabs.query({}, (tabs) => {
        const tab = tabs.find((item) => item.url === ${JSON.stringify(url)});
        if (!tab || tab.id === undefined) { resolve({ error: 'tab not found' }); return; }
        chrome.debugger.sendCommand(
          { tabId: tab.id },
          'Runtime.evaluate',
          {
            expression: '(() => { const host = document.querySelector("[data-browser-bridge-cursor]"); return host ? host.getAttribute("data-browser-bridge-cursor") : null; })()',
            returnByValue: true,
          },
          (result) => {
            if (chrome.runtime.lastError) { resolve({ error: chrome.runtime.lastError.message }); return; }
            resolve(result && result.result ? result.result.value : null);
          },
        );
      });
    })`,
    sessionId,
    true,
  );
}

function popupSnapshot(sessionId) {
  return state.cdp.evaluate(
    `(() => ({
      view: (() => {
        const names = ['idle', 'connecting', 'connected', 'reconnecting', 'error'];
        return names.find((name) => {
          const element = document.getElementById(name + '-view');
          return element && !element.hidden;
        }) ?? 'loading';
      })(),
      status: document.getElementById('status-row').hidden
        ? ''
        : document.getElementById('status-text').textContent,
      tab: document.getElementById('tab-row').hidden
        ? ''
        : document.getElementById('tab-row').textContent,
      error: document.getElementById('error-panel').hidden
        ? ''
        : document.getElementById('error-text').textContent,
    }))()`,
    sessionId,
  );
}

try {
  await run();
} catch (error) {
  process.exitCode = 1;
  line(`\n[e2e] FAILED: ${error instanceof Error ? error.stack : String(error)}`);
  if (state.mcp?.stderr) {
    line('\n[e2e] Last server output:');
    line(state.mcp.stderr.split(/\r?\n/).slice(-25).join('\n'));
  }
} finally {
  await cleanup();
}
