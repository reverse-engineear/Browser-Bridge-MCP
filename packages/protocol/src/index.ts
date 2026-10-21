import { z } from 'zod';

export const PROTOCOL_VERSION = 1 as const;
export const DEFAULT_PORT = 8787;
export const DEFAULT_DEADLINE_MS = 30_000;
export const HELLO_TIMEOUT_MS = 2_000;
export const HEARTBEAT_INTERVAL_MS = 20_000;
export const HEARTBEAT_TIMEOUT_MS = 45_000;
export const MAX_SNAPSHOT_NODES = 4_000;
export const MAX_SNAPSHOT_BYTES = 256 * 1024;
export const MAX_CONSOLE_ENTRIES = 1_000;
export const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
export const MAX_WS_PAYLOAD = 32 * 1024 * 1024;

export const WS_CLOSE_CODES = {
  SESSION_BUSY: 4002,
  BAD_MESSAGE: 4003,
  ORIGIN_REJECTED: 4004,
} as const;

export const ERROR_CODES = [
  'NOT_CONNECTED',
  'TAB_CLOSED',
  'NOT_AUTOMATABLE',
  'REF_NOT_FOUND',
  'REF_STALE',
  'NAVIGATION_TIMEOUT',
  'DETACHED',
  'TIMEOUT',
  'BAD_REQUEST',
  'SESSION_BUSY',
  'SERVER_UNREACHABLE',
  'ATTACH_FAILED',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const BridgeErrorSchema = z
  .object({
    code: z.enum(ERROR_CODES),
    message: z.string().min(1).max(2_000),
  })
  .strict();

export type BridgeError = z.infer<typeof BridgeErrorSchema>;

export const TabInfoSchema = z
  .object({
    id: z.number().int().nonnegative(),
    windowId: z.number().int().nonnegative(),
    url: z.string().max(4_096),
    title: z.string().max(2_048),
  })
  .strict();

export type TabInfo = z.infer<typeof TabInfoSchema>;

export const RefSchema = z
  .string()
  .min(4)
  .max(64)
  .regex(/^s\d+e\d+$/, 'Expected an element ref from a snapshot');

export const TOOL_NAMES = [
  'navigate',
  'go_back',
  'go_forward',
  'snapshot',
  'click',
  'type',
  'hover',
  'select_option',
  'press_key',
  'wait',
  'get_console_logs',
  'screenshot',
  'drag',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export const ToolNameSchema = z.enum(TOOL_NAMES);

const noArgs = z.object({}).strict();

export const ToolArgsSchemas = {
  navigate: z
    .object({
      url: z
        .string()
        .url()
        .max(2_048)
        .refine((value) => /^https?:\/\//i.test(value), 'Only http and https URLs are supported'),
    })
    .strict(),
  go_back: noArgs,
  go_forward: noArgs,
  snapshot: noArgs,
  click: z.object({ ref: RefSchema }).strict(),
  type: z
    .object({
      ref: RefSchema,
      text: z.string().max(10_000),
      submit: z.boolean().optional(),
    })
    .strict(),
  hover: z.object({ ref: RefSchema }).strict(),
  select_option: z
    .object({
      ref: RefSchema,
      values: z.array(z.string().max(1_000)).min(1).max(50),
    })
    .strict(),
  press_key: z.object({ key: z.string().min(1).max(64) }).strict(),
  wait: z.object({ seconds: z.number().finite().min(0).max(30) }).strict(),
  get_console_logs: noArgs,
  screenshot: noArgs,
  drag: z.object({ fromRef: RefSchema, toRef: RefSchema }).strict(),
} as const;

export type ToolArgsMap = {
  [K in ToolName]: z.infer<(typeof ToolArgsSchemas)[K]>;
};

export type ToolArgs = ToolArgsMap[ToolName];

export function validateToolArgs(name: ToolName, args: unknown):
  | { ok: true; args: ToolArgs }
  | { ok: false; message: string } {
  const parsed = ToolArgsSchemas[name].safeParse(args);
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues.map((issue) => issue.message).join('; '),
    };
  }
  return { ok: true, args: parsed.data as ToolArgs };
}

export const HelloSchema = z
  .object({
    type: z.literal('hello'),
    v: z.literal(PROTOCOL_VERSION),
    extensionVersion: z.string().min(1).max(32),
    tab: TabInfoSchema,
  })
  .strict();

export const HelloAckSchema = z
  .object({
    type: z.literal('hello_ack'),
    v: z.literal(PROTOCOL_VERSION),
    sessionId: z.string().uuid(),
    serverVersion: z.string().min(1).max(32),
  })
  .strict();

export const ToolCallSchema = z
  .object({
    type: z.literal('tool_call'),
    v: z.literal(PROTOCOL_VERSION),
    id: z.string().uuid(),
    name: ToolNameSchema,
    args: z.record(z.unknown()),
    deadlineMs: z.number().int().min(500).max(120_000),
  })
  .strict();

export const PingSchema = z
  .object({
    type: z.literal('ping'),
    v: z.literal(PROTOCOL_VERSION),
    t: z.number().finite(),
  })
  .strict();

export const PongSchema = z
  .object({
    type: z.literal('pong'),
    v: z.literal(PROTOCOL_VERSION),
    t: z.number().finite(),
  })
  .strict();

export const EventSchema = z
  .object({
    type: z.literal('event'),
    v: z.literal(PROTOCOL_VERSION),
    kind: z.enum(['tab_updated', 'page_committed', 'detached']),
    tab: TabInfoSchema.optional(),
    reason: z.string().max(2_000).optional(),
  })
  .strict();

export const ToolResultSchema = z
  .object({
    type: z.literal('tool_result'),
    v: z.literal(PROTOCOL_VERSION),
    id: z.string().uuid(),
    ok: z.boolean(),
    data: z.unknown().optional(),
    error: BridgeErrorSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.ok && value.error) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A successful result cannot carry an error' });
    }
    if (!value.ok && !value.error) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A failed result must carry an error' });
    }
  });

export const ClientMessageSchema = z.union([
  HelloSchema,
  ToolResultSchema,
  EventSchema,
  PingSchema,
  PongSchema,
]);

export const ServerMessageSchema = z.discriminatedUnion('type', [
  HelloAckSchema,
  ToolCallSchema,
  PingSchema,
  PongSchema,
]);

export type Hello = z.infer<typeof HelloSchema>;
export type HelloAck = z.infer<typeof HelloAckSchema>;
export type ToolCall = z.infer<typeof ToolCallSchema>;
export type ToolResult = z.infer<typeof ToolResultSchema>;
export type BridgeEvent = z.infer<typeof EventSchema>;
export type Ping = z.infer<typeof PingSchema>;
export type Pong = z.infer<typeof PongSchema>;
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

export const NavigateDataSchema = z
  .object({
    url: z.string().max(4_096),
    title: z.string().max(2_048),
  })
  .strict();

export const SnapshotDataSchema = z
  .object({
    text: z.string().max(MAX_SNAPSHOT_BYTES + 4_000),
    nodes: z.number().int().nonnegative(),
    truncated: z.boolean(),
    snapshotId: z.number().int().nonnegative(),
  })
  .strict();

export const OkDataSchema = z.object({ ok: z.literal(true) }).strict();

export const SelectDataSchema = z
  .object({
    ok: z.literal(true),
    values: z.array(z.string().max(1_000)).max(50),
  })
  .strict();

export const ConsoleEntrySchema = z
  .object({
    type: z.string().min(1).max(24),
    text: z.string().max(8_000),
    timestamp: z.number().finite(),
    source: z.string().max(2_048).optional(),
  })
  .strict();

export type ConsoleEntry = z.infer<typeof ConsoleEntrySchema>;

export const ConsoleDataSchema = z
  .object({
    entries: z.array(ConsoleEntrySchema).max(MAX_CONSOLE_ENTRIES),
    total: z.number().int().nonnegative(),
    dropped: z.number().int().nonnegative(),
  })
  .strict();

export const ScreenshotDataSchema = z
  .object({
    base64: z.string().max(MAX_SCREENSHOT_BYTES * 2),
    mimeType: z.literal('image/png'),
    width: z.number().int().nonnegative(),
    height: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
  })
  .strict();

export const ToolResultDataSchemas = {
  navigate: NavigateDataSchema,
  go_back: NavigateDataSchema,
  go_forward: NavigateDataSchema,
  snapshot: SnapshotDataSchema,
  click: OkDataSchema,
  type: OkDataSchema,
  hover: OkDataSchema,
  select_option: SelectDataSchema,
  press_key: OkDataSchema,
  wait: OkDataSchema,
  get_console_logs: ConsoleDataSchema,
  screenshot: ScreenshotDataSchema,
  drag: OkDataSchema,
} as const;

export type ToolResultDataMap = {
  [K in ToolName]: z.infer<(typeof ToolResultDataSchemas)[K]>;
};

export function isAutomatableUrl(rawUrl: string): { ok: true } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'This tab does not have a web address yet.' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'Chrome does not allow automation on this page.' };
  }

  const host = url.hostname.toLowerCase();
  const restrictedHosts = [
    'chromewebstore.google.com',
    'chrome.google.com',
    'microsoftedge.microsoft.com',
  ];
  if (restrictedHosts.includes(host)) {
    return { ok: false, reason: 'Chrome does not allow automation on extension store pages.' };
  }

  if (/\.pdf$/i.test(url.pathname)) {
    return { ok: false, reason: 'Chrome does not allow automation on PDF pages.' };
  }

  return { ok: true };
}

export function makeRef(snapshotId: number, backendNodeId: number): string {
  return `s${snapshotId}e${backendNodeId}`;
}

export function parseRef(ref: string): { snapshotId: number; backendNodeId: number } | null {
  const match = /^s(\d+)e(\d+)$/.exec(ref);
  if (!match) return null;
  const snapshotId = Number(match[1]);
  const backendNodeId = Number(match[2]);
  if (!Number.isSafeInteger(snapshotId) || !Number.isSafeInteger(backendNodeId)) return null;
  return { snapshotId, backendNodeId };
}
