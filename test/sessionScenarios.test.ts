/**
 * Session ids against `baton-spec`'s fake collector, in every scenario of
 * `collector/sessions.json`; what each checks is the file's `about`. One
 * `withBaton` server serves every client, so the install's own session id is
 * there to be wrongly shared. Skipped where `python3` is missing, which the
 * collector needs.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { describe, expect, it } from "vitest";
import type { Event } from "../src/events.js";
import { withBaton } from "../src/integrations/mcp/withBaton.js";
import { HttpSink } from "../src/sinks.js";
import { connectInMemory, echoServer, hasPython, scenarioFile, startCollector, toolEvents } from "./_scenarios.js";

/* eslint-disable @typescript-eslint/no-explicit-any -- the SDK's transport types differ by major */

interface Scenario {
  name: string;
  transport: "memory" | "stateful_http" | "stateless_http";
  clients: number;
  calls: number;
  expect: { sessions: "one" | "per_client" | "per_call"; origin: string; transport: string };
}

const spec = scenarioFile<{ scenarios: Scenario[] }>("sessions.json");

/** Scenarios this SDK does not run, with the reason. */
const NOT_RUN: Record<string, string> = {};

const CONFIG = { vendorId: "acme", vendorDisplayName: "Acme", consentToken: "ct" } as const;

async function callEcho(client: Client, calls: number): Promise<void> {
  for (let i = 0; i < calls; i += 1) {
    const result = await client.callTool({ name: "echo", arguments: { text: `hi ${i}` } });
    expect(result.content).toEqual([{ type: "text", text: `hi ${i}` }]);
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
}

/** Serves streamable HTTP and runs each client in turn. The SDK connects a
 * server to one transport at a time, so a new session or, when stateless, a
 * new request reconnects it; the clients take turns, so this is safe.
 * Returns the session id each client was given, none when stateless. */
async function overHttp(server: McpServer, stateful: boolean, clients: number, calls: number): Promise<string[]> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const body = await readBody(req);
    const known = sessions.get(String(req.headers["mcp-session-id"]));
    if (known) return known.handleRequest(req, res, body);
    if (req.method !== "POST") return void res.writeHead(405).end();
    await server.close();
    const transport = new StreamableHTTPServerTransport(
      stateful ? { sessionIdGenerator: randomUUID, onsessioninitialized: (id) => void sessions.set(id, transport) } : {},
    );
    await server.connect(transport as any);
    await transport.handleRequest(req, res, body);
  };
  const http = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  const given: string[] = [];
  try {
    for (let c = 0; c < clients; c += 1) {
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${String(port)}/mcp`));
      const client = new Client({ name: "scenario-runner", version: "1.0.0" });
      await client.connect(transport as any);
      await callEcho(client, calls);
      if (transport.sessionId) given.push(transport.sessionId);
      await client.close();
    }
  } finally {
    await server.close();
    await new Promise((resolve) => http.close(resolve));
  }
  return given;
}

describe.skipIf(!hasPython)("session ids against the fake collector", () => {
  it.each(spec.scenarios.filter((s) => !(s.name in NOT_RUN)))(
    "keeps SPEC §3.4: $name",
    async (scenario) => {
      const port = await startCollector("ok");
      const sink = new HttpSink(`http://127.0.0.1:${port}`, { apiKey: "k" });
      const server = echoServer();
      const handle = withBaton(server, { ...CONFIG, sink });
      let given: string[] = [];
      if (scenario.transport === "memory") {
        for (let c = 0; c < scenario.clients; c += 1) {
          const client = await connectInMemory(server);
          await callEcho(client, scenario.calls);
          await client.close();
        }
      } else {
        given = await overHttp(server, scenario.transport === "stateful_http", scenario.clients, scenario.calls);
      }
      await handle.aclose();

      const events = await toolEvents(port);
      const starts = events.filter((e) => e.event_type === "tool_call_start");
      expect(starts).toHaveLength(scenario.clients * scenario.calls);
      for (const event of events) {
        expect(event.session_id_origin).toBe(scenario.expect.origin);
        expect(event.transport_observed).toBe(scenario.expect.transport);
      }
      const end = (start: Event) => events.find((e) => e.event_type === "tool_call_end" && e.call_id === start.call_id);
      for (const start of starts) expect(end(start)?.session_id).toBe(start.session_id);

      const ids = starts.map((e) => e.session_id);
      if (scenario.expect.sessions === "one") {
        expect(new Set(events.map((e) => e.session_id)).size).toBe(1);
        const numbers = events.map((e) => e.sequence_number);
        expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
        expect(new Set(numbers).size).toBe(numbers.length);
      } else if (scenario.expect.sessions === "per_client") {
        expect(given).toHaveLength(scenario.clients);
        expect(new Set(given).size).toBe(scenario.clients);
        const perClient = given.flatMap((id) => Array.from({ length: scenario.calls }, () => id));
        expect(ids).toEqual(perClient);
      } else {
        expect(new Set(ids).size).toBe(ids.length);
      }
    },
    15_000,
  );
});
