/** Settings from the Console (SPEC §2.6) through `withBaton` and `createBaton`:
 * labels and `capture` on events, `results` per call, `goal` and `reports`
 * per `tools/list`, and the instructions. The cases are Python's
 * `tests/test_capture_settings.py` and `test_per_caller_surface.py`.
 *
 * `fetch` is stubbed, as in `dsnConfig.test.ts`: console settings need a DSN,
 * so events and the settings read both go through it. */

import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { BatonConfig } from "../../../src/integrations/mcp/config.js";
import { resolveBatonConfig } from "../../../src/integrations/mcp/config.js";
import { createBaton, withBaton } from "../../../src/integrations/mcp/withBaton.js";
import {
  CaptureSettings,
  SettingsFetcher,
  parseDocument,
  type SettingsDocument,
} from "../../../src/integrations/mcp/captureSettings.js";
import { PerCallerSurface } from "../../../src/integrations/mcp/perCaller.js";
import {
  INTENT_INSTRUCTIONS,
  buildServerInstructions,
  buildUserGoalParamDescription,
  withVendorInstructions,
} from "../../../src/integrations/mcp/llmText.js";
import type { Principal } from "../../../src/identity.js";
import { MAJORS, type Major } from "./_majors.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

const WORKSPACE = "ten_655b084e118b43f88992ee6357fcc23c";
const KEY = "baton_pk_" + "a".repeat(43);
const DSN = `https://${KEY}@ingest.example.com/${WORKSPACE}/srv`;
const REQUIRED = buildUserGoalParamDescription({ intentParamMode: "required" });
const OPTIONAL = buildUserGoalParamDescription({ intentParamMode: "optional" });
const GOAL = "1: find alice; success is her row";

const doc = (...audiences: unknown[]): string => JSON.stringify({ version: 9, audiences });
// A caller from claude-code with the beta label is in the beta audience; any other is not.
const BETA_QUIET = doc(
  {
    id: "beta",
    match: { label: ["beta"], client: ["claude-code"] },
    capture: { goal: "optional", reports: "off", results: "off" },
  },
  { id: "everyone", match: {}, capture: { goal: "required", reports: "on", results: "full" } },
);
const NOBODY_REPORTS = doc({ id: "everyone", match: {}, capture: { reports: "off" } });

const resolver = (): Principal => ({
  principalId: "user-1",
  labels: ["beta", "beta", ""],
  organization: { organizationId: "org_1", labels: ["enterprise"] },
});

interface Collector {
  events: Record<string, any>[];
  settingsReads: Request[];
}

/** Answers `GET /v0/settings` with `answer` and records the events posted. */
function stubCollector(answer: () => Response | Promise<Response>): Collector {
  const collector: Collector = { events: [], settingsReads: [] };
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (String(url).includes("/v0/settings")) {
      collector.settingsReads.push(new Request(url, init));
      return answer();
    }
    const body = JSON.parse(init.body as string) as { events?: Record<string, unknown>[] };
    collector.events.push(...(body.events ?? [body]));
    return new Response(null, { status: 202 });
  });
  return collector;
}

const answering = (body: string | null) => () =>
  body === null ? new Response(null, { status: 204 }) : new Response(body, { status: 200, headers: { etag: '"e"' } });

/** Until the first read's answer is held. */
async function settingsRead(collector: Collector): Promise<void> {
  await vi.waitFor(() => expect(collector.settingsReads.length).toBeGreaterThan(0));
  await new Promise((resolve) => setImmediate(resolve));
}

type How = "withBaton" | "createBaton";

function lookupServer(major: Major, instructions?: string): any {
  const server = major.make(instructions === undefined ? undefined : { instructions });
  major.tool(server, "lookup", { name: z.string() }, (args: { name: string }) => ({
    content: [{ type: "text" as const, text: args.name }],
  }));
  return server;
}

/** Install on `server`; returns flush-and-close. */
function installOn(how: How, server: any, config: BatonConfig): () => Promise<void> {
  if (how === "withBaton") {
    const handle = withBaton(server, config);
    return async () => {
      await handle.flush();
      await handle.aclose();
    };
  }
  const baton = createBaton(config);
  baton.wrap(server);
  return async () => {
    await baton.flush();
    await baton.aclose();
  };
}

type Listing = Record<string, any>;

/** One connection from `clientName`: list the tools, call `lookup`. */
async function session(major: Major, server: any, clientName: string): Promise<Listing> {
  const client = await major.connect(server, { clientName });
  const { tools } = await client.listTools();
  await client.callTool({ name: "lookup", arguments: { name: "alice", user_goal: GOAL } });
  await client.close();
  return Object.fromEntries(
    (tools as { name: string; inputSchema: unknown }[]).map((tool) => [tool.name, tool.inputSchema]),
  );
}

async function drive(
  major: Major,
  how: How,
  clientName: string,
  config: BatonConfig = {},
): Promise<{ listing: Listing; instructions: string }> {
  const collector = (globalThis as { collector?: Collector }).collector!;
  const server = lookupServer(major);
  const close = installOn(how, server, { dsn: DSN, settings: "console", resolvePrincipal: resolver, ...config });
  try {
    if (config.settings !== "local") await settingsRead(collector);
    const listing = await session(major, server, clientName);
    return { listing, instructions: server.server._instructions as string };
  } finally {
    await close();
  }
}

function useCollector(answer: () => Response | Promise<Response>): Collector {
  const collector = stubCollector(answer);
  (globalThis as { collector?: Collector }).collector = collector;
  return collector;
}

const ofType = (collector: Collector, type: string) => collector.events.filter((e) => e.event_type === type);
const reportTools = (listing: Listing) => Object.keys(listing).filter((name) => name !== "lookup");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.BATON_DSN;
});

describe.each(MAJORS)("$label", (major) => {
  describe.each<How>(["withBaton", "createBaton"])("%s", (how) => {
    it("events carry the caller's labels and audience", async () => {
      const collector = useCollector(answering(BETA_QUIET));
      await drive(major, how, "claude-code");
      const events = collector.events.filter((e) => e.event_type !== "surface_snapshot");
      expect(new Set(events.map((e) => e.event_type as string))).toEqual(
        new Set(["tool_list_start", "tool_list_end", "tool_call_start", "tool_call_end"]),
      );
      for (const event of events) {
        expect(event.labels, event.event_type).toEqual(["beta", "enterprise"]);
        expect(event.capture, event.event_type).toEqual({ settings_version: 9, audience: "beta" });
      }
      const [end] = ofType(collector, "tool_call_end");
      expect(end!.payload.result_capture).toBe("off");
      expect(end!.payload.result).toBeNull();
    });

    it("a caller outside the audience gets everyone's settings", async () => {
      const collector = useCollector(answering(BETA_QUIET));
      await drive(major, how, "cursor");
      const [end] = ofType(collector, "tool_call_end");
      expect(end!.capture).toEqual({ settings_version: 9, audience: "everyone" });
      expect(end!.payload.result).not.toBeNull();
    });

    it("code settings send labels and no capture, and read nothing", async () => {
      const collector = useCollector(answering(BETA_QUIET));
      await drive(major, how, "claude-code", { settings: "local" });
      const [end] = ofType(collector, "tool_call_end");
      expect(end!.labels).toEqual(["beta", "enterprise"]);
      expect(end!.capture).toBeNull();
      expect(collector.settingsReads).toEqual([]);
    });

    it("settings that fail to apply still serve the call", async () => {
      const collector = useCollector(answering(BETA_QUIET));
      vi.spyOn(CaptureSettings.prototype, "forCaller").mockImplementation(() => {
        throw new Error("settings bug");
      });
      vi.spyOn(process, "emitWarning").mockImplementation(() => {});
      await drive(major, how, "claude-code");
      expect(ofType(collector, "tool_call_error")).toEqual([]);
      const [end] = ofType(collector, "tool_call_end");
      expect(end!.capture).toBeNull();
      expect(end!.labels).toEqual(["beta", "enterprise"]);
    });

    it("a read that never answers stalls neither startup nor a call", async () => {
      const collector = useCollector(() => new Promise<Response>(() => {}));
      await drive(major, how, "claude-code");
      const [end] = ofType(collector, "tool_call_end");
      expect(end!.capture).toBeNull();
      expect(end!.payload.result).not.toBeNull();
    });

    it("one read starts at install and stops at close", async () => {
      useCollector(answering(null));
      const start = vi.spyOn(SettingsFetcher.prototype, "start");
      const stop = vi.spyOn(SettingsFetcher.prototype, "stop");
      await drive(major, how, "claude-code");
      expect(start).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledTimes(1);
    });

    it("two callers in different audiences see different tool lists", async () => {
      useCollector(answering(BETA_QUIET));
      const beta = (await drive(major, how, "claude-code")).listing;
      expect(beta.lookup.properties.user_goal.description).toBe(OPTIONAL);
      expect(beta.lookup.required ?? []).not.toContain("user_goal");
      expect(reportTools(beta)).toEqual([]);

      const other = (await drive(major, how, "cursor")).listing;
      expect(other.lookup.properties.user_goal.description).toBe(REQUIRED);
      expect(other.lookup.required).toContain("user_goal");
      expect(reportTools(other)).toHaveLength(1);
    });

    it("with no settings held the list and instructions are the code's", async () => {
      useCollector(answering(null));
      const { listing, instructions } = await drive(major, how, "claude-code");
      expect(listing.lookup.properties.user_goal.description).toBe(REQUIRED);
      expect(reportTools(listing)).toHaveLength(1);
      expect(instructions).toContain(reportTools(listing)[0]);
    });

    it("the pointer leaves the instructions when nobody has reports", async () => {
      useCollector(answering(NOBODY_REPORTS));
      expect((await drive(major, how, "claude-code")).instructions).toBe(INTENT_INSTRUCTIONS);
    });

    it("a caller without reports can still file one", async () => {
      const collector = useCollector(answering(BETA_QUIET));
      const server = lookupServer(major);
      const close = installOn(how, server, { dsn: DSN, settings: "console", resolvePrincipal: resolver });
      try {
        await settingsRead(collector);
        const client = await major.connect(server, { clientName: "claude-code" });
        const listed = ((await client.listTools()).tools as { name: string }[]).map((tool) => tool.name);
        expect(listed).toEqual(["lookup"]);
        const result = await client.callTool({
          name: "vendor_annotate",
          arguments: { tool_name: "lookup", user_goal: GOAL, what_happened: "no row for alice" },
        });
        expect(result.isError).toBeFalsy();
        await client.close();
      } finally {
        await close();
      }
      const [annotation] = ofType(collector, "annotation");
      expect(annotation!.capture).toEqual({ settings_version: 9, audience: "beta" });
      expect(annotation!.labels).toEqual(["beta", "enterprise"]);
    });
  });

  it("a removed subagent sentence stays removed", async () => {
    const collector = useCollector(answering(NOBODY_REPORTS));
    const server = major.make({ instructions: "Vendor text." });
    major.tool(server, "ask", { user_goal: z.string() }, () => ({ content: [] }));
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const handle = withBaton(server, { dsn: DSN, settings: "console" });
    try {
      await settingsRead(collector);
      const client = await major.connect(server);
      await client.listTools();
      await client.close();
      expect(server.server._instructions).toBe("Vendor text.");
    } finally {
      await handle.aclose();
    }
  });

  it("a server built after the settings arrive starts without the pointer", async () => {
    const collector = useCollector(answering(NOBODY_REPORTS));
    const baton = createBaton({ dsn: DSN, settings: "console" });
    try {
      await settingsRead(collector);
      for (let i = 0; i < 2; i++) {
        const server = lookupServer(major);
        baton.wrap(server);
        expect(server.server._instructions).toBe(INTENT_INSTRUCTIONS);
      }
      expect(collector.settingsReads).toHaveLength(1);
    } finally {
      await baton.aclose();
    }
  });

  it("a failed install reads no settings", () => {
    useCollector(answering(null));
    const start = vi.spyOn(SettingsFetcher.prototype, "start");
    expect(() => withBaton({} as never, { dsn: DSN, settings: "console" })).toThrow(/high-level McpServer/);
    expect(start).not.toHaveBeenCalled();
  });
});

describe("the config", () => {
  it.each<[Partial<BatonConfig> | Record<string, unknown>, RegExp]>([
    [{ settings: "cloud", dsn: DSN }, /settings/],
    [{ settings: "console", vendorId: "srv", vendorDisplayName: "S" }, /needs a dsn/],
    [{ settingsRefreshMs: 5000, dsn: DSN }, /15000/],
    [{ settingsRefreshMs: Number.NaN, dsn: DSN }, /15000/],
    [{ settingsRefreshMs: Number.POSITIVE_INFINITY, dsn: DSN }, /15000/],
    [{ settingsRefreshMs: "60000", dsn: DSN }, /15000/],
    [{ settingsRefreshMs: 1e12, dsn: DSN }, /2147483647/],
  ])("refuses bad settings at install: %j", (config, message) => {
    expect(() => withBaton(MAJORS[0]!.make(), config as BatonConfig)).toThrow(message);
  });

  it("reads with the DSN's key and workspace", async () => {
    const collector = useCollector(answering(null));
    const handle = withBaton(MAJORS[0]!.make(), { dsn: DSN, settings: "console" });
    await settingsRead(collector);
    await handle.aclose();
    const [read] = collector.settingsReads;
    expect(read!.url).toBe("https://ingest.example.com/v0/settings?server=srv");
    expect(read!.headers.get("Authorization")).toBe(`Bearer ${KEY}`);
    expect(read!.headers.get("X-Baton-Tenant-Id")).toBe(WORKSPACE);
  });

  it("console mode turns reports on, unless the vendor turns them off", () => {
    expect(resolveBatonConfig({ dsn: DSN, settings: "console" }).reportMode).toBe("on");
    expect(resolveBatonConfig({ dsn: DSN, settings: "console", reportMode: "off" }).reportMode).toBe("off");
    expect(resolveBatonConfig({ dsn: DSN }).reportMode).toBeUndefined();
  });

  it("a DSN from the environment turns reports on", () => {
    process.env.BATON_DSN = DSN;
    expect(resolveBatonConfig({ settings: "console" }).reportMode).toBe("on");
  });

  it("logging the config shows no key", () => {
    const config = resolveBatonConfig({ dsn: DSN, settings: "console" });
    expect(config.captureSettings).toBeDefined();
    expect(inspect(config, { depth: null, showHidden: true })).not.toContain(KEY);
    expect(JSON.stringify(config)).not.toContain(KEY);
  });

  it("local settings build no read", () => {
    expect(resolveBatonConfig({ dsn: DSN }).captureSettings).toBeUndefined();
  });
});

/** A document a test can swap, with no network. */
class HeldDocument {
  document: SettingsDocument | null;
  constructor(body: string | null) {
    this.document = body === null ? null : parseDocument(body);
  }
  start(): void {}
  stop(): void {}
}

const OURS = buildServerInstructions({ vendorDisplayName: "Server", annotationToolName: "srv_annotate" });

function surfaceOn(holder: { _instructions?: string }, source: HeldDocument): PerCallerSurface {
  return new PerCallerSurface({
    settings: new CaptureSettings("srv", source),
    intentParamMode: "required",
    annotationToolName: "srv_annotate",
    instructions: OURS,
    writeInstructions: (text) => {
      holder._instructions = withVendorInstructions(holder, text);
    },
    injectsGoal: (name) => name === "lookup",
  });
}

function installed(vendor: string): { _instructions?: string } {
  const holder: { _instructions?: string } = { _instructions: vendor };
  holder._instructions = withVendorInstructions(holder, OURS);
  return holder;
}

describe("the instructions", () => {
  it("follow the held document both ways", () => {
    const source = new HeldDocument(NOBODY_REPORTS);
    const holder = installed("Vendor text.");
    const surface = surfaceOn(holder, source);

    surface.followSettings();
    expect(holder._instructions).toBe(`Vendor text.\n\n${INTENT_INSTRUCTIONS}`);
    source.document = null;
    surface.followSettings();
    expect(holder._instructions).toBe(`Vendor text.\n\n${OURS}`);
    source.document = parseDocument(BETA_QUIET);
    surface.followSettings();
    expect(holder._instructions).toBe(`Vendor text.\n\n${OURS}`);
  });

  it("keep the subagent sentence below text the vendor sets later", () => {
    const source = new HeldDocument(NOBODY_REPORTS);
    const holder = installed("Vendor text.");
    const surface = surfaceOn(holder, source);
    holder._instructions = "Later.";

    surface.followSettings();
    expect(holder._instructions).toBe(`Later.\n\n${INTENT_INSTRUCTIONS}`);
    source.document = null;
    surface.followSettings();
    expect(holder._instructions).toBe(`Later.\n\n${OURS}`);
  });
});

describe("the tool list", () => {
  const goalSchema = () => ({
    type: "object",
    properties: { name: { type: "string" }, user_goal: { type: "string", description: REQUIRED } },
    required: ["name", "user_goal"],
  });
  const beta = () => {
    const settings = parseDocument(BETA_QUIET)!.settingsFor(
      { labels: ["beta"], clientName: "claude-code", shareKey: null },
      "srv",
    );
    return { principal: null, organization: null, labels: [], settings };
  };
  const surface = () => surfaceOn({}, new HeldDocument(BETA_QUIET));

  it("is rewritten for the caller without changing what was served", () => {
    const result = {
      tools: [
        { name: "lookup", inputSchema: goalSchema() },
        { name: "srv_annotate", inputSchema: {} },
      ],
      nextCursor: "c",
    };
    const out = surface().toolsFor(result, beta()) as typeof result;
    expect(out.nextCursor).toBe("c");
    expect(out.tools.map((tool) => tool.name)).toEqual(["lookup"]);
    expect(out.tools[0]!.inputSchema).toEqual({
      ...goalSchema(),
      properties: { ...goalSchema().properties, user_goal: { type: "string", description: OPTIONAL } },
      required: ["name"],
    });
    expect(result.tools[0]!.inputSchema).toEqual(goalSchema());
  });

  it("leaves a tool's own user_goal as it is", () => {
    const own = { properties: { user_goal: { description: "the vendor's" } }, required: ["user_goal"] };
    const out = surface().toolsFor({ tools: [{ name: "ask", inputSchema: own }] }, beta()) as any;
    expect(out.tools[0].inputSchema).toEqual(own);
  });

  it("leaves a schema it cannot read as it is", () => {
    const odd = { properties: { user_goal: 3 } };
    const out = surface().toolsFor({ tools: [{ name: "lookup", inputSchema: odd }] }, beta()) as any;
    expect(out.tools[0].inputSchema).toEqual(odd);
  });

  it("is served unchanged to a caller on the code's settings", () => {
    const result = { tools: [] };
    const everyone = parseDocument(BETA_QUIET)!.settingsFor({ labels: [], clientName: null, shareKey: null }, "srv");
    expect(surface().toolsFor(result, { principal: null, organization: null, labels: [], settings: everyone })).toBe(
      result,
    );
    expect(surface().toolsFor(result, { principal: null, organization: null, labels: [] })).toBe(result);
  });
});
