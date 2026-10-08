/**
 * `client_observed` (SPEC §11.4): the client's declared `clientInfo` and the
 * registered request headers, sent beside `agent_runtime` and never instead
 * of it.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  HEADER_VALUE_MAX_LEN,
  observeClient,
} from "../../../src/integrations/mcp/clientObserved.js";
import type { Extra } from "../../../src/integrations/mcp/mcpTypes.js";
import { CLIENT_INFO_META_KEY, CLIENT_NAME_MAX_LEN } from "../../../src/integrations/mcp/runtimeAdapter.js";
import { createBaton, withBaton } from "../../../src/integrations/mcp/withBaton.js";
import { ClientObservedSchema } from "../../../src/events.js";
import { identityScrub, Scrubber } from "../../../src/scrub.js";
import { CapturingSink, MAJORS } from "./_majors.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

const CLAUDE_CODE_UA = "claude-code/2.1.292 (sdk-cli)";

function extraV1(headers: Record<string, unknown>, meta?: Record<string, unknown>): Extra {
  return { requestInfo: { headers }, ...(meta ? { _meta: meta } : {}) };
}

function extraV2(headers: Record<string, string>): Extra {
  return { http: { req: { headers: new Headers(headers) } } };
}

/** `observeClient` with a scrubber that changes nothing. */
function observe(extra: Extra, server?: unknown) {
  return observeClient(extra, { server, scrubber: identityScrub });
}

describe("observeClient", () => {
  it("copies the registered headers, lower-cased, on both majors' header shapes", () => {
    const sent = { "User-Agent": CLAUDE_CODE_UA, "X-Anthropic-Client": "ClaudeCode" };
    const expected = {
      headers: { "user-agent": CLAUDE_CODE_UA, "x-anthropic-client": "ClaudeCode" },
    };
    expect(observe(extraV1(sent))).toEqual(expected);
    expect(observe(extraV2(sent))).toEqual(expected);
  });

  it("never copies a header that is not registered", () => {
    const observed = observe(
extraV1({
        "user-agent": CLAUDE_CODE_UA,
        authorization: "Bearer secret",
        cookie: "sid=secret",
        "x-forwarded-user": "alice",
      }),
    );
    expect(observed).toEqual({ headers: { "user-agent": CLAUDE_CODE_UA } });
    expect(JSON.stringify(observe(extraV1({ authorization: "Bearer secret" })))).toBe(
      undefined,
    );
  });

  it("is undefined, not an empty object, when nothing was observed", () => {
    expect(observe({} as any)).toBeUndefined();
    expect(observe(extraV1({}))).toBeUndefined();
    expect(observe(extraV1({ "user-agent": "" }))).toBeUndefined();
  });

  it("takes info from the request's own declaration before the handshake's", () => {
    const server = { getClientVersion: () => ({ name: "from-handshake", version: "1.0.0" }) };
    const onRequest = extraV1(
      {},
      { [CLIENT_INFO_META_KEY]: { name: "from-request", version: "9.9.9" } },
    );
    expect(observe(onRequest, server)).toEqual({
      info: { name: "from-request", version: "9.9.9" },
    });
    expect(observe({} as any, server)).toEqual({
      info: { name: "from-handshake", version: "1.0.0" },
    });
  });

  it("omits a name or version the client did not send", () => {
    const server = { getClientVersion: () => ({ name: "only-a-name" }) };
    expect(observe({} as any, server)).toEqual({ info: { name: "only-a-name" } });
  });

  it("leaves info out when the client is only recognised by the claudecode/* heuristic", () => {
    const guessed = extraV1({}, { "claudecode/toolUseId": "toolu_1" });
    expect(observe(guessed)).toBeUndefined();
  });

  it("passes every value through the vendor's scrubber, and drops one it does not return as text", () => {
    const server = { getClientVersion: () => ({ name: "alice-laptop", version: "1.0.0" }) };
    const scrubber = (value: unknown) =>
      typeof value === "string" && value.includes("alice") ? null : `scrubbed:${String(value)}`;
    expect(observeClient(extraV1({ "user-agent": CLAUDE_CODE_UA }), { server, scrubber })).toEqual({
      info: { version: "scrubbed:1.0.0" },
      headers: { "user-agent": `scrubbed:${CLAUDE_CODE_UA}` },
    });
  });

  it("leaves real client strings whole under the shipped scrubber, and redacts a credential", () => {
    const scrubber = (value: unknown) => new Scrubber().scrub(value);
    for (const sent of [
      CLAUDE_CODE_UA,
      "codex-mcp-client/0.161.0",
      "openai-mcp/1.0.0 (ChatGPT)",
      "node",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    ]) {
      expect(observeClient(extraV1({ "user-agent": sent }), { scrubber })?.headers).toEqual({
        "user-agent": sent,
      });
    }
    const leaked = observeClient(
      extraV1({ "user-agent": "my-agent/1.0 (token sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA)" }),
      { scrubber },
    );
    expect(leaked?.headers?.["user-agent"]).not.toContain("sk-ant-api03");
  });

  it("refuses an unregistered header at the schema", () => {
    expect(ClientObservedSchema.safeParse({ headers: { authorization: "x" } }).success).toBe(false);
    expect(ClientObservedSchema.safeParse({ headers: { "user-agent": "x" } }).success).toBe(true);
  });

  it("keeps the request's own pair even when it has no name, never mixing two sources", () => {
    const server = { getClientVersion: () => ({ name: "from-handshake", version: "1.0.0" }) };
    const versionOnly = extraV1({}, { [CLIENT_INFO_META_KEY]: { version: "9.9.9" } });
    expect(observe(versionOnly, server)).toEqual({ info: { version: "9.9.9" } });
  });

  it("cuts a declared name and version to the cap", () => {
    const long = "n".repeat(CLIENT_NAME_MAX_LEN * 2);
    const server = { getClientVersion: () => ({ name: long, version: long }) };
    const info = observe({}, server)?.info;
    expect(info?.name).toHaveLength(CLIENT_NAME_MAX_LEN);
    expect(info?.version).toHaveLength(CLIENT_NAME_MAX_LEN);
  });

  it("cuts a header value to the cap", () => {
    const observed = observe(extraV1({ "user-agent": "a".repeat(HEADER_VALUE_MAX_LEN * 4) }));
    expect(observed?.headers?.["user-agent"]).toHaveLength(HEADER_VALUE_MAX_LEN);
  });

  it("never throws: a server or headers object that raises yields nothing", () => {
    const server = {
      getClientVersion: () => {
        throw new Error("no connection");
      },
    };
    const extra = {
      get requestInfo(): never {
        throw new Error("boom");
      },
    } as any;
    expect(observe(extra, server)).toBeUndefined();
  });
});

describe.each(MAJORS.map((m) => [m.label, m] as const))("on %s", (_label, major) => {
  it("rides every event that has a caller, and never the surface snapshot", async () => {
    const sink = new CapturingSink();
    const server = major.make();
    major.tool(server, "lookup", { name: z.string() }, async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));
    major.resource(server, "readme", "probe://readme", () => ({
      contents: [{ uri: "probe://readme", text: "hello" }],
    }));
    const handle = withBaton(server, {
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
      sink,
    });
    const client = await major.connect(server);
    await client.callTool({ name: "lookup", arguments: { name: "alice" } });
    await client.listResources();
    await client.callTool({
      name: handle.annotationToolName,
      arguments: { user_goal: "look up", signal_type: "failure" },
    });

    const types = new Set(sink.events.map((e) => e.event_type));
    for (const expected of [
      "tool_call_start",
      "tool_call_end",
      "resource_list_start",
      "resource_list_end",
      "annotation",
      "surface_snapshot",
    ]) {
      expect(types).toContain(expected);
    }
    for (const event of sink.events) {
      if (event.event_type === "surface_snapshot") {
        expect(Object.keys(event)).not.toContain("client_observed");
        continue;
      }
      // In memory there is no HTTP request, so there are no headers to carry.
      expect(event.client_observed, event.event_type).toEqual({
        info: { name: "test-client", version: "1.0.0" },
      });
      expect(event.agent_runtime).toBe("test-client");
    }
  });
});

describe("on a server built per request, over real HTTP", () => {
  it("puts the scrubbed User-Agent on every event with a caller, where no handshake is seen", async () => {
    const sink = new CapturingSink();
    const baton = createBaton({
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
      sink,
      scrubber: (value) => (typeof value === "string" ? value.replace("secret", "[x]") : value),
    });
    const http = createServer((req, res) => {
      void (async () => {
        if (req.method !== "POST") {
          res.writeHead(405).end();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const server = new McpServer({ name: "vendor", version: "1.0.0" });
        server.registerTool("lookup", { inputSchema: { name: z.string() } }, () => ({
          content: [{ type: "text" as const, text: "ok" }],
        }));
        baton.wrap(server);
        const transport = new StreamableHTTPServerTransport({});
        res.on("close", () => void transport.close());
        await server.connect(transport as any);
        await transport.handleRequest(req, res, JSON.parse(Buffer.concat(chunks).toString()));
      })();
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const { port } = http.address() as AddressInfo;
    try {
      const client = new Client({ name: "http-client", version: "3.2.1" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${String(port)}/mcp`), {
          requestInit: {
            headers: { "user-agent": "my-agent/1.0 (secret)", authorization: "Bearer nope" },
          },
        }) as any,
      );
      await client.callTool({ name: "lookup", arguments: { name: "alice" } });
      await client.close();
    } finally {
      await new Promise((resolve) => http.close(resolve));
    }

    const withCaller = sink.events.filter((e) => e.event_type !== "surface_snapshot");
    expect(withCaller.map((e) => e.event_type)).toEqual(
      expect.arrayContaining(["tool_call_start", "tool_call_end"]),
    );
    for (const event of withCaller) {
      expect(event.client_observed, event.event_type).toEqual({
        headers: { "user-agent": "my-agent/1.0 ([x])" },
      });
    }
  });
});
