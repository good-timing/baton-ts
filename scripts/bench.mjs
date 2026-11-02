// Runs baton-spec's bench/bench.json against the SDK built in SDK_DIR and
// writes one result file. Only the public API is used, so the same script
// measures the last release and the checkout; scripts/bench.sh runs both.
//
//   node --expose-gc scripts/bench.mjs SDK_DIR published|checkout RESULT.json
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

const [sdkDir, source, out] = process.argv.slice(2);
if (!sdkDir || !["published", "checkout"].includes(source ?? "") || !out || !globalThis.gc) {
  console.error("usage: node --expose-gc scripts/bench.mjs SDK_DIR published|checkout RESULT.json");
  process.exit(2);
}
const spec = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "baton-spec");
const bench = JSON.parse(readFileSync(path.join(spec, "bench", "bench.json"), "utf-8"));
const { withBaton, HttpSink } = await import(pathToFileURL(path.join(sdkDir, "dist", "index.js")).href);
const { version } = JSON.parse(readFileSync(path.join(sdkDir, "package.json"), "utf-8"));

async function withCollector(mode, use) {
  if (mode === "down") return use(1);
  const child = spawn("python3", [path.join(spec, "collector", "fake_collector.py"), "--mode", mode], {
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

async function delivered(port, mode) {
  if (mode === "down") return 0;
  const response = await fetch(`http://127.0.0.1:${port}/_received?lists=0`, { signal: AbortSignal.timeout(10000) });
  const { counts } = await response.json();
  return (counts.tool_call_start ?? 0) + (counts.tool_call_end ?? 0);
}

/** A client of the bench server, and Baton's handle on it, or null when `port` is null. */
async function echoClient(port) {
  const server = new McpServer({ name: "bench", version: "1.0.0" });
  server.registerTool("echo", { inputSchema: { text: z.string() } }, async ({ text }) => ({
    content: [{ type: "text", text }],
  }));
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

/** Each call's ms, with `concurrency` calls in flight at once. */
async function timedCalls(client, calls, concurrency) {
  const times = [];
  let left = calls;
  const worker = async () => {
    while (left > 0) {
      left -= 1;
      const started = performance.now();
      const result = await client.callTool({ name: "echo", arguments: { text: "hello" } });
      // A real server reads each call from a socket, so I/O runs between calls.
      // The in-memory transport only queues microtasks, which never let it run.
      await new Promise((resolve) => setImmediate(resolve));
      times.push(performance.now() - started);
      if (result.isError) throw new Error(`echo failed: ${JSON.stringify(result.content)}`);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return times;
}

function pct(samples, p) {
  const ordered = [...samples].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.floor((p / 100) * ordered.length))];
}

async function overhead(m) {
  return withCollector(m.collector, async (port) => {
    const figures = {};
    for (const [name, to] of [["plain", null], ["baton", port]]) {
      const { client, handle } = await echoClient(to);
      await timedCalls(client, m.warmup, 1);
      figures[name] = await timedCalls(client, m.calls, m.concurrency);
      await client.close();
      await handle?.aclose();
    }
    const result = {};
    for (const name of ["plain", "baton"]) {
      for (const p of [50, 99]) result[`${name}_p${p}_ms`] = pct(figures[name], p);
    }
    for (const p of [50, 99]) result[`added_p${p}_ms`] = result[`baton_p${p}_ms`] - result[`plain_p${p}_ms`];
    return result;
  });
}

async function load(m) {
  return withCollector(m.collector, async (port) => {
    const { client, handle } = await echoClient(port);
    await timedCalls(client, m.warmup, 1);
    let started = performance.now();
    const times = await timedCalls(client, m.calls, m.concurrency);
    const wall = performance.now() - started;
    await client.close();
    started = performance.now();
    await handle.aclose();
    const closing = performance.now() - started;
    const emitted = 2 * (m.warmup + m.calls);
    const got = await delivered(port, m.collector);
    return {
      wall_ms: wall,
      call_p50_ms: pct(times, 50),
      call_p99_ms: pct(times, 99),
      close_ms: closing,
      emitted,
      delivered: got,
      lost: emitted - got,
    };
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

const runners = { overhead, burst: load, outage_hang: load, outage_down: load, memory, memory_outage: memory };
const measures = {};
const maxRssBytes = () => process.resourceUsage().maxRSS * 1024;
let peak = 0;
for (const m of bench.measures) {
  if (m.name.startsWith("memory") && !peak) peak = maxRssBytes();
  measures[m.name] = await runners[m.name](m);
}
const result = {
  sdk: "typescript",
  version,
  source,
  runtime: `node ${process.versions.node}`,
  max_rss_bytes: peak || maxRssBytes(),
  measures,
};
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
