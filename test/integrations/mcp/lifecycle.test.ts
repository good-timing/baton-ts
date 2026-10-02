/**
 * SPEC §11.4.4 — the resource and prompt lifecycles, this package's first
 * instrumentation of anything but a tool call.
 *
 * ⚠ **The twelve shapes were set by `baton-proxy`, which shipped first**, so
 * every assertion here is a parity assertion against that producer rather than
 * a design choice being pinned. Two of its inconsistencies are asserted ON
 * PURPOSE — `resource_read_start.params` carries `uri` as well as its own
 * member, `prompt_get_start.params` does NOT carry `name` — because a test
 * that tidied them would let this producer drift from the one the Console was
 * built against.
 *
 * ⚠ Driven through a real client over a real transport on both majors. The
 * seams sit on `_requestHandlers`, so nothing short of a dispatched request
 * exercises them.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { withBaton } from "../../../src/integrations/mcp/withBaton.js";
import { MAJORS, CapturingSink } from "./_majors.js";
import type { Event } from "../../../src/events.js";

/** Per-major registration for the two primitives this file needs. Not in
 * `_majors.ts` because nothing else needs them yet, and the shapes differ
 * enough that folding them in would put a second branch on `label`. */
interface Primitives {
  resource(server: unknown, name: string, uri: string, read: () => unknown): void;
  prompt(server: unknown, name: string, get: (args: unknown) => unknown): void;
}

const PRIMITIVES: Record<string, Primitives> = {
  "@modelcontextprotocol/sdk 1.x": {
    resource: (server, name, uri, read) =>
      (server as { registerResource: (...a: unknown[]) => unknown }).registerResource(
        name,
        uri,
        {},
        read,
      ),
    prompt: (server, name, get) =>
      (server as { registerPrompt: (...a: unknown[]) => unknown }).registerPrompt(
        name,
        { argsSchema: { topic: z.string() } },
        get,
      ),
  },
  "@modelcontextprotocol/server 2.x": {
    resource: (server, name, uri, read) =>
      (server as { registerResource: (...a: unknown[]) => unknown }).registerResource(
        name,
        uri,
        {},
        read,
      ),
    prompt: (server, name, get) =>
      (server as { registerPrompt: (...a: unknown[]) => unknown }).registerPrompt(
        name,
        { argsSchema: z.object({ topic: z.string() }) },
        get,
      ),
  },
};

describe.each(MAJORS)("resource and prompt lifecycles — $label", (major) => {
  const prims = PRIMITIVES[major.label]!;

  const payloadOf = (sink: CapturingSink, type: Event["event_type"]): Record<string, unknown> => {
    const event = sink.events.find((e) => e.event_type === type);
    expect(event, `no ${type} was emitted`).toBeDefined();
    return JSON.parse(JSON.stringify(event!.payload)) as Record<string, unknown>;
  };

  const connected = async (sink: CapturingSink, read?: () => unknown) => {
    const server = major.make();
    prims.resource(
      server,
      "doc",
      "file:///doc.txt",
      read ?? (() => ({ contents: [{ uri: "file:///doc.txt", text: "the body" }] })),
    );
    prims.prompt(server, "summarize", () => ({
      messages: [{ role: "user", content: { type: "text", text: "do it" } }],
    }));
    withBaton(server as never, {
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
      sink,
    });
    return { server, client: await major.connect(server) };
  };

  it("files resources/read as start + end, with the URI and the timing and NO body", async () => {
    const sink = new CapturingSink();
    const { client } = await connected(sink);
    const result = (await client.readResource({ uri: "file:///doc.txt" })) as {
      contents: { text: string }[];
    };

    // The caller still gets the body; the sensor does not.
    expect(result.contents[0]!.text).toBe("the body");
    expect(sink.events.map((e) => e.event_type)).toEqual([
      "resource_read_start",
      "resource_read_end",
    ]);

    const start = payloadOf(sink, "resource_read_start");
    expect(start["uri"]).toBe("file:///doc.txt");
    // ⚠ `uri` is in `params` TOO. The proxy builds this member by removing
    // `_meta` from the request params and nothing else, so the subject appears
    // twice — asserted rather than tidied, because the Console was built
    // against that producer.
    expect(start["params"]).toEqual({ uri: "file:///doc.txt" });

    const end = payloadOf(sink, "resource_read_end");
    expect(end["uri"]).toBe("file:///doc.txt");
    expect(typeof end["duration_ms"]).toBe("number");
    // ⚠ **The assertion this whole family exists for.** No member of any of
    // the twelve carries content, so `"the body"` must not appear ANYWHERE in
    // what was emitted — and therefore there is nothing for
    // `resultCaptureMode: "off"` to withhold, which is why SPEC §11.4.4
    // forbids `result_capture` on these payloads.
    expect(JSON.stringify(sink.events)).not.toContain("the body");
    expect(end).not.toHaveProperty("result_capture");
    expect(end).not.toHaveProperty("result");
  });

  it("files prompts/get with the NAME and its arguments — and not the rendered messages", async () => {
    const sink = new CapturingSink();
    const { client } = await connected(sink);
    await client.getPrompt({ name: "summarize", arguments: { topic: "quarterly" } });

    expect(sink.events.map((e) => e.event_type)).toEqual(["prompt_get_start", "prompt_get_end"]);
    const start = payloadOf(sink, "prompt_get_start");
    expect(start["name"]).toBe("summarize");
    // ⚠ `arguments` ALONE, so `name` is NOT in here — the opposite of the
    // resource read above. The two disagree in the producer the shapes came
    // from; both halves of that disagreement are asserted so neither drifts.
    expect(start["params"]).toEqual({ topic: "quarterly" });
    expect(start["params"]).not.toHaveProperty("name");
    // The SERVER authored this text, and the standing answer from the only
    // producer is that it does not egress.
    expect(JSON.stringify(sink.events)).not.toContain("do it");
  });

  it("scrubs the URI in EVERY member that carries it, not just `params`", async () => {
    // ⚠ **The leak this family shipped with, caught by review.** `uri` and
    // `name` are CALLER-supplied free text — paths, query strings, account
    // ids, emails — not vendor-registered identifiers like `tool_name`. A
    // first version scrubbed only `params`, so a read of
    // `file:///alice@corp.com/doc.txt` put the path REDACTED inside `params`
    // and RAW in the sibling `uri`, in one event, which makes the redaction
    // worthless for that value. The payload is now scrubbed WHOLE, which is
    // also what the proxy does (`emitter.py`: `payload = self._scrubber(payload)`).
    //
    // ⚠ Why 619 green tests missed it: every other fixture URI in this file is
    // PII-free, so no assertion could fire. The default scrubber redacts
    // emails, so one PII-bearing URI is all the detector needs.
    const sink = new CapturingSink();
    const server = major.make();
    const uri = "file:///alice@corp.com/doc.txt";
    prims.resource(server, "doc", uri, () => ({ contents: [{ uri, text: "x" }] }));
    withBaton(server as never, {
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
      sink,
    });
    const client = await major.connect(server);
    await client.readResource({ uri });

    // Nowhere, on any leg, in any member.
    expect(JSON.stringify(sink.events)).not.toContain("alice@corp.com");
    for (const type of ["resource_read_start", "resource_read_end"] as const) {
      expect(payloadOf(sink, type)["uri"]).toContain("REDACTED");
    }
  });

  it("scrubs the error leg too, and still caps AFTER scrubbing", async () => {
    // Both halves matter and the ORDER is the point: a PII value straddling
    // the cap must reach the scrubber whole, or the surviving half ships
    // unredacted. Same ruling as `errorBody` for the tool-call legs.
    const sink = new CapturingSink();
    const server = major.make();
    prims.resource(server, "doc", "file:///doc.txt", () => {
      throw new Error("could not reach alice@corp.com for file:///doc.txt");
    });
    withBaton(server as never, {
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
      sink,
    });
    const client = await major.connect(server);
    await client.readResource({ uri: "file:///doc.txt" }).catch(() => {});

    const error = payloadOf(sink, "resource_read_error");
    expect(error["error_body"]).toContain("REDACTED");
    expect(error["error_body"]).not.toContain("alice@corp.com");
    expect([...(error["error_body"] as string)].length).toBeLessThanOrEqual(2000);
  });

  it("spells an absent `params` as `{}`, which is the proxy's spelling", async () => {
    // ⚠ Parity, not conformance: the schema permits object OR null, and the
    // proxy never emits null (`dict(params) if params else {}`). A Console
    // consumer doing `Object.keys(payload.params)` is safe against that
    // producer and would throw on a null from this one.
    const sink = new CapturingSink();
    const { client } = await connected(sink);
    await client.getPrompt({ name: "summarize" }).catch(() => {});

    expect(payloadOf(sink, "prompt_get_start")["params"]).toEqual({});
  });

  it("seams a resource registered AFTER withBaton ran", async () => {
    // ⚠ Install ORDER is irrelevant for these four seams, unlike the two
    // `tools/*` ones: `installRequestSeam` patches `setRequestHandler`, so the
    // handler `registerResource` installs later is wrapped as it lands. The
    // install-site comment claimed the annotate-tool ordering mattered here,
    // which was the tool seams' reason copied one function too far.
    const sink = new CapturingSink();
    const server = major.make();
    withBaton(server as never, {
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
      sink,
    });
    prims.resource(server, "late", "file:///late.txt", () => ({
      contents: [{ uri: "file:///late.txt", text: "x" }],
    }));
    const client = await major.connect(server);
    await client.readResource({ uri: "file:///late.txt" });

    expect(sink.events.map((e) => e.event_type)).toEqual([
      "resource_read_start",
      "resource_read_end",
    ]);
  });

  it("counts the `resources` array on a list, never resource templates", async () => {
    const sink = new CapturingSink();
    const { client } = await connected(sink);
    await client.listResources();

    expect(sink.events.map((e) => e.event_type)).toEqual([
      "resource_list_start",
      "resource_list_end",
    ]);
    expect(payloadOf(sink, "resource_list_start")).toEqual({});
    // One registered resource. ⚠ Templates live behind a separate MCP method
    // with their own result array and are deliberately not added in, matching
    // the proxy — so a template-only server reports 0, which §11.4.4 says a
    // consumer MUST NOT read as "this server has no resources".
    expect(payloadOf(sink, "resource_list_end")["count"]).toBe(1);
  });

  it("counts the `prompts` array on a prompts list", async () => {
    const sink = new CapturingSink();
    const { client } = await connected(sink);
    await client.listPrompts();

    expect(sink.events.map((e) => e.event_type)).toEqual(["prompt_list_start", "prompt_list_end"]);
    expect(payloadOf(sink, "prompt_list_end")["count"]).toBe(1);
  });

  it("files a failing read as `*_error` with the exception's CLASS NAME", async () => {
    // ⚠ **The error leg is THROW-ONLY, which is why there is no returned-flag
    // branch in the seam.** `isError` is a `CallToolResult` member; a failing
    // resource read comes back as a JSON-RPC error. So `error_type` is
    // §11.4.3's RAISE spelling — the class name — where `baton-proxy` files
    // the JSON-RPC numeric code, because the wire is what IT holds. §11.4.4
    // states that divergence; both conform, and the member is an open string.
    const sink = new CapturingSink();
    const { client } = await connected(sink, () => {
      throw new TypeError("the vendor's own problem");
    });
    await client.readResource({ uri: "file:///doc.txt" }).catch(() => {});

    expect(sink.events.map((e) => e.event_type)).toEqual([
      "resource_read_start",
      "resource_read_error",
    ]);
    const error = payloadOf(sink, "resource_read_error");
    expect(error["uri"]).toBe("file:///doc.txt");
    // The class name, NOT a JSON-RPC code: both majors let a resource
    // callback's exception out of the request handler unconverted, so the
    // RAISE shape is the only one this vantage point ever sees.
    expect(error["error_type"]).toBe("TypeError");
    expect(error["error_body"]).toContain("the vendor's own problem");
    expect(typeof error["duration_ms"]).toBe("number");
    // ⚠ No `failure_kind` and no `result` on any of the six error payloads:
    // there is no returned-flag shape for a resource or a prompt, so §11.4.3's
    // RETURN discriminator has no counterpart here.
    expect(error).not.toHaveProperty("failure_kind");
    expect(error).not.toHaveProperty("result");
  });

  it("never consults the TOOL-shaped principal hook, and mints no `call_id`", async () => {
    // ⚠ Both are decisions, not gaps. The vendor's `resolvePrincipal` hook is
    // TOOL-shaped (`{extra, toolName, arguments}`), so calling it with a URI in
    // `toolName` would stretch a contract a vendor's hook cannot anticipate;
    // and the proxy — whose shapes these are — stamps neither member on these
    // types. A consumer pairing a start with its end therefore has only SPEC
    // §11.5.4's FIFO floor, which §11.4.4 records.
    //
    // ⚠ **The values are `null`, not absent, and that is the ENVELOPE's
    // posture rather than this seam's.** `envelopeShape` defaults both members
    // to `null`, so every event this package emits carries the keys — exactly
    // as a tool call with no resolved identity already does. SPEC §11.4 makes
    // null and absent equivalent on both (`principal` is "absent as a whole
    // whenever no identity was resolved"; `call_id` is "absent wherever the
    // producer did not mint one ... never an error"), and §11.4.3 documents
    // this same declare-vs-omit axis between this package and the proxy for
    // `result`. So a first version of this test asserted the keys were MISSING
    // and was wrong about the package, not about the design.
    const sink = new CapturingSink();
    const server = major.make();
    prims.resource(server, "doc", "file:///doc.txt", () => ({
      contents: [{ uri: "file:///doc.txt", text: "x" }],
    }));
    withBaton(server as never, {
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
      sink,
      // A hook that would THROW if the seam called it — the assertion is that
      // it never does, which an absent-`principal` check alone would not prove
      // (an absent hook also yields an absent principal).
      resolvePrincipal: () => {
        throw new Error("the lifecycle seams must not consult a tool-shaped hook");
      },
    });
    const client = await major.connect(server);
    await client.readResource({ uri: "file:///doc.txt" });

    expect(sink.events).toHaveLength(2);
    for (const event of sink.events) {
      const wire = JSON.parse(JSON.stringify(event)) as Record<string, unknown>;
      // Null, which is the envelope's spelling for "nobody was resolved" and
      // "no id was minted". The hook THROWS, so a null here is also the proof
      // that the seam never reached it — an absent-hook test could not tell
      // "not consulted" from "consulted and resolved nothing".
      expect(wire["principal"]).toBeNull();
      expect(wire["call_id"]).toBeNull();
      // The envelope is otherwise the SAME one a tool call carries, which is
      // what lets one endpoint accept all seventeen types.
      expect(wire["tenant_id"]).toBe("acme");
      expect(wire["vendor_id"]).toBe("acme");
      expect(wire["consent_token"]).toBe("ct");
      expect(typeof wire["session_id"]).toBe("string");
      expect(typeof wire["sequence_number"]).toBe("number");
    }
    // One monotonic counter across every event type on the session, which is
    // what the worker orders on.
    expect(sink.events.map((e) => e.sequence_number)).toEqual([1, 2]);
  });

  it("shares the session's sequence counter with tool calls", async () => {
    // The lifecycles and the tool calls are one stream, not two — §11.4.4's
    // reason for reusing the envelope. A separate counter would make
    // `(session_id, sequence_number)` ambiguous and silently misorder a
    // session that mixes them.
    const sink = new CapturingSink();
    const server = major.make();
    prims.resource(server, "doc", "file:///doc.txt", () => ({
      contents: [{ uri: "file:///doc.txt", text: "x" }],
    }));
    major.tool(server, "works", { name: z.string() }, () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));
    withBaton(server as never, {
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
      sink,
    });
    const client = await major.connect(server);
    await client.readResource({ uri: "file:///doc.txt" });
    await client.callTool({ name: "works", arguments: { name: "p1" } });

    expect(sink.events.map((e) => e.event_type)).toEqual([
      "resource_read_start",
      "resource_read_end",
      "surface_snapshot",
      "tool_call_start",
      "tool_call_end",
    ]);
    expect(sink.events.map((e) => e.sequence_number)).toEqual([1, 2, 3, 4, 5]);
  });
});
