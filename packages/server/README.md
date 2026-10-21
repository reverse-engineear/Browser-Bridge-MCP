# Browser Bridge MCP server

The local MCP server for Browser Bridge MCP. It exposes one Chrome tab to any MCP client over stdio and talks to the Browser Bridge extension through a shared loopback daemon.

Full setup, extension loading, and troubleshooting live in the [root README](../../README.md).

```
MCP client ─ stdio ─ browser-bridge-mcp ─ ws://127.0.0.1:8787/mcp-client ─ daemon ─ /extension ─ Chrome
```

## Run

Build the workspace first:

```bash
npm install
npm run build:server
```

Then point any MCP client at the absolute path:

```bash
claude mcp add browser-bridge -- node C:/path/to/browser-bridge-mcp/packages/server/dist/index.js
```

```json
{
  "mcpServers": {
    "browser-bridge": {
      "command": "node",
      "args": ["C:/path/to/browser-bridge-mcp/packages/server/dist/index.js"]
    }
  }
}
```

The first client starts the shared daemon if it is not running. Later clients join the same daemon and the same connected tab.

## Daemon

| command | effect |
| --- | --- |
| `node dist/index.js` | MCP stdio proxy; starts the daemon if needed |
| `node dist/index.js --stop` | stop the shared daemon |
| `node dist/index.js --daemon` | run the daemon in the foreground (used by the auto-start path) |
| `GET http://127.0.0.1:8787/health` | `{ service, version, pid, extensionConnected, clients }` |

- Port: `BROWSER_BRIDGE_PORT`, default `8787`. The shipped extension is compiled for 8787; another port also needs an extension rebuild with the same value.
- Log: `<temp>/browser-bridge/daemon.log`.
- Idle exit: after 30 minutes with no clients and no extension connection.
- A stdio client exiting leaves the daemon and other clients running.

## Protocol

`/extension` accepts only a `chrome-extension://<id>` Origin. `/mcp-client` rejects any request with an `Origin` header, so browser pages cannot connect. Messages are zod-parsed; hellos must arrive within 2 seconds; calls default to a 30-second deadline.

There is no password or pairing code. The security boundary is the OS user, the loopback bind, the extension Origin allowlist, and one extension session at a time. Any local program that can reach the port can act as an MCP client.

## Tools

`navigate`, `go_back`, `go_forward`, `snapshot`, `click`, `type`, `hover`, `select_option`, `press_key`, `wait`, `get_console_logs`, `screenshot`, `drag`.

Tool errors are returned to the client as `CODE: message`; they are never thrown across the WebSocket.

## Develop

```bash
npm run typecheck --workspace browser-bridge-mcp
npm test
npm run e2e
```

The package is not published to npm (`private: true`). `npm run pack:server` checks what would ship.
