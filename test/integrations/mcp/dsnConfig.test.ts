/**
 * One DSN, one install, and it must reach the WIRE.
 *
 * The TypeScript half of `baton` (Python)'s
 * `tests/functional/test_dsn_config_parity.py`. That file drives four doors
 * with one string because the SDK has four; this package has one, so what
 * survives is the rule the Python file is built on:
 *
 * **Asserted on the POSTed envelope, not on the config object.** A resolver
 * that computes the right values and a sink that never carries them are the
 * same outcome for the customer. `fetch` is stubbed rather than the sink
 * replaced, so the URL the SDK built and the bearer it attached are proven
 * too — the half a config-level assertion cannot reach.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withBaton } from "../../../src/integrations/mcp/withBaton.js";
import { resolveBatonConfig } from "../../../src/integrations/mcp/config.js";
import { HttpSink, StdoutSink } from "../../../src/sinks.js";
import { DEFAULT_CONSENT_TOKEN } from "../../../src/events.js";

const WORKSPACE = "ten_655b084e118b43f88992ee6357fcc23c";
const KEY = "baton_pk_" + "a".repeat(43);
const SERVER = "echo-server";
const DSN = `https://${KEY}@ingest.example.com/${WORKSPACE}/${SERVER}`;

interface Captured {
  url: string;
  bearer: string;
  events: Record<string, unknown>[];
  posts: number;
}

/**
 * A collector that records what actually arrived. `fetch` is stubbed BEFORE
 * `withBaton` runs, because `HttpSink` captures the global at construction.
 *
 * ⚠ **`new Response(null, …)`, and the null is load-bearing.** The first cut
 * returned `new Response("", { status: 204 })`, which THROWS — a 204 may not
 * carry a body — so every POST was a rejected fetch, retried four times, and
 * the sink never accepted one. The assertions passed anyway, because this
 * function records the request before it builds the response: the test proved
 * the SDK had ATTEMPTED a POST, which is not what it claims. `posts` is
 * counted for that reason, and asserted equal to the number of events.
 */
function stubCollector(): Captured {
  const captured: Captured = { url: "", bearer: "", events: [], posts: 0 };
  vi.stubGlobal(
    "fetch",
    async (url: string, init: { headers: Record<string, string>; body: string }) => {
      captured.posts += 1;
      captured.url = String(url);
      captured.bearer = init.headers["Authorization"] ?? "";
      const body = JSON.parse(init.body) as Record<string, unknown>[] | Record<string, unknown>;
      captured.events.push(...(Array.isArray(body) ? body : [body]));
      return new Response(null, { status: 202 });
    },
  );
  return captured;
}

async function driveOneToolCall(server: McpServer): Promise<void> {
  server.registerTool("echo", { inputSchema: { text: z.string() } }, async (args: { text: string }) => ({
    content: [{ type: "text" as const, text: args.text }],
  }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  await client.callTool({ name: "echo", arguments: { text: "hi" } });
  await client.close();
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.BATON_DSN;
  delete process.env.BATON_TENANT_ID;
});

describe("a DSN reaches the wire", () => {
  it("posts to the DSN's origin, with its key, under its identity", async () => {
    const captured = stubCollector();
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    const handle = withBaton(server, { dsn: DSN, consentToken: "ct" });

    await driveOneToolCall(server);
    await handle.flush();
    // Released explicitly: the first write registers a `beforeExit` handler,
    // and leaving it armed past the suite would drain against an unstubbed
    // global.
    await handle.aclose();

    // Asserted by EQUALITY, never by substring: an origin that kept the
    // workspace and server segments would produce a URL that a containment
    // check passes happily on.
    expect(captured.url).toBe("https://ingest.example.com/v0/events");
    expect(captured.bearer).toBe(`Bearer ${KEY}`);
    expect(captured.events.length).toBeGreaterThan(0);
    // One POST per event: the collector ACCEPTED them. A retried POST means
    // the sink rejected the response, and this assertion is what separates
    // "delivered" from "attempted".
    expect(captured.posts).toBe(captured.events.length);
    for (const event of captured.events) {
      expect(event.tenant_id).toBe(WORKSPACE);
      expect(event.vendor_id).toBe(SERVER);
    }
  });

  it("does not let a stale environment outrank the DSN", async () => {
    // The shape this rule exists for, and it is the common one: a server being
    // RE-onboarded has last install's `.env` beside the new inline DSN. If the
    // DSN's values fell through to `BATON_TENANT_ID` the way an unset field
    // does, the stale file would win silently and the events would arrive
    // under the previous server's name.
    process.env.BATON_TENANT_ID = "ten_stale";
    const captured = stubCollector();
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    const handle = withBaton(server, { dsn: DSN, consentToken: "ct" });

    await driveOneToolCall(server);
    await handle.flush();
    await handle.aclose();

    expect(captured.events.length).toBeGreaterThan(0);
    for (const event of captured.events) expect(event.tenant_id).toBe(WORKSPACE);
  });

  it("configures an install from an ambient BATON_DSN", async () => {
    // The hosted-vendor case the variable exists for: one value instead of
    // five, and the vendor's edit rather than a branch in our recipe.
    process.env.BATON_DSN = DSN;
    const captured = stubCollector();
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    const handle = withBaton(server, { consentToken: "ct" });

    await driveOneToolCall(server);
    await handle.flush();
    await handle.aclose();

    expect(captured.url).toBe("https://ingest.example.com/v0/events");
    expect(captured.events[0]?.vendor_id).toBe(SERVER);
  });
});

describe("what the DSN does not take over", () => {
  it("defaults the display name to the server slug VERBATIM", () => {
    // Not "Echo Server": this string reaches the calling agent, so a
    // capitalisation the vendor never chose is a fabricated name in front of
    // their users.
    expect(resolveBatonConfig({ dsn: DSN, consentToken: "ct" }).vendorDisplayName).toBe(SERVER);
  });

  it("refuses an explicitly EMPTIED display name instead of substituting the slug", () => {
    // Written because the fix for this reddened NO test — the same input is
    // refused when there is no dsn (validation rejects an empty display name,
    // citing the SPEC §5.4 whitelabel obligation) and used to be quietly
    // replaced by the server slug when there was one. One input, two answers,
    // decided by whether a dsn happens to be present. This string reaches the
    // calling agent, so the quiet substitution was the worse half.
    expect(() => resolveBatonConfig({ dsn: DSN, consentToken: "ct", vendorDisplayName: "" })).toThrow(
      /vendorDisplayName is required/,
    );
  });

  it("leaves an explicit display name alone", () => {
    expect(
      resolveBatonConfig({ dsn: DSN, consentToken: "ct", vendorDisplayName: "Toybox Pantry" })
        .vendorDisplayName,
    ).toBe("Toybox Pantry");
  });

  it("keeps the zero-config stdout path for an install with no DSN", () => {
    // A vendor who wires nothing still sees their events on stderr, which is
    // the first thing that proves an install works at all.
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    const handle = withBaton(server, {
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
    });
    expect(handle.sink).toBeInstanceOf(StdoutSink);
  });

  it("does not keep the packed string on the resolved config", () => {
    // It carries a bearer. Python retains its copy and pays for it — its
    // `repr(VendorConfig)` prints the key — and nothing here reads the string
    // after parsing, so this arm does not import the problem.
    const resolved = resolveBatonConfig({ dsn: DSN, consentToken: "ct" });
    expect(resolved.dsn).toBeUndefined();
  });

  it("does not print the bearer from anywhere the resolved config reaches", async () => {
    // The first cut of this test asserted only the line above and FAILED:
    // dropping the packed string left the key one field further down, in the
    // sink the SDK had just built from it. A resolved config and the handle
    // that carries it are both things a vendor logs while debugging an
    // install, so the claim worth pinning is about the object graph, not the
    // one field.
    const { inspect } = await import("node:util");
    const resolved = resolveBatonConfig({ dsn: DSN, consentToken: "ct" });

    expect(JSON.stringify(resolved)).not.toContain(KEY);
    expect(inspect(resolved, { depth: 5 })).not.toContain(KEY);
    expect(JSON.stringify(resolved.sink)).not.toContain(KEY);
    // And the sink still WORKS — the key is hidden from printing, not
    // dropped. Proven on the wire by the first test in this file.
    expect(resolved.sink).toBeInstanceOf(HttpSink);
  });
});

describe("two sources for one value", () => {
  it.each([
    ["vendorId", { vendorId: "other" }],
    ["tenantId", { tenantId: "ten_other" }],
    ["sink", { sink: new StdoutSink() }],
  ])("refuses an explicit DSN beside an explicit %s", (_name, extra) => {
    // Both are in the vendor's own source; picking one would be a guess, and a
    // wrong guess routes a server's traffic under someone else's identity.
    expect(() => resolveBatonConfig({ dsn: DSN, consentToken: "ct", ...extra })).toThrow(
      /already supplies it/,
    );
  });

  it("lets an ambient BATON_DSN LOSE to an explicit config instead of throwing", () => {
    // The regression this shape prevents: a vendor who exported BATON_DSN for
    // one server could not install a SECOND the old explicit way — the install
    // died naming a `dsn` that appears nowhere in their code.
    process.env.BATON_DSN = DSN;
    vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const server = new McpServer({ name: "legacy", version: "1.0.0" });
    const handle = withBaton(server, {
      vendorId: "legacy",
      vendorDisplayName: "Legacy",
      consentToken: "ct",
      sink: new StdoutSink(),
    });
    // The explicit config wins OUTRIGHT — not a merge, which would give a
    // server one half of each identity.
    expect(handle.vendorId).toBe("legacy");
    expect(handle.sink).toBeInstanceOf(StdoutSink);
  });

  it("announces that it ignored one", () => {
    // Silence here is the shape where broken and unbuilt look alike: a healthy
    // install whose events go nowhere near the collector the vendor believes
    // they configured.
    process.env.BATON_DSN = DSN;
    const warnings = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    resolveBatonConfig({ vendorId: "legacy", vendorDisplayName: "Legacy", consentToken: "ct" });
    const text = warnings.mock.calls.map((call) => String(call[0])).join("\n");
    expect(text).toContain("BATON_DSN");
    expect(text).toContain("IGNORED");
    expect(text).not.toContain(KEY);
  });
});

describe("the consent token", () => {
  it("lets a DSN be the WHOLE configuration", async () => {
    // The claim the lane exists for: one value in a distributable server's
    // source, and nothing else. Asserted on the envelope, because a config
    // that resolves and a sink that never carries it are the same outcome.
    const captured = stubCollector();
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    const handle = withBaton(server, { dsn: DSN });

    await driveOneToolCall(server);
    await handle.flush();
    await handle.aclose();

    expect(captured.posts).toBe(captured.events.length);
    expect(captured.events.length).toBeGreaterThan(0);
    for (const event of captured.events) {
      expect(event.consent_token).toBe(DEFAULT_CONSENT_TOKEN);
    }
  });

  it("keeps an explicit token", () => {
    expect(resolveBatonConfig({ dsn: DSN, consentToken: "ct" }).consentToken).toBe("ct");
  });

  it("refuses an explicitly emptied one", () => {
    // A value the vendor deliberately emptied is a mistake, not a request for
    // the default — and the message says which of the two it will accept.
    expect(() => resolveBatonConfig({ dsn: DSN, consentToken: "" })).toThrow(
      /Omit it to take the SDK's default/,
    );
  });

  it("reads no environment variable for it, deliberately", () => {
    // Pinned as an ABSENCE, because the obvious "fix" is to add the read.
    // Python reads BATON_CONSENT_TOKEN on its `Client` door only; its
    // `VendorConfig` — the door this package mirrors — takes a plain default,
    // and the `os.environ[...]` in its install examples is the RECIPE passing
    // a value, not the SDK reading one. Honouring it here would make this arm
    // behave differently from the Python door it mirrors.
    process.env.BATON_CONSENT_TOKEN = "from-the-environment";
    try {
      expect(resolveBatonConfig({ dsn: DSN }).consentToken).toBe(DEFAULT_CONSENT_TOKEN);
    } finally {
      delete process.env.BATON_CONSENT_TOKEN;
    }
  });
});

describe("an install with neither", () => {
  it("names the dsn as the other way to supply a vendorId", () => {
    // `withBaton(server, {})` used to fail a regex test against `undefined`,
    // which describes the pattern rather than the missing value.
    expect(() => withBaton(new McpServer({ name: "x", version: "1.0.0" }), {})).toThrow(
      /either directly, or via a dsn/,
    );
  });

});
