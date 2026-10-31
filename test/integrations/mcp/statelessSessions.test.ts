/**
 * SPEC §3.4 rung 5 over real stateless HTTP: with no session to read, each
 * request is its own session, numbered by the clock.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { describe, expect, it } from "vitest";

import type { Event } from "../../../src/events.js";
import { createBaton, withBaton } from "../../../src/integrations/mcp/withBaton.js";
import { CapturingSink } from "./_majors.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

const CONFIG = { vendorId: "acme", consentToken: "ct", intentParamMode: "optional" } as const;

function newServer(): McpServer {
  const server = new McpServer({ name: "vendor", version: "1.0.0" });
  server.registerTool("lookup", { inputSchema: { name: z.string() } }, () => ({
    content: [{ type: "text" as const, text: "ok" }],
  }));
  return server;
}

async function serve(
  handle: (req: any, res: any, body: unknown) => Promise<void>,
  calls: number,
): Promise<void> {
  const http = createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      await handle(req, res, JSON.parse(Buffer.concat(chunks).toString()));
    })();
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  try {
    for (let i = 0; i < calls; i += 1) {
      const client = new Client({ name: "caller", version: "1.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${String(port)}/mcp`)) as any,
      );
      await client.callTool({ name: "lookup", arguments: { name: `user-${String(i)}` } });
      await client.close();
    }
  } finally {
    await new Promise((resolve) => http.close(resolve));
  }
}

function assertOneSessionPerCall(events: Event[], calls: number): void {
  const starts = events.filter((e) => e.event_type === "tool_call_start");
  const ends = events.filter((e) => e.event_type === "tool_call_end");
  expect(starts).toHaveLength(calls);
  expect(ends).toHaveLength(calls);
  for (const start of starts) {
    expect(start).toMatchObject({ transport_observed: "http", session_id_origin: "minted" });
    const end = ends.find((e) => e.call_id === start.call_id)!;
    expect(end.session_id).toBe(start.session_id);
    // Clock-numbered (microseconds), not a per-session counter restarting at 1.
    expect(start.sequence_number).toBeGreaterThan(1e15);
    expect(end.sequence_number).toBeGreaterThan(start.sequence_number);
  }
  expect(new Set(starts.map((e) => e.session_id)).size).toBe(calls);
}

describe("stateless HTTP: one session per request (SPEC §3.4 rung 5)", () => {
  it("withBaton on one long-lived server never puts two callers in one session", async () => {
    const sink = new CapturingSink();
    const server = newServer();
    withBaton(server, { ...CONFIG, sink });

    // The SDK refuses to reuse a stateless transport, so the one server takes a
    // fresh one per request. The requests are sequential, so this is safe.
    await serve(async (req, res, body) => {
      await server.close();
      const transport = new StreamableHTTPServerTransport({});
      await server.connect(transport as any);
      await transport.handleRequest(req, res, body);
    }, 2);

    assertOneSessionPerCall(sink.events, 2);
  });

  it("createBaton numbers each request's session by the clock", async () => {
    const sink = new CapturingSink();
    const baton = createBaton({ ...CONFIG, sink });

    await serve(async (req, res, body) => {
      const server = newServer();
      baton.wrap(server);
      const transport = new StreamableHTTPServerTransport({});
      res.on("close", () => void transport.close());
      await server.connect(transport as any);
      await transport.handleRequest(req, res, body);
    }, 2);

    assertOneSessionPerCall(sink.events, 2);
  });
});
