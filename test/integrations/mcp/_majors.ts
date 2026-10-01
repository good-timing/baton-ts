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

/* eslint-disable @typescript-eslint/no-explicit-any */

export class CapturingSink implements Sink {
  readonly events: Event[] = [];
  async write(event: Event): Promise<void> {
    this.events.push(event);
  }
  async flush(): Promise<void> {}
  async aclose(): Promise<void> {}
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
  connect(server: any): Promise<any>;
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
  connect: async (server) => {
    const [clientTransport, serverTransport] = TransportV1.createLinkedPair();
    const client = new ClientV1({ name: "test-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
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
  connect: async (server) => {
    const [clientTransport, serverTransport] = TransportV2.createLinkedPair();
    const client = new ClientV2({ name: "test-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  },
};

export const MAJORS: Major[] = [V1, V2];
