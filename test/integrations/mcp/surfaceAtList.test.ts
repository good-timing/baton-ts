/**
 * The `surface_snapshot` sent at `tools/list`, and the `surface_hash` on that
 * request's `tool_list_end` (SPEC §11.4.2, §11.4.5).
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return */

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { withBaton } from "../../../src/integrations/mcp/withBaton.js";
import { CapturingSink, CFG, install, lowLevelServerOf, MAJORS } from "./_majors.js";

const GOAL = "1: find alice; success is her row";
const tool = (name: string, description?: string) => ({
  name,
  ...(description === undefined ? {} : { description }),
  inputSchema: z.toJSONSchema(z.object({ name: z.string() })),
});

/** A request straight to the server's handler map, as a stateless request delivers it. */
const dispatch = (server: any, method: string, params: Record<string, unknown> = {}) =>
  server._requestHandlers.get(method)({ jsonrpc: "2.0", id: 1, method, params }, {
    signal: new AbortController().signal,
    requestId: 1,
    sendNotification: async () => {},
    sendRequest: async () => ({}),
    mcpReq: { id: 1, method, signal: new AbortController().signal, requestState: () => undefined },
  });

const ofType = (sink: CapturingSink, type: string) => sink.events.filter((e) => e.event_type === type) as any[];
const toolNames = (snapshot: any) => snapshot.payload.tools.map((t: any) => t.name);

describe.each(MAJORS)("surface at tools/list ($label)", (major) => {
  function lowLevel(list: (request: any) => unknown) {
    const { server, listTools, callTool } = lowLevelServerOf(major);
    server.setRequestHandler(listTools, list);
    server.setRequestHandler(callTool, async () => ({ content: [{ type: "text", text: "ok" }] }));
    return server;
  }

  describe("on an McpServer", () => {
    function mcpServer() {
      const server = major.make();
      major.tool(server, "lookup", { name: z.string() }, () => ({ content: [{ type: "text", text: "ok" }] }));
      return server;
    }

    it("sends the snapshot before the listing's end, which names its hash", async () => {
      const sink = new CapturingSink();
      const server = mcpServer();
      const handle = install(server, sink, { reportMode: "on" });
      await (await major.connect(server)).listTools();
      await handle.flush();

      const [snapshot] = ofType(sink, "surface_snapshot");
      const [end] = ofType(sink, "tool_list_end");
      expect(toolNames(snapshot)).toEqual(["lookup"]);
      expect(end.payload.surface_hash).toBe(snapshot.payload.surface_hash);
      expect(sink.events.indexOf(snapshot)).toBeLessThan(sink.events.indexOf(end));
    });

    it("sends one snapshot for two listings of the same surface, and both ends name it", async () => {
      const sink = new CapturingSink();
      const server = mcpServer();
      const handle = install(server, sink);
      const client = await major.connect(server);
      await client.listTools();
      await client.listTools();
      await client.callTool({ name: "lookup", arguments: { name: "alice", user_goal: GOAL } });
      await handle.flush();

      const snapshots = ofType(sink, "surface_snapshot");
      expect(snapshots).toHaveLength(1);
      expect(ofType(sink, "tool_list_end").map((e) => e.payload.surface_hash)).toEqual([
        snapshots[0].payload.surface_hash,
        snapshots[0].payload.surface_hash,
      ]);
    });

    it("still sends a snapshot to a client that calls without listing", async () => {
      const sink = new CapturingSink();
      const server = mcpServer();
      const handle = install(server, sink);
      await (await major.connect(server)).callTool({ name: "lookup", arguments: { name: "alice", user_goal: GOAL } });
      await handle.flush();
      expect(ofType(sink, "surface_snapshot").map(toolNames)).toEqual([["lookup"]]);
    });
  });

  describe("on a low-level Server", () => {
    it("snapshots the list it served, never the tools option", async () => {
      const sink = new CapturingSink();
      const server = lowLevel(() => ({ tools: [tool("lookup", "served")] }));
      const handle = withBaton(server, { ...CFG, sink, tools: [tool("lookup", "catalog")] });
      await dispatch(server, "tools/call", { name: "lookup", arguments: { name: "alice", user_goal: GOAL } });
      await handle.flush();
      expect(ofType(sink, "surface_snapshot")).toEqual([]);

      await dispatch(server, "tools/list");
      await handle.flush();
      const [snapshot] = ofType(sink, "surface_snapshot");
      expect(snapshot.payload.tools.map((t: any) => t.description)).toEqual(["served"]);
      expect(ofType(sink, "tool_list_end")[0].payload.surface_hash).toBe(snapshot.payload.surface_hash);
    });

    it("still finds the report tool's name in a tools option given as a function", async () => {
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const name = withBaton(lowLevel(() => ({ tools: [] })), { ...CFG, sink: new CapturingSink(), reportMode: "on" })
        .annotationToolName;
      const server = lowLevel(() => ({ tools: [] }));
      withBaton(server, { ...CFG, sink: new CapturingSink(), reportMode: "on", tools: () => [tool(name)] });
      const answer = await dispatch(server, "tools/call", { name, arguments: {} });
      expect(answer.content).toEqual([{ type: "text", text: "ok" }]);
    });

    it("snapshots each list as served, so a tool one caller saw is not in another's", async () => {
      const sink = new CapturingSink();
      const lists = [[tool("lookup"), tool("admin")], [tool("lookup")]];
      const server = lowLevel(() => ({ tools: lists.shift() }));
      const handle = withBaton(server, { ...CFG, sink });
      await dispatch(server, "tools/list");
      await dispatch(server, "tools/list");
      await handle.flush();

      const snapshots = ofType(sink, "surface_snapshot");
      expect(snapshots.map(toolNames)).toEqual([["admin", "lookup"], ["lookup"]]);
      expect(ofType(sink, "tool_list_end").map((e) => e.payload.surface_hash)).toEqual(
        snapshots.map((s) => s.payload.surface_hash),
      );
    });

    it("gives two listings that finish together each its own hash", async () => {
      const sink = new CapturingSink();
      const gates: Array<() => void> = [];
      const lists = [[tool("lookup"), tool("admin")], [tool("lookup")]];
      const server = lowLevel(() => {
        const tools = lists.shift();
        return new Promise((resolve) => gates.push(() => resolve({ tools })));
      });
      const handle = withBaton(server, { ...CFG, sink });
      const listings = [dispatch(server, "tools/list"), dispatch(server, "tools/list")];
      await vi.waitFor(() => expect(gates).toHaveLength(2));
      for (const open of gates) open();
      await Promise.all(listings);
      await handle.flush();

      const hashOf = new Map(ofType(sink, "surface_snapshot").map((s) => [toolNames(s).join(","), s.payload.surface_hash]));
      expect([...hashOf.keys()].sort()).toEqual(["admin,lookup", "lookup"]);
      expect(ofType(sink, "tool_list_end").map((e) => e.payload.surface_hash)).toEqual([
        hashOf.get("admin,lookup"),
        hashOf.get("lookup"),
      ]);
    });

    it.each([
      ["answered with a next cursor", {}, { nextCursor: "2" }],
      ["asked for a later page", { cursor: "2" }, {}],
    ])("sends no snapshot and no hash for a list %s, nor at a later call", async (_label, params, page) => {
      const sink = new CapturingSink();
      const server = lowLevel(() => ({ tools: [tool("lookup")], ...page }));
      const handle = withBaton(server, { ...CFG, sink });
      await dispatch(server, "tools/list", params);
      await dispatch(server, "tools/call", { name: "lookup", arguments: { name: "alice", user_goal: GOAL } });
      await handle.flush();

      expect(ofType(sink, "surface_snapshot")).toEqual([]);
      const [end] = ofType(sink, "tool_list_end");
      expect(end.payload).not.toHaveProperty("surface_hash");
    });

    it("reports a surface it cannot hash once, not on every listing", async () => {
      const warned = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      warned.mockClear();
      const sink = new CapturingSink();
      const tools = [{ name: "lookup", inputSchema: { type: "object", default: 1n } }];
      const server = lowLevel(() => ({ tools }));
      const handle = withBaton(server, { ...CFG, sink });
      await dispatch(server, "tools/list");
      await dispatch(server, "tools/list");
      await handle.flush();

      const failures = warned.mock.calls.filter(([line]) => String(line).includes("surface snapshot capture failed"));
      expect(failures).toHaveLength(1);
      expect(ofType(sink, "tool_list_end").map((e) => e.payload.surface_hash)).toEqual([undefined, undefined]);
    });
  });
});
