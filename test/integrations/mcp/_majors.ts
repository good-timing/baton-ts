/**
 * Both official SDK majors behind one shape, for tests that must hold on each.
 * `@modelcontextprotocol/sdk` 1.x and `@modelcontextprotocol/server` 2.x build
 * servers, register tools and connect clients differently; this is the
 * smallest surface that lets one test body drive either.
 */

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

export interface Major {
  label: string;
  /** `eagerTools` declares the tools capability at construction, which on v2
   * makes the SDK install its `tools/list` handler before any tool exists. */
  make(options?: { eagerTools?: boolean }): any;
  tool(
    server: any,
    name: string,
    shape: Record<string, z.ZodType>,
    handler: (args: any) => unknown,
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
  tool: (server, name, shape, handler) => {
    server.registerTool(name, { inputSchema: shape }, handler);
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
  tool: (server, name, shape, handler) => {
    server.registerTool(name, { inputSchema: z.object(shape) }, handler);
  },
  connect: async (server) => {
    const [clientTransport, serverTransport] = TransportV2.createLinkedPair();
    const client = new ClientV2({ name: "test-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  },
};

export const MAJORS: Major[] = [V1, V2];
