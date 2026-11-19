/** Console settings on the library API (SPEC §2.6, §5.6). The cases are
 * Python's `tests/test_library_settings.py`, by name. */

import v8 from "node:v8";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, type Event, type Principal, type Sink } from "../../src/index.js";
import { SettingsFetcher } from "../../src/integrations/mcp/captureSettings.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

const KEY = "baton_pk_" + "a".repeat(43);
const DSN = `https://${KEY}@ingest.example.com/ten_655b084e118b43f88992ee6357fcc23c/srv_lib`;
const DOCUMENT = {
  version: 4,
  audiences: [
    { id: "enterprise", match: { label: ["enterprise"] }, capture: { results: "off" } },
    { id: "everyone", match: {}, capture: {} },
  ],
};
const EVERYONE_OFF = { version: 5, audiences: [{ id: "everyone", match: {}, capture: { results: "off" } }] };
const ENTERPRISE: Principal = {
  principalId: "u1",
  organization: { organizationId: "acme", labels: ["enterprise"] },
};

interface Collector {
  events: Record<string, any>[];
  settingsReads: number;
  /** Answers the settings reads waiting on it, and every later one, with `document`. */
  answer(document: unknown): void;
}

/** Answers `GET /v0/settings` once `answer()` is called and records the events posted. */
function stubCollector(): Collector {
  let document: unknown;
  let answered = false;
  const waiting: (() => void)[] = [];
  const collector: Collector = {
    events: [],
    settingsReads: 0,
    answer(value) {
      document = value;
      answered = true;
      for (const release of waiting.splice(0)) release();
    },
  };
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (String(url).includes("/v0/settings")) {
      collector.settingsReads += 1;
      if (!answered) await new Promise<void>((resolve) => waiting.push(resolve));
      return document === null
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify(document), { status: 200, headers: { etag: '"e"' } });
    }
    const body = JSON.parse(init.body as string) as { events?: Record<string, unknown>[] };
    collector.events.push(...(body.events ?? [body]));
    return new Response(null, { status: 202 });
  });
  return collector;
}

/** A client whose first settings read has answered `document`. */
async function clientWith(collector: Collector, document: unknown): Promise<Client> {
  const client = new Client({ dsn: DSN, settings: "console" });
  collector.answer(document);
  await vi.waitFor(() => expect(collector.settingsReads).toBeGreaterThan(0));
  await new Promise((resolve) => setImmediate(resolve));
  return client;
}

async function run(collector: Collector, document: unknown, principal?: Principal): Promise<Record<string, any>> {
  const client = await clientWith(collector, document);
  client.session(principal === undefined ? {} : { principal }, () =>
    client.trace({ toolName: "fetch" }, (trace) => trace.observed({ note: "private" })),
  );
  await client.aclose();
  return endOf(collector);
}

function endOf(collector: Collector): Record<string, any> {
  const ends = collector.events.filter((e) => e.event_type === "tool_call_end");
  expect(ends).toHaveLength(1);
  return ends[0]!;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Console settings on the library API", () => {
  it("sends no result for a caller in an audience with results off", async () => {
    const collector = stubCollector();
    const end = await run(collector, DOCUMENT, ENTERPRISE);
    expect(JSON.stringify(end)).not.toContain("private");
    expect(end.payload.result_capture).toBe("off");
    expect(end.capture).toEqual({ settings_version: 4, audience: "enterprise" });
  });

  it("keeps the code value for a caller in another audience", async () => {
    const collector = stubCollector();
    const end = await run(collector, DOCUMENT, { principalId: "u2" });
    expect(JSON.stringify(end)).toContain("private");
    expect(end.capture).toEqual({ settings_version: 4, audience: "everyone" });
  });

  it("applies the code values before the first read", async () => {
    const collector = stubCollector();
    const end = await run(collector, null, ENTERPRISE);
    expect(JSON.stringify(end)).toContain("private");
    expect(end.capture).toBeNull();
  });

  it("starts the settings reader with the client and stops it at close", async () => {
    const start = vi.spyOn(SettingsFetcher.prototype, "start");
    const stop = vi.spyOn(SettingsFetcher.prototype, "stop");
    await run(stubCollector(), DOCUMENT);
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalled();
  });

  it("runs a call outside a block under the settings", async () => {
    const collector = stubCollector();
    const client = await clientWith(collector, EVERYONE_OFF);
    client.trace({ toolName: "fetch" }, (trace) => trace.observed({ note: "private" }));
    await client.annotate({ whatHappened: "slow" });
    await client.aclose();
    expect(JSON.stringify(endOf(collector))).not.toContain("private");
    expect(new Set(collector.events.map((e) => JSON.stringify(e.capture)))).toEqual(
      new Set([JSON.stringify({ settings_version: 5, audience: "everyone" })]),
    );
  });

  it("picks the settings up in a block open across the first read", async () => {
    const collector = stubCollector();
    const client = new Client({ dsn: DSN, settings: "console" });
    await vi.waitFor(() => expect(collector.settingsReads).toBeGreaterThan(0));
    await client.session({ principal: ENTERPRISE }, async () => {
      collector.answer(DOCUMENT);
      await new Promise((resolve) => setImmediate(resolve));
      client.trace({ toolName: "fetch" }, (trace) => trace.observed({ note: "private" }));
    });
    await client.aclose();
    expect(endOf(collector).payload.result_capture).toBe("off");
  });

  it("still shows who the block is for", async () => {
    const collector = stubCollector();
    const client = await clientWith(collector, null);
    client.session({ principal: ENTERPRISE }, () => client.trace({ toolName: "fetch" }, () => null));
    await client.aclose();
    const end = endOf(collector);
    expect(end.principal.id).toBe("u1");
    expect(end.organization).not.toBeNull();
    expect(end.labels).toEqual(["enterprise"]);
  });

  it("never reads the Console with local settings", async () => {
    const collector = stubCollector();
    await new Client({ dsn: DSN }).aclose();
    expect(collector.settingsReads).toBe(0);
  });

  it.each([
    [{ settings: "remote" }, "must be one of"],
    [{ settings: "console", settingsRefreshMs: 1 }, "from 15000"],
    [{ reportMode: "sometimes" }, "must be one of"],
  ])("refuses bad settings at construction: %o", (options, message) => {
    expect(() => new Client({ dsn: DSN, ...(options as object) })).toThrow(message);
  });

  it("needs a dsn for Console settings", () => {
    expect(() => new Client({ vendorId: "v1", sink: new MemorySink(), settings: "console" })).toThrow("needs a dsn");
  });

  it("never throws over settings under the off switch", async () => {
    vi.stubEnv("BATON_DISABLED", "1");
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await new Client({ settings: "console" }).aclose();
  });

  it("stops reading the Console for a client dropped without close", async () => {
    stubCollector().answer(null);
    const stop = vi.spyOn(SettingsFetcher.prototype, "stop");
    (() => new Client({ dsn: DSN, settings: "console" }))();
    v8.setFlagsFromString("--expose-gc");
    const gc = vm.runInNewContext("gc") as () => void;
    await vi.waitFor(async () => {
      gc();
      await new Promise((resolve) => setImmediate(resolve));
      expect(stop).toHaveBeenCalled();
    });
  });

  it("reads nothing on Cloudflare Workers, and warns", async () => {
    const collector = stubCollector();
    vi.stubGlobal("WebSocketPair", function WebSocketPair() {});
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = new Client({ dsn: DSN, settings: "console" });
    await client.aclose();
    expect(collector.settingsReads).toBe(0);
    expect(warned.mock.calls.map(([message]) => String(message)).join("\n")).toContain("not supported on Cloudflare Workers");
  });
});

describe("test changes on the library path", () => {
  const CHANGE = "chg_1";
  const CHANGED = {
    version: 6,
    candidate: CHANGE,
    audiences: [{ id: "everyone", match: {}, capture: { results: "off" } }],
  };
  const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "fetch", arguments: {} } };
  const dispatch = (message: any) => ({
    jsonrpc: "2.0",
    id: message.id,
    result: { content: [{ type: "text", text: "private" }] },
  });

  /** Answers today's settings with nothing and a read of `CHANGE` with `CHANGED`. */
  function stubChanges(): Collector {
    const collector = stubCollector();
    const today = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) =>
      String(url).includes(`candidate=${CHANGE}`)
        ? new Response(JSON.stringify(CHANGED), { status: 200 })
        : today(url, init),
    );
    collector.answer(null);
    return collector;
  }

  it("takes the header's change and task", async () => {
    const collector = stubChanges();
    const client = new Client({ dsn: DSN, settings: "console" });
    const headers = { "Baton-Candidate": CHANGE, "Baton-Task": "task-7" };
    await client.serve(call, dispatch, { headers });
    await vi.waitFor(async () => {
      collector.events.length = 0;
      await client.serve(call, dispatch, { headers });
      await client.flush();
      expect(collector.events.find((e) => e.event_type === "tool_call_end")?.capture).toEqual({
        settings_version: 6,
        audience: "everyone",
        candidate: CHANGE,
        task: "task-7",
      });
    });
    await client.aclose();
    expect(JSON.stringify(collector.events)).not.toContain("private");
  });

  it("serves BATON_CANDIDATE's change from the first call", async () => {
    vi.stubEnv("BATON_CANDIDATE", CHANGE);
    vi.stubEnv("BATON_TASK", "task-8");
    const collector = stubChanges();
    const client = new Client({ dsn: DSN, settings: "console" });
    await client.serve(call, dispatch);
    await client.aclose();
    const end = collector.events.find((e) => e.event_type === "tool_call_end")!;
    expect(end.capture).toMatchObject({ candidate: CHANGE, task: "task-8" });
    expect(end.payload.result_capture).toBe("off");
  });

  it("warns that BATON_CANDIDATE needs Console settings", async () => {
    vi.stubEnv("BATON_CANDIDATE", CHANGE);
    stubCollector();
    const warned = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    await new Client({ dsn: DSN }).aclose();
    expect(warned.mock.calls.map(([message]) => String(message)).join("\n")).toContain('settings are not "console"');
  });
});

class MemorySink implements Sink {
  readonly events: Event[] = [];
  async write(event: Event): Promise<void> {
    this.events.push(event);
  }
  async flush(): Promise<void> {}
  async aclose(): Promise<void> {}
}
