/**
 * The off switch — `BATON_DISABLED=1`.
 *
 * Two claims, and they are the ones the design note wrote down before anyone
 * built this:
 *
 * 1. **Install NOTHING.** Not capture-and-discard. The vendor's server comes
 *    up exactly as it would with no `withBaton` call in the file — same tool
 *    behaviour, same instructions, no annotation tool on the surface, no
 *    events.
 * 2. **Never throw, and never touch stdout.** A stdio MCP server speaks
 *    JSON-RPC on stdout, so a courteous "Baton is disabled" line there breaks
 *    the server in exactly the deployment this switch exists for. And a switch
 *    that can still abort a boot is worse than no switch, so configs that
 *    would otherwise be refused must come back with a handle instead.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withBaton } from "../src/integrations/mcp/withBaton.js";
import { captureDisabled, DisabledSink } from "../src/optout.js";
import type { Event } from "../src/events.js";
import type { Sink } from "../src/sinks.js";

const KEY = "baton_pk_" + "a".repeat(43);
const DSN = `https://${KEY}@ingest.example.com/ten_${"6".repeat(32)}/echo-server`;

class CapturingSink implements Sink {
  readonly events: Event[] = [];
  closed = false;
  async write(event: Event): Promise<void> {
    this.events.push(event);
  }
  async flush(): Promise<void> {}
  async aclose(): Promise<void> {
    this.closed = true;
  }
}

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function vendorServer(): McpServer {
  const server = new McpServer({ name: "vendor", version: "1.0.0" }, { instructions: "vendor text" });
  server.registerTool("echo", { inputSchema: { text: z.string() } }, async (args: { text: string }) => ({
    content: [{ type: "text" as const, text: args.text }],
  }));
  return server;
}

beforeEach(() => {
  // Silenced, not asserted-on here: the line itself has its own test below.
  vi.spyOn(process, "emitWarning").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.BATON_DISABLED;
});

describe("what counts as off", () => {
  it.each(["1", "true", "yes", "TRUE", "anything at all", " 1 "])(
    "treats %o as disabled",
    (value) => {
      process.env.BATON_DISABLED = value;
      expect(captureDisabled()).toBe("BATON_DISABLED");
    },
  );

  it.each(["", "0", "false", "no", "off", "FALSE", " off "])(
    "leaves capture ON for %o",
    (value) => {
      // Permissive toward the opt-out, on purpose — but an explicit "off"
      // value is a person saying they want capture, and must not be read as
      // them asking for silence.
      process.env.BATON_DISABLED = value;
      expect(captureDisabled()).toBeNull();
    },
  );

  it("is off when the variable is absent", () => {
    expect(captureDisabled()).toBeNull();
  });
});

describe("off means install nothing", () => {
  it("leaves the vendor's tool call uncaptured and unchanged", async () => {
    process.env.BATON_DISABLED = "1";
    const sink = new CapturingSink();
    const server = vendorServer();
    withBaton(server, { vendorId: "acme", vendorDisplayName: "Acme", consentToken: "ct", sink });

    const client = await connect(server);
    const result = await client.callTool({ name: "echo", arguments: { text: "hi" } });
    await client.close();

    // The vendor's own behaviour is untouched...
    expect(result.content).toEqual([{ type: "text", text: "hi" }]);
    // ...and nothing was captured. Not "captured and dropped" — the wrap never
    // happened, which is what makes this different from a discard sink.
    expect(sink.events).toEqual([]);
  });

  it("puts no annotation tool on the surface", async () => {
    process.env.BATON_DISABLED = "1";
    const server = vendorServer();
    withBaton(server, { vendorId: "acme", vendorDisplayName: "Acme", consentToken: "ct" });

    const client = await connect(server);
    const listed = await client.listTools();
    await client.close();

    expect(listed.tools.map((tool) => tool.name)).toEqual(["echo"]);
  });

  it("leaves the vendor's instructions alone", async () => {
    process.env.BATON_DISABLED = "1";
    const server = vendorServer();
    withBaton(server, { vendorId: "acme", vendorDisplayName: "Acme", consentToken: "ct" });

    const client = await connect(server);
    const instructions = client.getInstructions();
    await client.close();

    expect(instructions).toBe("vendor text");
  });

  it("injects no intent params into the vendor's schema", async () => {
    process.env.BATON_DISABLED = "1";
    const server = vendorServer();
    withBaton(server, { vendorId: "acme", vendorDisplayName: "Acme", consentToken: "ct" });

    const client = await connect(server);
    const listed = await client.listTools();
    await client.close();

    const properties = listed.tools[0]?.inputSchema?.properties ?? {};
    expect(Object.keys(properties)).toEqual(["text"]);
  });
});

describe("the switch cannot break a server", () => {
  it("returns a handle for a config that would otherwise be refused", () => {
    // A promise of "set this and Baton stops" that can still abort a boot is
    // worse than no switch at all. This config has no vendorId and no dsn, so
    // with capture on it throws.
    process.env.BATON_DISABLED = "1";
    expect(() => withBaton(vendorServer(), {})).not.toThrow();
  });

  it("does not even parse a broken DSN", () => {
    // The guard sits ahead of config resolution for this reason: resolving
    // would throw on the string below, and would build an HttpSink for capture
    // that is not going to happen.
    process.env.BATON_DISABLED = "1";
    expect(() => withBaton(vendorServer(), { dsn: "not-a-dsn" })).not.toThrow();
  });

  it("hands back a handle whose flush and aclose are safe to call", async () => {
    process.env.BATON_DISABLED = "1";
    const handle = withBaton(vendorServer(), { vendorId: "acme", vendorDisplayName: "Acme", consentToken: "ct" });

    expect(handle.sink).toBeInstanceOf(DisabledSink);
    await expect(handle.flush()).resolves.toBeUndefined();
    await expect(handle.aclose()).resolves.toBeUndefined();
  });

  it("names nothing it did not resolve", () => {
    // An invented session id would put a real identifier on a handle whose
    // whole meaning is that no events exist under it.
    process.env.BATON_DISABLED = "1";
    const handle = withBaton(vendorServer(), { dsn: DSN });
    expect(handle.vendorId).toBe("");
    expect(handle.annotationToolName).toBe("");
    expect(handle.sessionId).toBe("baton-disabled");
  });

  it("still releases a sink the VENDOR constructed", async () => {
    // We took ownership of that object the moment they passed it, and the
    // switch does not undo that — their `finally { handle.aclose() }` must
    // still work.
    process.env.BATON_DISABLED = "1";
    const sink = new CapturingSink();
    const handle = withBaton(vendorServer(), { vendorId: "acme", vendorDisplayName: "Acme", consentToken: "ct", sink });

    expect(handle.sink).toBe(sink);
    await handle.aclose();
    expect(sink.closed).toBe(true);
  });
});

describe("nothing on stdout", () => {
  it("writes the disabled notice to stderr and never to stdout", () => {
    // A stdio MCP server speaks JSON-RPC on stdout. A courteous line there
    // corrupts the stream and breaks the server — in precisely the deployment
    // this switch exists for, which is why this is asserted rather than
    // assumed from the choice of function.
    process.env.BATON_DISABLED = "1";
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderr = vi.spyOn(process, "emitWarning").mockImplementation(() => {});

    withBaton(vendorServer(), { vendorId: "acme", vendorDisplayName: "Acme", consentToken: "ct" });

    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledOnce();
    expect(String(stderr.mock.calls[0]?.[0])).toContain("BATON_DISABLED");
  });
});

describe("read once, at install", () => {
  it("keeps capture on for a process that started with it on", async () => {
    // A boot-time switch, not a live one: a re-read per event would let a
    // mid-flight environment change split one session's events across two
    // answers.
    const sink = new CapturingSink();
    const server = vendorServer();
    withBaton(server, { vendorId: "acme", vendorDisplayName: "Acme", consentToken: "ct", sink });

    process.env.BATON_DISABLED = "1";
    const client = await connect(server);
    await client.callTool({ name: "echo", arguments: { text: "hi" } });
    await client.close();

    expect(sink.events.length).toBeGreaterThan(0);
  });

  it("keeps capture off for a process that started with it off", async () => {
    process.env.BATON_DISABLED = "1";
    const sink = new CapturingSink();
    const server = vendorServer();
    withBaton(server, { vendorId: "acme", vendorDisplayName: "Acme", consentToken: "ct", sink });

    delete process.env.BATON_DISABLED;
    const client = await connect(server);
    await client.callTool({ name: "echo", arguments: { text: "hi" } });
    await client.close();

    expect(sink.events).toEqual([]);
  });
});
