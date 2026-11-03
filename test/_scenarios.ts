/** What the runners of `baton-spec`'s scenario files share: the fake collector and the echo server. */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { afterEach } from "vitest";
import type { Event } from "../src/events.js";
import { HttpSink } from "../src/sinks.js";

const collectorDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "baton-spec", "collector");

export const hasPython = spawnSync("python3", ["--version"]).status === 0;

export function scenarioFile<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(collectorDir, name), "utf-8")) as T;
}

let running: ChildProcess | null = null;
afterEach(() => {
  running?.kill();
  running = null;
});

/** The port of a collector in `mode`, killed after the test. */
export async function startCollector(mode: string, delayMs = 0): Promise<number> {
  const child = spawn("python3", [path.join(collectorDir, "fake_collector.py"), "--mode", mode, "--delay-ms", String(delayMs)], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  running = child;
  const lines = createInterface({ input: child.stdout });
  return new Promise((resolve, reject) => {
    lines.once("line", (line) => resolve(Number(line)));
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`the fake collector exited (${String(code)}) before printing its port`)));
  });
}

/** The sink settings a scenario file shares, which a scenario's own `settings` override key by key. */
export interface SinkSettings {
  request_timeout_ms: number;
  shutdown_budget_ms: number;
  backoff_base_ms: number;
  flush_interval_ms?: number;
}

export function scenarioSink(port: number, settings: SinkSettings): HttpSink {
  return new HttpSink(`http://127.0.0.1:${port}`, {
    apiKey: "k",
    requestTimeoutMs: settings.request_timeout_ms,
    shutdownFlushTimeoutMs: settings.shutdown_budget_ms,
    backoffBaseMs: settings.backoff_base_ms,
    ...(settings.flush_interval_ms === undefined ? {} : { flushIntervalMs: settings.flush_interval_ms }),
  });
}

export interface Received {
  accepted: number[];
  events: Event[];
  requests: number;
  reports: number;
}

/** What the collector has received; `query` may ask it to wait first. */
export async function received(port: number, query = ""): Promise<Received> {
  const response = await fetch(`http://127.0.0.1:${port}/_received${query}`, { signal: AbortSignal.timeout(5000) });
  return (await response.json()) as Received;
}

/** The tool_call_start and tool_call_end events the collector accepted, in the order it got them. */
export async function toolEvents(port: number): Promise<Event[]> {
  const { events } = await received(port);
  return events.filter((e) => e.event_type === "tool_call_start" || e.event_type === "tool_call_end");
}

export function echoServer(): McpServer {
  const server = new McpServer({ name: "vendor", version: "1.0.0" });
  server.registerTool("echo", { inputSchema: { text: z.string() } }, async (args: { text: string }) => ({
    content: [{ type: "text" as const, text: args.text }],
  }));
  return server;
}

export async function connectInMemory(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "scenario-runner", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}
