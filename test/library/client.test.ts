import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, INTENT_PARAMS, identityScrub, type Event, type Sink } from "../../src/index.js";
import {
  buildExpectedResultParamDescription,
  buildOverallTaskParamDescription,
  buildUserGoalParamDescription,
} from "../../src/integrations/mcp/llmText.js";

class MemorySink implements Sink {
  readonly events: Event[] = [];
  async write(event: Event): Promise<void> {
    this.events.push(event);
  }
  async flush(): Promise<void> {}
  async aclose(): Promise<void> {}
}

function setup(options: ConstructorParameters<typeof Client>[0] = {}) {
  const sink = new MemorySink();
  const client = new Client({ sink, vendorId: "acme", ...options });
  return { sink, client };
}

const asJson = (event: Event): Record<string, unknown> =>
  JSON.parse(JSON.stringify(event)) as Record<string, unknown>;
const payloadOf = (event: Event): Record<string, unknown> =>
  asJson(event).payload as Record<string, unknown>;

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(
  readFileSync(path.join(here, "..", "..", "baton-spec", "events.schema.json"), "utf-8"),
) as object;
const ajv = new Ajv2020({ strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Client.trace", () => {
  it("emits start and end for a sync callback and returns its value", async () => {
    const { sink, client } = setup();
    const value = client.trace({ toolName: "search", params: { q: "x" } }, () => ({ hits: 2 }));
    await client.flush();

    expect(value).toEqual({ hits: 2 });
    const [start, end] = sink.events;
    expect(sink.events.map((e) => e.event_type)).toEqual(["tool_call_start", "tool_call_end"]);
    expect(start!.call_id).toBe(end!.call_id);
    expect(start!.call_id).not.toBeNull();
    expect(start!.transport_observed).toBe("library");
    expect(start!.session_id_origin).toBe("minted");
    expect(start!.agent_runtime).toBe("unknown");
    expect(start!.runtime_meta).toBeNull();
    expect(start!.session_id).toBe(end!.session_id);
    expect(end!.sequence_number).toBeGreaterThan(start!.sequence_number);
    expect(payloadOf(start!)).toMatchObject({ tool_name: "search", params: { q: "x" } });
    expect(payloadOf(end!).result).toEqual({ hits: 2 });
  });

  it("numbers events from the clock in microseconds", async () => {
    const { sink, client } = setup();
    const before = Date.now() * 1000;
    client.trace({ toolName: "t" }, () => null);
    await client.flush();
    expect(sink.events[0]!.sequence_number).toBeGreaterThanOrEqual(before);
  });

  it("awaits a promise before the call ends", async () => {
    const { sink, client } = setup();
    const value = await client.trace({ toolName: "slow" }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return "done";
    });
    await client.flush();
    expect(value).toBe("done");
    expect(payloadOf(sink.events[1]!).result).toBe("done");
    expect(payloadOf(sink.events[1]!).duration_ms as number).toBeGreaterThanOrEqual(4);
  });

  it("records a sync throw and rethrows the same error", async () => {
    const { sink, client } = setup();
    const boom = new TypeError("bad input");
    expect(() =>
      client.trace({ toolName: "t" }, () => {
        throw boom;
      }),
    ).toThrow(boom);
    await client.flush();
    expect(sink.events[1]!.event_type).toBe("tool_call_error");
    expect(payloadOf(sink.events[1]!)).toMatchObject({
      error_type: "TypeError",
      error_body: "bad input",
      result: null,
    });
    expect(payloadOf(sink.events[1]!)).not.toHaveProperty("failure_kind");
  });

  it("records a rejection and rejects with the same error", async () => {
    const { sink, client } = setup();
    const boom = new RangeError("too far");
    await expect(
      client.trace({ toolName: "t" }, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    await client.flush();
    expect(payloadOf(sink.events[1]!)).toMatchObject({ error_type: "RangeError", error_body: "too far" });
  });

  it("puts intent on the call's start, marked library_arg", async () => {
    const { sink, client } = setup();
    client.trace(
      { toolName: "t", intent: "find the invoice", expectedOutcome: "one invoice", workflow: "2: billing" },
      () => null,
    );
    client.trace({ toolName: "t" }, () => null);
    await client.flush();
    expect(payloadOf(sink.events[0]!)).toMatchObject({
      call_intent: "find the invoice",
      call_expected: "one invoice",
      call_workflow: "2: billing",
      intent_source: "library_arg",
    });
    expect(payloadOf(sink.events[2]!)).toMatchObject({ call_intent: null, intent_source: null });
    expect(sink.events.some((e) => e.event_type === "annotation")).toBe(false);
  });

  it("matches Python on blank text and empty failures", async () => {
    const { sink, client } = setup({ scrubber: identityScrub });
    client.trace({ toolName: "a", intent: "\x1c" }, () => null);
    client.trace({ toolName: "b" }, (trace) => trace.observed("kept", {}));
    client.trace({ toolName: "c" }, (trace) => trace.observed(undefined, { errorType: "", errorBody: "x" }));
    try {
      client.trace({ toolName: "d" }, () => {
        throw new Error("");
      });
    } catch {
      // expected
    }
    await client.annotate({ whatHappened: "\x1f", toolName: "", context: {} });
    await client.flush();
    const byTool = (name: string) => sink.events.filter((e) => payloadOf(e).tool_name === name);
    expect(payloadOf(byTool("a")[0]!).intent_source).toBeNull();
    expect(byTool("b")[1]!.event_type).toBe("tool_call_end");
    expect(payloadOf(byTool("b")[1]!).result).toBe("kept");
    expect(payloadOf(byTool("c")[1]!)).toMatchObject({ error_type: "Error", error_body: "x" });
    expect(payloadOf(byTool("d")[1]!).error_body).toContain("Error");
    const note = sink.events.find((e) => e.event_type === "annotation")!;
    expect(payloadOf(note)).toMatchObject({ what_happened: null, tool_name: "", context: null });
  });

  it("returns a native Promise and calls a thenable's then exactly once", async () => {
    const { client } = setup();
    let runs = 0;
    const lazy = {
      then(resolve: (value: string) => void) {
        runs += 1;
        resolve("rows");
      },
    };
    const out = client.trace({ toolName: "q" }, () => lazy);
    expect(out).toBeInstanceOf(Promise);
    expect(await out).toBe("rows");
    expect(runs).toBe(1);
  });

  it("lets observed() override the return value, or record a caught failure", async () => {
    const { sink, client } = setup();
    client.trace({ toolName: "a" }, (trace) => {
      trace.observed({ shown: true });
      return { raw: true };
    });
    client.trace({ toolName: "b" }, (trace) => {
      trace.observed(undefined, { error: new SyntaxError("caught") });
      return "fallback";
    });
    await client.flush();
    expect(payloadOf(sink.events[1]!).result).toEqual({ shown: true });
    expect(sink.events[3]!.event_type).toBe("tool_call_error");
    expect(payloadOf(sink.events[3]!)).toMatchObject({ error_type: "SyntaxError", error_body: "caught" });
  });

  it("withholds the result under resultCaptureMode off, without scrubbing it", async () => {
    const scrubber = vi.fn((value: unknown) => value);
    const { sink, client } = setup({ resultCaptureMode: "off", scrubber });
    client.trace({ toolName: "t" }, () => "secret body");
    await client.flush();
    expect(payloadOf(sink.events[1]!)).toMatchObject({ result: null, result_capture: "off" });
    expect(scrubber).not.toHaveBeenCalledWith("secret body");
  });

  it("scrubs params and results by default", async () => {
    const { sink, client } = setup();
    client.trace({ toolName: "t", params: { email: "a@b.com" } }, () => "mail a@b.com");
    await client.flush();
    expect(JSON.stringify(sink.events)).not.toContain("a@b.com");
  });
});

describe("Capture never breaks the vendor's call", () => {
  it("a throwing scrubber costs the field or the event, never the call", async () => {
    const { sink, client } = setup({
      scrubber: () => {
        throw new Error("scrubber down");
      },
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const value = client.trace({ toolName: "t", params: { a: 1 }, intent: "x" }, () => 42);
    await client.flush();
    expect(value).toBe(42);
    expect(sink.events.map((e) => e.event_type)).toEqual(["tool_call_start"]);
    expect(payloadOf(sink.events[0]!)).toMatchObject({ params: {}, call_intent: null });
  });

  it("a thrown value with no usable message is passed on unchanged", async () => {
    const { sink, client } = setup();
    const bare = Object.create(null) as object;
    class Trap extends Error {
      override get message(): string {
        throw new Error("getter");
      }
    }
    const trap = new Trap();
    // Vendor code may throw anything, so these tests do too.
    /* eslint-disable @typescript-eslint/only-throw-error, @typescript-eslint/prefer-promise-reject-errors */
    for (const thrown of [bare, trap]) {
      let caught: unknown;
      try {
        client.trace({ toolName: "t" }, () => {
          throw thrown;
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBe(thrown);
      await expect(client.trace({ toolName: "t" }, () => Promise.reject(thrown))).rejects.toBe(thrown);
    }
    /* eslint-enable @typescript-eslint/only-throw-error, @typescript-eslint/prefer-promise-reject-errors */
    expect(() => client.trace({ toolName: "t" }, (trace) => trace.observed(undefined, { error: trap }))).not.toThrow();
    await client.flush();
    expect(sink.events.filter((e) => e.event_type === "tool_call_error")).toHaveLength(5);
  });

  it("missing options from a JavaScript caller do not throw", async () => {
    const { client } = setup();
    const loose = client as unknown as {
      trace(o: undefined, fn: () => number): number;
      annotate(o: undefined): Promise<void>;
      wrap(o: undefined, fn: () => number): () => number;
    };
    expect(loose.trace(undefined, () => 1)).toBe(1);
    await expect(loose.annotate(undefined)).resolves.toBeUndefined();
    expect(loose.wrap(undefined, () => 2)()).toBe(2);
  });

  it("a failing sink is logged and dropped", async () => {
    const broken: Sink = {
      write: () => Promise.reject(new Error("network down")),
      flush: () => Promise.reject(new Error("flush down")),
      aclose: () => Promise.reject(new Error("close down")),
    };
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const client = new Client({ sink: broken, vendorId: "acme" });
    expect(await client.trace({ toolName: "t" }, async () => "ok")).toBe("ok");
    await expect(client.annotate({ whatHappened: "x" })).resolves.toBeUndefined();
    await expect(client.flush()).resolves.toBeUndefined();
    await expect(client.aclose()).resolves.toBeUndefined();
  });

  it("a closed client still runs the callback and sends nothing", async () => {
    const { sink, client } = setup();
    await client.aclose();
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(client.trace({ toolName: "t" }, () => 1)).toBe(1);
    await client.flush();
    expect(sink.events).toEqual([]);
  });

  it("BATON_DISABLED sends nothing, scrubs nothing and validates nothing", async () => {
    vi.stubEnv("BATON_DISABLED", "1");
    vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const scrubber = vi.fn((value: unknown) => value);
    const client = new Client({ scrubber });
    const value = client.session({ sessionId: "s", clientInfo: { name: "c" } }, () =>
      client.trace({ toolName: "t", params: { a: 1 } }, () => "r"),
    );
    expect(value).toBe("r");
    await client.annotate({ whatHappened: "x" });
    await client.aclose();
    expect(scrubber).not.toHaveBeenCalled();
  });
});

describe("Client.session", () => {
  it("gives every call inside it the block's values, across awaits", async () => {
    const { sink, client } = setup();
    await client.session(
      {
        sessionId: "  conv-1  ",
        principal: { principalId: "user-7", displayName: "Ann" },
        clientInfo: { name: "my-agent", version: "1.2" },
        headers: { "User-Agent": "agent/1", authorization: "Bearer x", "X-Anthropic-Client": ["a", "b"] },
        turnId: "run-9",
      },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        await client.trace({ toolName: "t" }, async () => null);
        await client.annotate({ whatHappened: "slow" });
      },
    );
    await client.flush();
    expect(sink.events).toHaveLength(3);
    for (const event of sink.events) {
      expect(event.session_id).toBe("conv-1");
      expect(event.session_id_origin).toBe("observed");
      expect(event.principal).toEqual({ id: "user-7", source: "asserted", form: "raw", display_name: "Ann" });
      expect(event.client_observed).toEqual({
        info: { name: "my-agent", version: "1.2" },
        headers: { "user-agent": "agent/1", "x-anthropic-client": "a, b" },
      });
      expect(event.runtime_meta).toEqual({ "baton/turn_id": "run-9" });
    }
    expect(JSON.stringify(sink.events)).not.toContain("Bearer");
  });

  it("keeps registered headers when another header has a name Headers refuses", async () => {
    const { sink, client } = setup();
    client.session({ headers: { "bad header": "x", "user-agent": "agent/1" } }, () =>
      client.trace({ toolName: "t" }, () => null),
    );
    await client.flush();
    expect(sink.events[0]!.client_observed).toEqual({ headers: { "user-agent": "agent/1" } });
  });

  it("reads only string header values, and a value Headers refuses costs only itself", async () => {
    const { sink, client } = setup();
    client.session({ headers: new Map([["x-anthropic-client", "cc"]]) as unknown as Headers }, () =>
      client.trace({ toolName: "a" }, () => null),
    );
    client.session({ headers: { "user-agent": "ok/1", "x-anthropic-client": "caf\u00e9 \u2615" } }, () =>
      client.trace({ toolName: "b" }, () => null),
    );
    await client.flush();
    expect(sink.events[0]!.client_observed).toEqual({ headers: { "x-anthropic-client": "cc" } });
    expect(sink.events[2]!.client_observed).toEqual({ headers: { "user-agent": "ok/1" } });
  });

  it("closes the sink once when aclose is called twice at once", async () => {
    const sink = new MemorySink();
    const close = vi.spyOn(sink, "aclose");
    const client = new Client({ sink, vendorId: "acme" });
    await Promise.all([client.aclose(), client.aclose()]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("sends session and turn ids as passed, without the scrubber", async () => {
    const { sink, client } = setup();
    client.session({ sessionId: "ann@example.com", turnId: "bob@example.com" }, () =>
      client.trace({ toolName: "t" }, () => null),
    );
    await client.flush();
    expect(sink.events[0]!.session_id).toBe("ann@example.com");
    expect(sink.events[0]!.runtime_meta).toEqual({ "baton/turn_id": "bob@example.com" });
  });

  it("mints a session for a blank id and drops a blank turn", async () => {
    const { sink, client } = setup();
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    client.session({ sessionId: "   ", turnId: "" }, () => client.trace({ toolName: "t" }, () => null));
    await client.flush();
    expect(sink.events[0]!.session_id_origin).toBe("minted");
    expect(sink.events[0]!.runtime_meta).toBeNull();
  });

  it("keeps two concurrent blocks apart", async () => {
    const { sink, client } = setup();
    const run = (id: string, delay: number) =>
      client.session({ sessionId: id }, async () => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        await client.trace({ toolName: id }, async () => null);
      });
    await Promise.all([run("first", 10), run("second", 1)]);
    await client.flush();
    for (const event of sink.events) {
      expect(event.session_id).toBe((payloadOf(event).tool_name as string));
    }
  });

  it("does not reach another client's calls", async () => {
    const a = setup();
    const b = setup();
    a.client.session({ sessionId: "a-only" }, () => b.client.trace({ toolName: "t" }, () => null));
    await b.client.flush();
    expect(b.sink.events[0]!.session_id).not.toBe("a-only");
    expect(b.sink.events[0]!.session_id_origin).toBe("minted");
  });

  it("gives each call outside a block its own session", async () => {
    const { sink, client } = setup();
    client.trace({ toolName: "a" }, () => null);
    client.trace({ toolName: "b" }, () => null);
    await client.flush();
    expect(sink.events[0]!.session_id).not.toBe(sink.events[2]!.session_id);
  });
});

describe("Client.wrap", () => {
  it("traces each call; one plain-object argument is the params", async () => {
    const { sink, client } = setup({ scrubber: identityScrub });
    const search = client.wrap("search", async (args: { q: string }) => `found ${args.q}`);
    expect(await search({ q: "cats" })).toBe("found cats");
    await client.flush();
    expect(payloadOf(sink.events[0]!)).toMatchObject({ tool_name: "search", params: { q: "cats" } });
    expect(payloadOf(sink.events[1]!).result).toBe("found cats");
  });

  it("keeps other arguments as a list, and keeps `this`", async () => {
    const { sink, client } = setup({ scrubber: identityScrub });
    const api = {
      base: 10,
      add: client.wrap({ toolName: "add" }, function (this: { base: number }, a: number, b: number) {
        return this.base + a + b;
      }),
    };
    expect(api.add(1, 2)).toBe(13);
    await client.flush();
    expect(payloadOf(sink.events[0]!).params).toEqual({ args: [1, 2] });
  });
});

describe("annotate", () => {
  it("trace.annotate reports in the call's session", async () => {
    const { sink, client } = setup();
    await client.trace({ toolName: "t" }, async (trace) => {
      await trace.annotate({ whatHappened: "empty result", toolName: "t", suggestedImprovement: "say why" });
    });
    await client.flush();
    const note = sink.events.find((e) => e.event_type === "annotation")!;
    expect(note.session_id).toBe(sink.events[0]!.session_id);
    expect(note.call_id).toBeNull();
    expect(payloadOf(note)).toMatchObject({
      what_happened: "empty result",
      tool_name: "t",
      suggested_improvement: "say why",
    });
  });
});

describe("wire shape", () => {
  it("every event validates against events.schema.json", async () => {
    const { sink, client } = setup();
    await client.session({ sessionId: "s", principal: { principalId: "p" }, turnId: "t" }, async () => {
      client.trace({ toolName: "ok", intent: "i" }, () => ({ a: 1 }));
      try {
        client.trace({ toolName: "bad" }, () => {
          throw new Error("x");
        });
      } catch {
        // expected
      }
      await client.annotate({ whatHappened: "w", context: { k: "v" } });
    });
    await client.flush();
    expect(sink.events).toHaveLength(5);
    for (const event of sink.events) {
      expect(validate(asJson(event)), ajv.errorsText(validate.errors)).toBe(true);
    }
  });
});

describe("Client config", () => {
  it("needs a sink or a dsn", () => {
    expect(() => new Client({ vendorId: "acme" })).toThrow(/somewhere to send events/);
  });

  it("refuses a dsn beside an explicit vendorId", () => {
    expect(
      () => new Client({ dsn: "https://baton_pk_abcdefgh123@ingest.example.com/ten_0123abcd/acme", vendorId: "x" }),
    ).toThrow(/both a dsn and an explicit vendorId/);
  });

  it("reads BATON_VENDOR_ID and BATON_CONSENT_TOKEN", async () => {
    vi.stubEnv("BATON_VENDOR_ID", "from-env");
    vi.stubEnv("BATON_CONSENT_TOKEN", "tok");
    const sink = new MemorySink();
    const client = new Client({ sink });
    client.trace({ toolName: "t" }, () => null);
    await client.flush();
    expect(sink.events[0]).toMatchObject({ vendor_id: "from-env", tenant_id: "from-env", consent_token: "tok" });
  });
});

describe("INTENT_PARAMS", () => {
  it("names the three injected params with the MCP wording, unlabelled", () => {
    expect(INTENT_PARAMS.map((p) => [p.name, p.traceOption])).toEqual([
      ["user_goal", "intent"],
      ["expected_result", "expectedOutcome"],
      ["overall_task", "workflow"],
    ]);
    const labelled = [
      buildUserGoalParamDescription({ intentParamMode: "required" }),
      buildExpectedResultParamDescription({ intentParamMode: "required" }),
      buildOverallTaskParamDescription({ intentParamMode: "required" }),
    ];
    INTENT_PARAMS.forEach((p, i) => expect(`REQUIRED. ${p.description}`).toBe(labelled[i]));
  });
});
