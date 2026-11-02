import {
  McpServer,
  InMemoryTransport,
  acceptedContent,
  createMcpHandler,
  inputRequired,
} from "@modelcontextprotocol/server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { createBaton } from "../../../src/integrations/mcp/withBaton.js";
import { CapturingSink, CFG, install } from "./_majors.js";

const CONFIG = { ...CFG, reportMode: "off" as const };

type Ctx = { mcpReq: { inputResponses?: Record<string, unknown>; requestState: () => unknown } };

const askConfirm = () =>
  inputRequired({
    inputRequests: {
      confirm: inputRequired.elicit({
        message: "Go?",
        requestedSchema: { type: "object", properties: { confirm: { type: "boolean" } }, required: ["confirm"] },
      }),
    },
  });

/** Pauses `pauses` times, then answers `done`: the first pause asks the client,
 * the rest carry only `requestState`. */
function pausing<T>(ctx: unknown, pauses: number, done: T) {
  const { mcpReq } = ctx as Ctx;
  const state = mcpReq.requestState();
  if (state === undefined && acceptedContent(mcpReq.inputResponses, "confirm") === undefined) return askConfirm();
  const step = Number(state ?? 1);
  return step < pauses ? inputRequired({ requestState: String(step + 1) }) : done;
}

const TOOL_RESULT = [{ type: "text" as const, text: "deployed" }];
const PROMPT_RESULT = [{ role: "user" as const, content: { type: "text" as const, text: "the plan" } }];
const RESOURCE_RESULT = [{ uri: "doc://one", text: "the doc" }];

const KINDS = {
  "tool call": {
    prefix: "tool_call_",
    register: (server: McpServer, pauses: number) =>
      server.registerTool("deploy", { inputSchema: z.object({ env: z.string() }) }, async (_args, ctx) =>
        pausing(ctx, pauses, { content: TOOL_RESULT }),
      ),
    invoke: async (client: Client) => (await client.callTool({ name: "deploy", arguments: { env: "prod" } })).content,
    final: TOOL_RESULT,
  },
  "prompt get": {
    prefix: "prompt_get_",
    register: (server: McpServer, pauses: number) =>
      server.registerPrompt("plan", {}, async (ctx) => pausing(ctx, pauses, { messages: PROMPT_RESULT })),
    invoke: async (client: Client) => (await client.getPrompt({ name: "plan" })).messages,
    final: PROMPT_RESULT,
  },
  "resource read": {
    prefix: "resource_read_",
    register: (server: McpServer, pauses: number) =>
      server.registerResource("doc", "doc://one", {}, async (_uri, ctx) =>
        pausing(ctx, pauses, { contents: RESOURCE_RESULT }),
      ),
    invoke: async (client: Client) => (await client.readResource({ uri: "doc://one" })).contents,
    final: RESOURCE_RESULT,
  },
} as const;

function newClient(options: object, elicitation = true): Client {
  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { capabilities: elicitation ? { elicitation: {} } : {}, ...options },
  );
  if (elicitation) {
    client.setRequestHandler("elicitation/create", async () => ({ action: "accept", content: { confirm: true } }));
  }
  return client;
}

// 2.0.0 serves 2026-07-28 only through `createMcpHandler`, a server per request;
// a hand-built server answers `server/discover` with -32601.
async function overModernHttp(sink: CapturingSink, build: () => McpServer, elicitation = true): Promise<Client> {
  const baton = createBaton({ ...CONFIG, sink });
  const handler = createMcpHandler(() => {
    const server = build();
    baton.wrap(server);
    return server;
  });
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = newClient({ versionNegotiation: { mode: { pin: "2026-07-28" } } }, elicitation);
  await client.connect(transport);
  return client;
}

async function overLegacyShim(sink: CapturingSink, build: () => McpServer, elicitation = true): Promise<Client> {
  const server = build();
  install(server, sink, { reportMode: "off" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = newClient({}, elicitation);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

const PROTOCOLS = [
  ["2026-07-28, input_required on the wire", overModernHttp],
  ["2025, through the server's legacy shim", overLegacyShim],
] as const;

const legs = (sink: CapturingSink, prefix: string) =>
  sink.events.filter((e) => e.event_type.startsWith(prefix)).map((e) => e.event_type);

function vendorServer(register: (server: McpServer) => void): McpServer {
  const server = new McpServer({ name: "vendor", version: "1.0.0" });
  register(server);
  return server;
}

describe.each(Object.entries(KINDS))("a %s that pauses for input", (_kind, kind) => {
  describe.each(PROTOCOLS)("client on %s", (_protocol, connect) => {
    it.each([1, 2])("is one call across %i pause(s): one start and one end", async (pauses) => {
      const sink = new CapturingSink();
      const client = await connect(sink, () => vendorServer((server) => kind.register(server, pauses)));

      expect(await kind.invoke(client)).toEqual(kind.final);
      expect(legs(sink, kind.prefix), JSON.stringify(sink.events, null, 2)).toEqual([
        `${kind.prefix}start`,
        `${kind.prefix}end`,
      ]);
    });

    it("that the SDK then fails sends one start and one error", async () => {
      const sink = new CapturingSink();
      // A client that cannot elicit: the SDK refuses the input request.
      const client = await connect(sink, () => vendorServer((server) => kind.register(server, 1)), false);

      await kind.invoke(client).catch(() => undefined);
      expect(legs(sink, kind.prefix)).toEqual([`${kind.prefix}start`, `${kind.prefix}error`]);
      // The SDK's failure has no SPEC §11.4.3 kind, so the member is omitted.
      expect(sink.events.at(-1)?.payload).not.toHaveProperty("failure_kind");
    });
  });
});

it("a tool call resumed into a returned error sends one start and one error", async () => {
  const sink = new CapturingSink();
  const client = await overModernHttp(sink, () =>
    vendorServer((server) =>
      server.registerTool("deploy", {}, async (ctx) =>
        pausing(ctx, 1, { isError: true, content: [{ type: "text" as const, text: "refused" }] }),
      ),
    ),
  );

  await client.callTool({ name: "deploy", arguments: {} });
  expect(legs(sink, "tool_call_")).toEqual(["tool_call_start", "tool_call_error"]);
});

it("a resumed tool call the SDK refuses before the handler runs sends no second start", async () => {
  const sink = new CapturingSink();
  let paused = false;
  // The tool is disabled by the resumed round, so the SDK refuses it.
  const client = await overModernHttp(sink, () =>
    vendorServer((server) => {
      const tool = server.registerTool("deploy", {}, async () => {
        paused = true;
        return askConfirm();
      });
      if (paused) tool.disable();
    }),
  );

  await client.callTool({ name: "deploy", arguments: {} }).catch(() => undefined);
  expect(legs(sink, "tool_call_"), JSON.stringify(sink.events, null, 2)).toEqual([
    "tool_call_start",
    "tool_call_error",
  ]);
});
