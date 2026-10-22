# Browser Bridge MCP

Give any local MCP client control of one Chrome tab.

Browser Bridge MCP is a portable, local-only bridge: an MV3 Chrome extension, a shared loopback daemon, and a stdio MCP server. There is no account, no cloud service, no database, and no pairing code. The browser stays on your machine, in your own profile, with your existing sessions.

```
MCP client A ─ stdio ─┐
MCP client B ─ stdio ─┼─ ws://127.0.0.1:8787/mcp-client ─ shared bridge ─ /extension ─ Chrome tab
MCP client C ─ stdio ─┘                                GET /health
```

The first MCP client starts a detached bridge. Later clients join the same bridge, so several assistants can share one tab instead of fighting over the port. Stopping one client does not stop the bridge.

## Requirements

- Node.js 20 or newer
- Google Chrome 116 or newer
- npm, which ships with Node.js

The server is plain Node.js and runs on Windows, macOS, and Linux. The browser side is Chrome-only.

## Portable quick start

This repository is the portable source: everything needed is here, with no prebuilt binaries committed. Build it once on each machine that will run it.

1. **Get the source.** Clone the repository or unzip a source download, then open a terminal in the project root:

   ```bash
   git clone https://github.com/reverse-engineear/Browser-Bridge-MCP.git
   cd Browser-Bridge-MCP
   npm install
   npm run build
   ```

   `npm ci` works too if you want an exact install from `package-lock.json`.

   The build produces:

   - MCP server: `packages/server/dist/index.js`
   - Extension: `apps/extension/.output/chrome-mv3`

2. **Load the extension.** Open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, and select `apps/extension/.output/chrome-mv3` — the folder that contains `manifest.json`. Pin the extension if you like.

3. **Register the MCP server** with your client. Use the absolute path to the built file; it is not on `PATH` and is not published to npm. See [Add the server to an MCP client](#add-the-server-to-an-mcp-client).

4. **Start your MCP client.** The client launches the stdio server, and the first one starts the shared bridge automatically.

5. **Connect a tab.** Open the page the assistant should use, click the Browser Bridge toolbar icon, and choose **Connect tab**. If a New Tab, `chrome://` or `edge://` page is in front, Browser Bridge replaces that tab with its own local blank page (`http://127.0.0.1:8787/blank`) so it can attach. If the popup says the bridge did not answer, start an MCP client first and then choose **Try again**.

6. **Verify.** Ask the client for a `snapshot`. A tree of the page with element refs such as `s1e42` means the whole path is working.

Loading the extension does not connect a tab. The popup's **Connect tab** button is the switch.

## Add the server to an MCP client

Use the same absolute path in every client. Paths with forward slashes work on Windows too.

Claude Code:

```bash
claude mcp add browser-bridge -- node "C:/Users/you/browser-bridge-mcp/packages/server/dist/index.js"
```

macOS or Linux:

```bash
claude mcp add browser-bridge -- node "/home/you/browser-bridge-mcp/packages/server/dist/index.js"
```

Any JSON-configured client (Claude Desktop, Cursor, VS Code, Codex, Windsurf/Devin, and others):

```json
{
  "mcpServers": {
    "browser-bridge": {
      "command": "node",
      "args": ["C:/Users/you/browser-bridge-mcp/packages/server/dist/index.js"]
    }
  }
}
```

On macOS or Linux, the `args` entry looks like:

```json
"args": ["/home/you/browser-bridge-mcp/packages/server/dist/index.js"]
```

Some clients, such as VS Code, use a `servers` key instead of `mcpServers`. Keep the `command` and `args` the same and put them where that client expects its MCP settings. Restart the client after changing its configuration.

Point the client at `packages/server/dist/index.js` itself, not at the repository folder or the `dist` directory.

## Everyday use

You do not run a Node command every time. Register the server once; your MCP client starts it on demand. All configured clients share the same bridge and the same connected tab.

- Open the target page, then connect it from the toolbar popup.
- The popup shows **Connected** with the tab title and URL.
- Choose **Disconnect** to end the browser session.
- The assistant can only act on that connected tab.
- Refs expire on navigation. Ask for a fresh `snapshot` after a page changes.
- Clicks, typing, hovers and drags show a smooth internal cursor on the page. It fades after a couple of seconds of inactivity. Switch **Agent cursor** off in the popup to hide it; the choice is remembered.

### Shared bridge lifecycle

| Action | What happens |
| --- | --- |
| First MCP client starts | A detached bridge starts on `127.0.0.1:8787` |
| Later MCP clients start | They join the existing bridge |
| One client closes | Other clients and the browser session keep working |
| No clients and no browser session for 30 minutes | The bridge exits by itself |
| `node packages/server/dist/index.js --stop` (from the repo root) | Stops the shared bridge now |

Check the bridge from a terminal:

```bash
curl http://127.0.0.1:8787/health
```

In Windows PowerShell, use `curl.exe` so it calls the real curl instead of the `Invoke-WebRequest` alias. It returns JSON such as:

```json
{"service":"browser-bridge","version":"0.1.0","pid":1234,"extensionConnected":true,"clients":1}
```

The bridge log is in the system temp directory:

- Windows: `%TEMP%\browser-bridge\daemon.log`
- macOS/Linux: `$TMPDIR/browser-bridge/daemon.log` or `/tmp/browser-bridge/daemon.log`

The default port is 8787. The server also reads `BROWSER_BRIDGE_PORT`, but the extension's URL is compiled from `DEFAULT_PORT` in `packages/protocol/src/index.ts`. To move the whole system to another port, change that constant, rebuild, and start the server with the same value.

## Tools

| Tool | Arguments | What it does |
| --- | --- | --- |
| `navigate` | `url` | Load an http/https URL in the connected tab and wait for the page |
| `go_back` / `go_forward` | — | Move through the tab's history |
| `snapshot` | — | Accessibility tree of the page with refs for interactive elements |
| `click` | `ref` | Trusted click on an element from the latest snapshot |
| `type` | `ref`, `text`, `submit?` | Replace the field's text and optionally press Enter |
| `hover` | `ref` | Move the pointer over an element |
| `select_option` | `ref`, `values` | Choose options in a native `<select>` |
| `press_key` | `key` | Send a key or chord such as `Enter` or `Control+A` |
| `wait` | `seconds` | Pause for 0–30 seconds |
| `get_console_logs` | — | Return buffered console entries, up to 1,000 |
| `get_network_requests` | `limit?`, `urlContains?`, `resourceType?` | Recent request metadata: method, URL, status, type, duration and size |
| `clear_network_requests` | — | Discard the buffered requests and report how many were removed |
| `screenshot` | — | Return a PNG of the visible viewport |
| `drag` | `fromRef`, `toRef` | Drag between two elements from the latest snapshot |

Snapshots are capped at 4,000 nodes and 256 KB. Screenshots are capped at 8 MB. Tool errors come back as `CODE: message` without breaking the session.

Network inspection is metadata only. The extension keeps the latest 500 requests for the connected tab; a call returns the latest 100 unless you pass `limit` (1–500), a case-insensitive `urlContains` filter, or a case-insensitive `resourceType` such as `XHR` or `Fetch`. `clear_network_requests` empties the buffer so the agent can start a clean capture. Capture starts when the tab connects and continues across navigation. Request and response headers, cookies, authorization values, and bodies are never recorded. Full URLs are recorded, including their query strings, so treat the output as sensitive when a site puts tokens in a URL.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `npm run build` fails | Check `node --version`; Node 20 or newer is required |
| Chrome says the extension folder is invalid | Build first, then select `apps/extension/.output/chrome-mv3`, which must contain `manifest.json` |
| Popup says the bridge did not answer | Start an MCP client that has the server configured, then choose **Try again** |
| Popup says another session is already connected | Disconnect the other Browser Bridge tab session, then connect this tab |
| `NOT_CONNECTED` | Connect a tab from the popup |
| `REF_STALE` or `REF_NOT_FOUND` | The page changed; take a new `snapshot` before acting |
| `NOT_AUTOMATABLE` | The page is restricted; see [Limits](#limits) |
| Port 8787 is already in use | Stop whatever owns it, or stop an old bridge with `--stop`. A different port needs the change described above |
| Chrome stopped debugging the tab | Close DevTools for that tab and connect it again |
| The connected tab was closed | Open the page again and connect the new tab |
| MCP client reports a missing module | Run `npm install && npm run build` and check that the client's absolute path points at `packages/server/dist/index.js` |
| Moved the checkout to another folder | Update the absolute path in every MCP client and reload the unpacked extension; Chrome's unpacked extension ID is derived from its folder path |

If the bridge will not start, read the daemon log. It usually names the port conflict or the startup error.

## Updating a checkout

```bash
git pull
npm install
npm run build
```

Then open `chrome://extensions`, click **Reload** on Browser Bridge, reconnect the tab from the popup, and restart any open MCP client. Your client configuration does not change unless the checkout path changed.

## Security model

- The bridge binds `127.0.0.1` only. It makes no outbound network calls and sends no telemetry.
- `/extension` accepts only a `chrome-extension://<id>` origin.
- `/mcp-client` rejects requests that carry an `Origin` header, so a web page cannot connect.
- One extension session is allowed at a time; a second gets `SESSION_BUSY`.
- There is **no password or pairing code**. Any local program that can reach the port can act as an MCP client, and any extension in this Chrome profile can claim the session. Run only trusted local software.
- The assistant acts in your real browser profile with your logged-in sessions. Every action is visible in the browser.
- The cursor overlay is injected only into the connected tab. It is pointer-transparent, never receives input, contains no page data, and is removed when you switch it off or disconnect.
- Page content, screenshots, console output, and network metadata are processed in memory by the bridge. Your MCP client may send tool results to its model provider; that transfer is between you and the client.
- Network results include full request URLs but never headers, cookies, or bodies. A URL can still carry a token in its query string, so review the output before sharing it.
- Clearing the extension's storage removes its saved tab state.

## Development

```bash
npm test                 # unit tests
npm run typecheck
npm run build
npm run e2e              # headless Chrome, full extension and MCP pass
npm run dev --workspace browser-bridge-extension
npm run icons            # regenerate the extension PNGs
```

The end-to-end test needs a built extension, a free port 8787, and a recent Chrome with the CDP `Extensions.loadUnpacked` command. On Windows it looks for Chrome in the default location; on macOS/Linux, or for a custom install, set `CHROME_PATH`:

```bash
CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm run e2e
```

The test writes screenshots to `replica/clone-screens/`, which is local-only and ignored by git.

Workspace layout:

- `packages/protocol` — zod schemas, tool contracts, shared constants
- `packages/server` — MCP stdio proxy, shared daemon, WebSocket hub
- `apps/extension` — WXT MV3 extension, popup, help page, CDP automation
- `fixtures` — local pages used by the end-to-end test

## Limits

- Chrome only, one tab per session.
- Several clients can interleave actions on the shared tab. There is no global call queue, so agents are instructed to take a fresh snapshot when the page state is uncertain.
- Chrome internal pages (`chrome://`, New Tab, `edge://`, `about:`) cannot be debugged, so Connect switches that tab to the bridge's local blank page. The Chrome Web Store, `file://` pages, PDFs in Chrome's viewer, and extension pages are still refused.
- A tab with DevTools open cannot also be attached by the extension; Chrome allows one debugger per tab.
- Default port 8787. Changing it affects both the server and the compiled extension.
- No store listing, localization, or automatic update channel yet. Update by rebuilding from source and reloading the unpacked extension.
- The extension is not sandboxed from the rest of your browser profile. Connect only pages you are willing to expose to the configured MCP clients.

## License and provenance

Browser Bridge MCP is licensed under the Apache License, Version 2.0. See `LICENSE` and `NOTICE`.

The server and protocol were developed with reference to the public [Browser MCP server repository](https://github.com/browsermcp/mcp), which is Apache-2.0 licensed. The Chrome extension in `apps/extension` is an original clean-room implementation and contains no code, markup, styles, icons, images, or copy from the Browser MCP extension. This project is not affiliated with or endorsed by Browser MCP.
