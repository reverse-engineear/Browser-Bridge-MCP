import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {
  isAutomatableUrl,
  validateToolArgs,
  type ToolArgsMap,
  type ToolName,
  type ToolResultDataMap,
} from '@browser-bridge/protocol';
import { BridgeToolError } from './errors.js';
import {
  TOOL_DEFINITIONS,
  formatToolError,
  formatToolResult,
  type McpToolResult,
} from './tools.js';

export interface BrowserBridge {
  callTool<K extends ToolName>(name: K, args: ToolArgsMap[K]): Promise<ToolResultDataMap[K]>;
}

export interface McpServerOptions {
  bridge: BrowserBridge;
  version: string;
  browserName: string;
  log: (message: string) => void;
}

const KNOWN_TOOLS = new Set<string>(TOOL_DEFINITIONS.map((tool) => tool.name));

export function createMcpServer(options: McpServerOptions): Server {
  const { bridge, version, browserName, log } = options;

  const server = new Server(
    { name: 'browser-bridge', version },
    {
      capabilities: { tools: {} },
      instructions: [
        `Use these tools to operate the tab the user connected in ${browserName}.`,
        'Start with snapshot: it returns refs such as s1e42 for clickable and typable elements.',
        'Refs expire when the page navigates. Take a fresh snapshot after any navigation or submit.',
        'The bridge can be shared by several assistants. Another one may have changed the page, so snapshot again if the state is uncertain.',
        'The user can see every action in their own browser, so act only on the connected tab.',
      ].join(' '),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS as unknown as Tool[],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<McpToolResult> => {
    const { name, arguments: rawArgs } = request.params;

    if (!KNOWN_TOOLS.has(name)) {
      return formatToolError('BAD_REQUEST', `Unknown tool "${name}".`);
    }

    const toolName = name as ToolName;
    const validated = validateToolArgs(toolName, rawArgs ?? {});
    if (!validated.ok) {
      return formatToolError('BAD_REQUEST', validated.message);
    }

    if (toolName === 'navigate') {
      const navigateArgs = validated.args as ToolArgsMap['navigate'];
      const guard = isAutomatableUrl(navigateArgs.url);
      if (!guard.ok) {
        return formatToolError('NOT_AUTOMATABLE', guard.reason);
      }
    }

    try {
      const data = await bridge.callTool(toolName, validated.args as ToolArgsMap[ToolName]);
      return formatToolResult(toolName, data as ToolResultDataMap[ToolName]);
    } catch (error) {
      if (error instanceof BridgeToolError) {
        log(`Tool ${toolName} failed: ${error.code} - ${error.message}`);
        return formatToolError(error.code, error.message);
      }
      const message = error instanceof Error ? error.message : String(error);
      log(`Tool ${toolName} failed unexpectedly: ${message}`);
      return formatToolError('INTERNAL', `The extension could not complete this call: ${message}`);
    }
  });

  return server;
}
