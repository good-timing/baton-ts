/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return */

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { reportTool } from "../../../src/library/reportTool.js";
import { withToolInputSchema } from "../../../src/integrations/mcp/schemaCompat.js";
import { ANNOTATION_INPUT_SHAPE, registerAnnotationTool } from "../../../src/integrations/mcp/annotation.js";
import { ServerCounter, SessionCounter } from "../../../src/integrations/mcp/sessionCounter.js";
import { createMcpHandler, McpServer as McpServerV2 } from "@modelcontextprotocol/server";
import { Client as ClientV2, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createBaton } from "../../../src/integrations/mcp/withBaton.js";
import { CapturingSink, CFG, install, lowLevelServerOf, MAJORS, nextTurn, type Major } from "./_majors.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Paths to every `{}` subschema: legal JSON Schema, but some MCP clients
 * refuse or mishandle it where `true` means the same. */
function emptySchemas(schema: unknown, path = "$"): string[] {
  if (schema === null || typeof schema !== "object") return [];
  if (!Array.isArray(schema) && Object.keys(schema).length === 0) return [path];
  return Object.entries(schema).flatMap(([key, value]) => emptySchemas(value, `${path}.${key}`));
}

/** `context`'s object branch: the field is nullable, so it is `anyOf` an object and null. */
function contextObject(schema: any): any {
  return schema?.properties?.context?.anyOf?.find((branch: any) => branch.type === "object");
}

/** A handler table the SDK can use but that is not a `Map`, so Baton installs no request seam. */
class HandlerTable {
  constructor(private readonly table: Map<unknown, unknown>) {}
  get(key: unknown) { return this.table.get(key); }
  set(key: unknown, value: unknown) { this.table.set(key, value); return this; }
  has(key: unknown) { return this.table.has(key); }
  delete(key: unknown) { return this.table.delete(key); }
}

function mcpServer(major: Major): any {
  const server = major.make();
  major.tool(server, "lookup", { name: z.string() }, () => ({ content: [] }));
  return server;
}

function lowLevel(major: Major): any {
  const { server, listTools } = lowLevelServerOf(major);
  server.setRequestHandler(listTools, async () => ({ tools: [] }));
  return server;
}

describe.each(MAJORS)("the report tool's input schema ($label)", (major) => {
  it.each([
    ["McpServer", () => mcpServer(major)],
    ["a low-level Server", () => lowLevel(major)],
  ])("has no empty subschema on %s", async (_kind, make) => {
    const server = make();
    const { annotationToolName } = install(server, new CapturingSink(), { reportMode: "on" });
    const client = await major.connect(server);
    const { tools } = await client.listTools();
    await client.close();
    const schema = tools.find((tool: any) => tool.name === annotationToolName)?.inputSchema;
    expect(contextObject(schema)?.additionalProperties).toBe(true);
    expect(emptySchemas(schema)).toEqual([]);
  });
});

it("the library report tool's input schema has no empty subschema", () => {
  const schema = reportTool({ vendorDisplayName: "Acme" }).inputSchema as any;
  expect(contextObject(schema)?.additionalProperties).toBe(true);
  expect(emptySchemas(schema)).toEqual([]);
});

describe.each(MAJORS)("an McpServer's report tool ($label)", (major) => {
  it("gives the SDK no schema to render, and lists Baton's own", async () => {
    const server = mcpServer(major);
    const { annotationToolName } = install(server, new CapturingSink(), { reportMode: "on" });
    expect(server._registeredTools[annotationToolName].inputSchema).toBeUndefined();
    const client = await major.connect(server);
    const { tools } = await client.listTools();
    await client.close();
    const schema = tools.find((tool: any) => tool.name === annotationToolName)?.inputSchema;

    const plain = lowLevel(major);
    const plainName = install(plain, new CapturingSink(), { reportMode: "on" }).annotationToolName;
    const plainClient = await major.connect(plain);
    const listed = (await plainClient.listTools()).tools;
    await plainClient.close();
    expect(schema).toEqual(listed.find((tool: any) => tool.name === plainName)?.inputSchema);
  });

  it("refuses bad arguments as the SDK refuses them for a tool with the same schema", async () => {
    const server = mcpServer(major);
    major.tool(server, "twin", ANNOTATION_INPUT_SHAPE, () => ({ content: [] }));
    const { annotationToolName } = install(server, new CapturingSink(), { reportMode: "on" });
    const client = await major.connect(server);
    for (const args of [{ user_goal: 5 }, {}, { user_goal: "g", tool_name: 3, context: "x" }, undefined]) {
      const report = await client.callTool({ name: annotationToolName, arguments: args });
      const twin = await client.callTool({ name: "twin", arguments: args });
      expect(report.isError).toBe(true);
      expect(JSON.stringify(report).replaceAll(annotationToolName, "twin")).toBe(JSON.stringify(twin));
    }
    await client.close();
  });

  it("registers its schema when Baton cannot reach the handler map", async () => {
    const sink = new CapturingSink();
    const server = mcpServer(major);
    server.server._requestHandlers = new HandlerTable(server.server._requestHandlers);
    const { annotationToolName } = install(server, sink, { reportMode: "on" });
    expect(server._registeredTools[annotationToolName].inputSchema).toBeDefined();
    const client = await major.connect(server);
    const report = await client.callTool({ name: annotationToolName, arguments: { user_goal: "g", what_happened: "w" } });
    await client.close();
    expect(report.content).toEqual([{ type: "text", text: JSON.stringify({ ok: true }) }]);
  });
});

describe.each(MAJORS)("an McpServer's own tool with the report tool's name ($label)", (major) => {
  it("makes withBaton throw before it changes the server", async () => {
    const reportName = install(mcpServer(major), new CapturingSink(), { reportMode: "on" }).annotationToolName;
    const server = mcpServer(major);
    major.tool(server, reportName, { mine: z.string() }, () => ({ content: [{ type: "text", text: "mine" }] }));
    const handlers = new Map(server.server._requestHandlers);
    expect(() => install(server, new CapturingSink(), { reportMode: "on" })).toThrow(/already registered/);
    expect(server.server._requestHandlers).toEqual(handlers);
    expect(server.server._instructions).toBeUndefined();
    const client = await major.connect(server);
    const { tools } = await client.listTools();
    const result = await client.callTool({ name: reportName, arguments: { mine: "x" } });
    await client.close();
    const schema = tools.find((tool: any) => tool.name === reportName)?.inputSchema;
    expect(Object.keys(schema.properties)).toEqual(["mine"]);
    expect(schema.required).toEqual(["mine"]);
    expect(result.content).toEqual([{ type: "text", text: "mine" }]);
  });
});

describe.each(MAJORS)("an McpServer and a report tool name the SDK refuses ($label)", (major) => {
  it("makes withBaton throw before it changes the server", () => {
    const server = mcpServer(major);
    const handlers = new Map(server.server._requestHandlers);
    expect(() => install(server, new CapturingSink(), { reportMode: "on", annotationToolName: "constructor" })).toThrow(
      /already registered/,
    );
    expect(server.server._requestHandlers).toEqual(handlers);
  });
});

describe.each(MAJORS)("a low-level Server's own tool with the report tool's name ($label)", (major) => {
  it("keeps its properties when Baton could not read the list", async () => {
    const own = { type: "object", properties: { mine: { type: "string" } } };
    let reportName = "";
    const { server, listTools } = lowLevelServerOf(major);
    server.setRequestHandler(listTools, async () => {
      let reads = 0;
      // Baton's first read of the list throws, so its own seam serves the list as it came.
      return {
        get tools() {
          if (reads++ === 0) throw new Error("unreadable once");
          return [{ name: reportName, inputSchema: own }];
        },
      };
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    reportName = install(server, new CapturingSink(), { reportMode: "on" }).annotationToolName;
    const client = await major.connect(server);
    const { tools } = await client.listTools();
    await client.close();
    expect(tools.find((tool: any) => tool.name === reportName)?.inputSchema.properties).toEqual(own.properties);
  });
});

describe("withToolInputSchema", () => {
  const result = { tools: [{ name: "lookup", inputSchema: { type: "object" } }, { name: "acme_annotate", description: "d", inputSchema: {} }] };

  it("replaces the named tool's inputSchema in a copy", () => {
    const served = withToolInputSchema(result, "acme_annotate", { type: "object", properties: {} }) as any;
    expect(served.tools[1]).toEqual({ name: "acme_annotate", description: "d", inputSchema: { type: "object", properties: {} } });
    expect(served.tools[0]).toBe(result.tools[0]);
    expect(result.tools[1]!.inputSchema).toEqual({});
  });

  it("returns the result as it came without that tool", () => {
    expect(withToolInputSchema(result, "other", {})).toBe(result);
  });
});

it("an McpServer made per request over 2.x HTTP takes a report", async () => {
  const sink = new CapturingSink();
  const baton = createBaton({ ...CFG, sink, reportMode: "on" });
  const handler = createMcpHandler(() => {
    const server = new McpServerV2({ name: "vendor", version: "1.0.0" });
    server.registerTool("lookup", { inputSchema: z.object({ name: z.string() }) }, () => ({ content: [] }));
    baton.wrap(server);
    return server;
  });
  const client = new ClientV2({ name: "test-client", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    }),
  );
  const result = await client.callTool({
    name: "vendor_annotate",
    arguments: { user_goal: "g", what_happened: "w", context: { a: 1 } },
  });
  await client.close();
  await nextTurn();
  expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ ok: true }) }]);
  expect(sink.events.find((event) => event.event_type === "annotation")?.payload).toMatchObject({ context: { a: 1 } });
});

it.each([
  ["no validateToolInput", {}],
  ["a validateToolInput that throws something else", { validateToolInput: () => Promise.reject(new TypeError("changed")) }],
  ["a validateToolInput that returns nothing", { validateToolInput: () => Promise.resolve(undefined) }],
])("the report tool checks its arguments itself on an McpServer with %s", async (_kind, sdk) => {
  const handlers: Record<string, (extra: unknown) => Promise<any>> = {};
  const server = { ...sdk, registerTool: (name: string, _config: unknown, handler: any) => (handlers[name] = handler) };
  const sink = new CapturingSink();
  const options = {
    sink,
    counter: new ServerCounter(new SessionCounter(), "sdk-x"),
    tenantId: "t",
    vendorId: "acme",
    vendorDisplayName: "Acme",
    consentToken: "ct",
    fallbackSessionId: "sdk-x",
    scrubber: (value: unknown) => value,
    annotationToolName: "acme_report",
  };
  let args: unknown = { user_goal: 5 };
  registerAnnotationTool(server as never, options, () => args);
  const bad = await handlers.acme_report!({});
  args = { user_goal: "g", what_happened: "w" };
  const report = await handlers.acme_report!({});
  expect(bad.isError).toBe(true);
  expect(bad.content[0].text).toMatch(/^Invalid arguments for tool acme_report: /);
  expect(report.content).toEqual([{ type: "text", text: JSON.stringify({ ok: true }) }]);
});
