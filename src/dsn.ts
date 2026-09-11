/**
 * The packed connection string a wrapped server ships with — parse only.
 *
 * A **DSN** carries the four values an install needs in one string:
 *
 * ```text
 * https://baton_pk_<random>@ingest.goodtiming.ai/ten_<32 hex>/echo-server
 * │       │                 │                    │            │
 * scheme  key (the bearer)  authority            workspace    server
 *
 * dsn        = scheme "://" key "@" authority "/" workspace "/" server
 * scheme     = "https" | "http"
 * key        = "baton_pk_" tail          ; "baton_sk_" warns and still works
 * authority  = host [ ":" port ]
 * workspace  = "ten_" 32(hexdigit)
 * server     = the vendor_id pattern below
 * ```
 *
 * It replaces five environment variables with one value that can sit inline in
 * a distributable server's source, which is the whole point: a stdio server
 * runs on every user's machine, so a key that cannot ship means events that
 * never arrive.
 *
 * **Nothing here reaches the wire.** The envelope still carries `tenant_id`,
 * `vendor_id` and `consent_token` as separate fields — the SDK unpacks the
 * string and fills them in. This is config ergonomics; ingest, SPEC and the
 * `baton-spec` vectors are untouched.
 *
 * **The path segments are DATA, not a route.** Nobody can `GET` that URL. The
 * ingest origin is scheme + authority and *nothing else*; `HttpSink` appends
 * `/v0/events` itself, exactly as it does for an explicitly-constructed sink.
 * A parser that appends anything here reproduces a double-append this project
 * has already shipped once.
 *
 * Line-for-line port of `baton` (Python)'s `baton/_dsn.py`. The grammar is the
 * contract between the console's mint and both SDKs, so the two parsers are
 * kept the same shape deliberately — including the two deliberate
 * permissivenesses, because a parser STRICTER than the mint is what breaks a
 * customer, while one that is looser only fails to catch a typo the collector
 * will reject readably anyway:
 *
 * - **The key's tail is not length-checked.** The grammar says 43 characters
 *   and the mint says so today; that number belongs to the console, and
 *   pinning it here means the day the mint changes, every shipped SDK refuses
 *   every new key. The prefix carries the meaning — length does not.
 * - **The server segment is checked with `VENDOR_ID_PATTERN`**, the same
 *   object `validateBatonConfig` uses, rather than a second regex restating
 *   its ceiling. That ceiling has already been costed wrong twice.
 *
 * **Never put a parsed DSN in an error message.** It holds a bearer token, and
 * an exception carrying one lands in stack traces, logs and issue reports.
 * Every throw below goes through `redact`.
 */

/**
 * Vendor IDs become annotation tool name prefixes; same client-pattern as
 * annotation tool names. Rejects dots so the default tool name is valid.
 *
 * It lives HERE rather than in `integrations/mcp/config.ts` — which is where
 * it was defined and where `validateBatonConfig` still applies it — for the
 * same structural reason the Python copy moved: the DSN's server segment IS a
 * vendorId, and a top-level module must not import from `integrations/`. One
 * object, imported both places, so the two rules cannot drift apart the way a
 * copied regex would.
 */
export const VENDOR_ID_PATTERN = /^[a-zA-Z0-9_-]{1,48}$/;

// The console mints lowercase, but hex case is not meaningful and refusing an
// uppercase digit would be a rule stricter than the mint. Matched loosely,
// passed through VERBATIM — the value is compared as a string server-side, so
// this parser must never normalise it.
const WORKSPACE_PATTERN = /^ten_[0-9a-fA-F]{32}$/;

const PUBLISHABLE_PREFIX = "baton_pk_";
const SECRET_PREFIX = "baton_sk_";

/**
 * A credential-shaped run: a prefix followed by enough tail to BE one.
 *
 * ⚠ **The floor on the tail is what lets this same pattern run over finished
 * sentences.** This module's own help text says "as in
 * `https://baton_pk_...@host/ten_.../server`" and its secret-key warning names
 * `baton_sk_` out loud; a pattern matching a bare prefix would eat both and
 * leave the reader with `<key>` where the example belongs. A real key's tail
 * is 43 URL-safe base64 characters — `%` is admitted too, since the tail is
 * deliberately unvalidated and one may contain it — so eight is far below any
 * credential and far above an ellipsis.
 */
const KEY_RUN = /baton_(?:pk|sk)_[A-Za-z0-9_%-]{8,}/g;

function looksLikeAKey(value: string): boolean {
  return value.startsWith(PUBLISHABLE_PREFIX) || value.startsWith(SECRET_PREFIX);
}

/**
 * Whether a credential is anywhere INSIDE this value, not merely at its start.
 *
 * ⚠ **`startsWith` was the blind spot, and it was load-bearing in two
 * places.** A segment with a key glued to it — `srv-baton_pk_…`, the shape a
 * paste into a half-filled field makes — starts with neither prefix, so it
 * slipped past the key-in-slot refusal that names the slot and past the "the
 * key is in the PATH" hint, landing on a pattern-mismatch message that
 * interpolates the segment instead. Expressed through the scan rather than a
 * second regex, so there is ONE notion of "looks like a credential" and it
 * cannot drift from the one that redacts.
 */
function containsKey(value: string): boolean {
  return sweep(value) !== value;
}

// What a bare key gets told. It is the single most likely paste error — the
// /account page labels the key type "Publishable key" and the string you copy
// "DSN" — so it earns a real sentence rather than a parse error.
const BARE_KEY_HINT =
  "this looks like a bare key, not a DSN — copy the full value from " +
  "/account, which starts with https:// and ends with your server's name";

/**
 * Warn on stderr, never stdout: stdout is the JSON-RPC stream under stdio
 * transport, which is exactly the deployment this feature exists for.
 *
 * `process.emitWarning` is this repo's existing convention (`HttpSink`'s
 * buffer overflow), guarded here the way `resolveTenantId` guards its
 * environment read — `process` is absent on edge and worker runtimes, and a
 * missing warning channel must not crash a vendor's server startup.
 */
function warn(message: string): void {
  if (typeof process !== "undefined" && typeof process.emitWarning === "function") {
    process.emitWarning(message);
  }
}

/** The four values unpacked from one string. See the module docstring. */
export interface Dsn {
  /**
   * Scheme + authority, no path and no trailing slash — what `HttpSink` takes
   * as its base URL and appends `/v0/events` to.
   */
  readonly origin: string;
  /**
   * The workspace segment, `ten_` prefix included and case as minted. The
   * prefix is part of the id, not a marker to strip.
   */
  readonly tenantId: string;
  /**
   * The server segment. This is the server the key is BOUND to: a mismatch
   * between it and the events' `vendor_id` is refused at ingest.
   */
  readonly vendorId: string;
  /**
   * The bearer, whole and unmodified — the auth layer hashes the entire string
   * including its prefix, so nothing here may trim it.
   */
  readonly key: string;
}

interface SplitDsn {
  scheme: string;
  netloc: string;
  /** Whether an authority-terminating `/` was present, so `redact` can render
   * the original shape rather than inventing or dropping a separator. */
  slash: string;
  path: string;
}

/**
 * The ONE split, shared by `redact` and `parseDsn`.
 *
 * ⚠ **Two functions splitting one string two ways is the defect this shape
 * exists to prevent**, and the Python original records it as shipped: its
 * `redact` partitioned on the first `@` while its parser used `rpartition` on
 * the netloc, so a string with two `@`s put the credential on the
 * "redacted" side of the split and the safe message carried the whole key.
 *
 * ⚠ **Hand-rolled rather than `new URL()`, and that is a measurement, not a
 * preference.** WHATWG parsing percent-encodes userinfo: `new URL(
 * "https://a@b@host/…").username` is `"a%40b"`, an ALTERED key — and
 * `decodeURIComponent` cannot round-trip it back, because the parser is
 * deliberately loose about the tail and a tail containing a literal `%` is
 * legal. Python's `rpartition("@")` hands back the key verbatim; the bearer is
 * hashed whole server-side, so a parser that rewrites one byte of it produces
 * a key that matches no row. `new URL` is still used below, but only as a
 * VALIDATOR of the authority, after the credential is already split off.
 */
function splitDsn(raw: string): SplitDsn | null {
  const schemeEnd = raw.indexOf("://");
  if (schemeEnd === -1) return null;
  const scheme = raw.slice(0, schemeEnd).toLowerCase();
  const rest = raw.slice(schemeEnd + 3);

  // The authority ends at the first `/`, `?` or `#` — what `urlsplit` does,
  // and skipping the last two would let `https://key@host?a=b/ten_.../srv`
  // parse with a QUERY STRING inside the origin, which `HttpSink` would then
  // append `/v0/events` to.
  const end = rest.search(/[/?#]/);
  if (end === -1) return { scheme, netloc: rest, slash: "", path: "" };

  const netloc = rest.slice(0, end);
  if (rest[end] !== "/") {
    // A query or fragment where the path belongs: no segments at all, which is
    // the "exactly two path segments" refusal.
    return { scheme, netloc, slash: "", path: "" };
  }
  const afterSlash = rest.slice(end + 1);
  const pathEnd = afterSlash.search(/[?#]/);
  return {
    scheme,
    netloc,
    slash: "/",
    path: pathEnd === -1 ? afterSlash : afterSlash.slice(0, pathEnd),
  };
}

/** `netloc.rpartition("@")` — the LAST `@`, so a key containing one survives. */
function splitKeyFromAuthority(netloc: string): { key: string; at: boolean; authority: string } {
  const index = netloc.lastIndexOf("@");
  if (index === -1) return { key: "", at: false, authority: netloc };
  return { key: netloc.slice(0, index), at: true, authority: netloc.slice(index + 1) };
}

/**
 * A DSN with its credential removed, safe for an error message or a log.
 *
 * Keeps everything that helps someone fix the problem (scheme, host,
 * workspace, server) and drops the one part that must not be repeated. Falls
 * back to a bare marker if the string is too malformed to split, since "I
 * could not parse it" must never become "here is your token".
 *
 * ⚠ **The PATH is redacted too, and skipping it was the third leak of this
 * kind.** A key pasted into the workspace or server slot is a plausible
 * mistake — the two halves of a DSN look alike to someone copying by eye —
 * and such a string has no `@` at all, so every earlier version of this
 * function reported "no key" and then printed the path with the key in it.
 */
export function redact(raw: string): string {
  const parts = splitDsn(raw);
  if (parts === null) return "<dsn>";
  const { at, authority } = splitKeyFromAuthority(parts.netloc);
  // The path is assembled RAW and swept whole below, rather than elided
  // segment by segment. A per-segment pass is what this function used to do,
  // and it is the shape the leaks kept coming through: it can only cover the
  // slots someone remembered to route through it.
  const assembled = at
    ? `${parts.scheme}://***@${authority}${parts.slash}${parts.path}`
    : `${parts.scheme}://<no key>@${parts.netloc}${parts.slash}${parts.path}`;
  return sweep(assembled);
}

/**
 * The last line: anything still shaped like a credential is elided, wherever
 * it sits.
 *
 * ⚠ **The fourth leak of this kind, and the one per-slot handling could not
 * see.** The elision ran on PATH segments; a key pasted into the
 * AUTHORITY slot — `https://baton_pk_…` with nothing after it — was
 * interpolated verbatim, so the refusal printed the whole bearer. That case is
 * not exotic, it is the one this parser STEERS people into: a vendor who
 * pastes a bare key is told "copy the full value from /account, which starts
 * with `https://`", and the obvious next move is to prepend `https://` to the
 * key already in hand and run it again — putting the credential into the boot
 * log on the retry.
 *
 * So the guarantee stops being a list of slots that each remember to elide,
 * and becomes one scan of the finished string: a slot added later cannot
 * forget. Prefix-anchored, so the host, workspace and server around it stay
 * readable — the whole point of redacting rather than refusing to say
 * anything.
 */
function sweep(message: string): string {
  return message.replace(KEY_RUN, "<key>");
}

/**
 * The only way this module throws, so the scan cannot be skipped.
 *
 * ⚠ **Review found two throws that skipped it, under a docstring already
 * claiming they could not.** The two pattern-mismatch refusals interpolate the
 * offending segment, which was elided by a prefix-anchored check that a
 * glued-on key — `srv-baton_pk_…`, what a paste into a half-filled field makes
 * — walks straight past. The bearer printed in plaintext, in the same sentence
 * as its own redaction.
 *
 * ⚠ **This sweep and `containsKey`'s key-in-slot refusal cover that input
 * jointly, and NEITHER is load-bearing alone** — measured by mutation:
 * removing either one reds no leak test, removing both reds three. That is
 * worth stating rather than leaving to be rediscovered, because it means a
 * reader who deletes one of them sees a green suite and concludes it was dead.
 * They are kept as a pair on purpose, and they answer different questions: the
 * refusal decides which SENTENCE a vendor reads, and is pinned by its own
 * test; this decides what no sentence may contain.
 *
 * The exit is the right home for the second job. A guarantee that lives at the
 * call sites is one the next message added does not know about.
 */
function fail(message: string): never {
  throw new Error(sweep(message));
}

/** `BATON_DSN`, or undefined — guarded, since `process` is absent on edge and
 * worker runtimes and this module must not crash a server's startup there. */
function dsnFromEnvironment(): string | undefined {
  const fromEnv = typeof process !== "undefined" ? process.env?.BATON_DSN : undefined;
  // Set-but-empty is how a shell exports a variable it failed to fill.
  // Treating it as a value would raise a parse error naming a string the
  // vendor never wrote.
  return fromEnv ? fromEnv : undefined;
}

/**
 * `dsn`: explicit argument → `BATON_DSN` → undefined.
 *
 * The SDK's existing precedence rule, unchanged. `BATON_DSN` exists for the
 * hosted vendor who will not put the value in source: one environment variable
 * instead of five, and their edit rather than a branch in the install recipe.
 */
export function resolveDsn(explicit: string | undefined): string | undefined {
  if (explicit !== undefined) return explicit;
  return dsnFromEnvironment();
}

/**
 * Which DSN applies, given what the caller ALSO configured by hand.
 *
 * ⚠ **An environment variable is not something the caller passed, and the
 * first cut of the Python original treated the two as one value.** Folding
 * `BATON_DSN` in before the conflict check meant a vendor who exported it for
 * one server could not install a SECOND server the old explicit way in the
 * same process: the install died accusing them of passing a `dsn` that appears
 * nowhere in their code. It also contradicted the precedence rule this SDK
 * states everywhere else — explicit wins, the environment is the fallback — by
 * letting an ambient value beat an explicit one and then blaming the caller
 * for the collision.
 *
 * So the two sources are separated:
 *
 * - **An explicit DSN beside an explicit `vendorId` / `tenantId` / `sink`
 *   still throws.** Both are in the vendor's own source; picking one would be
 *   a guess, and a wrong guess routes a server's traffic under someone else's
 *   identity.
 * - **An ambient `BATON_DSN` loses to explicit configuration and is
 *   ignored**, which is just "explicit wins" applied to a value the caller did
 *   not write. It still outranks `BATON_TENANT_ID` and friends, which is the
 *   re-install case the DSN exists for: environment against environment, the
 *   packed one is the one someone chose today.
 * - **Being ignored is announced.** A vendor who exported `BATON_DSN`
 *   expecting it to configure this server would otherwise get a healthy
 *   install that ships events nowhere near the collector — broken and unbuilt
 *   looking alike, at the one boundary where nobody is watching.
 */
export function selectDsn(
  explicit: string | undefined,
  supplied: Record<string, boolean>,
  door: string,
): string | undefined {
  const conflicts = Object.keys(supplied)
    .filter((name) => supplied[name])
    .sort();

  if (explicit !== undefined) {
    if (conflicts.length > 0) {
      fail(
        `${door} got both a dsn and an explicit ${conflicts[0]} — the dsn ` +
          `already supplies it. Drop one: the dsn is the single value from ` +
          `/account, and ${conflicts[0]} is what it unpacks to.`,
      );
    }
    return explicit;
  }

  const ambient = dsnFromEnvironment();
  if (ambient === undefined) return undefined;
  if (conflicts.length > 0) {
    warn(
      `baton: BATON_DSN is set, but this ${door} supplies ${conflicts.join(", ")} ` +
        `directly, so BATON_DSN is being IGNORED and these events are NOT going ` +
        `to the collector it names. Remove the explicit value to use it, or ` +
        `unset BATON_DSN if it was meant for a different server.`,
    );
    return undefined;
  }
  return ambient;
}

/**
 * Unpack a DSN, throwing on anything that is not one.
 *
 * Loud at install, which is the behaviour a missing required environment
 * variable already has and the reason the TypeScript recipe grew an `env()`
 * helper: a config value that arrives wrong must fail where the vendor is
 * looking, not at the first tool call in production.
 */
export function parseDsn(raw: string): Dsn {
  if (typeof raw !== "string" || raw.trim() === "") {
    fail("dsn must be a non-empty string");
  }

  const dsn = raw.trim();

  if (looksLikeAKey(dsn)) {
    // No redact() — a bare key has no structure to show, and echoing it is the
    // thing redact() exists to prevent.
    fail(`dsn is not a URL: ${BARE_KEY_HINT}`);
  }

  const safe = redact(dsn);
  const parts = splitDsn(dsn);

  if (parts === null || (parts.scheme !== "https" && parts.scheme !== "http")) {
    fail(
      `dsn ${safe} must start with https:// (or http:// for local ` +
        `development) — ${BARE_KEY_HINT}`,
    );
  }

  const { key, at, authority } = splitKeyFromAuthority(parts.netloc);
  if (!at || !key) {
    // The likeliest way to arrive here is not a missing key but a MISPLACED
    // one: the two path segments and the userinfo all look alike to someone
    // copying by eye. Saying which mistake it is costs one scan and saves the
    // reader the guess.
    // A key sitting where the HOST belongs is the retry of the bare-key
    // mistake: that refusal says "copy the full value, which starts with
    // https://", so the next thing a vendor tries is their bare key with a
    // scheme in front of it. Landing them on the generic sentence would leave
    // them exactly as stuck as before, having done what they were told.
    if (looksLikeAKey(parts.netloc)) {
      fail(
        `dsn ${safe} is a bare key with a scheme in front of it: ${BARE_KEY_HINT}. ` +
          `The full value also carries a host, your workspace and your server — ` +
          `https://baton_pk_...@host/ten_.../server`,
      );
    }
    const misplaced = parts.path.split("/").some((segment) => containsKey(segment));
    const detail = misplaced
      ? "the key is in the PATH — it goes before an @"
      : "the value from /account has the key before an @";
    fail(
      `dsn ${safe} carries no key: ${detail}, as in https://baton_pk_...@host/ten_.../server`,
    );
  }
  if (key.includes(":")) {
    fail(
      `dsn ${safe} has a ':' in its key — a DSN carries one credential and no password field`,
    );
  }
  if (!authority) {
    fail(`dsn ${safe} has no host`);
  }

  // ⚠ **`new URL` is the host validator, and it runs only AFTER the credential
  // is split off.** Node's `ERR_INVALID_URL` carries the string it was handed
  // on `error.input`, so validating the whole DSN would put the bearer into an
  // exception — the single thing this module exists to prevent. Handed the
  // authority alone, the worst that error can hold is a hostname.
  //
  // ⚠ **Nothing from the caught error crosses over — not the object, not
  // `{ cause }`, not its message.** `cause` is the TypeScript twin of Python's
  // `__context__` trap: it survives on the thrown error and is reachable by
  // anything that walks the chain — an error reporter, a structured logger,
  // vitest's own diff. Only the constructor NAME is carried, and it carries no
  // input.
  //
  // Python reaches this check earlier (its `urlsplit` runs before the key
  // checks above), so a string that is BOTH keyless and unparseable gets the
  // "carries no key" sentence here and "not a parseable URL" there. Both
  // refuse, neither leaks; the order is what the leak-safe placement costs.
  let hostReason: string | null = null;
  let parsedAuthority: URL | null = null;
  try {
    parsedAuthority = new URL(`${parts.scheme}://${authority}`);
  } catch (error) {
    hostReason = error instanceof Error ? error.constructor.name : "Error";
  }
  if (parsedAuthority === null) {
    fail(`dsn ${safe} is not a parseable URL (${hostReason ?? "Error"})`);
  }

  // ⚠ **A BACKSLASH smuggles a path into the authority, and the validator said
  // yes.** WHATWG folds `\` to `/` for special schemes, so
  // `new URL("https://ingest.example.com\evil")` parses happily with host
  // `ingest.example.com` and path `/evil` — while the split above, which ends
  // the authority at `/`, `?` or `#`, keeps the whole thing as the authority.
  // The origin became `https://ingest.example.com\evil`, `HttpSink` appended
  // `/v0/events`, and `fetch` resolved that to
  // `https://ingest.example.com/evil/v0/events`: a 404 at the first tool call,
  // in production, from an install that raised nothing — the exact failure the
  // "loud at install" promise exists to prevent.
  //
  // Asserted on what the URL parser MADE of the authority rather than by
  // adding `\` to the terminator set, because the question is not which
  // characters WHATWG folds — it is whether anything but a host survived.
  if (
    parsedAuthority.pathname !== "/" ||
    parsedAuthority.search !== "" ||
    parsedAuthority.hash !== ""
  ) {
    fail(
      `dsn ${safe} has something other than a host between its key and its ` +
        `path — the ingest origin is the scheme and the authority and nothing ` +
        `else, and the workspace and server are the two path segments after ` +
        `it: https://baton_pk_...@host/ten_.../server`,
    );
  }

  const segments = parts.path.split("/").filter((segment) => segment !== "");
  // Destructured with a rest element rather than length-checked, so the two
  // names narrow to `string` from the same test that refuses the wrong count.
  // `segments.length !== 2` would read more directly and `noUncheckedIndexedAccess`
  // cannot see through it — leaving a choice between an assertion that lies
  // the day someone edits the check, and an unreachable branch no test covers.
  const [workspace, server, ...extra] = segments;
  if (workspace === undefined || server === undefined || extra.length > 0) {
    fail(
      `dsn ${safe} must carry exactly two path segments — the workspace and ` +
        `the server, as in /ten_<32 hex>/<server>. A missing server is never ` +
        `defaulted: it is what the key is bound to.`,
    );
  }

  for (const [slot, segment] of [
    ["workspace", workspace],
    ["server", server],
  ] as const) {
    if (containsKey(segment)) {
      // Checked BEFORE the pattern tests below, which would otherwise
      // interpolate the segment — and a key is far more useful to name by its
      // slot than to print back.
      fail(
        `dsn ${safe} has a KEY in the ${slot} slot. The key goes before the @, ` +
          `and the path carries the workspace and the server: ` +
          `https://baton_pk_...@host/ten_<32 hex>/<server>`,
      );
    }
  }

  if (!WORKSPACE_PATTERN.test(workspace)) {
    fail(
      `dsn ${safe} has ${JSON.stringify(workspace)} where the workspace ` +
        `belongs — expected ten_ followed by 32 hex characters. If the two path ` +
        `segments are the right way round, this is not a Baton DSN.`,
    );
  }
  if (!VENDOR_ID_PATTERN.test(server)) {
    fail(
      `dsn ${safe} has ${JSON.stringify(server)} where the server belongs ` +
        `— it must match ${VENDOR_ID_PATTERN.source}, because this value becomes ` +
        `the annotation tool name prefix as well as the envelope's vendor_id.`,
    );
  }

  if (key.startsWith(SECRET_PREFIX)) {
    // A warning, never a refusal. The KEY ROW is the authority on what a key
    // may do, not its prefix — an SDK enforcing a console policy turns a typo
    // at the mint site into a confusing client-side error. But a secret key
    // inside a server that ships to strangers is worth saying out loud, and
    // this is the only place that can say it. The prefix only — the point is
    // not to repeat the secret.
    warn(
      `baton: this DSN carries a ${SECRET_PREFIX} key (a workspace SECRET) where ` +
        `a ${PUBLISHABLE_PREFIX} key belongs. It will work. But if this server ` +
        `ships to anyone else, that key reads and writes everything the ` +
        `workspace holds — mint a publishable key at /account instead.`,
    );
  }

  return sealKey({
    origin: `${parts.scheme}://${authority}`,
    tenantId: workspace,
    vendorId: server,
    key,
  });
}

/**
 * The parsed DSN, with its bearer kept out of anything that prints the object.
 *
 * `dsn.key` still reads the key — the sink needs it. What changes is the
 * INCIDENTAL paths: `console.log(dsn)`, `util.inspect`, and the
 * `JSON.stringify` inside every structured logger, each of which would
 * otherwise write a publishable key into a vendor's log the moment anyone
 * debugs their install. Python's copy takes the same precaution one field at a
 * time (`field(repr=False)`); a JS object has no repr, so the two hooks that
 * stand in for one are both defined.
 *
 * Both are non-enumerable, so `{...dsn}` and `Object.keys` are unchanged — a
 * spread that silently dropped the bearer would be a far worse trap than the
 * one being closed.
 */
function sealKey(dsn: Dsn): Dsn {
  const shown = { origin: dsn.origin, tenantId: dsn.tenantId, vendorId: dsn.vendorId, key: "<key>" };
  Object.defineProperty(dsn, "toJSON", { value: () => shown, enumerable: false });
  // `Symbol.for`, not an import of `node:util`: this package runs on edge and
  // worker runtimes too, and a registry symbol is inert where nothing reads it.
  Object.defineProperty(dsn, Symbol.for("nodejs.util.inspect.custom"), {
    value: () => shown,
    enumerable: false,
  });
  return dsn;
}
