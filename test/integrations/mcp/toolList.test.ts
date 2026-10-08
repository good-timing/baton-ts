/** SPEC §11.4.5: a `tools/list` request is recorded, whether or not a tool is
 * then called. Driven through a real client on both majors. */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MAJORS, CapturingSink, install } from "./_majors.js";

const INTENT_PARAMS = ["user_goal", "expected_result", "overall_task"];

describe.each(MAJORS)("tool list events — $label", (major) => {
  const withLookup = (): unknown => {
    const server = major.make();
    major.tool(server, "lookup", { name: z.string() }, () => ({
      content: [{ type: "text", text: "found" }],
    }));
    return server;
  };

  const typesOf = (sink: CapturingSink): string[] => sink.events.map((e) => e.event_type);

  it("a client that only lists the tools leaves a start and an end", async () => {
    const sink = new CapturingSink();
    const server = withLookup();
    install(server, sink);
    const client = await major.connect(server);

    const listed = (await client.listTools()) as { tools: { name: string }[] };

    expect(typesOf(sink)).toEqual(["tool_list_start", "tool_list_end"]);
    const [start, end] = sink.events;
    expect(start!.payload).toEqual({});
    expect(Object.keys(end!.payload).sort()).toEqual(["count", "duration_ms"]);
    expect(listed.tools.map((t) => t.name)).toContain("lookup");
    expect((end!.payload as { count: number }).count).toBe(listed.tools.length);
    expect(end!.session_id).toBe(start!.session_id);
  });

  it("is sent by a server that had no tool when it was wrapped", async () => {
    const sink = new CapturingSink();
    const server = major.make();
    install(server, sink);
    const client = await major.connect(server);

    await client.listTools();

    expect(typesOf(sink)).toEqual(["tool_list_start", "tool_list_end"]);
  });

  it("carries no tool name", async () => {
    const sink = new CapturingSink();
    const server = withLookup();
    install(server, sink);
    const client = await major.connect(server);

    await client.listTools();

    expect(sink.events).toHaveLength(2);
    expect(JSON.stringify(sink.events.map((e) => e.payload))).not.toContain("lookup");
  });

  it("names the caller, and carries no principal and no call id", async () => {
    const sink = new CapturingSink();
    const server = withLookup();
    install(server, sink, { resolvePrincipal: () => ({ principalId: "employee-1" }) });
    const client = await major.connect(server);

    await client.listTools();

    expect(sink.events).toHaveLength(2);
    for (const event of sink.events) {
      expect(event.client_observed, event.event_type).toEqual({
        info: { name: "test-client", version: "1.0.0" },
      });
      expect(event.principal, event.event_type).toBeNull();
      expect(event.call_id, event.event_type).toBeNull();
    }
  });

  it("each list request gets its own pair", async () => {
    const sink = new CapturingSink();
    const server = withLookup();
    install(server, sink);
    const client = await major.connect(server);

    await client.listTools();
    await client.listTools();

    expect(typesOf(sink)).toEqual([
      "tool_list_start",
      "tool_list_end",
      "tool_list_start",
      "tool_list_end",
    ]);
  });

  it("each seam applies once when a handler is registered after install", async () => {
    const sink = new CapturingSink();
    const server = withLookup();
    install(server, sink, { intentParamMode: "required" });
    major.resource(server, "doc", "file:///doc.txt", () => ({
      contents: [{ uri: "file:///doc.txt", text: "body" }],
    }));
    const client = await major.connect(server);

    const listed = (await client.listTools()) as {
      tools: { name: string; inputSchema: { required?: string[] } }[];
    };

    expect(typesOf(sink)).toEqual(["tool_list_start", "tool_list_end"]);
    const lookup = listed.tools.find((t) => t.name === "lookup");
    expect(lookup!.inputSchema.required).toEqual(["name", ...INTENT_PARAMS]);
  });

  it.each(["optional", "off"] as const)("is sent under intentParamMode %s", async (mode) => {
    const sink = new CapturingSink();
    const server = withLookup();
    install(server, sink, { intentParamMode: mode });
    const client = await major.connect(server);

    await client.listTools();

    expect(typesOf(sink)).toEqual(["tool_list_start", "tool_list_end"]);
  });

  it("a list that fails leaves a start and an error, and the client still sees the failure", async () => {
    const sink = new CapturingSink();
    const server = withLookup() as { server: { _requestHandlers: Map<string, unknown> } };
    server.server._requestHandlers.set("tools/list", () => {
      throw new Error("list is down");
    });
    install(server, sink);
    const client = await major.connect(server);

    await expect(client.listTools()).rejects.toThrow(/list is down/);

    expect(typesOf(sink)).toEqual(["tool_list_start", "tool_list_error"]);
    const error = sink.events[1]!.payload as Record<string, unknown>;
    expect(Object.keys(error).sort()).toEqual(["duration_ms", "error_body", "error_type"]);
    expect(error["error_type"]).toBe("Error");
    expect(error["error_body"]).toBe("list is down");
  });
});
