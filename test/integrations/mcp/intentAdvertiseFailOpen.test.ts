/**
 * The `tools/list` seam fails OPEN, through the real protocol path: with its
 * transform forced to throw, the vendor's `tools/list` still answers with the
 * SDK's own result, and calls still run.
 *
 * A module mock is the only way to make Baton's own code throw inside a real
 * request, and `vi.mock` applies to the whole file, so this lives apart from
 * `intentAdvertise.test.ts`.
 */

import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";

import { withBaton } from "../../../src/integrations/mcp/withBaton.js";
import { CapturingSink, MAJORS } from "./_majors.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

vi.mock("../../../src/integrations/mcp/schemaCompat.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    advertiseUserGoalRequired: () => {
      throw new Error("seam boom");
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each(MAJORS.map((m) => [m.label, m] as const))("on %s", (_label, major) => {
  it("serves the SDK's own tools/list when the seam throws, and logs it", async () => {
    const written: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
      written.push(String(chunk));
      return true;
    });

    const server = major.make();
    major.tool(server, "lookup", { name: z.string() }, async (args: any) => ({
      content: [{ type: "text" as const, text: `found ${String(args.name)}` }],
    }));
    // The default mode, "required", is the one that installs the seam.
    withBaton(server, {
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
      sink: new CapturingSink(),
    });
    const client = await major.connect(server);

    const { tools } = await client.listTools();
    const lookup = (tools as any[]).find((t) => t.name === "lookup");
    // The SDK's own rendering: injection is there, the advertisement is not.
    expect(lookup.inputSchema.required).toEqual(["name"]);
    expect(lookup.inputSchema.properties).toHaveProperty("user_goal");
    expect(written.join("")).toMatch(
      /baton: tools\/list advertisement failed; serving the SDK's own result: Error: seam boom/,
    );

    const res = await client.callTool({ name: "lookup", arguments: { name: "alice" } });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toBe("found alice");
  });
});
