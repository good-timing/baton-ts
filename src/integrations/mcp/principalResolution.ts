/** `BatonConfig.resolvePrincipal` — the ONLY identity provenance (SPEC §11.4).
 *
 * The producer never reads the token itself and never derives the value: who
 * the person is, and whether the id is hashed, are the hook's to state. Every
 * principal this SDK emits is `source: "asserted"`. The hook's context carries
 * the validated `authInfo`, and `oauthHooks.ts` ships the two ready-made
 * OAuth hooks.
 *
 * The TypeScript half of Python's `integrations/identity_adapter.py`.
 */

import {
  type Principal,
  type PrincipalWire,
  PRINCIPAL_FORM_RAW,
  normalizePrincipal,
  principalFor,
} from "../../identity.js";
import { warn } from "./annotationName.js";
import {
  type AuthInfo,
  type Extra,
  extraAuthInfo,
  extraHeaders,
  extraMeta,
  isThenable,
} from "./mcpTypes.js";

/** What a vendor's `resolvePrincipal` hook is handed.
 *
 * Adapter-neutral BY CONSTRUCTION rather than by convention — the peers' own
 * handler-context objects differ in shape between the two majors, and this
 * type is what makes one hook portable across them.
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
   * hook can answer differently per call rather than per install. `null` on a
   * request that is not a tool call. */
  toolName: string | null;
  /** The call's arguments, AFTER Baton's injected intent params are stripped,
   * so a hook sees exactly what the vendor's own handler will. Empty on a
   * request that is not a tool call. */
  arguments: Record<string, unknown>;
  /** The validated access token for this request, read from wherever this
   * major keeps it — see `extraAuthInfo`. `null` on stdio and on any
   * unauthenticated request. `principalFromOAuthSub` and
   * `principalFromOAuthEmail` read it, and so can a vendor's own hook.
   *
   * Optional so a vendor hand-building a context in their own tests keeps
   * compiling, as Python's defaulted `claims` keeps theirs running. */
  authInfo?: AuthInfo | null | undefined;
}

/** A vendor's per-request identity resolver. Sync or async; returning `null`
 * means "no opinion about this caller", which is not an error. */
export type ResolvePrincipalHook = (
  context: PrincipalResolutionContext,
) => Principal | null | Promise<Principal | null>;

/** Build the hook's input from whichever major's context arrived.
 *
 * ⚠ **ONE factory, called by every emit path.** Every request that resolves
 * a principal goes through here rather than each
 * assembling a context, because per-site assembly is exactly how the Python SDK ended up
 * with two adapters delivering different header shapes behind one declared
 * type — and no test could see it, because each path only ever tested itself.
 */
function buildPrincipalResolutionContext(
  extra: Extra,
  toolName: string | null,
  args: Record<string, unknown>,
): PrincipalResolutionContext {
  return {
    headers: extraHeaders(extra),
    meta: extraMeta(extra),
    toolName,
    arguments: args,
    authInfo: extraAuthInfo(extra),
  };
}

/** How long a vendor's hook may take, the same budget Python gives one. */
export const HOOK_TIMEOUT_MS = 5000;

const TIMED_OUT = Symbol("hookTimedOut");

async function withinHookBudget(answer: unknown): Promise<unknown> {
  if (!isThenable(answer)) return answer;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), HOOK_TIMEOUT_MS);
    // A pending hook must not hold a finished process open. Outside Node a
    // timer is a number with no `unref`: `principalResolution.test.ts`,
    // "where a timer is a plain number".
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    const first = await Promise.race([answer, deadline]);
    if (first !== TIMED_OUT) return first;
    warn(
      `baton: resolvePrincipal did not answer within ${String(HOOK_TIMEOUT_MS / 1000)}s; ` +
        "this request is sent without a principal.",
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
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
      "in 0.3.5, so the principal is dropped from every event until the hook returns the new key.",
  );
}

/** Run a vendor's hook and turn its answer into the envelope's `principal`.
 *
 * ⚠ **Never throws.** A hook that raises, returns the wrong shape, or returns
 * `null` yields an anonymous request, not a failed one — `principal` is
 * additive analytics and a vendor's own bug in their resolver may not fail
 * their request (SPEC §11.2 fail-open).
 *
 * A hook that has not answered within `HOOK_TIMEOUT_MS` is given up on, which
 * cannot bound one that blocks synchronously.
 */
export async function resolveCallPrincipal(
  hook: ResolvePrincipalHook | undefined,
  call: { extra: Extra; toolName: string | null; arguments: Record<string, unknown> },
): Promise<PrincipalWire | null> {
  // The context is built HERE — after the hook check, inside the try — and
  // the signature takes the raw call so a caller cannot do it the other way:
  // a server with no hook pays nothing, and a throw from the header read
  // cannot escape into the vendor's request.
  if (hook === undefined) return null;
  try {
    const context = buildPrincipalResolutionContext(call.extra, call.toolName, call.arguments);
    const result: unknown = await withinHookBudget(hook(context));
    // Reading the result stays inside the try: a getter or Proxy on what the
    // hook returned is still the vendor's code.
    const principal = normalizePrincipal(result);
    if (principal === null) {
      warnIfPreRenameShape(result);
      return null;
    }
    return principalFor(principal, (form) => {
      warn(
        `baton: resolvePrincipal returned form ${describeForm(form)}, expected "raw" or "hashed" — ` +
          `sending it as "${PRINCIPAL_FORM_RAW}".`,
      );
    });
  } catch {
    // Broad on purpose: this calls code a VENDOR wrote, and an identity read
    // may not be able to fail a request. Nothing is logged to stdout — that
    // stream is the MCP JSON-RPC frame (AGENTS.md boundary rule 2).
    return null;
  }
}

function describeForm(form: unknown): string {
  return typeof form === "string" ? JSON.stringify(form.slice(0, 32)) : `of type ${typeof form}`;
}
