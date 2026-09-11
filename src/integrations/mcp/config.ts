/**
 * `BatonConfig` — vendor-side configuration for `withBaton`. A trimmed
 * mirror of `baton` (Python)'s `integrations/_config.py::VendorConfig`.
 */

import { VENDOR_ID_PATTERN } from "../../dsn.js";
import type { Sink } from "../../sinks.js";

// Vendor IDs are the annotation-tool-name prefix — same pattern Python
// validates against. They are NOT the tenant id: see `BatonConfig.tenantId`,
// which used to be a second copy of this value.
//
// Imported from `dsn.ts` rather than defined here, and re-exported so this
// stays the name the rest of the integration reads: a DSN's server segment IS
// a vendorId, so the parser applies this very rule, and a second copy of the
// regex is how the two drift apart. This recipe has already costed that 48
// wrong twice by writing the number down somewhere else. Python makes the
// same move, for the same reason.
export { VENDOR_ID_PATTERN } from "../../dsn.js";

// Per-tool intent-param injection modes (mirrors baton-proxy's
// BATON_INTENT_PARAM and Python's VendorConfig.intent_param_mode).
const INTENT_PARAM_MODES = new Set(["optional", "required", "off"]);

/** Normalized input to `BatonConfig.resolveSessionId`. Deliberately doesn't
 * carry the raw MCP SDK `extra` object — this shape is stable across
 * whatever the TS MCP ecosystem does with its request-handler signature. */
export interface SessionResolutionContext {
  meta: Record<string, unknown> | null;
  toolName: string;
  arguments: Record<string, unknown>;
}

export type ResolveSessionIdHook = (
  context: SessionResolutionContext,
) => string | null | undefined | Promise<string | null | undefined>;

export interface BatonConfig {
  /** Short stable identifier for the SERVER whose surface is captured
   * (e.g. `"acme"`). Also the default annotation tool name prefix
   * (`{vendorId}_annotate`). This is not the account — see `tenantId`. */
  vendorId: string;
  /** Account identifier for the envelope's `tenant_id` (SPEC §11.4).
   *
   * **This is not `vendorId`, and conflating them is the bug this field
   * exists to fix.** `tenantId` names the ACCOUNT the collector
   * authenticates; `vendorId` names the SERVER whose surface is being
   * captured. One account wraps many servers, so sending the account id in
   * both slots collapses them: two servers in one workspace render as one,
   * whose label flips to whichever deployed last, and a server ends up
   * naming itself with its workspace's opaque id.
   *
   * Resolved explicit → `BATON_TENANT_ID` → `vendorId`. That last fallback
   * exists for our own fixtures during the change, not for anyone's install
   * — a wrap block states this value on its own line, because it is the diff
   * a customer reviews in their pull request. The environment read is
   * guarded, so this package still loads on runtimes with no `process`. */
  tenantId?: string;
  /** Human-readable vendor name used in server instructions and the
   * annotation tool description — whitelabel obligation (SPEC §5.4): no
   * Baton-branded strings reach the calling agent. */
  vendorDisplayName: string;
  /** End-user consent token attached to every emitted event per SPEC §2.3 —
   * required, the Console MUST reject events missing it. */
  consentToken: string;
  /** Where events go. Defaults to `new StdoutSink()` — zero-config dev mode. */
  sink?: Sink;
  /** Default `agent_runtime` when `_meta` heuristics can't detect one. */
  defaultAgentRuntime?: string;
  /** PII scrubber per SPEC §7, applied to tool params/results, `_meta`,
   * intent strings and error bodies before they reach the sink. Defaults to
   * the shipped default ruleset (`new Scrubber().scrub` — email, bearer,
   * sk-keys, AWS keys, JWTs, phones, Luhn-checked cards, plus sensitive
   * field names), matching `baton` (Python) and baton-proxy: on by default
   * so untouched integrations get scrubbing without the operator opting in.
   * Pass `identityScrub` to explicitly opt out, or supply your own. */
  scrubber?: (value: unknown) => unknown;
  /** Optional vendor-supplied session-id resolver, checked BEFORE
   * `extra.sessionId` — mirrors Python's `resolve_session_id` rung 0. */
  resolveSessionId?: ResolveSessionIdHook;
  /** Optional override for the annotation tool name. Default is
   * `{vendorId}_annotate`. */
  annotationToolName?: string;
  /** Per-tool intent-param injection (mirrors baton-extmcp's vendor-neutral
   * naming). `"optional"` (default) injects `user_goal`/`expected_result`
   * string params on every wrapped tool's advertised schema; `"required"`
   * also adds `user_goal` to the schema's required fields (`expected_result`
   * stays optional regardless); `"off"` disables injection. Both params are
   * stripped before the vendor handler runs, so the tool never sees them.
   * This is what captures intent on runtimes that drop `instructions`
   * (notably Claude Desktop) — where the annotation tool alone yields
   * nothing. A tool registered with no `inputSchema` at all is left alone
   * regardless of this setting (see `schemaCompat.injectGoalParams`). */
  intentParamMode?: "optional" | "required" | "off";
}

/**
 * `tenant_id` per SPEC §11.4: explicit → `BATON_TENANT_ID` → `vendorId`.
 * Mirrors Python's `integrations/_config.py::_resolve_tenant_id`, including
 * its falsy-means-unset behaviour (`if explicit:`), so an empty string falls
 * through rather than emitting a blank tenant.
 *
 * The `vendorId` tail is a migration shim for this repo's own fixtures, not a
 * supported configuration: it reproduces exactly the collapse the split exists
 * to end, so it is the branch to delete once the recipe emits the var.
 *
 * Resolved ONCE per `withBaton` install and shared by the tool-call and
 * annotation paths — two resolutions could disagree, and an annotation under a
 * different tenant than its call is unjoinable.
 */
export function resolveTenantId(explicit: string | undefined, vendorId: string): string {
  if (explicit) return explicit;
  // Guarded: `process` is absent on edge/worker runtimes, and this package
  // reads no other environment variable. A missing `process` is a miss, not a
  // crash inside the vendor's server startup.
  const fromEnv = typeof process !== "undefined" ? process.env?.BATON_TENANT_ID : undefined;
  if (fromEnv) return fromEnv;
  return vendorId;
}

export function validateBatonConfig(config: BatonConfig): void {
  if (!VENDOR_ID_PATTERN.test(config.vendorId)) {
    throw new Error(
      `vendorId ${JSON.stringify(config.vendorId)} must match ${VENDOR_ID_PATTERN.source} ` +
        "— used as the default annotation tool name prefix.",
    );
  }
  if (!config.vendorDisplayName) {
    throw new Error(
      "BatonConfig.vendorDisplayName is required — used in server instructions " +
        "and the annotation tool description (whitelabel obligation, SPEC §5.4).",
    );
  }
  if (!config.consentToken) {
    throw new Error(
      "BatonConfig.consentToken is required per SPEC §2.3 — events without a " +
        "valid consent_token MUST be rejected by the consumer.",
    );
  }
  if (config.intentParamMode !== undefined && !INTENT_PARAM_MODES.has(config.intentParamMode)) {
    throw new Error(
      `BatonConfig.intentParamMode ${JSON.stringify(config.intentParamMode)} must be one of ` +
        `${JSON.stringify([...INTENT_PARAM_MODES].sort())}.`,
    );
  }
}
