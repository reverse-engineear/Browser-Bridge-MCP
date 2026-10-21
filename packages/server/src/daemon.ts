import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT } from '@browser-bridge/protocol';
import { SERVER_VERSION } from './config.js';
import { HealthSchema, type Health } from './control.js';
import { BridgeToolError } from './errors.js';
import { BridgeHub } from './hub.js';

const DAEMON_ENTRY = fileURLToPath(new URL('./index.js', import.meta.url));
const IDLE_TIMEOUT_MS = 30 * 60_000;
const IDLE_CHECK_MS = 60_000;
const START_TIMEOUT_MS = 10_000;

export interface DaemonPaths {
  log: string;
}

export function daemonPaths(): DaemonPaths {
  const dir = path.join(tmpdir(), 'browser-bridge');
  return { log: path.join(dir, 'daemon.log') };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function probeHealth(port: number, timeoutMs = 800): Promise<Health | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const parsed = HealthSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function ensureDaemon(
  port = DEFAULT_PORT,
  log: (message: string) => void = () => undefined,
): Promise<Health> {
  const existing = await probeHealth(port);
  if (existing) return existing;

  const paths = daemonPaths();
  mkdirSync(path.dirname(paths.log), { recursive: true });
  const logFd = openSync(paths.log, 'a');

  try {
    const child = spawn(process.execPath, [DAEMON_ENTRY, '--daemon'], {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', 'ignore', logFd],
      env: { ...process.env, BROWSER_BRIDGE_PORT: String(port) },
    });
    child.unref();
  } finally {
    closeSync(logFd);
  }

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await delay(100);
    const health = await probeHealth(port, 500);
    if (health) {
      log(`Shared bridge ready on ws://127.0.0.1:${port} (pid ${health.pid}).`);
      return health;
    }
  }

  throw new BridgeToolError(
    'SERVER_UNREACHABLE',
    `Could not start the shared bridge on port ${port}. The port may belong to another program; stop it and try again. Log: ${paths.log}`,
  );
}

export async function stopDaemon(port = DEFAULT_PORT): Promise<Health | null> {
  const health = await probeHealth(port);
  if (!health) return null;

  try {
    process.kill(health.pid, 'SIGTERM');
  } catch {
    return null;
  }

  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    await delay(100);
    if (!(await probeHealth(port, 300))) return health;
  }
  return health;
}

export async function runDaemon(port = DEFAULT_PORT): Promise<void> {
  const log = (message: string) => process.stderr.write(`[browser-bridge] ${message}\n`);
  const hub = new BridgeHub({ port, serverVersion: SERVER_VERSION, log });

  let shuttingDown = false;
  let emptySince = Date.now();

  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(idleTimer);
    log(`Daemon shutting down (${reason}).`);
    await hub.close();
    process.exit(0);
  };

  const idleTimer = setInterval(() => {
    if (hub.clientCount > 0 || hub.connected) {
      emptySince = Date.now();
      return;
    }
    if (Date.now() - emptySince > IDLE_TIMEOUT_MS) {
      void shutdown('no clients or browser sessions');
    }
  }, IDLE_CHECK_MS);
  idleTimer.unref();

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  await hub.listen();
  log(`Daemon ${process.pid} ready; MCP clients connect on ws://127.0.0.1:${port}/mcp-client.`);
}
