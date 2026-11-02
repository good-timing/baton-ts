/**
 * Session ids against `baton-spec`'s fake collector, in every scenario of
 * `collector/sessions.json`; what each checks is the file's `about`. One
 * `withBaton` server serves every client, so the install's own session id is
 * there to be wrongly shared. Skipped where `python3` is missing, which the
 * collector needs.
 */
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { withBaton } from "../src/integrations/mcp/withBaton.js";
import { HttpSink } from "../src/sinks.js";
import { serveHttp } from "./_http.js";
import { CFG } from "./integrations/mcp/_majors.js";
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

/** Calls echo `calls` times as client `c`, each with its own text, so the
 * runner can find each call's events. Returns the texts in call order. */
async function callEcho(client: Client, c: number, calls: number): Promise<string[]> {
  const texts: string[] = [];
  for (let i = 0; i < calls; i += 1) {
    const text = `client ${c} call ${i}`;
    const result = await client.callTool({ name: "echo", arguments: { text } });
    expect(result.content).toEqual([{ type: "text", text }]);
    texts.push(text);
  }
  return texts;
}

/** Serves streamable HTTP and runs each client in turn. The SDK connects a
 * server to one transport at a time, so a new session or, when stateless, a
 * new request reconnects it; the clients take turns, so this is safe.
 * Returns each client's call texts, and the session id it was given, if any. */
async function overHttp(
  server: McpServer,
  stateful: boolean,
  clients: number,
  calls: number,
): Promise<{ texts: string[]; given?: string }[]> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const http = await serveHttp(async (req, res, body) => {
    const known = sessions.get(String(req.headers["mcp-session-id"]));
    if (known) return known.handleRequest(req, res, body);
    if (req.method !== "POST") return void res.writeHead(405).end();
    await server.close();
    const transport = new StreamableHTTPServerTransport(
      stateful ? { sessionIdGenerator: randomUUID, onsessioninitialized: (id) => void sessions.set(id, transport) } : {},
    );
    await server.connect(transport as any);
    await transport.handleRequest(req, res, body);
  });
  const ran: { texts: string[]; given?: string }[] = [];
  try {
    for (let c = 0; c < clients; c += 1) {
      const transport = new StreamableHTTPClientTransport(http.url);
      const client = new Client({ name: "scenario-runner", version: "1.0.0" });
      await client.connect(transport as any);
      const texts = await callEcho(client, c, calls);
      ran.push(transport.sessionId ? { texts, given: transport.sessionId } : { texts });
      await client.close();
    }
  } finally {
    await server.close();
    await http.close();
  }
  return ran;
}

describe.skipIf(!hasPython)("session ids against the fake collector", () => {
  it.each(spec.scenarios.filter((s) => !(s.name in NOT_RUN)))(
    "keeps SPEC §3.4: $name",
    async (scenario) => {
      const port = await startCollector("ok");
      const sink = new HttpSink(`http://127.0.0.1:${port}`, { apiKey: "k" });
      const server = echoServer();
      const handle = withBaton(server, { ...CFG, sink });
      let ran: { texts: string[]; given?: string }[] = [];
      if (scenario.transport === "memory") {
        for (let c = 0; c < scenario.clients; c += 1) {
          const client = await connectInMemory(server);
          ran.push({ texts: await callEcho(client, c, scenario.calls) });
          await client.close();
        }
      } else {
        ran = await overHttp(server, scenario.transport === "stateful_http", scenario.clients, scenario.calls);
      }
      await handle.aclose();

      const events = await toolEvents(port);
      expect(events).toHaveLength(2 * scenario.clients * scenario.calls);
      for (const event of events) {
        expect(event.session_id_origin).toBe(scenario.expect.origin);
        expect(event.transport_observed).toBe(scenario.expect.transport);
      }
      // Each call's start and end, in the order the calls were made.
      const calls = ran.map(({ texts }) =>
        texts.map((text) => {
          const start = events.find(
            (e) => e.event_type === "tool_call_start" && (e.payload as { params?: { text?: string } }).params?.text === text,
          )!;
          const end = events.find((e) => e.event_type === "tool_call_end" && e.call_id === start.call_id)!;
          expect(end.session_id).toBe(start.session_id);
          return [start, end] as const;
        }),
      );

      const ids = calls.flat().map(([start]) => start.session_id);
      if (scenario.expect.sessions === "one") {
        expect(new Set(ids).size).toBe(1);
        const numbers = calls.flat(2).map((e) => e.sequence_number);
        numbers.slice(1).forEach((n, i) => expect(n).toBeGreaterThan(numbers[i]!));
      } else if (scenario.expect.sessions === "per_client") {
        const given = ran.map((r) => r.given);
        expect(new Set(given).size).toBe(scenario.clients);
        calls.forEach((client, c) => {
          expect(given[c]).toBeDefined();
          for (const [start] of client) expect(start.session_id).toBe(given[c]);
        });
      } else {
        expect(new Set(ids).size).toBe(ids.length);
      }
    },
    15_000,
  );
});
