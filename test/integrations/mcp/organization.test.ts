import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { Organization, Principal } from "../../../src/index.js";
import { resolveCaller } from "../../../src/integrations/mcp/principalResolution.js";
import { CapturingSink, MAJORS, install, spyWarnings } from "./_majors.js";

const ACME: Organization = { organizationId: "org_acme", displayName: "Acme", form: "hashed" };
const ACME_WIRE = { id: "org_acme", source: "asserted", form: "hashed", display_name: "Acme" };
const PERSON_WIRE = { id: "u_123", source: "asserted", form: "raw" };

const call = { extra: {}, toolName: "lookup", arguments: {} };

/** `resolveCaller` from a fresh module: each kind of warning is printed once
 * per process. */
async function freshResolveCaller(): Promise<typeof resolveCaller> {
  vi.resetModules();
  return (await import("../../../src/integrations/mcp/principalResolution.js")).resolveCaller;
}

describe("resolveCaller", () => {
  it.each([
    ["a person and their company", { principalId: "u_123", organization: ACME }, PERSON_WIRE, ACME_WIRE],
    ["only the company", ACME, null, ACME_WIRE],
    ["an unusable person keeps the company", { principalId: "  ", organization: ACME }, null, ACME_WIRE],
    [
      "an unusable company keeps the person",
      { principalId: "u_123", organization: { organizationId: "" } },
      PERSON_WIRE,
      null,
    ],
    [
      "a company beside a person with no principalId key",
      { organization: ACME },
      null,
      ACME_WIRE,
    ],
    [
      "a userId beside a usable principalId",
      { principalId: "u_123", userId: "u_123" },
      PERSON_WIRE,
      null,
    ],
    [
      "a company that is not an object keeps the person",
      { principalId: "u_123", organization: "org_acme" as never },
      PERSON_WIRE,
      null,
    ],
  ] as const)("%s", async (_label, returned, principal, organization) => {
    expect(await resolveCaller(() => returned as Principal | Organization, call)).toEqual({
      principal,
      organization,
    });
  });
});

describe("an organization that is dropped", () => {
  it.each([
    [
      "an unusable organizationId",
      { principalId: "u_123", organization: { organizationId: " " } },
      "organization has no usable organizationId",
    ],
    ["no id at all", { principal_id: "u_123" }, "neither principalId nor organizationId"],
    ["a flat organizationId", { principalId: "u_123", organizationId: "o" }, "put the company in `organization`"],
  ])("is warned about: %s", async (_label, returned, message) => {
    const warnings = spyWarnings();
    try {
      const fresh = await freshResolveCaller();
      expect((await fresh(() => returned as never, call)).organization).toBeNull();
    } finally {
      warnings.restore();
    }
    expect(warnings.seen.join("\n")).toContain(message);
  });
});

it("reports each problem once, though the hook runs on every request", async () => {
  const fresh = await freshResolveCaller();
  const warnings = spyWarnings();
  try {
    for (let i = 0; i < 3; i++) await fresh(() => ({ principalId: "" }), call);
  } finally {
    warnings.restore();
  }
  expect(warnings.seen).toHaveLength(1);
});

it("keys that once on the kind of problem, not the vendor's value", async () => {
  const fresh = await freshResolveCaller();
  const warnings = spyWarnings();
  try {
    for (const form of ["a@x.example", "b@x.example", "c@x.example"]) {
      await fresh(() => ({ principalId: "u_123", form }) as never, call);
    }
  } finally {
    warnings.restore();
  }
  expect(warnings.seen).toHaveLength(1);
});

describe.each(MAJORS)("end to end on $label", (major) => {
  // Every emit path that resolves the hook: the tool call, a tools/list
  // request and the annotation tool.
  it.each([
    ["a person and their company", { principalId: "u_123", organization: ACME }, PERSON_WIRE, ACME_WIRE],
    ["only the company", ACME, null, ACME_WIRE],
  ] as const)("%s rides on every event", async (_label, returned, principal, organization) => {
    const server = major.make();
    major.tool(server, "lookup", { name: z.string() }, () => ({ content: [] }));
    const sink = new CapturingSink();
    const handle = install(server, sink, { resolvePrincipal: () => returned, reportMode: "on" });
    const client = await major.connect(server);
    await client.listTools();
    await client.callTool({ name: "lookup", arguments: { name: "x" } });
    await client.callTool({
      name: handle.annotationToolName,
      arguments: { user_goal: "look up", what_happened: "it returned nothing" },
    });
    const events = sink.events.filter((e) => e.event_type !== "surface_snapshot");
    expect(new Set(events.map((e) => e.event_type))).toEqual(
      new Set(["tool_list_start", "tool_list_end", "tool_call_start", "tool_call_end", "annotation"]),
    );
    for (const event of events) {
      expect([event.event_type, event.principal, event.organization]).toEqual([
        event.event_type,
        principal,
        organization,
      ]);
    }
  });
});
