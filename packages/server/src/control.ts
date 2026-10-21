import { z } from 'zod';
import {
  BridgeErrorSchema,
  PROTOCOL_VERSION,
  TabInfoSchema,
  ToolNameSchema,
} from '@browser-bridge/protocol';

export const CLIENT_HELLO_TIMEOUT_MS = 2_000;
export const BRIDGE_SERVICE = 'browser-bridge';

export const ClientHelloSchema = z
  .object({
    type: z.literal('client_hello'),
    v: z.literal(PROTOCOL_VERSION),
  })
  .strict();

export const ClientCallSchema = z
  .object({
    type: z.literal('client_call'),
    v: z.literal(PROTOCOL_VERSION),
    id: z.string().uuid(),
    name: ToolNameSchema,
    args: z.record(z.unknown()),
  })
  .strict();

export const ClientMessageSchema = z.union([ClientHelloSchema, ClientCallSchema]);

export const ClientReadySchema = z
  .object({
    type: z.literal('client_ready'),
    v: z.literal(PROTOCOL_VERSION),
    serverVersion: z.string().min(1).max(32),
    connected: z.boolean(),
    tab: TabInfoSchema.optional(),
  })
  .strict();

export const ClientResultSchema = z
  .object({
    type: z.literal('client_result'),
    v: z.literal(PROTOCOL_VERSION),
    id: z.string().uuid(),
    ok: z.boolean(),
    data: z.unknown().optional(),
    error: BridgeErrorSchema.optional(),
  })
  .strict();

export const ClientStateSchema = z
  .object({
    type: z.literal('client_state'),
    v: z.literal(PROTOCOL_VERSION),
    connected: z.boolean(),
    tab: TabInfoSchema.optional(),
  })
  .strict();

export const ClientServerMessageSchema = z.discriminatedUnion('type', [
  ClientReadySchema,
  ClientResultSchema,
  ClientStateSchema,
]);

export const HealthSchema = z
  .object({
    service: z.literal(BRIDGE_SERVICE),
    version: z.string().min(1).max(32),
    pid: z.number().int().positive(),
    extensionConnected: z.boolean(),
    clients: z.number().int().nonnegative(),
  })
  .strict();

export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type ClientReady = z.infer<typeof ClientReadySchema>;
export type ClientResult = z.infer<typeof ClientResultSchema>;
export type ClientState = z.infer<typeof ClientStateSchema>;
export type ClientServerMessage = z.infer<typeof ClientServerMessageSchema>;
export type Health = z.infer<typeof HealthSchema>;
