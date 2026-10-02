/** Ready-made `resolvePrincipal` hooks for a server running OAuth.
 *
 * Pass one as `BatonConfig.resolvePrincipal`. Each reads a claim off the
 * validated token the context carries as `authInfo`, and returns `null` when
 * the claim is not there — so they compose:
 *
 * ```ts
 * resolvePrincipal: (ctx) => principalFromOAuthEmail(ctx) ?? principalFromOAuthSub(ctx)
 * ```
 *
 * They are ordinary hooks: what they return is `source: "asserted"` like any
 * other (SPEC §11.4). The Python twins are `principal_from_oauth_sub` and
 * `principal_from_oauth_email`, and the two must agree on one token.
 *
 * ⚠ **They read the claims from `authInfo.extra`, and that is a convention,
 * not a contract.** Neither MCP major's `AuthInfo` has a `claims` member — the
 * only place a verifier can put the token's subject is the free-form `extra`
 * bag, and nothing specifies the keys. These hooks expect the standard JWT
 * claim names (`sub`, `iss`, `email`) at the top of `extra`, which is what a
 * verifier that spreads its decoded payload into `extra` produces. A verifier
 * that nests them, renames them or omits them gets `null` here, and its vendor
 * writes a three-line hook reading wherever their verifier put them. Python
 * reads a typed `claims` field instead, which is why the two arms describe the
 * same hooks differently.
 *
 * ⚠ **Never `clientId`.** It names the OAuth APPLICATION, not the person, and
 * is identical for every user of one app; keying on it merges all of them.
 *
 * HTTP only: MCP auth is HTTP middleware, so a stdio call has no token and both
 * hooks return `null` there.
 */

import { type Principal, pythonStrip } from "../../identity.js";
import { type PrincipalResolutionContext } from "./principalResolution.js";

/** The token's claim bag, or `null`. Never throws: it reads an object a
 * vendor's verifier built, and an identity read may not fail a tool call. */
function claimsOf(
  context: PrincipalResolutionContext,
): Record<string, unknown> | null {
  try {
    const extra = context.authInfo?.extra;
    return extra !== null && typeof extra === "object" ? extra : null;
  } catch {
    return null;
  }
}

/** `iss` when it is a non-empty string. `""` and `null` hash differently, so
 * an empty one passed through would give one person a second pseudonym. */
function issuerOf(claims: Record<string, unknown>): string | null {
  const iss = claims.iss;
  return typeof iss === "string" && iss !== "" ? iss : null;
}

/** A non-blank string claim, or `null`. Blank is a miss because the hash
 * canonicalizes (strips), so every whitespace-only value is one phantom actor.
 *
 * ⚠ `pythonStrip`, never `.trim()`: the two strip different codepoints
 * (`\x1f` survives `.trim()`, U+FEFF survives Python's `strip()`), and the
 * Python twins decide blankness with `strip()`. With `.trim()` one token gave a
 * principal on one SDK and none on the other under `email ?? sub`. */
function stringClaim(claims: Record<string, unknown>, name: string): string | null {
  const value = claims[name];
  return typeof value === "string" && pythonStrip(value) !== "" ? value : null;
}

/** The token's `sub`, keyed with its `iss` — a subject is unique only per
 * issuer, so two identity providers can hand two people the same one. */
export function principalFromOAuthSub(
  context: PrincipalResolutionContext,
): Principal | null {
  const claims = claimsOf(context);
  if (claims === null) return null;
  const sub = stringClaim(claims, "sub");
  return sub === null ? null : { principalId: sub, issuer: issuerOf(claims) };
}

/** The token's `email`, as the WHOLE address and with NO issuer.
 *
 * `principalId` is the whole address and `userName` the part before the last
 * `@`. The local part alone is not an id — `alice@acme.com` and
 * `alice@contoso.com` are two people — and `userName` is sent nowhere.
 *
 * No issuer, unlike the `sub` hook: a subject is unique only per issuer, an
 * address on its own, and folding `iss` in would give one person a new
 * pseudonym the day their identity provider changes its issuer URL.
 *
 * ⚠ `email` is not a standard ACCESS-token claim (OIDC puts it in the ID
 * token), so it is here only if the identity provider adds it and the verifier
 * keeps it. `email_verified` is not consulted: whether an unverified address is
 * good enough is the vendor's call. */
export function principalFromOAuthEmail(
  context: PrincipalResolutionContext,
): Principal | null {
  const claims = claimsOf(context);
  if (claims === null) return null;
  const email = stringClaim(claims, "email");
  if (email === null) return null;
  const at = email.lastIndexOf("@");
  return {
    principalId: email,
    userName: at > 0 ? email.slice(0, at) : null,
  };
}
