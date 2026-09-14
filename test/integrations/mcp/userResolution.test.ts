import { describe, expect, it, vi } from "vitest";

import { VENDOR_HASH_SCHEME, hashUserId } from "../../../src/identity.js";
import { extraHeaders } from "../../../src/integrations/mcp/mcpTypes.js";
import {
  resolveCallUserId,
  type UserResolutionContext,
  warnIfIdentityCannotResolve,
} from "../../../src/integrations/mcp/userResolution.js";

const TENANT = "tenant-ts";
const KEY = "ts-identity-key";

/** What a vendor writes — the canonical header spelling, because that is what
 * the header is called in every document describing it. ONE function, run
 * against both majors' context shapes. */
function vendorHook(ctx: UserResolutionContext) {
  const id = ctx.headers?.get("X-Forwarded-User");
  return id === null || id === undefined ? null : { userId: id };
}

/** The 1.x shape: `requestInfo.headers` is a plain record whose values may be
 * a string, an ARRAY (repeated header line), or undefined. */
function extraV1(headers: Record<string, unknown>) {
  return { requestInfo: { headers } };
}

/** The v2 shape: `http.req.headers` is a Web `Headers`. Measured on
 * `@modelcontextprotocol/server` 2.0.0 — that package's `.d.ts` types `http`
 * as `{ authInfo? }` and omits `req` entirely, so this shape is asserted
 * against the RUNTIME, not the published type. */
function extraV2(headers: Record<string, string>) {
  return { http: { req: { headers: new Headers(headers) } } };
}

describe("one vendor hook across both SDK majors (register A8, applied prospectively)", () => {
  it("resolves the SAME principal on 1.x and on v2", async () => {
    // Assert the EXPECTED value, not merely that the two agree: two majors
    // broken identically — both `null`, which is the state before this change
    // — pass an agreement-only check. Python's parity file rule 1.
    const expected = hashUserId("employee-4417", {
      tenantId: TENANT,
      key: KEY,
      scheme: VENDOR_HASH_SCHEME,
    });

    const resolved: Record<string, string | null> = {};
    for (const [major, extra] of [
      // 1.x delivers ASGI-style lowercased names; v2 delivers a Headers.
      ["1.x", extraV1({ "x-forwarded-user": "employee-4417" })],
      ["v2", extraV2({ "x-forwarded-user": "employee-4417" })],
    ] as const) {
      resolved[major] = await resolveCallUserId(
        vendorHook,
        { extra, toolName: "lookup", arguments: {} },
        { mode: "hashed", tenantId: TENANT, key: KEY },
      );
    }

    expect(resolved["1.x"]).toBe(expected);
    expect(resolved["v2"]).toBe(expected);
  });

  it("folds case on both, so the canonical spelling is not a 1.x-only privilege", () => {
    for (const extra of [
      extraV1({ "x-forwarded-user": "e-1" }),
      extraV2({ "x-forwarded-user": "e-1" }),
    ]) {
      const headers = extraHeaders(extra);
      expect(headers?.get("X-Forwarded-User")).toBe("e-1");
      expect(headers?.get("x-forwarded-user")).toBe("e-1");
      expect(headers?.get("X-FORWARDED-USER")).toBe("e-1");
    }
  });

  it("joins a repeated 1.x header line instead of handing back an array", () => {
    // The trap that has no Python equivalent: 1.x types a header value as
    // `string | string[]`, so a proxy chain appending a second line turns one
    // `headers[name]` into an array. A hook expecting text would then hash
    // something like "alice,bob" — or crash on `.trim()` — depending on what
    // it did next. `Headers` applies the platform's documented join.
    const headers = extraHeaders(extraV1({ "x-forwarded-user": ["alice", "bob"] }));
    expect(headers?.get("x-forwarded-user")).toBe("alice, bob");
  });

  it("skips a non-string header value rather than inventing one", () => {
    // `String({})` is "[object Object]" — a header that exists and holds a
    // lie, which downstream reads as a client that sent something.
    const headers = extraHeaders(
      extraV1({ "x-forwarded-user": {}, "x-real-user": "alice", "x-empty": undefined }),
    );
    expect(headers?.get("x-forwarded-user")).toBeNull();
    expect(headers?.get("x-empty")).toBeNull();
    expect(headers?.get("x-real-user")).toBe("alice");
  });

  it("survives a header name Headers.append REFUSES, rather than failing the call", () => {
    // `SSEServerTransport` passes Node's `req.headers` through verbatim, and
    // under Node's HTTP/2 compatibility API that carries the pseudo-headers
    // `:path` / `:method` / `:authority` / `:scheme`. `Headers.append(":path")`
    // throws `TypeError: invalid header name`. Unguarded that escapes into the
    // vendor's tool call and 500s EVERY call on an HTTP/2 deployment — before
    // the vendor's own handler runs, on a server that may never have
    // configured identity at all.
    const headers = extraHeaders(
      extraV1({
        ":path": "/mcp",
        ":method": "POST",
        ":authority": "example.test",
        "x-forwarded-user": "employee-4417",
      }),
    );

    // The good header survived the bad ones, which is the whole point.
    expect(headers?.get("X-Forwarded-User")).toBe("employee-4417");
    // Absence is checked by ENUMERATION, not `get(":path")` — that call throws
    // for the same reason `append` did, so asking the obvious way reproduces
    // the bug inside the assertion.
    expect([...(headers?.keys() ?? [])]).toEqual(["x-forwarded-user"]);
  });

  it("reads a cross-realm Headers rather than reporting it as stdio", () => {
    // `instanceof Headers` is false for a `Headers` from another realm — a
    // `vm` context, a fetch shim, a bundled polyfill. The fallthrough would
    // return `null`, which this function's contract defines as "no HTTP
    // request in flight", and that statement would be FALSE: the hook would
    // see stdio semantics on an authenticated HTTP call.
    const foreign = {
      get(name: string): string | null {
        return name.toLowerCase() === "x-forwarded-user" ? "employee-4417" : null;
      },
    };
    const headers = extraHeaders({ http: { req: { headers: foreign } } });

    expect(headers).not.toBeNull();
    expect(headers?.get("X-Forwarded-User")).toBe("employee-4417");
  });

  it("reports NO HTTP REQUEST as null, distinctly from a client that sent nothing", () => {
    // stdio, the common case. `null` is us saying the question does not
    // apply; an empty `Headers` would be a claim about the caller.
    expect(extraHeaders({})).toBeNull();
  });
});

describe("resolveCallUserId fail-open", () => {
  const call = {
    extra: extraV1({ "x-forwarded-user": "employee-4417" }),
    toolName: "lookup",
    arguments: {},
  };
  const opts = { mode: "hashed", tenantId: TENANT, key: KEY } as const;

  it("returns null when no hook is configured", async () => {
    expect(await resolveCallUserId(undefined, call, opts)).toBeNull();
  });

  it("treats a throwing hook as anonymous, never as a failed call", async () => {
    const boom = () => {
      throw new Error("vendor bug");
    };
    await expect(resolveCallUserId(boom, call, opts)).resolves.toBeNull();
  });

  it("treats a rejecting async hook the same way", async () => {
    const boom = () => Promise.reject(new Error("vendor bug"));
    await expect(resolveCallUserId(boom, call, opts)).resolves.toBeNull();
  });

  it("accepts a SYNC hook as well as an async one", async () => {
    // The prior art was bitten here: their resolver took the hook's return
    // value verbatim, so an `async` hook silently produced an anonymous event.
    const sync = () => ({ userId: "employee-4417" });
    const async = () => Promise.resolve({ userId: "employee-4417" });
    expect(await resolveCallUserId(sync, call, opts)).toBe(
      await resolveCallUserId(async, call, opts),
    );
    expect(await resolveCallUserId(sync, call, opts)).not.toBeNull();
  });

  it("does not let the HASHING step throw into the vendor's tool call", async () => {
    // `createHmac` rejects a key that is not a string/TypedArray. Install-time
    // validation refuses that now, but this function's docstring promises it
    // cannot raise, and a promise like that must not rest on an argument about
    // who calls it.
    const resolved = await resolveCallUserId(() => ({ userId: "e-1" }), call, {
      mode: "hashed",
      tenantId: TENANT,
      key: 12345 as unknown as string,
    });
    expect(resolved).toBeNull();
  });

  it("routes the hook's return through normalizePrincipal", async () => {
    // One representative shape, not six: `normalizePrincipal`'s own test
    // enumerates the rejection modes, and re-running them through the wrapper
    // reds two files for one cause. What is unique HERE is only that the
    // wrapper consults it at all — a snake_case key is the shape a vendor
    // reaches for first, and it must not duck-type through.
    expect(await resolveCallUserId(() => ({ user_id: "e-1" }) as never, call, opts)).toBeNull();
  });

  it("gives the hook the tool name and the post-strip arguments", async () => {
    // Per-call, not per-install: the hook can answer differently for the
    // annotation tool than for a lookup.
    const seen: string[] = [];
    const seenArgs: Record<string, unknown>[] = [];
    const hook = (c: UserResolutionContext) => {
      seen.push(c.toolName);
      seenArgs.push(c.arguments);
      return { userId: `user-of-${c.toolName}` };
    };
    const a = await resolveCallUserId(
      hook,
      { extra: {}, toolName: "lookup", arguments: { q: "one" } },
      opts,
    );
    const b = await resolveCallUserId(
      hook,
      { extra: {}, toolName: "acme_annotate", arguments: { q: "two" } },
      opts,
    );

    expect(seen).toEqual(["lookup", "acme_annotate"]);
    // The arguments half of this test's own title, which it did not assert
    // until now — and `withBaton.ts` carries a comment saying the AFTER-the-
    // strip ordering is load-bearing, so the field deserves a witness.
    expect(seenArgs).toEqual([{ q: "one" }, { q: "two" }]);
    expect(a).not.toBe(b);
  });
});

describe("warnIfIdentityCannotResolve", () => {
  /** The silent-success case: identity configured, nothing emitted, and until
   * this warning existed there was no string in the process to grep for. */
  function capture(config: Parameters<typeof warnIfIdentityCannotResolve>[0]): string[] {
    const seen: string[] = [];
    // `vi.spyOn` rather than a hand-rolled swap: it restores on its own and
    // avoids reassigning a bound method off `process`.
    const spy = vi.spyOn(process, "emitWarning").mockImplementation((m) => {
      seen.push(String(m));
    });
    try {
      warnIfIdentityCannotResolve(config);
    } finally {
      spy.mockRestore();
    }
    return seen;
  }

  const hook = () => ({ userId: "employee-4417" });

  it("warns when a hook is set, mode is hashed, and no key exists", () => {
    const seen = capture({ resolveUser: hook, userIdMode: "hashed", userIdHmacKey: undefined });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("BATON_USER_ID_HMAC_KEY");
  });

  it("never puts the principal in the message", () => {
    // Identity was configured and produced nothing; printing the value to
    // explain that would be the residency leak one layer sideways.
    const seen = capture({ resolveUser: hook, userIdMode: "hashed", userIdHmacKey: undefined });
    expect(seen[0]).not.toContain("employee-4417");
  });

  it("stays quiet in every state that is not that one", () => {
    // A server with no hook is the common case and must not be nagged; raw
    // mode needs no key; a key present is the working configuration.
    expect(capture({ userIdMode: "hashed", userIdHmacKey: undefined })).toEqual([]);
    expect(capture({ resolveUser: hook, userIdMode: "raw", userIdHmacKey: undefined })).toEqual([]);
    expect(capture({ resolveUser: hook, userIdMode: "hashed", userIdHmacKey: "k" })).toEqual([]);
  });
});
