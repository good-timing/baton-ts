/**
 * SPEC §11.4 — every event says where its `session_id` came from. A consumer
 * joins a stateless session only when every `"http"` event in it says
 * `"minted"`, so one emit site that leaves the field out switches the join off
 * for the whole session.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MAJORS, CapturingSink, install, type Major } from "./_majors.js";

const DOC_URI = "file:///doc.txt";

const EVERY_TYPE = [
  "surface_snapshot",
  "tool_list_start",
  "tool_list_end",
  "tool_call_start",
  "tool_call_end",
  "tool_call_error",
  "annotation",
  "resource_list_start",
  "resource_list_end",
  "resource_read_start",
  "resource_read_end",
  "prompt_list_start",
  "prompt_list_end",
  "prompt_get_start",
  "prompt_get_end",
];

async function driveEveryRequest(
  major: Major,
  sink: CapturingSink,
  sessionId?: string,
): Promise<string> {
  const server = major.make();
  major.tool(server, "works", { name: z.string() }, () => ({
    content: [{ type: "text" as const, text: "ok" }],
  }));
  major.tool(server, "boom", {}, () => {
    throw new Error("simulated failure");
  });
  major.resource(server, "doc", DOC_URI, () => ({ contents: [{ uri: DOC_URI, text: "x" }] }));
  major.prompt(server, "summarize", { topic: z.string() }, () => ({
    messages: [{ role: "user", content: { type: "text", text: "do it" } }],
  }));
  const handle = install(server, sink, { reportMode: "on" });
  const client = await major.connect(server, sessionId === undefined ? {} : { sessionId });

  await client.listTools();
  await client.callTool({ name: "works", arguments: { name: "p1", user_goal: "find p1" } });
  await client.callTool({ name: "boom", arguments: {} });
  await client.callTool({
    name: handle.annotationToolName,
    arguments: { user_goal: "look up", what_happened: "the call came back unusable" },
  });
  await client.listResources();
  await client.readResource({ uri: DOC_URI });
  await client.listPrompts();
  await client.getPrompt({ name: "summarize", arguments: { topic: "the quarter" } });
  return handle.sessionId;
}

const originsByType = (sink: CapturingSink): Record<string, string[]> => {
  const seen: Record<string, Set<string>> = {};
  for (const event of sink.events) {
    const wire = JSON.parse(JSON.stringify(event)) as Record<string, unknown>;
    (seen[event.event_type] ??= new Set()).add(
      `${String(wire["session_id"])} ${String(wire["session_id_origin"])}`,
    );
  }
  return Object.fromEntries(Object.entries(seen).map(([type, values]) => [type, [...values]]));
};

describe.each(MAJORS)("session_id_origin — $label", (major) => {
  it("is `minted` on every event when the transport reports no session", async () => {
    const sink = new CapturingSink();
    const installTimeId = await driveEveryRequest(major, sink);

    const origins = originsByType(sink);
    expect(Object.keys(origins)).toEqual(expect.arrayContaining(EVERY_TYPE));
    for (const [type, values] of Object.entries(origins)) {
      expect(values, type).toEqual([`${installTimeId} minted`]);
    }
  });

  it("is `observed` on every event of a call when the transport reports one", async () => {
    const sink = new CapturingSink();
    const installTimeId = await driveEveryRequest(major, sink, "from-transport");

    const origins = originsByType(sink);
    expect(Object.keys(origins)).toEqual(expect.arrayContaining(EVERY_TYPE));
    const { surface_snapshot: snapshot, ...perRequest } = origins;
    // The snapshot describes the server, outside any request.
    expect(snapshot).toEqual([`${installTimeId} minted`]);
    for (const [type, values] of Object.entries(perRequest)) {
      expect(values, type).toEqual(["from-transport observed"]);
    }
  });
});
