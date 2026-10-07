/**
 * Both official SDK majors behind one shape, for tests that must hold on each.
 * `@modelcontextprotocol/sdk` 1.x and `@modelcontextprotocol/server` 2.x build
 * servers, register tools and connect clients differently; this is the
 * smallest surface that lets one test body drive either.
 */

import { expect } from "vitest";
import { McpServer as McpServerV1 } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client as ClientV1 } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport as TransportV1 } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  McpServer as McpServerV2,
  InMemoryTransport as TransportV2,
} from "@modelcontextprotocol/server";
import { Client as ClientV2 } from "@modelcontextprotocol/client";
import { z } from "zod";

import type { Event } from "../../../src/events.js";
import type { Sink } from "../../../src/sinks.js";
import { withBaton } from "../../../src/integrations/mcp/withBaton.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

export class CapturingSink implements Sink {
  readonly events: Event[] = [];
  closed = false;
  async write(event: Event): Promise<void> {
    this.events.push(event);
  }
  async flush(): Promise<void> {}
  async aclose(): Promise<void> {
    this.closed = true;
  }
}

/** The terminal event of the (single) call, with its type pinned FIRST — and
 * narrowed to it, so a caller reads the payload without restating the literal
 * in a hand-written guard.
 *
 * ⚠ Pinning the type before reading a body is load-bearing, not tidiness.
 * Taken off "whichever terminal event was emitted", body assertions pass
 * against the OLD behaviour too — the returned error flag was already inside
 * `tool_call_end.result` before it was reclassified. That is the Python
 * change's recorded lesson.
 *
 * Shared because two test files had grown byte-identical copies, and the
 * second one dropped this paragraph. */
export function terminal<T extends Event["event_type"]>(
  sink: CapturingSink,
  expected: T,
): Extract<Event, { event_type: T }> {
  const event = sink.events[sink.events.length - 1]!;
  expect(event.event_type).toBe(expected);
  return event as Extract<Event, { event_type: T }>;
}

export interface Major {
  label: string;
  /** `eagerTools` declares the tools capability at construction, which on v2
   * makes the SDK install its `tools/list` handler before any tool exists. */
  make(options?: { eagerTools?: boolean }): any;
  /** `outputSchema` takes the same per-major shape rule as `inputSchema`,
   * which is the whole reason it belongs here rather than in a caller: a test
   * that re-derived the rule would have to branch on something, and the only
   * thing to branch on is `label` — a string whose job is rendering
   * `describe.each` titles. */
  tool(
    server: any,
    name: string,
    shape: Record<string, z.ZodType>,
    handler: (args: any) => unknown,
    outputShape?: Record<string, z.ZodType>,
  ): void;
  /** `authInfo`, when given, rides every request the client sends — the
   * in-memory transports of BOTH majors accept it on `send` and deliver it
   * where a real bearer-auth middleware would, so a test can drive an
   * authenticated call without standing up an OAuth server. */
  connect(server: any, options?: { authInfo?: unknown }): Promise<any>;
  /** Register a static resource. The two majors agree here, which is itself
   * worth keeping in ONE place: a future divergence lands on the interface
   * rather than in whichever test noticed. */
  resource(server: any, name: string, uri: string, read: () => unknown): void;
  /** Register a prompt. ⚠ `argsSchema` takes the same raw-shape-vs-`z.object`
   * rule as `inputSchema` above, and for the same reason it belongs here: a
   * caller re-deriving it would have to branch on `label`, a string whose job
   * is rendering `describe.each` titles. */
  prompt(server: any, name: string, args: Record<string, z.ZodType>, get: () => unknown): void;
}

/** The three `BatonConfig` members every test in this directory supplies.
 *
 * Shared for the reason `terminal` below is: four files had grown the same
 * literal, and a new required member — or a default worth pinning — then has
 * to be found in all four. */
export const CFG = { vendorId: "acme", vendorDisplayName: "Acme", consentToken: "ct" } as const;

/** `withBaton` with this directory's standard config. `extra` is for the one
 * thing a case is actually varying (`resultCaptureMode`, a `scrubber`, a
 * `resolvePrincipal`) — without it a case that needs one option forks the whole
 * helper, which is what happened before this existed. */
export function install(
  server: unknown,
  sink: CapturingSink,
  extra: Partial<Parameters<typeof withBaton>[1]> = {},
): ReturnType<typeof withBaton> {
  return withBaton(server as never, { ...CFG, sink, ...extra });
}

/** Make every message `transport` sends carry `authInfo`. */
function withAuthInfo(transport: any, authInfo: unknown): void {
  if (authInfo === undefined) return;
  const send = transport.send.bind(transport) as (m: unknown, o: object) => Promise<void>;
  transport.send = (message: unknown, opts?: Record<string, unknown>): Promise<void> =>
    send(message, { ...opts, authInfo });
}

const V1: Major = {
  label: "@modelcontextprotocol/sdk 1.x",
  make: (options) =>
    new McpServerV1(
      { name: "vendor", version: "1.0.0" },
      options?.eagerTools ? { capabilities: { tools: {} } } : undefined,
    ),
  tool: (server, name, shape, handler, outputShape) => {
    server.registerTool(
      name,
      outputShape ? { inputSchema: shape, outputSchema: outputShape } : { inputSchema: shape },
      handler,
    );
  },
  connect: async (server, options) => {
    const [clientTransport, serverTransport] = TransportV1.createLinkedPair();
    withAuthInfo(clientTransport, options?.authInfo);
    const client = new ClientV1({ name: "test-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  },
  resource: (server, name, uri, read) => {
    server.registerResource(name, uri, {}, read);
  },
  prompt: (server, name, args, get) => {
    server.registerPrompt(name, { argsSchema: args }, get);
  },
};

const V2: Major = {
  label: "@modelcontextprotocol/server 2.x",
  make: (options) =>
    new McpServerV2(
      { name: "vendor", version: "1.0.0" },
      options?.eagerTools ? { capabilities: { tools: {} } } : undefined,
    ),
  tool: (server, name, shape, handler, outputShape) => {
    server.registerTool(
      name,
      outputShape
        ? { inputSchema: z.object(shape), outputSchema: z.object(outputShape) }
        : { inputSchema: z.object(shape) },
      handler,
    );
  },
  connect: async (server, options) => {
    const [clientTransport, serverTransport] = TransportV2.createLinkedPair();
    withAuthInfo(clientTransport, options?.authInfo);
    const client = new ClientV2({ name: "test-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  },
  resource: (server, name, uri, read) => {
    server.registerResource(name, uri, {}, read);
  },
  prompt: (server, name, args, get) => {
    server.registerPrompt(name, { argsSchema: z.object(args) }, get);
  },
};

export const MAJORS: Major[] = [V1, V2];
