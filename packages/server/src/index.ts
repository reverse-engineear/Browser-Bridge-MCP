#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DEFAULT_PORT } from '@browser-bridge/protocol';
import { BridgeClient } from './client.js';
import { parsePort, SERVER_VERSION } from './config.js';
import { ensureDaemon, runDaemon, stopDaemon } from './daemon.js';
import { createMcpServer } from './mcp.js';

const BROWSER_NAME = 'Chrome';

function log(message: string): void {
  process.stderr.write(`[browser-bridge] ${message}\n`);
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const port = parsePort(process.env.BROWSER_BRIDGE_PORT) ?? DEFAULT_PORT;

  if (args.has('--stop')) {
    const stopped = await stopDaemon(port);
    log(stopped ? `Stopped the shared bridge (pid ${stopped.pid}).` : `No shared bridge is running on port ${port}.`);
    return;
  }

  if (args.has('--daemon')) {
    await runDaemon(port);
    return;
  }

  log(`Browser Bridge server ${SERVER_VERSION}`);
  const health = await ensureDaemon(port, log);
  log(`Using the shared bridge started by pid ${health.pid}.`);

  const bridge = new BridgeClient(port, log);
  await bridge.connect();

  const server = createMcpServer({
    bridge,
    version: SERVER_VERSION,
    browserName: BROWSER_NAME,
    log,
  });

  const transport = new StdioServerTransport();
  let shuttingDown = false;

  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`Shutting down (${reason}). The shared bridge stays up for other clients.`);
    try {
      await server.close();
    } catch {
      // The client may already have closed the pipe.
    }
    bridge.close();
    process.exit(0);
  };

  transport.onclose = () => {
    void shutdown('client closed stdio');
  };

  process.stdin.on('end', () => {
    void shutdown('stdin ended');
  });

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  await server.connect(transport);
  log(
    health.extensionConnected
      ? 'MCP client connected. A browser tab is already available.'
      : 'MCP client connected. Waiting for a tab in the extension popup.',
  );
}

main().catch((error: unknown) => {
  log(`Fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
