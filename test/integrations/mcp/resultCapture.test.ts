/**
 * SPEC §11.4 — `resultCaptureMode: "off"` withholds result-derived data, and
 * says so on the wire. §11.2.6 (what a conforming SDK must do), §11.4.3 (which
 * of the two failure shapes withholds what), §7 (the scrubber MUST NOT be
 * invoked on a withheld result).
 *
 * ⚠ **Every other fixture in this package captures a response**, so `"off"` is
 * a branch no test here has ever entered — the mode-switched blind spot, where
 * a green suite and a working server are blind for the same reason. So the
 * mode is synthesised, and each test is written to be able to fail:
 *
 * - **The discriminator is "was the scrubber CALLED", not "is `result` empty".**
 *   A payload with a null result is produced by BOTH a correct short-circuit
 *   and a wrong one that scrubs the body and then discards it — and the second
 *   has already run the vendor's code over data we promised not to touch. A
 *   counting scrubber tells the two apart; a payload assertion cannot.
 * - **The control is the same fixture under `"full"`**, which must record a
 *   call. Without it, a scrubber never invoked for an unrelated reason (a
 *   broken fixture, a tool that never ran) passes the `"off"` leg vacuously.
 *
 * Runs on BOTH MCP majors, because the wrapper sees the vendor's literal
 * return and the two SDKs hand it over differently.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { withBaton } from "../../../src/integrations/mcp/withBaton.js";
import { MAJORS, CapturingSink } from "./_majors.js";
import type { Event } from "../../../src/events.js";

const SECRET = "row-42-social-security-000-00-0000";

/** A scrubber that remembers everything it was asked to scrub.
 *
 * Identity, so `"full"` behaves exactly as an unconfigured SDK does and the
 * control leg is not testing this helper instead of the code under test. */
class Recorder {
  readonly calls: unknown[] = [];

  scrub = (value: unknown): unknown => {
    this.calls.push(value);
    return value;
  };

  /** Whether the secret ever reached the scrubber, at any depth. */
  saw(needle: string): boolean {
    return this.calls.some((c) => JSON.stringify(c ?? null)?.includes(needle));
  }
}

function terminal<T extends Event["event_type"]>(
  sink: CapturingSink,
  expected: T,
): Extract<Event, { event_type: T }> {
  const event = sink.events[sink.events.length - 1]!;
  expect(event.event_type).toBe(expected);
  return event as Extract<Event, { event_type: T }>;
}

describe.each(MAJORS)("resultCaptureMode — $label", (major) => {
  const install = (
    server: unknown,
    sink: CapturingSink,
    mode: "full" | "off",
    rec: Recorder,
  ) =>
    withBaton(server as never, {
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
      sink,
      scrubber: rec.scrub,
      resultCaptureMode: mode,
    });

  /** One successful call through a tool whose body carries the secret. */
  const runOk = async (mode: "full" | "off") => {
    const sink = new CapturingSink();
    const rec = new Recorder();
    const server = major.make();
    major.tool(server, "fetch", { row: z.string() }, () => ({
      content: [{ type: "text" as const, text: SECRET }],
    }));
    install(server, sink, mode, rec);
    const client = await major.connect(server);
    await client.callTool({ name: "fetch", arguments: { row: "42" } });
    return { sink, rec };
  };

  /** One call that RETURNS the error flag — the shape that withholds both. */
  const runReturnedError = async (mode: "full" | "off") => {
    const sink = new CapturingSink();
    const rec = new Recorder();
    const server = major.make();
    major.tool(server, "soft_fail", { row: z.string() }, () => ({
      content: [{ type: "text" as const, text: SECRET }],
      isError: true,
    }));
    install(server, sink, mode, rec);
    const client = await major.connect(server);
    await client.callTool({ name: "soft_fail", arguments: { row: "42" } });
    return { sink, rec };
  };

  /** One call that THROWS — the shape `"off"` must leave alone. */
  const runThrow = async (mode: "full" | "off") => {
    const sink = new CapturingSink();
    const rec = new Recorder();
    const server = major.make();
    major.tool(server, "hard_fail", { row: z.string() }, () => {
      throw new Error(`no such row ${SECRET}`);
    });
    install(server, sink, mode, rec);
    const client = await major.connect(server);
    await client.callTool({ name: "hard_fail", arguments: { row: "42" } }).catch(() => undefined);
    return { sink, rec };
  };

  // ==========================================================================
  // 1 · The short-circuit
  // ==========================================================================

  it("off: the scrubber is NEVER invoked on the result", async () => {
    const { rec } = await runOk("off");
    expect(rec.saw(SECRET), "SPEC §7 forbids invoking the scrubber on a withheld result").toBe(
      false,
    );
  });

  it("full: the scrubber IS invoked — the control", async () => {
    const { rec } = await runOk("full");
    expect(rec.saw(SECRET)).toBe(true);
  });

  it("off: neither errorText nor the scrubber touches a RETURNED failure's body", async () => {
    const { rec } = await runReturnedError("off");
    expect(rec.saw(SECRET)).toBe(false);
  });

  it("full: the returned failure's body IS read — the control", async () => {
    const { rec } = await runReturnedError("full");
    expect(rec.saw(SECRET)).toBe(true);
  });

  // ==========================================================================
  // 2 · The wire
  // ==========================================================================

  it("off: tool_call_end carries the marker and no body", async () => {
    const { sink } = await runOk("off");
    const event = terminal(sink, "tool_call_end");
    expect(event.payload.result_capture).toBe("off");
    expect(event.payload.result).toBeNull();
    // SPEC §11.2.6 — classification, pairing and timing all still work.
    expect(event.payload.tool_name).toBe("fetch");
    expect(typeof event.payload.duration_ms).toBe("number");
  });

  it("off: the RETURNED failure withholds BOTH members and stays classified", async () => {
    const { sink } = await runReturnedError("off");
    const event = terminal(sink, "tool_call_error");
    expect(event.payload.result_capture).toBe("off");
    expect(event.payload.result).toBeNull();
    // `""` and not dropped: `error_body` is REQUIRED on this payload, and the
    // marker is what distinguishes withheld from "the failure said nothing".
    expect(event.payload.error_body).toBe("");
    // Not result-derived, so the classification survives.
    expect(event.payload.error_type).toBe("tool_error");
  });

  it("off: the THROW shape is UNCHANGED, and carries NO marker", async () => {
    // §11.4.3(1): a thrown error's message is the vendor's own code speaking
    // about a call that returned nothing, so nothing here is result-derived
    // and nothing is withheld — including the marker, which would otherwise
    // claim a withholding that did not happen.
    const off = await runThrow("off");
    const full = await runThrow("full");
    const a = terminal(off.sink, "tool_call_error");
    const b = terminal(full.sink, "tool_call_error");

    // EQUALITY across the two modes is the assertion, not a literal message:
    // what §11.4.3 promises is that `"off"` changes this leg not at all.
    expect(a.payload.error_body).toBe(b.payload.error_body);
    expect(a.payload.error_type).toBe(b.payload.error_type);
    // ...and the control for that: there has to be something to preserve.
    expect(a.payload.error_body, "a blank body would satisfy equality vacuously").not.toBe("");
    expect(a.payload.result_capture).toBeUndefined();
  });

  it("full: no marker reaches the wire at all", async () => {
    // SPEC §11.4: there is no `"full"` on the wire — absence is what means
    // captured. This package OMITS the key where the Python SDK sends null;
    // both are conformant and a consumer must read the VALUE, never the key.
    const { sink } = await runOk("full");
    const event = terminal(sink, "tool_call_end");
    expect(event.payload.result_capture).toBeUndefined();
    expect("result_capture" in event.payload).toBe(false);
  });
});

describe("a withheld event validates against the PUBLISHED schema", () => {
  /** ⚠ This exists because 496 green tests did NOT depend on the spec pin.
   *
   * `conformance.test.ts` ajv-validates the `baton-spec` vectors and a set of
   * MINIMALLY-populated payloads — none of which carries `result_capture`. So
   * the pin could be reverted to `f1e0280` and the whole suite still passed,
   * while every `"off"` event this SDK emits was rejected by the shared
   * schema: both tool-call payload definitions are `additionalProperties:
   * false`, so the older schema reads the new member as an illegal extra key.
   *
   * That is the failure mode `CONTRIBUTING.md` already names — "a stale pin
   * makes these tests pass loudly and prove nothing" — and this diff added the
   * first wire member where it was silent. An `"off"`-shaped event validated
   * here is what makes the pin load-bearing again.
   */
  it("ajv accepts a withheld tool_call_end against events.schema.json", async () => {
    const schema = JSON.parse(
      readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../baton-spec/events.schema.json"),
        "utf-8",
      ),
    ) as object;
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    const validate = ajv.compile(schema);

    const sink = new CapturingSink();
    const rec = new Recorder();
    const server = MAJORS[0]!.make();
    MAJORS[0]!.tool(server, "fetch", { row: z.string() }, () => ({
      content: [{ type: "text" as const, text: SECRET }],
    }));
    withBaton(server as never, {
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
      sink,
      scrubber: rec.scrub,
      resultCaptureMode: "off",
    });
    const client = await MAJORS[0]!.connect(server);
    await client.callTool({ name: "fetch", arguments: { row: "42" } });

    const event = terminal(sink, "tool_call_end");
    expect(event.payload.result_capture, "the assertion below would be vacuous").toBe("off");
    const ok = validate(JSON.parse(JSON.stringify(event)));
    expect(ok, JSON.stringify(validate.errors)).toBe(true);
  });
});

describe("resultCaptureMode validation", () => {
  it("refuses an unregistered value at the config door", () => {
    // The union literal makes this a COMPILE error for a TypeScript caller;
    // the runtime check is for the JavaScript one. It matters more here than
    // for most fields because the failure is silent in the one direction that
    // cannot be undone: an unrecognised mode reads as "not off", so bodies a
    // vendor believed were switched off get captured and sent.
    for (const wrong of ["OFF", "Off", "off ", "none", "disabled"]) {
      expect(() =>
        withBaton({} as never, {
          vendorId: "acme",
          vendorDisplayName: "Acme",
          consentToken: "ct",
          resultCaptureMode: wrong as "full" | "off",
        }),
      ).toThrow(/resultCaptureMode/);
    }
  });
});
