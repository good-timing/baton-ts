import { describe, expect, it } from "vitest";

import { observeTransport, type Extra } from "../../../src/integrations/mcp/mcpTypes.js";

/**
 * `transport_observed` — the two cells the end-to-end harness cannot reach.
 *
 * `emitterConformance.test.ts` drives a real in-memory session and asserts
 * `"no-http-request"` there. It cannot assert the other two: this package has
 * NO streamable-HTTP, SSE or fetch-handler fixture on either major (the only
 * HTTP in the suite is a stubbed `fetchImpl` for the collector sink, which is
 * egress, not transport). So the carriers are driven synthetically here, in the
 * same shape `principalResolution.test.ts` uses for header parity.
 *
 * ⚠ **Synthetic is weaker than a socket, and this is the honest place to say
 * so.** These literals assert that the read keys on the right property; they do
 * NOT prove a real `@modelcontextprotocol/server` populates it. That proof is
 * the v15 probe — 10 rows, both majors, in-memory / streamable-HTTP / SSE /
 * fetch-handler, negative controls both ways — which is a measurement in
 * `baton-internal`, not a test here. Python's side has a real socket
 * (`_running_server`); TypeScript has no equivalent, and that is a fixture gap
 * recorded rather than papered over.
 */
describe("observeTransport", () => {
  it("reads the 1.x carrier as http", () => {
    // `@modelcontextprotocol/sdk` 1.30.0 hangs the transport request off
    // `requestInfo`. Presence is the whole signal — headers are not consulted.
    const extra = { requestInfo: { headers: { host: "example.test" } } } as Extra;
    expect(observeTransport(extra)).toBe("http");
  });

  it("reads the v2 carrier as http", () => {
    // `@modelcontextprotocol/server` 2.0.0 hangs it off `http.req`, declared as
    // `globalThis.Request` on `ServerContext` — see the citation in mcpTypes.ts.
    const extra = { http: { req: { headers: new Headers() } } } as unknown as Extra;
    expect(observeTransport(extra)).toBe("http");
  });

  it("reads an empty-headers HTTP request as http, not as absence", () => {
    // ⚠ The fold this field exists to prevent. `extraHeaders` would return an
    // EMPTY `Headers` here, and a reader that keyed on "did I get any headers"
    // would call a live HTTP call stdio — handing a consumer the licence to
    // group a process-wide session_id on a multi-caller server.
    const extra = { http: { req: { headers: new Headers() } } } as unknown as Extra;
    expect(observeTransport(extra)).toBe("http");
    expect(observeTransport({ requestInfo: { headers: {} } })).toBe("http");
  });

  it("reads no carrier as no-http-request", () => {
    // stdio and in-memory. The negative control for every row above.
    expect(observeTransport({})).toBe("no-http-request");
    expect(observeTransport({ sessionId: "s" })).toBe("no-http-request");
  });

  it("reads a throwing carrier as read-failed, never as absence", () => {
    // The whole safety argument. A getter that throws is OUR problem, and
    // reporting it as `"no-http-request"` would publish it as a fact about the
    // customer's deployment — Python's equivalent helper has exactly that fold
    // as a live defect (register A6).
    const extra = {
      get http(): never {
        throw new TypeError("unexpected context shape");
      },
    } as unknown as Extra;
    expect(observeTransport(extra)).toBe("read-failed");
  });

  it("never throws into the vendor's tool call", () => {
    // SPEC §11.2: capture is fail-open. This runs on every call of every
    // server, so an escape here 500s a tool call before the vendor's handler.
    const hostile = {
      get http(): never {
        throw new Error("boom");
      },
      get requestInfo(): never {
        throw new Error("boom");
      },
    } as unknown as Extra;
    expect(() => observeTransport(hostile)).not.toThrow();
  });
});
