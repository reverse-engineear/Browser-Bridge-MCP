import { zodToJsonSchema } from 'zod-to-json-schema';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  ToolArgsSchemas,
  type ConsoleEntry,
  type ErrorCode,
  type NetworkEntry,
  type ToolName,
  type ToolResultDataMap,
} from '@browser-bridge/protocol';

type JsonSchema = Record<string, unknown>;

export interface McpToolDefinition {
  name: ToolName;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: Record<string, unknown>;
}

interface ToolCopy {
  name: ToolName;
  title: string;
  description: string;
  annotations?: Record<string, unknown>;
}

const TOOL_COPY: ToolCopy[] = [
  {
    name: 'navigate',
    title: 'Navigate',
    description:
      'Open an http or https URL in the connected tab. Waits for the page load before returning. Only the user-selected tab moves.',
  },
  {
    name: 'go_back',
    title: 'Go back',
    description: 'Move the connected tab back one entry in its browsing history.',
  },
  {
    name: 'go_forward',
    title: 'Go forward',
    description: 'Move the connected tab forward one entry in its browsing history.',
  },
  {
    name: 'snapshot',
    title: 'Snapshot the page',
    description:
      'Return a text map of the page. Interactive nodes carry a ref for click, type, hover, select_option and drag. Refs stay valid until the page navigates, so take a new snapshot after the page changes.',
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'click',
    title: 'Click',
    description:
      'Click an element from the latest snapshot with a trusted mouse event. Scrolling, overlays and pointer coordinates are handled for you.',
  },
  {
    name: 'type',
    title: 'Type text',
    description:
      'Focus an element from the latest snapshot and insert text. Existing text in a form field is selected first. Set submit to true to press Enter afterwards.',
  },
  {
    name: 'hover',
    title: 'Hover',
    description: 'Move the pointer over an element from the latest snapshot.',
  },
  {
    name: 'select_option',
    title: 'Select an option',
    description: 'Choose one or more values in a native select element from the latest snapshot.',
  },
  {
    name: 'press_key',
    title: 'Press a key',
    description:
      'Send a key or chord to the connected tab. Examples: Enter, Tab, Escape, ArrowDown, Control+A.',
  },
  {
    name: 'wait',
    title: 'Wait',
    description: 'Pause for up to 30 seconds so the page can settle.',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_console_logs',
    title: 'Read console logs',
    description:
      'Return the console entries buffered for this tab. The latest 1,000 entries are kept and the buffer survives page navigation.',
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'get_network_requests',
    title: 'Read network requests',
    description:
      'Return metadata for requests the connected tab made since it connected: method, URL, resource type, status, duration, encoded size, cache or service-worker use, redirects and failures. Request and response headers, cookies and bodies are never recorded. Returns the latest 100 entries by default; pass limit, a case-insensitive urlContains filter, or a resourceType such as XHR or Fetch to narrow the result. Full URLs can contain sensitive query values.',
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'clear_network_requests',
    title: 'Clear captured requests',
    description:
      'Discard every buffered network request for the connected tab and report how many entries were removed. Capture resumes immediately. Use it right before reproducing an action so the next read contains only that action.',
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  {
    name: 'screenshot',
    title: 'Screenshot',
    description: 'Capture a PNG of the visible part of the connected tab.',
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'drag',
    title: 'Drag between elements',
    description:
      'Press the pointer on one snapshot element, move to a second element, then release. Works with pointer-driven interfaces; native file drags are not supported.',
  },
];

export const TOOL_DEFINITIONS: McpToolDefinition[] = TOOL_COPY.map((tool) => ({
  name: tool.name,
  title: tool.title,
  description: tool.description,
  inputSchema: zodToJsonSchema(ToolArgsSchemas[tool.name], {
    target: 'jsonSchema7',
    $refStrategy: 'none',
  }) as JsonSchema,
  ...(tool.annotations ? { annotations: tool.annotations } : {}),
}));

export type McpToolResult = CallToolResult;

function text(value: string): McpToolResult {
  return { content: [{ type: 'text', text: value }] };
}

function clockTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('en-GB', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatConsoleEntry(entry: ConsoleEntry): string {
  const level = entry.type.padEnd(5);
  const source = entry.source ? `  (${entry.source})` : '';
  return `${clockTime(entry.timestamp)}  ${level}  ${entry.text}${source}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} kB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return '-';
  return durationMs < 1_000 ? `${durationMs} ms` : `${(durationMs / 1_000).toFixed(1)} s`;
}

function formatNetworkEntry(entry: NetworkEntry): string {
  const method = entry.method.padEnd(7);
  const status = entry.failed ? 'FAILED' : entry.status === null ? 'pending' : String(entry.status);
  const statusLabel = status.padEnd(7);
  const type = entry.resourceType.padEnd(12);
  const duration = formatDuration(entry.durationMs);
  const size = entry.sizeBytes === null ? '-' : formatBytes(entry.sizeBytes);
  const flags: string[] = [];
  if (entry.redirects) flags.push(`${entry.redirects} redirect${entry.redirects === 1 ? '' : 's'}`);
  if (entry.fromCache) flags.push('cache');
  if (entry.fromServiceWorker) flags.push('service worker');
  const extras = flags.length ? `  [${flags.join(', ')}]` : '';
  const failure = entry.errorText ? `\n  error: ${entry.errorText}` : '';
  return `${clockTime(entry.startedAt)}  ${method}  ${statusLabel}  ${type}  ${duration}  ${size}  ${entry.url}${extras}${failure}`;
}

export function formatToolResult<K extends ToolName>(
  name: K,
  data: ToolResultDataMap[K],
): McpToolResult {
  switch (name) {
    case 'navigate': {
      const page = data as ToolResultDataMap['navigate'];
      return text(`${page.title || 'Untitled page'}\n${page.url}`);
    }
    case 'go_back': {
      const page = data as ToolResultDataMap['go_back'];
      return text(`Went back to ${page.title || 'an untitled page'}.\n${page.url}`);
    }
    case 'go_forward': {
      const page = data as ToolResultDataMap['go_forward'];
      return text(`Went forward to ${page.title || 'an untitled page'}.\n${page.url}`);
    }
    case 'snapshot': {
      const snapshot = data as ToolResultDataMap['snapshot'];
      if (!snapshot.text.trim()) {
        return text('The page did not expose any accessible content.');
      }
      return text(snapshot.text);
    }
    case 'click':
      return text('Clicked the element.');
    case 'type':
      return text('Typed the text.');
    case 'hover':
      return text('Moved the pointer over the element.');
    case 'select_option': {
      const selection = data as ToolResultDataMap['select_option'];
      return text(selection.values.length ? `Selected: ${selection.values.join(', ')}.` : 'Cleared the selection.');
    }
    case 'press_key':
      return text('Pressed the key.');
    case 'wait':
      return text('Wait finished.');
    case 'get_console_logs': {
      const logs = data as ToolResultDataMap['get_console_logs'];
      if (logs.entries.length === 0) return text('No console messages yet.');
      const lines = logs.entries.map(formatConsoleEntry);
      if (logs.dropped > 0) {
        lines.unshift(`[buffer] ${logs.dropped} older entries were dropped.`);
      }
      return text(lines.join('\n'));
    }
    case 'get_network_requests': {
      const network = data as ToolResultDataMap['get_network_requests'];
      if (network.entries.length === 0) {
        return text(
          network.total === 0
            ? 'No network requests captured yet. Requests are recorded from the moment this tab connects.'
            : 'No captured requests match those filters.',
        );
      }
      const lines = network.entries.map(formatNetworkEntry);
      if (network.dropped > 0) {
        lines.unshift(`[buffer] ${network.dropped} older requests were dropped.`);
      }
      return text(lines.join('\n'));
    }
    case 'clear_network_requests': {
      const cleared = data as ToolResultDataMap['clear_network_requests'];
      if (cleared.cleared === 0) return text('The network capture was already empty.');
      return text(
        `Cleared ${cleared.cleared} captured request${cleared.cleared === 1 ? '' : 's'}. Capture is running again.`,
      );
    }
    case 'screenshot': {
      const shot = data as ToolResultDataMap['screenshot'];
      return {
        content: [
          { type: 'image', data: shot.base64, mimeType: shot.mimeType },
          { type: 'text', text: `Screenshot: ${shot.width} x ${shot.height}px.` },
        ],
      };
    }
    case 'drag':
      return text('Dragged from the first element to the second.');
    default:
      return text('Done.');
  }
}

export function formatToolError(code: ErrorCode, message: string): McpToolResult {
  return {
    content: [{ type: 'text', text: `${code}: ${message}` }],
    isError: true,
  };
}
