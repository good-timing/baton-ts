/**
 * `client_observed` (SPEC §11.4): the client's declared `clientInfo` and the
 * registered request headers. The SDK names no client: `agent_runtime` is
 * always `unknown`.
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
  CLIENT_INFO_META_KEY,
  clientObservedMember,
  observeClient,
} from "../../../src/integrations/mcp/clientObserved.js";
import type { Extra } from "../../../src/integrations/mcp/mcpTypes.js";
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
    const sent = {
      "User-Agent": CLAUDE_CODE_UA,
      "X-Anthropic-Client": "ClaudeCode",
    };
    const expected = {
      headers: {
        "user-agent": CLAUDE_CODE_UA,
        "x-anthropic-client": "ClaudeCode",
      },
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
    expect(JSON.stringify(observe(extraV1({ authorization: "Bearer secret" })))).toBe(undefined);
  });

  it("is undefined, not an empty object, when nothing was observed", () => {
    expect(observe({} as any)).toBeUndefined();
    expect(observe(extraV1({}))).toBeUndefined();
    expect(observe(extraV1({ "user-agent": "" }))).toBeUndefined();
  });

  it("takes info from the request's own declaration before the handshake's", () => {
    const server = {
      getClientVersion: () => ({ name: "from-handshake", version: "1.0.0" }),
    };
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
    expect(observe({} as any, server)).toEqual({
      info: { name: "only-a-name" },
    });
  });

  it("leaves info out when only a claudecode/* key is present", () => {
    const guessed = extraV1({}, { "claudecode/toolUseId": "toolu_1" });
    expect(observe(guessed)).toBeUndefined();
  });

  it("passes every value through the vendor's scrubber, and drops one it does not return as text", () => {
    const server = {
      getClientVersion: () => ({ name: "alice-laptop", version: "1.0.0" }),
    };
    const scrubber = (value: unknown) =>
      typeof value === "string" && value.includes("alice") ? null : `scrubbed:${String(value)}`;
    expect(
      observeClient(extraV1({ "user-agent": CLAUDE_CODE_UA }), {
        server,
        scrubber,
      }),
    ).toEqual({
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
      extraV1({
        "user-agent": "my-agent/1.0 (token sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA)",
      }),
      { scrubber },
    );
    expect(leaked?.headers?.["user-agent"]).not.toContain("sk-ant-api03");
  });

  it("refuses an unregistered header at the schema", () => {
    expect(ClientObservedSchema.safeParse({ headers: { authorization: "x" } }).success).toBe(false);
    expect(ClientObservedSchema.safeParse({ headers: { "user-agent": "x" } }).success).toBe(true);
  });

  it("keeps the request's own pair even when it has no name, never mixing two sources", () => {
    const server = {
      getClientVersion: () => ({ name: "from-handshake", version: "1.0.0" }),
    };
    const versionOnly = extraV1({}, { [CLIENT_INFO_META_KEY]: { version: "9.9.9" } });
    expect(observe(versionOnly, server)).toEqual({
      info: { version: "9.9.9" },
    });
  });

  it.each([{}, { name: "" }, { name: 5, version: null }])(
    "yields to the handshake when the request's declaration holds no text: %j",
    (onRequest) => {
      const server = {
        getClientVersion: () => ({ name: "from-handshake", version: "1.0.0" }),
      };
      const extra = extraV1({}, { [CLIENT_INFO_META_KEY]: onRequest });
      expect(observe(extra, server)).toEqual({
        info: { name: "from-handshake", version: "1.0.0" },
      });
    },
  );

  // Literal lengths: SPEC §11.4 states them, so a changed constant must fail.
  it.each([
    [127, 127],
    [128, 128],
    [129, 128],
    [5000, 128],
  ])("cuts a declared name and version of %i to %i", (sent, kept) => {
    const server = {
      getClientVersion: () => ({
        name: "n".repeat(sent),
        version: "v".repeat(sent),
      }),
    };
    expect(observe({}, server)).toEqual({
      info: { name: "n".repeat(kept), version: "v".repeat(kept) },
    });
  });

  it.each([
    [255, 255],
    [256, 256],
    [257, 256],
    [5000, 256],
  ])("cuts a header value of %i to %i", (sent, kept) => {
    const observed = observe(extraV1({ "user-agent": "a".repeat(sent) }));
    expect(observed).toEqual({ headers: { "user-agent": "a".repeat(kept) } });
  });

  it("leaves the key out of the envelope, never null, when nothing was observed", () => {
    expect(clientObservedMember({}, { scrubber: identityScrub })).toEqual({});
  });

  it("joins a 1.x header that arrived as several lines", () => {
    const observed = observe(extraV1({ "User-Agent": ["agent/1.0", "proxy/2"] }));
    expect(observed).toEqual({ headers: { "user-agent": "agent/1.0, proxy/2" } });
  });

  it("hands the scrubber the whole value, before the cap", () => {
    const seen: unknown[] = [];
    const scrubber = (value: unknown) => {
      seen.push(value);
      return value;
    };
    observeClient(extraV1({ "user-agent": "a".repeat(300) }), { scrubber });
    expect(seen).toEqual(["a".repeat(300)]);
  });

  it("applies the cap to what the scrubber returned", () => {
    const server = { getClientVersion: () => ({ name: "zed" }) };
    const observed = observeClient({}, { server, scrubber: () => "r".repeat(5000) });
    expect(observed).toEqual({ info: { name: "r".repeat(128) } });
  });

  it("drops one value its scrubber throws on, and keeps the rest", () => {
    const server = {
      getClientVersion: () => ({ name: "zed", version: "0.9" }),
    };
    const scrubber = (value: unknown) => {
      if (value === "zed") throw new Error("vendor scrubber bug");
      return value;
    };
    const observed = observeClient(extraV1({ "user-agent": "agent/1.0" }), {
      server,
      scrubber,
    });
    expect(observed).toEqual({
      info: { version: "0.9" },
      headers: { "user-agent": "agent/1.0" },
    });
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
    major.tool(server, "broken", {}, async () => {
      throw new Error("vendor bug");
    });
    major.tool(server, "refused", {}, async () => ({
      isError: true,
      content: [{ type: "text" as const, text: "not allowed" }],
    }));
    major.tool(
      server,
      "mistyped",
      {},
      async () => ({ content: [], structuredContent: { count: "three" } }),
      { count: z.number() },
    );
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
    // Each call ends at its own emit site; the first also opens the session's
    // proactive annotation.
    await client.callTool({ name: "lookup", arguments: { name: "alice", user_goal: "find her" } });
    for (const name of ["broken", "refused", "mistyped", "no-such-tool"]) {
      await client.callTool({ name, arguments: {} }).catch(() => undefined);
    }
    await client.listResources();
    await client.callTool({
      name: handle.annotationToolName,
      arguments: { user_goal: "look up", signal_type: "failure" },
    });

    const types = new Set(sink.events.map((e) => e.event_type));
    for (const expected of [
      "tool_call_start",
      "tool_call_end",
      "tool_call_error",
      "resource_list_start",
      "resource_list_end",
      "annotation",
      "surface_snapshot",
    ]) {
      expect(types).toContain(expected);
    }
    const failures = sink.events
      .filter((e) => e.event_type === "tool_call_error")
      .map((e) => (e.payload as { tool_name: string }).tool_name);
    expect(failures.sort()).toEqual(["broken", "mistyped", "no-such-tool", "refused"]);
    expect(sink.events.filter((e) => e.event_type === "annotation")).toHaveLength(2);
    for (const event of sink.events) {
      if (event.event_type === "surface_snapshot") {
        expect(Object.keys(event)).not.toContain("client_observed");
        continue;
      }
      // In memory there is no HTTP request, so there are no headers to carry.
      expect(event.client_observed, event.event_type).toEqual({
        info: { name: "test-client", version: "1.0.0" },
      });
      expect(event.agent_runtime).toBe("unknown");
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
        server.registerResource("readme", "probe://readme", {}, () => ({
          contents: [{ uri: "probe://readme", text: "hello" }],
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
            headers: {
              "user-agent": "my-agent/1.0 (secret)",
              authorization: "Bearer nope",
            },
          },
        }) as any,
      );
      await client.callTool({ name: "lookup", arguments: { name: "alice" } });
      await client.listResources();
      const { tools } = await client.listTools();
      const annotate = tools.find((tool) => tool.name !== "lookup")!.name;
      await client.callTool({
        name: annotate,
        arguments: { user_goal: "look up", signal_type: "failure" },
      });
      await client.close();
    } finally {
      await new Promise((resolve) => http.close(resolve));
    }

    const withCaller = sink.events.filter((e) => e.event_type !== "surface_snapshot");
    expect(withCaller.map((e) => e.event_type)).toEqual(
      expect.arrayContaining([
        "tool_call_start",
        "tool_call_end",
        "resource_list_end",
        "annotation",
      ]),
    );
    for (const event of withCaller) {
      expect(event.client_observed, event.event_type).toEqual({
        headers: { "user-agent": "my-agent/1.0 ([x])" },
      });
    }
  });
});
