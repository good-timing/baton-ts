/** Test changes fetched by id: `BATON_CANDIDATE` and the `Baton-Candidate`
 * header (SPEC §2.6), and `capture.candidate` on events (SPEC §11.4). The
 * cases are Python's `tests/test_candidate_settings.py` and the adapters'
 * `test_candidate.py`. */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  CANDIDATE_READS_AT_ONCE,
  CANDIDATE_START_TIMEOUT_MS,
  CANDIDATES_HELD,
  type CandidateRead,
  CaptureSettings,
  SettingsFetcher,
  headerCandidate,
  mayHide,
  parseDocument,
  type SettingsDocument,
  type SettingsSource,
} from "../../../src/integrations/mcp/captureSettings.js";
import { resolveBatonConfig } from "../../../src/integrations/mcp/config.js";
import { withBaton } from "../../../src/integrations/mcp/withBaton.js";
import { serveHttp } from "../../_http.js";
import { MAJORS } from "./_majors.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

const CHANGE = "chg_1";
const WORKSPACE = "ten_655b084e118b43f88992ee6357fcc23c";
const DSN = `https://baton_tk_${"a".repeat(43)}@ingest.example.com/${WORKSPACE}/srv`;

/** A document whose one overlay changes `lookup`'s description to `text`. */
function document(text: string, candidate?: string): Record<string, any> {
  return {
    version: 3,
    ...(candidate === undefined ? {} : { candidate }),
    audiences: [{ id: "everyone", match: {}, capture: {}, overlay: "ov_1" }],
    overlays: {
      ov_1: { actions: [{ target: { tool: "lookup" }, replace: text }] },
      ov_server: { actions: [{ target: { instructions: true }, append: `Instructions: ${text}` }] },
    },
    server_overlay: "ov_server",
  };
}

const TODAY = document("Today's text.");
const CHANGED = document("The change's text.", CHANGE);

type Answer = Record<string, any> | 403 | 404 | 500 | "down" | "hang";

/** Holds today's document and answers each change read from `changes`. */
class Source implements SettingsSource {
  readonly document: SettingsDocument | null;
  readonly reads: string[] = [];
  readonly timeouts: number[] = [];
  private gate: Promise<void> | null = null;
  private open: () => void = () => {};

  constructor(readonly changes: Record<string, Answer>) {
    this.document = parseDocument(JSON.stringify(TODAY));
  }

  /** Change reads wait until `release()`. */
  hold(): void {
    this.gate = new Promise((resolve) => (this.open = resolve));
  }

  release(): void {
    this.open();
  }

  start(): void {}
  stop(): void {}

  async fetchCandidate(candidate: string, timeoutMs: number): Promise<CandidateRead> {
    this.reads.push(candidate);
    this.timeouts.push(timeoutMs);
    if (this.gate !== null) await this.gate;
    const answer = this.changes[candidate];
    if (answer === 403) return { outcome: "refused" };
    if (answer === 404) return { outcome: "unknown" };
    if (answer === undefined || answer === 500 || answer === "down" || answer === "hang") return { outcome: "failed" };
    const parsed = parseDocument(JSON.stringify(answer), candidate);
    return parsed === null ? { outcome: "failed" } : { outcome: "loaded", document: parsed };
  }
}

function started(source: Source, candidate: string | null = null): CaptureSettings {
  const settings = new CaptureSettings("srv", source, candidate);
  settings.start();
  return settings;
}

const caller = (candidate: string | null) => ({ labels: [], clientName: null, shareKey: null, candidate });

/** The description of `lookup` and the event tag a request gets. */
function served(settings: CaptureSettings, candidate: string | null): [string | undefined, string | undefined] {
  const call = settings.forCaller(caller(candidate))!;
  return [call.overlay!.actions[0]!.text, call.capture.candidate];
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** What a request with the header gets once the background read is done. */
async function settled(settings: CaptureSettings, candidate: string): Promise<[string | undefined, string | undefined]> {
  served(settings, candidate);
  await tick();
  return served(settings, candidate);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the header", () => {
  it("a test key gets the change's text and its tag", async () => {
    const settings = started(new Source({ [CHANGE]: CHANGED }));
    expect(await settled(settings, CHANGE)).toEqual(["The change's text.", CHANGE]);
  });

  it("the first request gets today's settings, untagged", () => {
    const settings = started(new Source({ [CHANGE]: CHANGED }));
    expect(served(settings, CHANGE)).toEqual(["Today's text.", undefined]);
  });

  it("a prod key gets today's settings and one warning", async () => {
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const source = new Source({ a: 403, b: 403 });
    const settings = started(source);
    expect(await settled(settings, "a")).toEqual(["Today's text.", undefined]);
    expect(served(settings, "b")).toEqual(["Today's text.", undefined]);
    expect(source.reads).toEqual(["a"]);
    expect(warning.mock.calls.filter(([m]) => String(m).includes("not a test key"))).toHaveLength(1);
  });

  it.each<Answer>([404, 500, "down", { version: "bad" }])("a change that cannot be read gets today's settings: %j", async (answer) => {
    const settings = started(new Source({ [CHANGE]: answer }));
    expect(await settled(settings, CHANGE)).toEqual(["Today's text.", undefined]);
  });

  it("a document for another change is not served", async () => {
    const settings = started(new Source({ [CHANGE]: document("Other.", "chg_2") }));
    expect(await settled(settings, CHANGE)).toEqual(["Today's text.", undefined]);
  });

  it("an unknown id is read once", async () => {
    const source = new Source({ [CHANGE]: 404 });
    const settings = started(source);
    await settled(settings, CHANGE);
    served(settings, CHANGE);
    expect(source.reads).toEqual([CHANGE]);
  });

  it("a failed read is tried again after a wait", async () => {
    const source = new Source({ [CHANGE]: "down" });
    const settings = started(source);
    settings.retryAfterMs = 50;
    await settled(settings, CHANGE);
    source.changes[CHANGE] = CHANGED;
    expect(await settled(settings, CHANGE)).toEqual(["Today's text.", undefined]);
    expect(source.reads).toEqual([CHANGE]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await settled(settings, CHANGE)).toEqual(["The change's text.", CHANGE]);
  });

  it("at most 32 ids are held", async () => {
    const ids = Array.from({ length: CANDIDATES_HELD + 1 }, (_, i) => `chg_${i}`);
    const source = new Source(Object.fromEntries(ids.map((id) => [id, document(id, id)])));
    const settings = started(source);
    for (const id of ids) await settled(settings, id);
    expect(served(settings, ids[0]!)).toEqual(["Today's text.", undefined]);
    expect(source.reads.filter((id) => id === ids[0])).toHaveLength(2);
  });

  it("at most four reads run at once", async () => {
    const ids = Array.from({ length: CANDIDATE_READS_AT_ONCE + 2 }, (_, i) => `chg_${i}`);
    const source = new Source(Object.fromEntries(ids.map((id) => [id, document(id, id)])));
    source.hold();
    const settings = started(source);
    for (const id of ids) expect(served(settings, id)).toEqual(["Today's text.", undefined]);
    expect(source.reads).toHaveLength(CANDIDATE_READS_AT_ONCE);
    source.release();
    await tick();
    expect(await settled(settings, ids.at(-1)!)).toEqual([ids.at(-1), ids.at(-1)]);
  });

  it.each(["", "a b", "x".repeat(129), "../settings", "é"])("a header that cannot be an id is ignored: %j", (value) => {
    expect(headerCandidate(new Headers({ "Baton-Candidate": value }))).toBeNull();
  });

  it("the header is read case-insensitively and stripped", () => {
    expect(headerCandidate(new Headers({ "baton-candidate": ` ${CHANGE} ` }))).toBe(CHANGE);
    expect(headerCandidate(null)).toBeNull();
  });

  it("a tool the change hides may be hidden", async () => {
    const hides = document("x", CHANGE);
    hides.overlays.ov_1.actions.push({ target: { tool: "drop" }, remove: true });
    const settings = started(new Source({ [CHANGE]: hides }));
    expect(mayHide(settings, "drop")).toBe(false);
    await settled(settings, CHANGE);
    expect(mayHide(settings, "drop")).toBe(true);
  });
});

describe("the variable", () => {
  it("a test key serves the change from the start", async () => {
    const settings = started(new Source({ [CHANGE]: CHANGED }), CHANGE);
    await settings.ready;
    expect(served(settings, null)).toEqual(["The change's text.", CHANGE]);
  });

  it("the header wins", async () => {
    const source = new Source({ [CHANGE]: CHANGED, chg_2: document("Another change.", "chg_2") });
    const settings = started(source, CHANGE);
    await settings.ready;
    expect(await settled(settings, "chg_2")).toEqual(["Another change.", "chg_2"]);
  });

  it("a header whose change is not held gets today's settings", async () => {
    const settings = started(new Source({ [CHANGE]: CHANGED, chg_2: 404 }), CHANGE);
    await settings.ready;
    expect(await settled(settings, "chg_2")).toEqual(["Today's text.", undefined]);
  });

  it("a header retries the variable's failed read", async () => {
    vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const source = new Source({ [CHANGE]: "down" });
    const settings = new CaptureSettings("srv", source, CHANGE);
    settings.retryAfterMs = 0;
    settings.start();
    await settings.ready;
    source.changes[CHANGE] = CHANGED;
    expect(await settled(settings, CHANGE)).toEqual(["The change's text.", CHANGE]);
  });

  it("a prod key warns once and serves today's settings", async () => {
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const settings = started(new Source({ [CHANGE]: 403, b: 403 }), CHANGE);
    await settings.ready;
    expect(served(settings, null)).toEqual(["Today's text.", undefined]);
    expect(served(settings, "b")).toEqual(["Today's text.", undefined]);
    expect(warning.mock.calls.filter(([m]) => String(m).includes("not a test key"))).toHaveLength(1);
  });

  it.each<Answer>([404, "down"])("a change that cannot be read is reported and today's settings apply: %j", async (answer) => {
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const settings = started(new Source({ [CHANGE]: answer }), CHANGE);
    await settings.ready;
    expect(served(settings, null)).toEqual(["Today's text.", undefined]);
    expect(warning.mock.calls.some(([m]) => String(m).includes("BATON_CANDIDATE"))).toBe(true);
  });

  it("the start read gets the start timeout", async () => {
    vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const source = new Source({ [CHANGE]: "hang" });
    const settings = started(source, CHANGE);
    await settings.ready;
    expect(source.timeouts).toEqual([CANDIDATE_START_TIMEOUT_MS]);
  });

  it("an answer after the start timeout is dropped", async () => {
    vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const source = new Source({ [CHANGE]: CHANGED });
    source.hold();
    const settings = new CaptureSettings("srv", source, CHANGE, 20);
    settings.start();
    await settings.ready;
    expect(served(settings, null)).toEqual(["Today's text.", undefined]);
    source.release();
    await tick();
    expect(served(settings, null)).toEqual(["Today's text.", undefined]);
  });

  it("a 403 after the start timeout still names the key", async () => {
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const source = new Source({ [CHANGE]: 403 });
    source.hold();
    const settings = new CaptureSettings("srv", source, CHANGE, 20);
    settings.start();
    await settings.ready;
    source.release();
    await tick();
    expect(warning.mock.calls.some(([m]) => String(m).includes("not a test key"))).toBe(true);
  });

  it("a read that ends after close changes nothing and says nothing", async () => {
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const source = new Source({ [CHANGE]: 404 });
    source.hold();
    const settings = started(source, CHANGE);
    settings.stop();
    source.release();
    await tick();
    expect(warning).not.toHaveBeenCalled();
  });

  it("local settings report it once", () => {
    vi.stubEnv("BATON_CANDIDATE", CHANGE);
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    void withBaton(new McpServer({ name: "local", version: "1" }), { dsn: DSN }).aclose();
    expect(warning.mock.calls.filter(([m]) => String(m).includes('not "console"'))).toHaveLength(1);
  });

  it("console settings read it", () => {
    vi.stubEnv("BATON_CANDIDATE", CHANGE);
    const settings = resolveBatonConfig({ dsn: DSN, settings: "console" }).captureSettings as any;
    expect(settings.candidate).toBe(CHANGE);
  });
});

describe("the read", () => {
  const fetcher = (answer: () => Response) => {
    const urls: string[] = [];
    const reader = new SettingsFetcher({
      origin: "https://ingest.example.com",
      apiKey: "k",
      tenantId: WORKSPACE,
      vendorId: "srv",
      refreshMs: 60_000,
      fetchImpl: (async (url: string) => {
        urls.push(url);
        return answer();
      }) as typeof fetch,
    });
    return { reader, urls };
  };

  it("asks for the change by id", async () => {
    const { reader, urls } = fetcher(() => new Response(JSON.stringify(CHANGED), { status: 200 }));
    const read = await reader.fetchCandidate(CHANGE, 1000);
    expect(read.outcome).toBe("loaded");
    expect(new URL(urls[0]!).searchParams.get("candidate")).toBe(CHANGE);
    expect(new URL(urls[0]!).searchParams.get("server")).toBe("srv");
  });

  it.each([
    [403, "refused"],
    [404, "unknown"],
    [500, "failed"],
  ])("answers %i as %s", async (status, outcome) => {
    const { reader } = fetcher(() => new Response(null, { status }));
    expect((await reader.fetchCandidate(CHANGE, 1000)).outcome).toBe(outcome);
  });

  it("a document for another change is not loaded", async () => {
    const { reader } = fetcher(() => new Response(JSON.stringify(TODAY), { status: 200 }));
    expect((await reader.fetchCandidate(CHANGE, 1000)).outcome).toBe("failed");
  });
});

it("the limits are the spec's", () => {
  expect([CANDIDATES_HELD, CANDIDATE_READS_AT_ONCE, CANDIDATE_START_TIMEOUT_MS]).toEqual([32, 4, 5000]);
});

it("a change with no actions still tags its events", () => {
  const bare = { version: 3, candidate: CHANGE, audiences: [{ id: "everyone", match: {}, capture: {} }] };
  const parsed = parseDocument(JSON.stringify(bare), CHANGE)!;
  expect(parsed.settingsFor(caller(null), "srv").capture).toEqual({ settings_version: 3, audience: "everyone", candidate: CHANGE });
});

/** Answers settings reads from `changes` by id, and today's document otherwise. */
function useCollector(changes: Record<string, Answer>): { events: Record<string, any>[] } {
  const collector = { events: [] as Record<string, any>[] };
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (url: string | URL, init: RequestInit) => {
    // The MCP client's own requests go to the local server.
    if (new URL(url).hostname === "127.0.0.1") return realFetch(url, init);
    if (String(url).includes("/v0/settings")) {
      const id = new URL(url).searchParams.get("candidate");
      const answer = id === null ? TODAY : changes[id];
      if (typeof answer === "number") return new Response(null, { status: answer });
      return new Response(JSON.stringify(answer), { status: 200 });
    }
    const body = JSON.parse(init.body as string) as { events?: Record<string, unknown>[] };
    collector.events.push(...(body.events ?? [body]));
    return new Response(null, { status: 202 });
  });
  return collector;
}

describe.each(MAJORS)("$label", (major) => {
  it("the variable's change is served from the first initialize", async () => {
    vi.stubEnv("BATON_CANDIDATE", CHANGE);
    const collector = useCollector({ [CHANGE]: CHANGED });
    const server = major.make();
    major.tool(server, "lookup", { name: z.string() }, () => ({ content: [{ type: "text" as const, text: "ok" }] }));
    const handle = withBaton(server, { dsn: DSN, settings: "console" });
    try {
      const client = await major.connect(server, { clientName: "eval" });
      expect(client.getInstructions()).toContain("Instructions: The change's text.");
      const { tools } = await client.listTools();
      expect(tools.find((t: { name: string }) => t.name === "lookup").description).toBe("The change's text.");
      await client.callTool({ name: "lookup", arguments: { name: "a" } });
      await client.close();
    } finally {
      await handle.flush();
      await handle.aclose();
    }
    const [end] = collector.events.filter((e) => e.event_type === "tool_call_end");
    expect(end!.capture.candidate).toBe(CHANGE);
  });
});

it("a tools/list sent before any handshake waits for the variable's change", async () => {
  vi.stubEnv("BATON_CANDIDATE", CHANGE);
  let answer: (response: Response) => void = () => {};
  const held = new Promise<Response>((resolve) => (answer = resolve));
  useCollector({});
  const stubbed = globalThis.fetch;
  vi.stubGlobal("fetch", (url: string, init: RequestInit) =>
    new URL(url).searchParams.has("candidate") ? held : stubbed(url, init),
  );
  const server = new McpServer({ name: "vendor", version: "1.0.0" });
  server.registerTool("lookup", { description: "Look up.", inputSchema: { name: z.string() } }, () => ({
    content: [{ type: "text" as const, text: "ok" }],
  }));
  const handle = withBaton(server, { dsn: DSN, settings: "console" });
  try {
    const list = (server.server as any)._requestHandlers.get("tools/list");
    const extra = { signal: new AbortController().signal, requestId: 1, sendNotification: async () => {}, sendRequest: async () => ({}) };
    const listed = list({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, extra);
    answer(new Response(JSON.stringify(CHANGED), { status: 200 }));
    const { tools } = await listed;
    expect(tools.find((t: { name: string }) => t.name === "lookup").description).toBe("The change's text.");
  } finally {
    await handle.aclose();
  }
});

describe("over HTTP", () => {
  /** One server per request, wrapped by `withBaton`; each call sends the header. */
  async function callWithHeader(changes: Record<string, Answer>): Promise<{ descriptions: string[]; events: Record<string, any>[] }> {
    const collector = useCollector(changes);
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    server.registerTool("lookup", { description: "Look up.", inputSchema: { name: z.string() } }, () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));
    const handle = withBaton(server, { dsn: DSN, settings: "console" });
    const http = await serveHttp(async (req, res, body) => {
      if (req.method !== "POST") return void res.writeHead(405).end();
      await server.close();
      const transport = new StreamableHTTPServerTransport({});
      await server.connect(transport as any);
      await transport.handleRequest(req, res, body);
    });
    const descriptions: string[] = [];
    try {
      await tick();
      for (let i = 0; i < 2; i++) {
        const client = new Client({ name: "eval", version: "1.0.0" });
        const headers = { "Baton-Candidate": CHANGE };
        await client.connect(new StreamableHTTPClientTransport(http.url, { requestInit: { headers } }) as any);
        const { tools } = await client.listTools();
        descriptions.push(tools.find((t) => t.name === "lookup")!.description!);
        await client.callTool({ name: "lookup", arguments: { name: "a" } });
        await client.close();
        await tick();
      }
    } finally {
      await http.close();
      await handle.flush();
      await handle.aclose();
    }
    return { descriptions, events: collector.events };
  }

  it("a test key with the header gets the change and tagged events", async () => {
    const { descriptions, events } = await callWithHeader({ [CHANGE]: CHANGED });
    expect(descriptions.at(-1)).toBe("The change's text.");
    const ends = events.filter((e) => e.event_type === "tool_call_end");
    expect(ends.at(-1)!.capture.candidate).toBe(CHANGE);
  });

  it("a prod key with the header gets today's tool list", async () => {
    vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const { descriptions, events } = await callWithHeader({ [CHANGE]: 403 });
    expect(descriptions).toEqual(["Today's text.", "Today's text."]);
    for (const end of events.filter((e) => e.event_type === "tool_call_end")) {
      expect(end.capture).not.toHaveProperty("candidate");
    }
  });
});
