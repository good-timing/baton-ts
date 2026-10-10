import { describe, expect, it } from "vitest";
import { z } from "zod";

import { PRINCIPAL_FORM_RAW, PRINCIPAL_SOURCE_ASSERTED } from "../../../src/identity.js";
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
  return resolveCallPrincipal(hook, { extra, toolName: "lookup", arguments: {} });
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
    );
    expect(got).toBeNull();
  });
});

describe("cross-SDK parity: the SAME principal Python's twin produces", () => {
  // What `principal_from_oauth_sub` / `principal_from_oauth_email` return for
  // the same claims. A mismatch means one arm keys a person differently.
  it.each([
    ["sub", principalFromOAuthSub, CLAIMS.sub, {}],
    ["email", principalFromOAuthEmail, CLAIMS.email, { display_name: "Alice" }],
  ] as const)("%s, on both majors", async (_label, hook, expected, named) => {
    for (const shape of [extraV1, extraV2]) {
      expect(await resolve(hook, shape(authInfo(CLAIMS)))).toEqual({
        id: expected,
        source: PRINCIPAL_SOURCE_ASSERTED,
        form: PRINCIPAL_FORM_RAW,
        ...named,
      });
    }
  });
});

describe("principalFromOAuthSub", () => {
  it("reads sub from authInfo.extra, and nothing else", () => {
    expect(
      principalFromOAuthSub(
        ctx(authInfo({ sub: "alice", iss: "https://idp" })),
      ),
    ).toEqual({ principalId: "alice" });
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

});

describe("principalFromOAuthEmail", () => {
  it("keys on the WHOLE address and names the local part", () => {
    expect(
      principalFromOAuthEmail(
        ctx(authInfo({ email: "alice@acme.com", iss: "https://idp" })),
      ),
    ).toEqual({
      principalId: "alice@acme.com",
      displayName: "alice",
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
    expect(a?.id).toBe("alice@acme.com");
    expect(b?.id).toBe("alice@contoso.com");
  });

  it("sends the local part as display_name", async () => {
    const got = await resolve(
      principalFromOAuthEmail,
      extraV2(authInfo({ email: "alice@acme.com" })),
    );
    expect(got!.display_name).toBe("alice");
  });

  it("does not fall back to sub — which claim names the person is the vendor's call", () => {
    expect(principalFromOAuthEmail(ctx(authInfo({ sub: "alice" })))).toBeNull();
  });

  it("composes with ?? into email-else-sub", () => {
    const hook: ResolvePrincipalHook = (c) =>
      principalFromOAuthEmail(c) ?? principalFromOAuthSub(c);
    expect(hook(ctx(authInfo({ sub: "alice" }))) as unknown).toEqual({ principalId: "alice" });
  });

  it("splits on the LAST @, and names nobody when there is no local part", () => {
    expect(
      principalFromOAuthEmail(ctx(authInfo({ email: '"a@b"@acme.com' })))
        ?.displayName,
    ).toBe('"a@b"');
    expect(principalFromOAuthEmail(ctx(authInfo({ email: "alice" })))).toEqual({
      principalId: "alice",
      displayName: null,
    });
    expect(
      principalFromOAuthEmail(ctx(authInfo({ email: "@acme.com" })))?.displayName,
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
  it("the email hook resolves the address from an authenticated call", async () => {
    const server = major.make();
    major.tool(server, "lookup", { name: z.string() }, () => ({ content: [] }));
    const sink = new CapturingSink();
    install(server, sink, {
      resolvePrincipal: principalFromOAuthEmail,
      tenantId: TENANT,
    });
    const client = await major.connect(server, { authInfo: authInfo(CLAIMS) });
    await client.callTool({ name: "lookup", arguments: { name: "x" } });
    const calls = sink.events.filter((e) => e.event_type.startsWith("tool_call"));
    expect(calls.length).toBeGreaterThan(0);
    for (const event of calls) {
      expect(event.principal).toEqual({
        id: CLAIMS.email,
        source: PRINCIPAL_SOURCE_ASSERTED,
        form: PRINCIPAL_FORM_RAW,
        display_name: "Alice",
      });
    }
  });

  it("the annotation tool resolves the same principal as the tool call", async () => {
    // The second `resolveCallPrincipal` site (annotation.ts).
    const server = major.make();
    major.tool(server, "lookup", { name: z.string() }, () => ({ content: [] }));
    const sink = new CapturingSink();
    const handle = install(server, sink, {
      resolvePrincipal: principalFromOAuthEmail,
      tenantId: TENANT,
    });
    const client = await major.connect(server, { authInfo: authInfo(CLAIMS) });
    await client.callTool({ name: "lookup", arguments: { name: "x" } });
    await client.callTool({
      name: handle.annotationToolName,
      arguments: { user_goal: "look up", what_happened: "it returned nothing" },
    });
    const annotations = sink.events.filter((e) => e.event_type === "annotation");
    expect(annotations.length).toBeGreaterThan(0);
    const ids = new Set(
      sink.events.filter((e) => e.event_type !== "surface_snapshot").map((e) => e.principal?.id ?? null),
    );
    expect([...ids]).toEqual([CLAIMS.email]);
  });

  it("an authenticated call with NO hook carries no principal", async () => {
    const server = major.make();
    major.tool(server, "lookup", { name: z.string() }, () => ({ content: [] }));
    const sink = new CapturingSink();
    install(server, sink, { tenantId: TENANT });
    const client = await major.connect(server, { authInfo: authInfo(CLAIMS) });
    await client.callTool({ name: "lookup", arguments: { name: "x" } });
    const calls = sink.events.filter((e) => e.event_type.startsWith("tool_call"));
    expect(calls.length).toBeGreaterThan(0);
    for (const event of calls) expect(event.principal ?? null).toBeNull();
  });
});
