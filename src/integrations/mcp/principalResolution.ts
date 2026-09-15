/** `BatonConfig.resolvePrincipal` — the ASSERTED identity provenance.
 *
 * The TypeScript half of Python's `integrations/identity_adapter.py`, built to
 * close register D6: the field (`user_id` until 0.3.5) had been on this SDK's
 * envelope since 0.3.0 and NOTHING could populate it, so a partition that
 * works on one of two SDKs is not a partition.
 *
 * **Hook only — there is deliberately no attested (`h1:`) rung here yet.**
 * Python reads `claims["sub"]` off a verified access token; TypeScript's
 * `AuthInfo` has no `claims` field at all (it is
 * `{token, clientId, scopes, expiresAt?, resource?, extra?}`), so the nearest
 * carrier is the untyped `extra` bag and nothing specifies that `sub` lives
 * there. Reading it would mean guessing where a subject lives, vendor by
 * vendor — and a wrong guess is how two people end up as one actor. Recorded
 * as a divergence rather than filled with a guess.
 */

import {
  type Principal,
  type PrincipalIdMode,
  PRINCIPAL_ID_MODE_HASHED,
  normalizePrincipal,
  principalIdFor,
} from "../../identity.js";
import { warn } from "./annotationName.js";
import { type Extra, extraHeaders, extraMeta } from "./mcpTypes.js";

/** What a vendor's `resolvePrincipal` hook is handed.
 *
 * Adapter-neutral BY CONSTRUCTION rather than by convention — the peers' own
 * handler-context objects differ in shape between the two majors, and this
 * type is what makes one hook portable across them. The prior art takes the
 * opposite approach: AgentCat's `identify()` receives the raw per-major object
 * behind `{ sessionId?: string; [key: string]: any }`, documented as "only
 * `sessionId` is common to both; everything else is SDK-version-specific".
 * That is the divergence handed to the vendor as `any`; this is the divergence
 * absorbed by us.
 */
export interface PrincipalResolutionContext {
  /** The call's HTTP headers, case-insensitive on BOTH majors — see
   * `extraHeaders` for the two shapes it reconciles.
   *
   * `null` means NO HTTP REQUEST (every stdio call, the common case), never
   * "the client sent no headers". The distinction matters: the first is us
   * telling you the question does not apply, the second would be a claim about
   * the caller that we are not in a position to make. */
  headers: Headers | null;
  /** The call's `_meta`, from wherever this major keeps it. */
  meta: Record<string, unknown> | null;
  /** The tool being called — the annotation tool's own name on that path, so a
   * hook can answer differently per call rather than per install. */
  toolName: string;
  /** The call's arguments, AFTER Baton's injected intent params are stripped,
   * so a hook sees exactly what the vendor's own handler will. */
  arguments: Record<string, unknown>;
}

/** A vendor's per-request identity resolver. Sync or async; returning `null`
 * means "no opinion about this caller", which is not an error. */
export type ResolvePrincipalHook = (
  context: PrincipalResolutionContext,
) => Principal | null | Promise<Principal | null>;

/** Build the hook's input from whichever major's context arrived.
 *
 * ⚠ **ONE factory, called by every emit path.** Both consumers (the tool-call
 * wrapper and the annotation tool) go through here rather than each assembling
 * a context, because per-site assembly is exactly how the Python SDK ended up
 * with two adapters delivering different header shapes behind one declared
 * type — and no test could see it, because each path only ever tested itself.
 */
function buildPrincipalResolutionContext(
  extra: Extra,
  toolName: string,
  args: Record<string, unknown>,
): PrincipalResolutionContext {
  return {
    headers: extraHeaders(extra),
    meta: extraMeta(extra),
    toolName,
    arguments: args,
  };
}

/** Warn ONCE at install when identity is configured but cannot produce a value.
 *
 * ⚠ **The silent-success case is the one that needs a voice.** A vendor sets
 * `resolvePrincipal`, ships, and sees `principal_id: null` on every event forever —
 * hashed mode with no key DROPS the field by design, and without this there is
 * no string anywhere in the process to grep for. Python spends a `warned` set
 * threaded through five call sites to say this; here all three inputs are
 * install-resolved constants, so it costs one check at startup and nothing per
 * call.
 *
 * ⚠ **The message must never contain the principal.** Identity was configured
 * and produced nothing, and printing the value to explain that would put raw
 * end-user identity in the vendor's log files — the residency leak one layer
 * sideways. Python's equivalent carries the same warning.
 *
 * `process.emitWarning` because `console` is banned in this package (stdout is
 * the MCP JSON-RPC frame) and this is the channel `optout.ts` and `HttpSink`
 * already use. Guarded like every `process` read here: absent on edge and
 * worker runtimes, where a missing warning channel must not crash startup.
 */
export function warnIfIdentityCannotResolve(config: {
  resolvePrincipal?: ResolvePrincipalHook | undefined;
  principalIdMode: PrincipalIdMode;
  principalIdHmacKey: string | Uint8Array | undefined;
}): void {
  if (config.resolvePrincipal === undefined) return;
  if (config.principalIdMode !== PRINCIPAL_ID_MODE_HASHED) return;
  if (config.principalIdHmacKey !== undefined) return;
  if (typeof process === "undefined" || typeof process.emitWarning !== "function") return;
  // The pre-0.3.5 variable is never read. Naming it is the only way an upgrade
  // that kept it learns why identity stopped; its value is never logged.
  const renamed = process.env?.BATON_USER_ID_HMAC_KEY
    ? "BATON_USER_ID_HMAC_KEY is set, but it was renamed to " +
      "BATON_PRINCIPAL_ID_HMAC_KEY in 0.3.5 and is no longer read. "
    : "";
  process.emitWarning(
    "baton: resolvePrincipal is configured but no principal_id HMAC key is set, so " +
      `principal_id is dropped from every event (events still emit). ${renamed}Set ` +
      "BATON_PRINCIPAL_ID_HMAC_KEY or BatonConfig.principalIdHmacKey, or pass " +
      'principalIdMode: "raw" if you intend to emit the subject verbatim.',
  );
}

let warnedPreRenameShape = false;

/** A hook still returning the pre-0.3.5 `{ userId }` resolves nobody on every
 * call and throws nothing, unlike a renamed config key. Say so once, and never
 * with the value. */
function warnIfPreRenameShape(result: unknown): void {
  const userId = (result as { userId?: unknown } | null | undefined)?.userId;
  if (warnedPreRenameShape || typeof userId !== "string") return;
  warnedPreRenameShape = true;
  warn(
    "baton: resolvePrincipal returned { userId }, which was renamed to { principalId } " +
      "in 0.3.5, so principal_id is dropped from every event until the hook returns the new key.",
  );
}

/** Run a vendor's hook and turn its answer into the envelope's `principal_id`.
 *
 * ⚠ **Never throws.** A hook that raises, returns the wrong shape, or returns
 * `null` yields an anonymous call, not a failed one — `principal_id` is additive
 * analytics and a vendor's own bug in their resolver may not fail their tool
 * call (SPEC §11.2 fail-open). The prior art converged on the identical rule.
 *
 * ⚠ **No timeout, and that is a DIVERGENCE from Python recorded rather than
 * an omission.** Python runs vendor hooks off the event loop under a 5s
 * budget (`integrations/_hooks.py`); this arm awaits the hook inline. ⚠ An
 * earlier draft justified that by "matching `resolveSessionId`, the convention
 * already shipped here" — but `BatonConfig.resolveSessionId` was REMOVED
 * 2026-09-12 and the surviving function takes no vendor callable at all. The
 * real precedent is `scrubber`, the only other vendor code this SDK runs
 * inline; `resolvePrincipal` is the first vendor hook on its per-call path. So the
 * gap is real and deserves its true weight rather than an argument from a
 * convention that no longer exists. A hook that blocks stalls this request.
 * Containment is a separate, larger change on this arm.
 */
export async function resolveCallPrincipalId(
  hook: ResolvePrincipalHook | undefined,
  call: { extra: Extra; toolName: string; arguments: Record<string, unknown> },
  options: {
    mode: PrincipalIdMode;
    tenantId: string;
    key?: Uint8Array | string | null | undefined;
  },
): Promise<string | null> {
  // ⚠ **The context is built HERE — after the hook check, inside the try —
  // and the signature takes the raw call rather than a built context so a
  // caller CANNOT do it the other way.** Passing a context as an argument
  // meant it was constructed on every tool call of every server that never
  // configured identity, and constructed OUTSIDE this guard, so a throw from
  // the header read escaped into the vendor's tool call. Python states the
  // same rule (`standalone/middleware.py`: "the context is built only when a
  // hook exists"), and having it as a convention rather than a shape is how
  // this arm got it wrong.
  if (hook === undefined) return null;
  let result: unknown;
  try {
    const context = buildPrincipalResolutionContext(call.extra, call.toolName, call.arguments);
    result = await hook(context);
  } catch {
    // Broad on purpose, and for the reason the sibling guards are: this calls
    // code a VENDOR wrote, and an identity read may not be able to fail a
    // tool call. Nothing is logged to stdout — that stream is the MCP
    // JSON-RPC frame (AGENTS.md boundary rule 2).
    return null;
  }
  const principal = normalizePrincipal(result);
  if (principal === null) {
    warnIfPreRenameShape(result);
    return null;
  }
  try {
    return principalIdFor(principal, {
      mode: options.mode,
      tenantId: options.tenantId,
      key: options.key,
    });
  } catch {
    // The hashing step, which the guard above did NOT cover. `createHmac`
    // rejects a key that is not a string/TypedArray, and a JavaScript vendor
    // — or a TypeScript one whose config came from parsed settings and is
    // typed `any` — reaches this with `principalIdHmacKey: 12345`. Install-time
    // validation refuses that now, but this function's docstring promises it
    // cannot raise, and a promise like that needs the guard rather than an
    // argument about who calls it. Python guards the same call for the same
    // reason (`identity_adapter.py:324`).
    return null;
  }
}

