/** A tool's `outputSchema` in the `surface_snapshot`, as `tools/list` spells it. */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { Client } from "../../../src/index.js";
import { withBaton } from "../../../src/integrations/mcp/withBaton.js";
import { CapturingSink, CFG, install, lowLevelServerOf, MAJORS } from "./_majors.js";

const snapshotTools = (sink: CapturingSink) =>
  sink.events.filter((e) => e.event_type === "surface_snapshot").map((e: any) => e.payload.tools);
const ok = () => ({ content: [{ type: "text", text: "ok" }], structuredContent: { n: 1 } });

describe.each(MAJORS)("outputSchema in the snapshot ($label)", (major) => {
  it("on an McpServer, as tools/list serves it, and no key for a tool without one", async () => {
    const sink = new CapturingSink();
    const server = major.make();
    major.tool(server, "counted", { q: z.string() }, ok, { n: z.number() });
    major.tool(server, "plain", { q: z.string() }, ok);
    const handle = install(server, sink);
    const { tools: listed } = await (await major.connect(server)).listTools();
    await handle.flush();

    const [tools] = snapshotTools(sink);
    const byName = Object.fromEntries(tools.map((t: any) => [t.name, t]));
    expect(byName.counted.outputSchema).toEqual(listed.find((t: any) => t.name === "counted").outputSchema);
    expect(byName.counted.outputSchema).toBeDefined();
    expect(byName.plain).not.toHaveProperty("outputSchema");
  });

  it("on an McpServer, follows an update of the output schema", async () => {
    const sink = new CapturingSink();
    const server = major.make();
    major.tool(server, "counted", { q: z.string() }, ok, { n: z.number() });
    const handle = install(server, sink);
    const next = { n: z.number(), total: z.number() };
    server._registeredTools.counted.update({ outputSchema: major === MAJORS[0] ? next : z.object(next) });
    const { tools: listed } = await (await major.connect(server)).listTools();
    await handle.flush();

    const tools = snapshotTools(sink).at(-1);
    expect(tools[0].outputSchema).toEqual(listed[0].outputSchema);
    expect(Object.keys(tools[0].outputSchema.properties)).toEqual(["n", "total"]);
  });

  it("on a low-level Server, as listed, copied, and only when it is an object", async () => {
    const sink = new CapturingSink();
    const outputSchema = { type: "object", properties: { n: { type: "number" } } };
    const { server, listTools, callTool } = lowLevelServerOf(major);
    server.setRequestHandler(listTools, () => ({
      tools: [
        { name: "counted", inputSchema: { type: "object" }, outputSchema },
        { name: "odd", inputSchema: { type: "object" }, outputSchema: "not a schema" },
      ],
    }));
    server.setRequestHandler(callTool, async () => ok());
    const handle = withBaton(server, { ...CFG, sink });
    // Straight to the handler: a client rejects a list with a non-object outputSchema.
    await server._requestHandlers.get("tools/list")({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, {
      signal: new AbortController().signal,
      requestId: 1,
      sendNotification: async () => {},
      sendRequest: async () => ({}),
      mcpReq: { id: 1, method: "tools/list", signal: new AbortController().signal, requestState: () => undefined },
    });
    outputSchema.properties.n.type = "string";
    await handle.flush();

    const [tools] = snapshotTools(sink);
    expect(tools[0].outputSchema).toEqual({ type: "object", properties: { n: { type: "number" } } });
    expect(tools[1]).not.toHaveProperty("outputSchema");
  });
});

it("on the library path, as the vendor passes it", async () => {
  const sink = new CapturingSink();
  const client = new Client({ sink, vendorId: "srv-1", tenantId: "ten_abc" });
  const outputSchema = { type: "object", properties: { n: { type: "number" } } };
  await client.listTools([{ name: "counted", inputSchema: { type: "object" }, outputSchema }], {});
  await client.flush();
  expect(snapshotTools(sink)[0][0].outputSchema).toEqual(outputSchema);
});
