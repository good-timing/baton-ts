import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  PRINCIPAL_FORM_HASHED,
  PRINCIPAL_SOURCE_ASSERTED,
  hashPrincipalId,
} from "../../../src/identity.js";
import {
  principalFromOAuthEmail,
  principalFromOAuthSub,
} from "../../../src/index.js";
import {
  type AuthInfo,
  extraAuthInfo,
} from "../../../src/integrations/mcp/mcpTypes.js";
import {
  type PrincipalResolutionContext,
  type ResolvePrincipalHook,
  resolveCallPrincipal,
} from "../../../src/integrations/mcp/principalResolution.js";
import { CapturingSink, MAJORS, install } from "./_majors.js";

const TENANT = "ten_parity";
const KEY = "cross-sdk-key";
const CLAIMS = {
  sub: "opaque-123",
  email: "Alice@Acme.example",
  iss: "https://idp.example",
};

function authInfo(extra: Record<string, unknown> | undefined): AuthInfo {
  return { token: "jwt", clientId: "acme-desktop-app", scopes: [], extra };
}

/** The two places the majors keep the token: 1.x `extra.authInfo`, v2
 * `ctx.http.authInfo`. */
const extraV1 = (info: unknown) => ({ authInfo: info });
const extraV2 = (info: unknown) => ({ http: { authInfo: info } });

function ctx(info: AuthInfo | null): PrincipalResolutionContext {
  return {
    headers: null,
    meta: null,
    toolName: "lookup",
    arguments: {},
    authInfo: info,
  };
}

async function resolve(hook: ResolvePrincipalHook, extra: object) {
  return resolveCallPrincipal(
    hook,
    { extra, toolName: "lookup", arguments: {} },
    { mode: "hashed", tenantId: TENANT, key: KEY },
  );
}

describe("the context carries the validated token on both majors", () => {
  it("reads 1.x's extra.authInfo and v2's ctx.http.authInfo", () => {
    const info = authInfo(CLAIMS);
    expect(extraAuthInfo(extraV1(info))).toBe(info);
    expect(extraAuthInfo(extraV2(info))).toBe(info);
  });

  it("is null on stdio, and for anything that is not an object", () => {
    expect(extraAuthInfo({})).toBeNull();
    expect(extraAuthInfo(extraV1("a-bare-token-string"))).toBeNull();
    expect(extraAuthInfo(extraV2(null))).toBeNull();
  });

  it("is NOT read unless a hook reads it — a token alone yields no principal", async () => {
    // No hook: the producer has no token rung (SPEC §11.4).
    const got = await resolveCallPrincipal(
      undefined,
      { extra: extraV1(authInfo(CLAIMS)), toolName: "lookup", arguments: {} },
      { mode: "hashed", tenantId: TENANT, key: KEY },
    );
    expect(got).toBeNull();
  });
});

describe("cross-SDK parity: the SAME digest Python's twin produces", () => {
  // ⚠ FROZEN from baton-sdk's `principal_from_oauth_sub` / `principal_from_oauth_email`
  // on the same claims, tenant and key (2026-10-02). Both SDKs share the hash
  // (pinned by the identity corpus); what this pins is that the two hooks
  // pick the same (id, issuer) PAIR from one token. Do not update a literal to
  // make this pass — a mismatch means one arm keys a person differently.
  const PY_SUB =
    "6c532d2c0a0366be74008fe3c4be5449fcc4e886b6825deca9ed30d2e5305a26";
  const PY_EMAIL =
    "7c2bd6eddc6679977e0ae2543f05922835a7cc0e28c86a518967e06b1c86f5ff";

  it.each([
    ["sub", principalFromOAuthSub, PY_SUB],
    ["email", principalFromOAuthEmail, PY_EMAIL],
  ] as const)("%s, on both majors", async (_label, hook, expected) => {
    for (const shape of [extraV1, extraV2]) {
      expect(await resolve(hook, shape(authInfo(CLAIMS)))).toEqual({
        id: expected,
        source: PRINCIPAL_SOURCE_ASSERTED,
        form: PRINCIPAL_FORM_HASHED,
      });
    }
  });
});

describe("principalFromOAuthSub", () => {
  it("reads sub and iss from authInfo.extra", () => {
    expect(
      principalFromOAuthSub(
        ctx(authInfo({ sub: "alice", iss: "https://idp" })),
      ),
    ).toEqual({
      principalId: "alice",
      issuer: "https://idp",
    });
  });

  it("never falls back to clientId, which names the APP", () => {
    expect(principalFromOAuthSub(ctx(authInfo(undefined)))).toBeNull();
    expect(
      principalFromOAuthSub(ctx(authInfo({ client_id: "acme-desktop-app" }))),
    ).toBeNull();
  });

  it("treats a blank, non-string or missing sub as a miss", () => {
    for (const sub of ["", "  ", 7, undefined]) {
      expect(principalFromOAuthSub(ctx(authInfo({ sub })))).toBeNull();
    }
    expect(principalFromOAuthSub(ctx(null))).toBeNull();
  });

  it("drops an empty issuer rather than hashing a second pseudonym", () => {
    expect(
      principalFromOAuthSub(ctx(authInfo({ sub: "alice", iss: "" })))?.issuer,
    ).toBeNull();
  });
});

describe("principalFromOAuthEmail", () => {
  it("keys on the WHOLE address and names the local part", () => {
    expect(
      principalFromOAuthEmail(
        ctx(authInfo({ email: "alice@acme.com", iss: "https://idp" })),
      ),
    ).toEqual({
      principalId: "alice@acme.com",
      userName: "alice",
    });
  });

  it("keeps the same local part at two domains as two people", async () => {
    const a = await resolve(
      principalFromOAuthEmail,
      extraV1(authInfo({ email: "alice@acme.com" })),
    );
    const b = await resolve(
      principalFromOAuthEmail,
      extraV1(authInfo({ email: "alice@contoso.com" })),
    );
    expect(a?.id).toBe(
      hashPrincipalId("alice@acme.com", { tenantId: TENANT, key: KEY }),
    );
    expect(a?.id).not.toBe(b?.id);
  });

  it("never puts the address or its local part on the wire", async () => {
    const got = await resolve(
      principalFromOAuthEmail,
      extraV2(authInfo({ email: "alice@acme.com" })),
    );
    const blob = JSON.stringify(got);
    expect(blob).not.toContain("alice");
    expect(blob).not.toContain("acme");
  });

  it("keeps one pseudonym when the issuer URL changes — no issuer is folded in", async () => {
    const a = await resolve(
      principalFromOAuthEmail,
      extraV1(authInfo({ email: "alice@acme.com", iss: "https://sts.windows.net/x/" })),
    );
    const b = await resolve(
      principalFromOAuthEmail,
      extraV1(authInfo({ email: "alice@acme.com", iss: "https://login.microsoftonline.com/x/v2.0" })),
    );
    expect(a).not.toBeNull();
    expect(a).toEqual(b);
  });

  it("does not fall back to sub — which claim names the person is the vendor's call", () => {
    expect(principalFromOAuthEmail(ctx(authInfo({ sub: "alice" })))).toBeNull();
  });

  it("composes with ?? into email-else-sub", () => {
    const hook: ResolvePrincipalHook = (c) =>
      principalFromOAuthEmail(c) ?? principalFromOAuthSub(c);
    expect(hook(ctx(authInfo({ sub: "alice" }))) as unknown).toEqual({
      principalId: "alice",
      issuer: null,
    });
  });

  it("splits on the LAST @, and names nobody when there is no local part", () => {
    expect(
      principalFromOAuthEmail(ctx(authInfo({ email: '"a@b"@acme.com' })))
        ?.userName,
    ).toBe('"a@b"');
    expect(principalFromOAuthEmail(ctx(authInfo({ email: "alice" })))).toEqual({
      principalId: "alice",
      userName: null,
    });
    expect(
      principalFromOAuthEmail(ctx(authInfo({ email: "@acme.com" })))?.userName,
    ).toBeNull();
  });

  it("ignores email_verified", () => {
    const got = principalFromOAuthEmail(
      ctx(authInfo({ email: "alice@acme.com", email_verified: false })),
    );
    expect(got?.principalId).toBe("alice@acme.com");
  });

  it("decides blankness as Python's strip() does, so the twins agree under ??", () => {
    // `\x1f` is stripped by Python and kept by `.trim()`; U+FEFF the reverse.
    const hook: ResolvePrincipalHook = (c) => principalFromOAuthEmail(c) ?? principalFromOAuthSub(c);
    expect(hook(ctx(authInfo({ email: "\x1f", sub: "opaque-123" }))) as unknown).toEqual({
      principalId: "opaque-123",
      issuer: null,
    });
    expect(principalFromOAuthEmail(ctx(authInfo({ email: "\uFEFF" })))?.principalId).toBe("\uFEFF");
  });

  it("treats a blank or non-string email as a miss", () => {
    for (const email of ["", "  ", 7, undefined]) {
      expect(principalFromOAuthEmail(ctx(authInfo({ email })))).toBeNull();
    }
  });

  it("never throws on a hostile token object", () => {
    const hostile = {
      get extra(): Record<string, unknown> {
        throw new Error("verifier blew up");
      },
    } as unknown as AuthInfo;
    expect(principalFromOAuthEmail(ctx(hostile))).toBeNull();
    expect(principalFromOAuthSub(ctx(hostile))).toBeNull();
  });
});

describe.each(MAJORS)("end to end on $label", (major) => {
  // The unit cases above hand `resolveCallPrincipal` a hand-shaped `extra`.
  // This drives a REAL server of each major, with the token delivered by the
  // SDK's own transport, so a major that kept `authInfo` somewhere other than
  // where `extraAuthInfo` reads would leave every event without a principal.
  it("the email hook resolves the frozen Python digest from an authenticated call", async () => {
    const server = major.make();
    major.tool(server, "lookup", { name: z.string() }, () => ({ content: [] }));
    const sink = new CapturingSink();
    install(server, sink, {
      resolvePrincipal: principalFromOAuthEmail,
      tenantId: TENANT,
      principalIdHmacKey: KEY,
    });
    const client = await major.connect(server, { authInfo: authInfo(CLAIMS) });
    await client.callTool({ name: "lookup", arguments: { name: "x" } });
    const calls = sink.events.filter((e) => e.event_type.startsWith("tool_call"));
    expect(calls.length).toBeGreaterThan(0);
    for (const event of calls) {
      expect(event.principal).toEqual({
        id: "7c2bd6eddc6679977e0ae2543f05922835a7cc0e28c86a518967e06b1c86f5ff",
        source: PRINCIPAL_SOURCE_ASSERTED,
        form: PRINCIPAL_FORM_HASHED,
      });
    }
  });

  it("the annotation tool resolves the same principal as the tool call", async () => {
    // The second `resolveCallPrincipal` site (annotation.ts). Python's parity
    // file collapses both emit paths to one value for this reason.
    const server = major.make();
    major.tool(server, "lookup", { name: z.string() }, () => ({ content: [] }));
    const sink = new CapturingSink();
    const handle = install(server, sink, {
      resolvePrincipal: principalFromOAuthEmail,
      tenantId: TENANT,
      principalIdHmacKey: KEY,
    });
    const client = await major.connect(server, { authInfo: authInfo(CLAIMS) });
    await client.callTool({ name: "lookup", arguments: { name: "x" } });
    await client.callTool({
      name: handle.annotationToolName,
      arguments: { user_goal: "look up", signal_type: "failure" },
    });
    const annotations = sink.events.filter((e) => e.event_type === "annotation");
    expect(annotations.length).toBeGreaterThan(0);
    const ids = new Set(
      sink.events.filter((e) => e.event_type !== "surface_snapshot").map((e) => e.principal?.id ?? null),
    );
    expect([...ids]).toEqual(["7c2bd6eddc6679977e0ae2543f05922835a7cc0e28c86a518967e06b1c86f5ff"]);
  });

  it("an authenticated call with NO hook carries no principal", async () => {
    const server = major.make();
    major.tool(server, "lookup", { name: z.string() }, () => ({ content: [] }));
    const sink = new CapturingSink();
    install(server, sink, { tenantId: TENANT, principalIdHmacKey: KEY });
    const client = await major.connect(server, { authInfo: authInfo(CLAIMS) });
    await client.callTool({ name: "lookup", arguments: { name: "x" } });
    const calls = sink.events.filter((e) => e.event_type.startsWith("tool_call"));
    expect(calls.length).toBeGreaterThan(0);
    for (const event of calls) expect(event.principal ?? null).toBeNull();
  });
});
