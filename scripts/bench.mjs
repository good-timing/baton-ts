// Runs baton-spec's bench/bench.json against the SDK built in SDK_DIR and
// writes one result file. Only the public API is used, so the same script
// measures the last release and the checkout; scripts/bench.sh runs both.
//
//   node --expose-gc scripts/bench.mjs SDK_DIR published|checkout RESULT.json [MEASURE]
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

const usage = () => {
  console.error("usage: node --expose-gc scripts/bench.mjs SDK_DIR published|checkout RESULT.json [MEASURE]");
  process.exit(2);
};
const [sdkDir, source, out, only] = process.argv.slice(2);
if (!sdkDir || !["published", "checkout"].includes(source ?? "") || !out || !globalThis.gc) usage();
const spec = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "baton-spec");
const bench = JSON.parse(readFileSync(path.join(spec, "bench", "bench.json"), "utf-8"));
if (only !== undefined && !bench.measures.some((m) => m.name === only)) usage();
const { withBaton, HttpSink } = await import(pathToFileURL(path.join(sdkDir, "dist", "index.js")).href);
const { version } = JSON.parse(readFileSync(path.join(sdkDir, "package.json"), "utf-8"));

async function withCollector(mode, use) {
  if (mode === "down") return use(1);
  const child = spawn("python3", [path.join(spec, "collector", "fake_collector.py"), "--mode", mode, "--no-events"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    const port = await new Promise((resolve, reject) => {
      createInterface({ input: child.stdout }).once("line", (line) => resolve(Number(line)));
      child.once("exit", (code) => reject(new Error(`the fake collector exited (${code})`)));
    });
    return await use(port);
  } finally {
    child.kill();
  }
}

/** Emitted, delivered and lost for `m`'s calls, a tool_call_start and a tool_call_end each. */
async function losses(port, m) {
  const emitted = 2 * (m.warmup + m.calls);
  const got = await delivered(port, m.collector);
  return { emitted, delivered: got, lost: emitted - got };
}

async function delivered(port, mode) {
  if (mode === "down") return 0;
  const response = await fetch(`http://127.0.0.1:${port}/_received?lists=0`, { signal: AbortSignal.timeout(10000) });
  const { counts } = await response.json();
  return (counts.tool_call_start ?? 0) + (counts.tool_call_end ?? 0);
}

/** A client of the bench server, with the large tool when `resultBytes` is set,
 * and Baton's handle on it, or null when `port` is null. */
async function echoClient(port, resultBytes = 0) {
  const server = new McpServer({ name: "bench", version: "1.0.0" });
  server.registerTool("echo", { inputSchema: { text: z.string() } }, async ({ text }) => ({
    content: [{ type: "text", text }],
  }));
  if (resultBytes) {
    const text = "hello ".repeat(Math.floor(resultBytes / 6) + 1).slice(0, resultBytes);
    server.registerTool("large", {}, async () => ({ content: [{ type: "text", text }] }));
  }
  const handle = port === null ? null : withBaton(server, {
    vendorId: "v",
    vendorDisplayName: "V",
    sink: new HttpSink(`http://127.0.0.1:${port}`, { apiKey: "k" }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "bench", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, handle };
}

const echoCall = { name: "echo", arguments: { text: "hello" } };

/** Each call's ms, with `concurrency` calls in flight at once. */
async function timedCalls(client, calls, concurrency, call = echoCall) {
  const times = [];
  let left = calls;
  const worker = async () => {
    while (left > 0) {
      left -= 1;
      const started = performance.now();
      const result = await client.callTool(call);
      // A real server reads each call from a socket, so I/O runs between calls.
      // The in-memory transport only queues microtasks, which never let it run.
      await new Promise((resolve) => setImmediate(resolve));
      times.push(performance.now() - started);
      if (result.isError) throw new Error(`${call.name} failed: ${JSON.stringify(result.content)}`);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return times;
}

function pct(samples, p) {
  const ordered = [...samples].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.floor((p / 100) * ordered.length))];
}

/** Call times, wall time and the still-open install handle of one pass on a new server. */
async function onePass(m, port, call = echoCall) {
  const { client, handle } = await echoClient(port, m.result_bytes);
  await timedCalls(client, m.warmup, 1, call);
  const started = performance.now();
  const times = await timedCalls(client, m.calls, m.concurrency, call);
  const wall = performance.now() - started;
  await client.close();
  return { times, wall, handle };
}

/** The call times on a server without Baton, then on one with it, and what
 * Baton adds to them. */
async function added(m, port, call) {
  const figures = {};
  const result = {};
  for (const [name, to] of [["plain", null], ["baton", port]]) {
    const { times, handle } = await onePass(m, to, call);
    figures[name] = times;
    await handle?.aclose();
  }
  for (const name of ["plain", "baton"]) {
    for (const p of [50, 99]) result[`${name}_p${p}_ms`] = pct(figures[name], p);
  }
  for (const p of [50, 99]) result[`added_p${p}_ms`] = result[`baton_p${p}_ms`] - result[`plain_p${p}_ms`];
  return result;
}

async function overhead(m) {
  return withCollector(m.collector, (port) => added(m, port, echoCall));
}

const largeCall = { name: "large", arguments: {} };

async function largeResult(m) {
  return withCollector(m.collector, async (port) => {
    const result = { ...(await added(m, port, largeCall)), ...(await losses(port, m)) };
    // Read on a second Baton server, untimed, so the full GCs stay out of the
    // timed calls. Its events come after the count above.
    const { client, handle } = await echoClient(port, m.result_bytes);
    await timedCalls(client, m.warmup, 1, largeCall);
    const before = liveHeap();
    await timedCalls(client, m.calls, m.concurrency, largeCall);
    result.heap_growth_bytes = liveHeap() - before;
    await client.close();
    await handle.aclose();
    return result;
  });
}

async function load(m) {
  return withCollector(m.collector, async (port) => {
    // So that neither pass's times include collecting garbage made before it.
    globalThis.gc();
    const plain = await onePass(m, null);
    globalThis.gc();
    const baton = await onePass(m, port);
    const started = performance.now();
    await baton.handle.aclose();
    const result = { close_ms: performance.now() - started };
    for (const [prefix, pass] of [["plain_", plain], ["", baton]]) {
      result[`${prefix}wall_ms`] = pass.wall;
      for (const p of [50, 99]) result[`${prefix}call_p${p}_ms`] = pct(pass.times, p);
    }
    for (const p of [50, 99]) result[`added_call_p${p}_ms`] = result[`call_p${p}_ms`] - result[`plain_call_p${p}_ms`];
    return { ...(await losses(port, m)), ...result };
  });
}

function liveHeap() {
  globalThis.gc();
  return process.memoryUsage().heapUsed;
}

async function memory(m) {
  const half = m.calls / 2;
  return withCollector(m.collector, async (port) => {
    const { client, handle } = await echoClient(port);
    await timedCalls(client, m.warmup, 1);
    const heaps = [liveHeap()];
    for (let i = 0; i < 2; i += 1) {
      await timedCalls(client, half, m.concurrency);
      heaps.push(liveHeap());
    }
    await client.close();
    await handle.aclose();
    return {
      heap_after_warmup_bytes: heaps[0],
      heap_at_half_bytes: heaps[1],
      heap_at_end_bytes: heaps[2],
      growth_per_call_bytes: (heaps[2] - heaps[1]) / half,
    };
  });
}

const runners = { overhead, large_result: largeResult, burst: load, outage_hang: load, outage_down: load, memory, memory_outage: memory };
const measures = {};
const maxRssBytes = () => process.resourceUsage().maxRSS * 1024;
let peak = 0;
for (const m of bench.measures) {
  if (only !== undefined && m.name !== only) continue;
  if (m.name.startsWith("memory") && !peak) peak = maxRssBytes();
  measures[m.name] = await runners[m.name](m);
}
const result = {
  sdk: "typescript",
  version,
  source,
  runtime: `node ${process.versions.node}`,
  cpu: os.cpus()[0]?.model.trim() || "unknown",
  max_rss_bytes: peak || maxRssBytes(),
  measures,
};
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
