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
import {
  annotationToolNameFromServer,
  usableServerName,
} from "../../../src/integrations/mcp/annotationName.js";
import {
  buildServerInstructions,
  INSTRUCTIONS_SUBAGENT_CLAUSE,
  fitsInstructionsCap,
} from "../../../src/integrations/mcp/llmText.js";

const KEY = "baton_pk_" + "a".repeat(43);
const SEGMENT = "srv-c8eca135";
const DSN = `https://${KEY}@ingest.example.com/ten_37714baa/${SEGMENT}`;
const CAP = 1500;

/** The part of the instructions the cap budgets: the subagent sentence has no
 * names in it and sits outside it. */
function budgeted(instructions: string): number {
  expect(instructions.endsWith(INSTRUCTIONS_SUBAGENT_CLAUSE)).toBe(true);
  return instructions.length - INSTRUCTIONS_SUBAGENT_CLAUSE.length;
}

interface Seen {
  handleToolName: string;
  toolNames: string[];
  instructions: string;
  description: string;
}

/** Install, connect a real client, and read what the agent would read. */
async function seenOnV1(serverName: string, config: BatonConfig): Promise<Seen> {
  const server = new McpServerV1({ name: serverName, version: "1.0.0" });
  const handle = withBaton(server, { reportMode: "on", ...config });
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
  const handle = withBaton(server, { reportMode: "on", ...config });
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
  const handle = withBaton(server, { reportMode: "on", ...config });
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
      /^Use `toybox-pantry_annotate` to report a toybox-pantry tool call /,
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
      new RegExp(`^Use \`${SEGMENT}_annotate\` to report a ${SEGMENT} tool call`),
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
    expect(s.instructions).toMatch(/^Use `[^`]*` to report a Toybox Pantry tool call/);
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
    expect(s.instructions).toMatch(/^Use `[^`]*` to report a Toybox Pantry Inventory Helper tool call/);
    expect(budgeted(s.instructions)).toBeLessThanOrEqual(CAP);
    // The DSN's host is unreachable, so the sink's own close warning is expected.
    expect(warnings.filter((w) => !w.includes("unsent"))).toEqual([]);
  });
});

describe("each explicit field wins on its own", () => {
  it("an explicit display name leaves the tool name derived", async () => {
    const s = await seenOnV1("toybox-pantry", { dsn: DSN, vendorDisplayName: "Toybox Pantry" });
    expect(s.handleToolName).toBe("toybox-pantry_annotate");
    expect(s.instructions).toMatch(/^Use `[^`]*` to report a Toybox Pantry tool call/);
  });

  it("an explicit tool name leaves the display name derived", async () => {
    const s = await seenOnV1("toybox-pantry", { dsn: DSN, annotationToolName: "pantry_feedback" });
    expect(s.handleToolName).toBe("pantry_feedback");
    expect(s.instructions).toMatch(/^Use `[^`]*` to report a toybox-pantry tool call/);
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
    expect(s.instructions).toMatch(/^Use `[^`]*` to report a Acme tool call/);
  });

  it("does not take the display name from the server: reports still need one", () => {
    const server = new McpServerV1({ name: "toybox-pantry", version: "1.0.0" });
    expect(() =>
      withBaton(server, { vendorId: "acme", consentToken: "ct", reportMode: "on" }),
    ).toThrow(/needs a vendorDisplayName with reportMode: "on"/);
  });
});

describe("the guards", () => {
  it("falls back for a name that is not a string", () => {
    const server = new McpServerV1({ name: 42 as unknown as string, version: "1.0.0" });
    const s = installedOnV1(server, { dsn: DSN });
    expect(s.handleToolName).toBe(`${SEGMENT}_annotate`);
    expect(s.instructions).toMatch(new RegExp(`^Use \`[^\`]*\` to report a ${SEGMENT} tool call`));
  });

  it("falls back for a blank name, which validation would otherwise refuse", () => {
    const s = installedOnV1(new McpServerV1({ name: "   ", version: "1.0.0" }), { dsn: DSN });
    expect(s.handleToolName).toBe(`${SEGMENT}_annotate`);
    expect(s.instructions).toMatch(new RegExp(`^Use \`[^\`]*\` to report a ${SEGMENT} tool call`));
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
    expect(s.instructions).toMatch(/^Use `[^`]*` to report a toybox-cafe tool call/);
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
      buildServerInstructions({ vendorDisplayName: "x".repeat(1500), annotationToolName: "t" }),
    ).toThrow(/exceeds the 1500-char safety cap/);
  });

  it("drops a display name too long to fit and keeps the derived tool name", () => {
    const s = installedOnV1(new McpServerV1({ name: "x".repeat(1500), version: "1.0.0" }), {
      dsn: DSN,
    });
    expect(s.instructions).toMatch(new RegExp(`^Use \`[^\`]*\` to report a ${SEGMENT} tool call`));
    expect(s.handleToolName).toBe(`${"x".repeat(30)}_annotate`);
    expect(budgeted(s.instructions)).toBeLessThanOrEqual(CAP);
    expect(warnings.join("\n")).toMatch(/does not fit the server-instructions budget as the display name/);
  });

  it("gives the readable name to the TOOL when only one of the two fits", () => {
    // The Python SDK's tie-break. The tie is found by rendering rather than
    // written down as a length: the shortest name that fits beside
    // `srv-c8eca135_annotate` but not beside its own readable tool name.
    const readable = (n: number) => `${"q".repeat(Math.min(n, 30))}_annotate`;
    let tie = 0;
    for (let n = 31; n <= 1500 && tie === 0; n++) {
      const name = "q".repeat(n);
      const both = fitsInstructionsCap({ vendorDisplayName: name, annotationToolName: readable(n) });
      const displayOnly = fitsInstructionsCap({
        vendorDisplayName: name,
        annotationToolName: `${SEGMENT}_annotate`,
      });
      if (!both && displayOnly) tie = n;
    }
    expect(tie, "no length ties under the current template").toBeGreaterThan(30);

    const s = installedOnV1(new McpServerV1({ name: "q".repeat(tie), version: "1.0.0" }), {
      dsn: DSN,
    });
    expect(s.handleToolName).toBe(readable(tie));
    expect(s.instructions).toMatch(new RegExp(`^Use \`[^\`]*\` to report a ${SEGMENT} tool call`));
    expect(budgeted(s.instructions)).toBeLessThanOrEqual(CAP);

    // One shorter, both fit, and both stay readable.
    const below = installedOnV1(
      new McpServerV1({ name: "q".repeat(tie - 1), version: "1.0.0" }),
      { dsn: DSN },
    );
    expect(below.handleToolName).toBe(readable(tie - 1));
    expect(below.instructions).toMatch(
      new RegExp(`^Use \`[^\`]*\` to report a ${"q".repeat(tie - 1)} tool call`),
    );
  });

  it("never changes the tool name and never throws, over every length up to the cap", () => {
    // The Python SDK's sweep, the same two properties. The tool name is the one
    // the tool-name rule gives beside the DSN segment: the display name is the
    // only thing that moves. And the pair always renders, so a cosmetic default
    // never stops a boot.
    let moved = 0;
    let kept = 0;
    for (let n = 1; n <= CAP; n++) {
      const name = "p".repeat(n);
      let s: Seen | undefined;
      expect(() => {
        s = installedOnV1(new McpServerV1({ name, version: "1.0.0" }), { dsn: DSN });
      }, `length ${n}`).not.toThrow();
      const besideTheSegment = annotationToolNameFromServer(name, SEGMENT) ?? `${SEGMENT}_annotate`;
      expect(s!.handleToolName, `length ${n}`).toBe(besideTheSegment);
      expect(budgeted(s!.instructions), `length ${n}`).toBeLessThanOrEqual(CAP);
      const display = /^Use `[^`]*` to report a (.*?) tool call that went wrong/.exec(
        s!.instructions,
      )?.[1];
      if (display !== SEGMENT) {
        expect(display, `length ${n}`).toBe(name);
        moved += 1;
      } else {
        kept += 1;
      }
    }
    // Anchored: without them the sweep passes if the display name always, or
    // never, moves.
    expect(moved).toBeGreaterThanOrEqual(30);
    expect(kept).toBeGreaterThan(0);
  });
});
