/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return */

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { reportTool } from "../../../src/library/reportTool.js";
import { withToolInputSchema } from "../../../src/integrations/mcp/schemaCompat.js";
import { CapturingSink, install, lowLevelServerOf, MAJORS, type Major } from "./_majors.js";

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
    expect(schema?.properties?.context?.additionalProperties).toBe(true);
    expect(emptySchemas(schema)).toEqual([]);
  });
});

it("the library report tool's input schema has no empty subschema", () => {
  const schema = reportTool({ vendorDisplayName: "Acme" }).inputSchema as any;
  expect(schema.properties.context.additionalProperties).toBe(true);
  expect(emptySchemas(schema)).toEqual([]);
});

describe.each(MAJORS)("an McpServer's report tool ($label)", (major) => {
  it("lists Baton's own rendering of its schema, not the SDK's", async () => {
    const server = mcpServer(major);
    const { annotationToolName } = install(server, new CapturingSink(), { reportMode: "on" });
    // What the SDK would render from a vendor's zod that reads Baton's schema differently.
    server._registeredTools[annotationToolName].inputSchema = z.object({ rendered_by_the_vendors_zod: z.string() });
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
