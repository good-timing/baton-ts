/**
 * The server's own name reaches the calling agent, on both SDK majors.
 *
 * The console's recipe is `withBaton(server, { dsn })`, and a DSN's server
 * segment is an opaque `srv-<8 hex>`. A stranger's walk of the self-serve lane
 * on 2026-09-14 was shown that id twice, as the annotate tool's name and as
 * what the instructions called the vendor, on a server its author had named
 * `toybox-pantry`. Both labels now come from the server, under one rule shared
 * with the Python SDK: `src/integrations/mcp/annotationName.ts`.
 *
 * Asserted through a real client where the name is one a client accepts,
 * because what matters is what the agent is shown: `tools/list` and the
 * instructions from `initialize`. The guard cases install without connecting,
 * since a client refuses a non-string server name in the handshake itself.
 */

import { McpServer as McpServerV1 } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client as ClientV1 } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport as TransportV1 } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  McpServer as McpServerV2,
  InMemoryTransport as TransportV2,
} from "@modelcontextprotocol/server";
import { Client as ClientV2 } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { withBaton } from "../../../src/integrations/mcp/withBaton.js";
import type { BatonConfig } from "../../../src/integrations/mcp/config.js";
import { usableServerName } from "../../../src/integrations/mcp/annotationName.js";
import { buildServerInstructions } from "../../../src/integrations/mcp/llmText.js";

const KEY = "baton_pk_" + "a".repeat(43);
const SEGMENT = "srv-c8eca135";
const DSN = `https://${KEY}@ingest.example.com/ten_37714baa/${SEGMENT}`;
const CAP = 1500;

interface Seen {
  handleToolName: string;
  toolNames: string[];
  instructions: string;
  description: string;
}

/** Install, connect a real client, and read what the agent would read. */
async function seenOnV1(serverName: string, config: BatonConfig): Promise<Seen> {
  const server = new McpServerV1({ name: serverName, version: "1.0.0" });
  const handle = withBaton(server, config);
  const [clientTransport, serverTransport] = TransportV1.createLinkedPair();
  const client = new ClientV1({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  const annotate = tools.find((t) => t.name === handle.annotationToolName);
  const seen = {
    handleToolName: handle.annotationToolName,
    toolNames: tools.map((t) => t.name),
    instructions: client.getInstructions() ?? "",
    description: annotate?.description ?? "",
  };
  await client.close();
  await handle.aclose();
  return seen;
}

async function seenOnV2(serverName: string, config: BatonConfig): Promise<Seen> {
  const server = new McpServerV2({ name: serverName, version: "1.0.0" });
  const handle = withBaton(server, config);
  const [clientTransport, serverTransport] = TransportV2.createLinkedPair();
  const client = new ClientV2({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  const annotate = tools.find((t) => t.name === handle.annotationToolName);
  const seen = {
    handleToolName: handle.annotationToolName,
    toolNames: tools.map((t) => t.name),
    instructions: client.getInstructions() ?? "",
    description: annotate?.description ?? "",
  };
  await client.close();
  await handle.aclose();
  return seen;
}

/** Install only, and read the text off the server. For names no client would
 * accept in a handshake. */
function installedOnV1(server: McpServerV1, config: BatonConfig): Seen {
  const handle = withBaton(server, config);
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const internals = server as any;
  const seen = {
    handleToolName: handle.annotationToolName,
    toolNames: Object.keys(internals._registeredTools as Record<string, unknown>),
    instructions: internals.server._instructions as string,
    description: internals._registeredTools[handle.annotationToolName].description as string,
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return seen;
}

const MAJORS = [
  ["@modelcontextprotocol/sdk 1.x", seenOnV1],
  ["@modelcontextprotocol/server 2.x", seenOnV2],
] as const;

let warnings: string[];

beforeEach(() => {
  warnings = [];
  vi.spyOn(process, "emitWarning").mockImplementation((warning: string | Error) => {
    warnings.push(String(warning));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each(MAJORS)("on %s", (_label, seen) => {
  it("names the tool and the vendor after the server, never the DSN segment", async () => {
    const s = await seen("toybox-pantry", { dsn: DSN });

    expect(s.handleToolName).toBe("toybox-pantry_annotate");
    expect(s.toolNames).toContain("toybox-pantry_annotate");
    expect(s.instructions).toMatch(
      /^This server is wrapped in the toybox-pantry usage and friction SDK\. Use `toybox-pantry_annotate` /,
    );
    expect(s.description).toMatch(/^Report a toybox-pantry tool call that went wrong/);
    for (const text of [s.instructions, s.description, ...s.toolNames]) {
      expect(text).not.toContain(SEGMENT);
    }
  });

  it("falls back to the DSN segment in both places for a library's default name", async () => {
    // `fastmcp` is what Python's own libraries call a server nobody named. No
    // TypeScript peer supplies a default, but the rule is one rule across both
    // SDKs, so the string is refused here too.
    const s = await seen("fastmcp", { dsn: DSN });

    expect(s.handleToolName).toBe(`${SEGMENT}_annotate`);
    expect(s.instructions).toMatch(
      new RegExp(`^This server is wrapped in the ${SEGMENT} usage and friction SDK\\.`),
    );
    expect(s.description).toMatch(new RegExp(`^Report a ${SEGMENT} tool call`));
    expect(s.instructions).not.toContain("fastmcp");
  });

  it("lets an explicit vendorDisplayName and annotationToolName win", async () => {
    const s = await seen("toybox-pantry", {
      dsn: DSN,
      vendorDisplayName: "Toybox Pantry",
      annotationToolName: "pantry_feedback",
    });

    expect(s.handleToolName).toBe("pantry_feedback");
    expect(s.toolNames).not.toContain("toybox-pantry_annotate");
    expect(s.instructions).toMatch(/^This server is wrapped in the Toybox Pantry usage/);
    expect(s.instructions).toContain("`pantry_feedback`");
    expect(s.description).toMatch(/^Report a Toybox Pantry tool call/);
  });

  it("derives both from a 30-char server name and stays under the instructions cap", async () => {
    // 30 is the slug cap, and the longest name that derives both labels with
    // nothing cut. Verbatim for the display name, slugged for the tool.
    const name = "Toybox Pantry Inventory Helper";
    expect(name).toHaveLength(30);
    const s = await seen(name, { dsn: DSN });

    expect(s.handleToolName).toBe("toybox-pantry-inventory-helper_annotate");
    expect(s.instructions).toMatch(/^This server is wrapped in the Toybox Pantry Inventory Helper usage/);
    expect(s.instructions.length).toBeLessThanOrEqual(CAP);
    expect(warnings).toEqual([]);
  });
});

describe("each explicit field wins on its own", () => {
  it("an explicit display name leaves the tool name derived", async () => {
    const s = await seenOnV1("toybox-pantry", { dsn: DSN, vendorDisplayName: "Toybox Pantry" });
    expect(s.handleToolName).toBe("toybox-pantry_annotate");
    expect(s.instructions).toMatch(/^This server is wrapped in the Toybox Pantry usage/);
  });

  it("an explicit tool name leaves the display name derived", async () => {
    const s = await seenOnV1("toybox-pantry", { dsn: DSN, annotationToolName: "pantry_feedback" });
    expect(s.handleToolName).toBe("pantry_feedback");
    expect(s.instructions).toMatch(/^This server is wrapped in the toybox-pantry usage/);
  });
});

describe("with no DSN", () => {
  it("still derives the tool name, as Python 0.8.3 does, and keeps the explicit display name", async () => {
    const s = await seenOnV1("toybox-pantry", {
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
    });
    expect(s.handleToolName).toBe("toybox-pantry_annotate");
    expect(s.instructions).toMatch(/^This server is wrapped in the Acme usage/);
  });

  it("does not take the display name from the server: it stays required", () => {
    const server = new McpServerV1({ name: "toybox-pantry", version: "1.0.0" });
    expect(() => withBaton(server, { vendorId: "acme", consentToken: "ct" })).toThrow(
      /vendorDisplayName is required/,
    );
  });
});

describe("the guards", () => {
  it("falls back for a name that is not a string", () => {
    const server = new McpServerV1({ name: 42 as unknown as string, version: "1.0.0" });
    const s = installedOnV1(server, { dsn: DSN });
    expect(s.handleToolName).toBe(`${SEGMENT}_annotate`);
    expect(s.instructions).toMatch(new RegExp(`^This server is wrapped in the ${SEGMENT} usage`));
  });

  it("falls back for a blank name, which validation would otherwise refuse", () => {
    const s = installedOnV1(new McpServerV1({ name: "   ", version: "1.0.0" }), { dsn: DSN });
    expect(s.handleToolName).toBe(`${SEGMENT}_annotate`);
    expect(s.instructions).toMatch(new RegExp(`^This server is wrapped in the ${SEGMENT} usage`));
  });

  it("refuses `<ClassName>-<4 hex>`, matched on the server's own class", () => {
    class PantryServer extends McpServerV1 {}
    const own = installedOnV1(new PantryServer({ name: "PantryServer-9f2a", version: "1.0.0" }), {
      dsn: DSN,
    });
    expect(own.handleToolName).toBe(`${SEGMENT}_annotate`);

    const base = installedOnV1(new McpServerV1({ name: "McpServer-1a2b", version: "1.0.0" }), {
      dsn: DSN,
    });
    expect(base.handleToolName).toBe(`${SEGMENT}_annotate`);
  });

  it("keeps a real name that happens to end in hex", () => {
    // Hex spells words. A bare trailing `-[0-9a-f]{4}` rule would throw this
    // name away; matching the class name is what keeps it.
    const s = installedOnV1(new McpServerV1({ name: "toybox-cafe", version: "1.0.0" }), {
      dsn: DSN,
    });
    expect(s.handleToolName).toBe("toybox-cafe_annotate");
    expect(s.instructions).toMatch(/^This server is wrapped in the toybox-cafe usage/);
  });

  it("falls back, and says so, when reading the name throws", () => {
    // Unit-level: a throwing getter on the serverInfo a vendor passed would
    // also throw from the surface snapshot's own read of it, and from the
    // SDK's handshake, neither of which this rule covers.
    expect(
      usableServerName(() => {
        throw new Error("boom");
      }),
    ).toBeUndefined();
    expect(warnings.join("\n")).toMatch(/reading the server name failed/);
  });
});

describe("the instructions cap", () => {
  it("still throws on text over the cap: the budget is real", () => {
    expect(() =>
      buildServerInstructions({ vendorDisplayName: "x".repeat(200), annotationToolName: "t" }),
    ).toThrow(/exceeds the 1500-char safety cap/);
  });

  it("drops a display name too long to fit and keeps the derived tool name", () => {
    const s = installedOnV1(new McpServerV1({ name: "x".repeat(200), version: "1.0.0" }), {
      dsn: DSN,
    });
    expect(s.instructions).toMatch(new RegExp(`^This server is wrapped in the ${SEGMENT} usage`));
    expect(s.handleToolName).toBe(`${"x".repeat(30)}_annotate`);
    expect(s.instructions.length).toBeLessThanOrEqual(CAP);
    expect(warnings.join("\n")).toMatch(/does not fit the server-instructions budget as the display name/);
  });

  it("resolves the display name first, so the tool name is the one that gives way", () => {
    // 90 chars fits beside `srv-c8eca135_annotate` (21) but not beside the
    // 39-char derived tool name. The order is the one Python's parallel pass
    // implements: its tool-name check already measures against the resolved
    // display name.
    const name = "y".repeat(90);
    const s = installedOnV1(new McpServerV1({ name, version: "1.0.0" }), { dsn: DSN });
    expect(s.instructions).toMatch(new RegExp(`^This server is wrapped in the ${name} usage`));
    expect(s.handleToolName).toBe(`${SEGMENT}_annotate`);
    expect(s.instructions.length).toBeLessThanOrEqual(CAP);
  });
});
