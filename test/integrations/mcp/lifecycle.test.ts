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
import { MAJORS, CapturingSink, install } from "./_majors.js";
import type { Event } from "../../../src/events.js";

describe.each(MAJORS)("resource and prompt lifecycles — $label", (major) => {
  const payloadOf = (sink: CapturingSink, type: Event["event_type"]): Record<string, unknown> => {
    const event = sink.events.find((e) => e.event_type === type);
    expect(event, `no ${type} was emitted`).toBeDefined();
    return JSON.parse(JSON.stringify(event!.payload)) as Record<string, unknown>;
  };

  const connected = async (sink: CapturingSink, read?: () => unknown) => {
    const server = major.make();
    major.resource(
      server,
      "doc",
      "file:///doc.txt",
      read ?? (() => ({ contents: [{ uri: "file:///doc.txt", text: "the body" }] })),
    );
    major.prompt(server, "summarize", { topic: z.string() }, () => ({
      messages: [{ role: "user", content: { type: "text", text: "do it" } }],
    }));
    install(server, sink);
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
    major.resource(server, "doc", uri, () => ({ contents: [{ uri, text: "x" }] }));
    install(server, sink);
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
    major.resource(server, "doc", "file:///doc.txt", () => {
      throw new Error("could not reach alice@corp.com for file:///doc.txt");
    });
    install(server, sink);
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
    install(server, sink);
    major.resource(server, "late", "file:///late.txt", () => ({
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

  it("never asks the principal hook, on any of the four requests", async () => {
    const sink = new CapturingSink();
    const server = major.make();
    major.resource(server, "doc", "file:///doc.txt", () => ({
      contents: [{ uri: "file:///doc.txt", text: "x" }],
    }));
    major.prompt(server, "summarize", { topic: z.string() }, () => ({ messages: [] }));
    let asked = 0;
    install(server, sink, {
      resolvePrincipal: () => {
        asked += 1;
        return { principalId: "employee-1" };
      },
    });
    const client = await major.connect(server);

    await client.listResources();
    await client.readResource({ uri: "file:///doc.txt" });
    await client.listPrompts();
    await client.getPrompt({ name: "summarize", arguments: { topic: "quarterly" } });

    expect(sink.events).toHaveLength(8);
    expect(asked).toBe(0);
    expect(sink.events.map((e) => e.principal)).toEqual(Array(8).fill(null));
  });

  it("carries the envelope a tool call does, with a null `principal` and `call_id`", async () => {
    // `null`, not absent: `envelopeShape` defaults both members, and SPEC
    // §11.4 makes the two spellings equivalent.
    const sink = new CapturingSink();
    const server = major.make();
    major.resource(server, "doc", "file:///doc.txt", () => ({
      contents: [{ uri: "file:///doc.txt", text: "x" }],
    }));
    install(server, sink);
    const client = await major.connect(server);
    await client.readResource({ uri: "file:///doc.txt" });

    expect(sink.events).toHaveLength(2);
    for (const event of sink.events) {
      const wire = JSON.parse(JSON.stringify(event)) as Record<string, unknown>;
      expect(wire["principal"]).toBeNull();
      expect(wire["call_id"]).toBeNull();
      // The envelope is otherwise the SAME one a tool call carries, which is
      // what lets one endpoint accept every type.
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
    major.resource(server, "doc", "file:///doc.txt", () => ({
      contents: [{ uri: "file:///doc.txt", text: "x" }],
    }));
    major.tool(server, "works", { name: z.string() }, () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));
    install(server, sink);
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
