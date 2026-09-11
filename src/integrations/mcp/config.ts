/**
 * `BatonConfig` — vendor-side configuration for `withBaton`. A trimmed
 * mirror of `baton` (Python)'s `integrations/_config.py::VendorConfig`.
 */

import { parseDsn, selectDsn, VENDOR_ID_PATTERN } from "../../dsn.js";
import { DEFAULT_CONSENT_TOKEN } from "../../events.js";
import { HttpSink, type Sink } from "../../sinks.js";

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
  /** The packed connection string from /account — one value carrying the
   * ingest host, the workspace, the server and the key that binds them.
   *
   * `withBaton(server, { dsn })` is the whole wrap block a DISTRIBUTABLE
   * server ships with, and that is the case it exists for: a stdio server
   * runs on every user's machine, so five `BATON_*` variables are five values
   * that never arrive. Resolved explicit → `BATON_DSN` → unset.
   *
   * **Environment variables do not override it.** A server being re-onboarded
   * has last install's `.env` beside the new inline DSN, and if these values
   * fell through to `BATON_TENANT_ID` the way an unset field does, the stale
   * file would win silently and the events would arrive under the previous
   * server's name.
   *
   * Passing a dsn AND an explicit `vendorId`, `tenantId` or `sink` throws:
   * two sources for one value cannot be reconciled without guessing, and a
   * wrong guess routes a server's traffic under someone else's identity.
   * Everything else — the display name, the scrubber, the injection modes,
   * every identity option — is unaffected; set them alongside a dsn freely. */
  dsn?: string;
  /** Short stable identifier for the SERVER whose surface is captured
   * (e.g. `"acme"`). Also the default annotation tool name prefix
   * (`{vendorId}_annotate`). This is not the account — see `tenantId`.
   *
   * Required unless a `dsn` supplies it — the DSN's last path segment IS this
   * value, and it is what the key is BOUND to. */
  vendorId?: string;
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
   * Baton-branded strings reach the calling agent.
   *
   * Defaults to the DSN's server segment VERBATIM when a `dsn` is given and
   * this is not. Verbatim rather than prettified: this string reaches the
   * calling agent, so inventing a capitalisation the vendor never chose would
   * put a fabricated name in front of their users. */
  vendorDisplayName?: string;
  /** End-user consent token attached to every emitted event per SPEC §2.3 —
   * the Console MUST reject events missing it.
   *
   * **Defaulted, so the customer never has to carry it** — see
   * `DEFAULT_CONSENT_TOKEN` for why the field stays on the wire regardless.
   * Passing `""` explicitly still throws: a value the vendor deliberately
   * emptied is a mistake, not a request for the default.
   *
   * ⚠ **No environment variable is read for this, and that is parity rather
   * than a gap.** Python reads `BATON_CONSENT_TOKEN` on its `Client` door
   * only; its `VendorConfig` — the door this package mirrors — takes a plain
   * default, and the `os.environ["BATON_CONSENT_TOKEN"]` in its install
   * examples is the RECIPE passing a value explicitly, not the SDK reading
   * one. Adding the read here would make this arm honour a variable the
   * equivalent Python door ignores. */
  consentToken?: string;
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

/**
 * A config with everything the DSN can supply already filled in.
 *
 * The three fields are required HERE and optional on `BatonConfig`, so the
 * compiler enforces that `withBaton` reads the resolved value: the wrap paths,
 * the annotation tool and the surface snapshot all close over this object, and
 * one of them reading the caller's raw config would emit events under a
 * different identity than the rest.
 */
export interface ResolvedBatonConfig extends BatonConfig {
  vendorId: string;
  vendorDisplayName: string;
  consentToken: string;
}

/**
 * Fill in whatever the DSN carries, returning a config nothing downstream has
 * to know about. Mirrors Python's `integrations/_config.py::resolve_config`.
 *
 * **Everything a DSN supplies lands at the EXPLICIT tier, above the
 * environment** — see `BatonConfig.dsn` for why that matters more than it
 * sounds. A NEW object is returned rather than the caller's mutated: a vendor
 * may hold one config and hand it to two servers, and an install that rewrote
 * its argument would make the second inherit the first's resolution.
 *
 * ⚠ **The parsed key is NOT kept on the returned config.** It reaches the sink
 * and stops there. Python retains its `dsn` string on the config and pays for
 * it — `repr(VendorConfig)` prints the bearer, which is one of the leaks
 * parked for that repo — and nothing here reads the string after parsing, so
 * this arm simply does not import the problem.
 */
export function resolveBatonConfig(config: BatonConfig): ResolvedBatonConfig {
  const dsnString = selectDsn(
    config.dsn,
    {
      // Truthiness per field, mirroring Python's `bool()` / `is not None`
      // split: an empty `vendorId` is an unset one, while an explicitly
      // supplied `tenantId` or `sink` is a conflict whatever it holds.
      vendorId: Boolean(config.vendorId),
      tenantId: config.tenantId !== undefined,
      sink: config.sink !== undefined,
    },
    "BatonConfig",
  );

  if (dsnString === undefined) {
    const defaulted: BatonConfig = {
      ...config,
      consentToken: config.consentToken ?? DEFAULT_CONSENT_TOKEN,
    };
    validateBatonConfig(defaulted);
    return defaulted;
  }

  const dsn = parseDsn(dsnString);
  // The packed string is DELETED rather than overwritten with `undefined`:
  // `exactOptionalPropertyTypes` refuses the latter, and dropping the property
  // is what is wanted anyway — see the note above about not keeping the
  // bearer on an object that outlives this call.
  const rest: BatonConfig = { ...config };
  delete rest.dsn;
  const identity: BatonConfig = {
    ...rest,
    vendorId: dsn.vendorId,
    tenantId: dsn.tenantId,
    vendorDisplayName: config.vendorDisplayName || dsn.vendorId,
    // `??`, not `||`: an explicit empty string must survive to the validation
    // below and be REFUSED there, rather than be quietly replaced by the
    // default it was deliberately not left as.
    consentToken: config.consentToken ?? DEFAULT_CONSENT_TOKEN,
  };

  // Validated BEFORE the sink is built. The ordering is parity with Python,
  // where `HttpSink.__init__` eagerly constructs an httpx client that a later
  // validation failure would leave unclosed; this `HttpSink` holds no resource
  // until its first write, so here the order protects nothing and is kept so
  // the two arms cannot answer "what happens on a bad config" differently.
  validateBatonConfig(identity);

  // `identity` is a ResolvedBatonConfig from here — `validateBatonConfig` is
  // an assertion signature, so the three required fields are proven by the
  // same call that refuses a config missing them, rather than re-asserted with
  // a cast that would go on compiling if a check were ever deleted.
  return {
    ...identity,
    // The origin is scheme + authority; `HttpSink` appends `/v0/events`
    // itself, exactly as it does for an explicitly-constructed sink.
    sink: new HttpSink(dsn.origin, { apiKey: dsn.key }),
  };
}

export function validateBatonConfig(config: BatonConfig): asserts config is ResolvedBatonConfig {
  if (!config.vendorId) {
    throw new Error(
      "BatonConfig needs a vendorId — either directly, or via a dsn whose " +
        "last path segment names the server (see /account).",
    );
  }
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
  if (config.consentToken !== undefined && !config.consentToken) {
    throw new Error(
      "BatonConfig.consentToken was set to an empty string, and events " +
        "without a valid consent_token MUST be rejected by the consumer per " +
        "SPEC §2.3. Omit it to take the SDK's default.",
    );
  }
  if (!config.consentToken) {
    // Reached only by a direct call: `resolveBatonConfig` fills the default in
    // before validating. Kept because this function is exported and asserts
    // the field is present — an assertion signature that can be true while the
    // field is missing is worse than no signature.
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
