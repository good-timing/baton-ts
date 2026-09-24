# Changelog

## Unreleased: the principal becomes an object, and a returned error flag becomes a failure

- **BREAKING — `principal_id` becomes `principal: {id, source, form}`.** All
  three members are required together, so a producer emits the whole object or
  omits it, and no conformant event carries an id whose classification a
  consumer has to guess. `source` is where the identity came from, `form` is
  whether the value is a pseudonym or real text.

  The scheme prefix had been carrying both facts in one string, and `"raw"`
  mode — which emits no prefix at all — dropped both. A consumer could not
  recover them, so this is a wire problem rather than a read-model one. Both
  members now ride every mode.

  **Read `form` to classify, never the value's shape.** A real OIDC subject
  (`mailto:`, `acct:`, `urn:`, `https:`) reads as a scheme-tagged pseudonym to
  anything testing for "letters then a colon". And per `SPEC §11.4`, trust a
  principal as verified only where `source` is exactly `"attested"`, and treat
  anything but `form: "hashed"` as personal data — stated that way round so an
  unregistered value fails safe. Both value sets are open; tolerate an unknown
  value rather than reject the event.

- **`v1:` is retired; every hashed principal is tagged `h1:`.** The tag was
  never part of the HMAC message, so it only ever differed from `h1:` by
  label — the regenerated parity corpus proves it moved no digest, all sixteen
  shared cases byte-identical. What the tag records now is the HMAC **key
  generation** and nothing else; `h2:` remains reserved for a rotation, which
  is the one event that can move a digest.

  **A vendor recomputing a pseudonym must stop passing `scheme`.** It now
  defaults to `HASH_SCHEME`, matching Python.

  Note that `principal.id` is the whole string including the tag, so the
  emitted id for a given person does change (`v1:<hex>` to `h1:<hex>`) even
  though the hex does not. Nothing needs migrating: the only thing that ever
  produced a `v1:` value on this SDK was a configured `resolvePrincipal` hook,
  and no install has one — the onboarding recipe ships neither a hook nor an
  HMAC key, so every install to date emits `principal: null`.

- **This SDK still has no attested rung, and that is `source`'s job to say.**
  Every principal it emits carries `source: "asserted"`: `AuthInfo` exposes no
  `claims`, so a subject's location would be a guess. ⚠ Do not read the `h1:`
  prefix as an attestation — it is the key generation and is identical on both
  provenances, and `SPEC §11.4` forbids presenting an asserted principal as
  verified.

- `principalIdFor` is now `principalFor` and returns the wire object.
  **Newly exported:** `PrincipalWireSchema`, `PRINCIPAL_FORM_HASHED` /
  `PRINCIPAL_FORM_RAW`, `PRINCIPAL_SOURCE_ASSERTED`, and `HASH_SCHEME` — which was previously withheld on purpose, because
  `hashPrincipalId`'s `scheme` had no default and naming the tag invited a
  vendor to pass the wrong one. It defaults correctly now, so the constant and
  the default cannot disagree. `principalFor` itself is **not** exported: it is
  the single construction site for the wire object, and handing it out would
  let a caller assemble a partial `principal` by hand.

- **BEHAVIOUR — a tool that RETURNS an error result now emits
  `tool_call_error`, where it used to emit `tool_call_end`.** MCP files a
  failed `tools/call` as a 200 whose `CallToolResult` sets `isError`; a
  JSON-RPC error means a protocol fault. This package classified on thrown
  exceptions alone, so every failure a vendor reported as a value was filed as
  a success (SPEC §11.4.3; §6.1's old wording said "on exception", and this
  package copied the spec).

  The caller's result is unchanged: the value is returned, never thrown
  (§11.2). What moves is which event the session carries, and with it any
  Console figure that counts failures.

- **`tool_call_error.result` is now EMITTED, not merely accepted.** `67453eb`
  landed the schema half; this is the producer half. On a returned flag it
  carries the whole result envelope, which keeps the flag and the reason that
  a flat `error_body` string would lose. On a throw it is explicitly `null`,
  which is the shape Python's vector carries.

  ⚠ **`error_body` is capped at 2000 CODE POINTS, not UTF-16 units**, which
  is what Python's `[:2000]` counts — so the two producers agree on what the
  cap means, and a reason whose boundary falls inside a surrogate pair no
  longer ships a lone surrogate. Both failure legs share one cap.

  ⚠ **On this SDK, `tool_call_error.result` and `tool_call_end.result` are the
  same shape** — the object the vendor's handler returned, `{content,
  isError?}`, which neither major converts. Python's two differ (there
  `tool_call_end.result` is the unwrapped content list), and SPEC §11.4.3 keeps
  the envelope era-native on purpose, so a consumer must read the producer's
  shape rather than assume Python's.

  `error_type` is the registered literal `"tool_error"` for the returned shape
  and stays the error's constructor name for a throw. The literal is the same
  one `baton` (Python) and `baton-extmcp` emit, which is what lets a consumer
  compare the three sensors.

- ⚠ **One spelling, `isError`, and no `content` guard — both measured on both
  majors, 2026-09-24.** Python's helper probes `is_error` first because that is
  an attribute name `mcp` 2.x introduced; the TS SDKs have no snake_case era,
  and what this package sees is the vendor's own literal return, passed through
  unconverted by `@modelcontextprotocol/sdk` 1.x and
  `@modelcontextprotocol/server` 2.x alike.

  Python's helper also requires a list-valued `content`, to exclude an object
  that merely carries the attribute. SPEC §11.4.3 required that of every
  producer until 2026-09-24 and now scopes it to the converted-result vantage
  point, because the guard is wrong at this one: a tool returning `{isError: true, rows: 0}` — no
  content at all — reaches the client as `{content: [], isError: true}`. The
  guard would make this sensor miss a failure its own caller can see.

- ⚠ **Not closed: a failure the SDK manufactures above the handler.** Measured
  on both majors — a tool registered with an `outputSchema` whose handler
  returns `content` and no `structuredContent` hands this wrapper a
  success-shaped object, and the SDK's own output validation, which runs after
  the executor, then sends the client `isError: true`. This package still
  emits `tool_call_end` for it. A handler-level wrap cannot see that class at
  all; a wire sensor can. The scope is stated on `isErrorResult` and pinned by
  a test, so the day it changes is visible.

- **`baton-spec` moves to `f1e0280`**, which carries `result` on
  `ToolCallErrorPayload` and a second `tool_call_error` vector for the returned
  shape. The cross-SDK conformance scenario grew the `soft_fail` tool to match
  `generate.py`'s, so both failure shapes are now pinned against a real
  Python-emitted envelope — `error_type` and `error_body` compared, not
  exempted.

## 0.3.7: the envelope says what was underneath the call

- **Every event carries `transport_observed`, recording what the SDK saw
  beneath the call.** An optional nullable string, `SPEC §11.4`: `"http"` when
  a transport request object is reachable — `requestInfo` on the 1.x peer,
  `http.req` on 2.x — `"no-http-request"` when neither is, which is stdio and
  in-memory, and `"read-failed"` if reading the carrier throws. Emitted on both
  majors.

  It exists because `SPEC §3.4`'s session ladder ends in a process-wide
  fallback id, and that terminus is correct on one deployment shape and wrong
  on another — the two are identical on the wire. `no-http-request` is the only
  value that licenses a consumer to group on that fallback.

  **The value set is open**: tolerate an unregistered value rather than reject
  the event, and key any grouping rule on `no-http-request` positively, never
  on "not http". The value is read from the request object and never from
  `extraHeaders`, which returns `null` both when no HTTP request is in flight
  and when a header it was handed could not be appended — that fold would hand
  out the grouping licence because a header was malformed, merging two
  strangers.

  This function never returns `null`. A `null` on the envelope means the SDK
  did not look, which is the library path with no MCP transport at all; every
  caller here is inside a live MCP call.

  **Consumer consequence:** additive and optional, so nothing has to change. A
  collector with a closed envelope schema must accept the field before
  upgrading. The Python SDK emits the same field from 0.8.9, and additionally
  emits nothing at all where a tool is called programmatically.

- **Coordinates in `_meta` are rounded to 1 decimal before they reach
  `runtime_meta`.** Any `latitude` or `longitude` key (case-insensitive, exact,
  at any depth) holding a number or a plain decimal string is rounded in its
  own type; other values are left alone. So ChatGPT's `openai/userLocation`
  arrives at roughly 11 km instead of metres, with city, region, country and
  timezone kept. This runs after runtime detection and before your scrubber, so
  it applies with a custom scrubber too. Tool params and results are not
  touched: a tool of yours that takes or returns coordinates is captured at
  full precision. Mirrors Python's `round_meta_coordinates`, including the
  half-to-even tie rule, so the two SDKs store the same digits.

- **README thinned to the npm shape.** The page npm renders is now the short
  version, with the reference material on
  [goodtiming.ai/docs.html#typescript](https://goodtiming.ai/docs.html#typescript).
  Four claims the review caught are corrected, and the gap list gained the one
  that captures nothing: a 1.x task-based tool registered with an object at
  `.handler` emits no `tool_call_*` events and still advertises the intent
  parameters.

## 0.3.6: intent is asked for on every call, never enforced

- **`intentParamMode: "required"` now advertises `user_goal` as required, and
  is the default.** Until now it advertised exactly what `"optional"` did:
  zod cannot express "advertised required, not enforced" (in v4 the two are
  one bit), and this package had no `tools/list` hook to do it on the
  response the way Python does. It has one now. `withBaton` wraps the SDK's
  `tools/list` handler (on both `@modelcontextprotocol/sdk` 1.x and
  `@modelcontextprotocol/server` 2.x) and, for every wrapped tool whose
  `user_goal` Baton injected, appends `user_goal` to that tool's advertised
  `inputSchema.required`. Nothing else in the response changes, and the zod
  schema is never touched: a call that omits `user_goal` still passes
  validation, still runs your handler, and its `tool_call_start` simply
  carries no intent. A tool that declares its own `user_goal` is left alone.
  If the seam ever throws, the SDK's own `tools/list` result is served
  untouched and the failure is logged to stderr.

  Under `"required"`, `user_goal`'s description now leads with "REQUIRED."
  instead of "OPTIONAL.", as Python's does.

  ⚠ **The default changes from `"optional"` to `"required"`** (decided
  2026-09-15). Every agent is now asked for `user_goal` on every wrapped tool;
  none is refused for leaving it out. Set `intentParamMode: "optional"` to
  keep the previous advertisement. `seam_augmentations.intent_param.mode`
  reports `"required"` for installs that take the default, while the
  `surface_hash` is unchanged, because it is computed from your tools and
  never from Baton's additions. Python's default is still `"optional"`.

## 0.3.5: `user_id` is now `principal_id`

- ⚠ **BREAKING — the identity field and everything that configures it are
  renamed, with no aliases.** The value is unchanged: same derivation, same
  `v1:` tag, and every hashed value is byte-identical, because the field name
  was never part of the HMAC.

  | was | now |
  |---|---|
  | envelope `user_id` | `principal_id` |
  | `BatonConfig.resolveUser` | `resolvePrincipal` |
  | `BatonConfig.userIdMode` | `principalIdMode` |
  | `BatonConfig.userIdHmacKey` | `principalIdHmacKey` |
  | `BATON_USER_ID_HMAC_KEY` | `BATON_PRINCIPAL_ID_HMAC_KEY` |
  | `Principal.userId` | `Principal.principalId` |
  | `hashUserId` | `hashPrincipalId` |
  | `ResolveUserHook` / `UserResolutionContext` / `UserIdMode` | `ResolvePrincipalHook` / `PrincipalResolutionContext` / `PrincipalIdMode` |

  **Why.** The field was documented as "which person" and "which customer" at
  once. What a vendor can honestly resolve is often a service account or an
  organisation, and under the old name those looked like misuse.
  `principal_id` is whoever your resolver asserted, at whatever grain that is.
  It is not an agent-run key: one principal commonly covers several concurrent
  runs.

  **What you change.** Rename the config keys; an old key now throws when
  `withBaton` validates its config. Have your hook return `{ principalId }`;
  one still returning `{ userId }` resolves nobody, and the SDK warns once
  when it sees that. Rename the
  environment variable: the old one is **not read**, and when a
  `resolvePrincipal` hook has no key, the install warning names the old
  variable if it is still set, because hashed identity fails open and would
  otherwise just stop appearing.

  **If you run your own collector,** accept `principal_id` before upgrading
  producers, and keep accepting `user_id` as the same field until none remain.
  Python `baton-sdk` 0.8.6 makes the same change.

## 0.3.4: the agent is told your server's name, not its id

- **The annotation tool is named after your server.** `withBaton(server, { dsn })`
  registered `srv-c8eca135_annotate`, built from the DSN's server segment, an
  opaque id the console mints. It now registers `{slug}_annotate` from the name
  you gave `new McpServer({ name })`, so `toybox-pantry` registers
  `toybox-pantry_annotate`. The rule is Python 0.8.3's, unchanged: lowercased,
  anything outside `[a-z0-9-]` to a hyphen, hyphens collapsed and stripped,
  capped at 30. It falls back to `{vendorId}_annotate` for a name a library
  made up (`fastmcp`, `mcp-server`, `<ClassName>-<4 hex>`), one that slugs to
  nothing or cannot be read, and one that would push the server instructions
  over their 1500-char cap. `annotationToolName` still wins.

  ⚠ **This applies without a DSN too**, as it does in Python: a server built as
  `new McpServer({ name: "vendor" })` with `vendorId: "acme"` now registers
  `vendor_annotate`, not `acme_annotate`. Clients re-list tools on connect, so
  agents follow by themselves; it bites only where the old name was written
  into docs, a prompt or a script. Set `annotationToolName` to keep it.
  `surface_snapshot.seam_augmentations.injected_tools` carries the new name
  too, so match that list by the `_annotate` suffix, never by an exact name.

- **The instructions and the tool description name your server, not the DSN
  segment.** With a `dsn` and no `vendorDisplayName`, the display name is now
  your server's name VERBATIM (not slugged: you chose it, and it reaches your
  users), under the same guards, falling back to the DSN segment where they
  apply. An explicit `vendorDisplayName` still wins, and with no `dsn` it is
  still required. The Python SDK takes the same rule in a parallel change, so
  the two implement one rule.

- **The agent-facing wording is Python's default text.** The instructions said
  the server was "wrapped in the ... support-signal SDK" and asked for an
  annotation before every tool call. They now carry Python's
  `proactive_mode="off"` text byte for byte: a "usage and friction SDK", a
  head asking for a report when a call goes wrong or a needed tool does not
  exist, and no pre-call request, because the injected
  `user_goal`/`expected_result`/`overall_task` params already carry intent on
  every call. The annotation tool description follows. Both are compared
  against Python 0.8.4's own rendering (`test/integrations/mcp/llmTextVectors.json`).
  ⚠ With `intentParamMode: "off"`, nothing now asks the agent for intent.
  Python refuses that combination; this arm has no proactive mode to refuse
  it against.

- One resolved tool name reaches every consumer. The registration used to
  re-derive its own from `(vendorId, override)`, which with the server as an
  input would have registered `srv-..._annotate` while the instructions named
  the server-derived tool.

## 0.3.3 — `user_id` has a producer on this arm

- **`BatonConfig.resolveUser` — the vendor identity hook, and the first thing
  on this SDK able to populate `user_id` at all.** The field has been on the
  envelope since 0.3.0 and was null by construction on every TypeScript event,
  so a Console partition by end-user worked for Python-sourced traffic and
  silently did not for TypeScript-sourced traffic. Supply a function returning
  `{ userId, issuer? }` and it runs on every captured tool call and on the
  annotation tool.

  `userIdMode` selects `"hashed"` (default, a `v1:`-tagged per-tenant HMAC
  pseudonym) or `"raw"` (the subject verbatim). `userIdHmacKey` resolves
  explicit → `BATON_USER_ID_HMAC_KEY` → unset. ⚠ **With no key, hashed mode
  DROPS the field rather than falling back to raw** — the fallback would be a
  residency breach that looks like success.

  **Hashes are byte-identical to Python's**, which is asserted rather than
  claimed: `test/identityVectors.json` is GENERATED from
  `baton.identity.hash_user_id` and compared string-for-string. That corpus
  earned its keep immediately — JavaScript's `.trim()` strips `U+FEFF` and
  Python's `.strip()` does not, so a BOM-prefixed subject would have hashed to
  two different actors across the two SDKs. The canonicalizer strips Python's
  whitespace set exactly, measured against CPython rather than assumed.

- **Headers reach the hook as ONE shape on both SDK majors.** The peers
  disagree twice over: `@modelcontextprotocol/sdk` 1.x puts them at
  `extra.requestInfo.headers` as a plain object whose value is a **string or
  an array** when a header repeats, while `@modelcontextprotocol/server` v2
  puts them at `http.req.headers` as a Web `Headers`. Left alone,
  `headers["X-Forwarded-User"]` would return text on one major, an array on a
  repeat, and `undefined` on the other, with nothing to warn the vendor —
  which is the bug the Python SDK shipped and fixed as register A8. Here it is
  absorbed before shipping: the hook always receives a Web `Headers`, so
  lookups fold case and repeated values join by the platform's own rule.

  `context.headers` is `null` when **no HTTP request is in flight** — every
  stdio call, the common case. That is us saying the question does not apply,
  never a claim that the client sent no headers.

- **No attested (`h1:`) rung on this arm, stated as a gap.** Python also reads
  a principal off a verified access token's `claims["sub"]`. TypeScript's
  `AuthInfo` has no `claims` field at all, so the nearest carrier is the
  untyped `extra` bag and no specification says a subject lives there. Reading
  it would mean guessing, vendor by vendor, and a wrong guess is how two
  people become one actor.

- **`hashUserId`'s `scheme` is REQUIRED here, where Python defaults it.** That
  arm emits both provenances so an `h1:` default is right there; this arm emits
  only `v1:`. A vendor following the export's own rationale — recompute the
  pseudonym to join your records against Console data — would take the default,
  get `h1:`, and have an equality join return zero rows forever. The hex halves
  are identical under both tags, so it fails in the most confusing way
  available. Naming the provenance is one word.

- **A subject containing an unpaired surrogate is a MISS, not a hash.** Node
  substitutes U+FFFD rather than throwing, so `"a\uD800"`, `"a\uDC00"` and
  `"a\uFFFD"` all produced ONE digest — distinct people merged into one actor,
  which is the failure this field exists to prevent. Python raises and drops
  the field, so refusing keeps the two arms agreeing. Raw mode is capped at 128
  characters, matching Python's `RAW_USER_ID_MAX_LEN`.

- **It says so when it cannot work.** Configuring `resolveUser` in hashed mode
  with no key drops `user_id` from every event — correct, and previously
  silent, with no string anywhere in the process to grep for. One
  `process.emitWarning` at install now names the state and the fix. It never
  contains the principal: identity was configured and produced nothing, and
  printing the value to explain that would put raw end-user identity in the
  vendor's log files.

- ⚠ **The hook is awaited INLINE with no timeout**, matching this SDK's
  existing `resolveSessionId` convention and diverging from Python, which runs
  vendor hooks off the event loop under a 5-second budget. A hook that blocks
  stalls its own request. Recorded rather than half-built.

---

## 0.3.2 — a key in the host slot is refused; a short workspace id parses

- **SECURITY: a DSN with the key and the host transposed no longer parses.**
  `https://x@<key>/ten_.../srv` splits on the last `@`, so the key landed in
  the authority — and any userinfo at all, one character, kept it out of the
  no-`@` branch that has the sentence for this. Nothing downstream objected:
  the segments validated, `origin` became `https://baton_pk_...`, and
  `HttpSink` appended `/v0/events` and handed that to `fetch` **as a hostname**
  — putting the publishable key in a DNS query and a TLS SNI field on every
  send, to every resolver in path. The one-character userinfo silently became
  the bearer, so nothing authenticated either.

  `parseDsn` now refuses it, naming the mistake ("has the KEY where the host
  belongs"), without repeating the credential.

  **Python was never affected** — `baton` has had this refusal since its own
  review found it (`_dsn.py:395`). This was a port gap: the two parsers are
  kept character-for-character precisely so a DSN that works in one fails in
  the other, and they had diverged on the single input where the difference is
  a leak. **Nothing to do on upgrade** unless you hold such a DSN, which never
  delivered an event.

- **A DSN's workspace segment may now carry 8 hex characters as well as 32.**
  `parseDsn` accepted `ten_` + exactly 32 hex; the Console's `new_tenant_id`
  moved to 8 hex on 2026-09-12, so a DSN the Console hands out today was
  refused at install by every shipped SDK — TypeScript 0.3.1 and Python 0.8.2
  alike. Python widens `_WORKSPACE_PATTERN` in the same change; the two parsers
  answering one question differently is how a DSN that works in Python fails
  in TypeScript.

  Both lengths are accepted rather than the new one alone: a DSN ships inline
  in a distributable server's source, so refusing the old length would break
  installs already running on an upgrade that is supposed to be safe.

  **Nothing to do on upgrade.** Existing `ten_<32 hex>` DSNs are unaffected —
  this widens what is accepted and narrows nothing. Only the packed DSN path
  was ever length-checked; an explicitly configured `tenantId` was not, and
  still is not.

- **REMOVED: `BatonConfig.resolveSessionId`, with the `SessionResolutionContext`
  and `ResolveSessionIdHook` types.** Python removes its
  `VendorConfig.resolve_session_id` (SPEC §3.4 rung 0) in the same change; this
  is that removal on both arms, not a port lagging behind it.

  **Why:** the rung keyed the session on an identifier the SDK did not mint,
  which is what retired the `_meta` rungs on the Python side. A vendor's handle
  differs from a client's only in who supplied it, and the join rule does not
  draw that line — the SDK mints `call_id` and keys on that, while everything
  else is emitted as data and grouped downstream, where the choice can be
  revised and re-run against stored events.

  **Nothing changes on the wire.** `session_id` still resolves from the
  transport's `extra.sessionId`, then the process-wide install-time fallback.
  Passing `resolveSessionId` is now a type error at compile time; at runtime an
  extra property is ignored, so a JavaScript consumer gets silence rather than
  a throw. No deployment's `session_id` changes value: the hook shipped with
  zero callers, verified across all eight repos and the website at removal.

  ⚠ **The types go here and stay in Python.** `SessionResolutionContext` is
  still public in `baton` (Python) because `resolve_user` takes it; this SDK
  has no identity hook yet, so nothing consumed either type once the session
  hook went. **`user_id` is on the TS envelope and remains null by
  construction** — the replacement mechanism Python points vendors at does not
  exist here. That gap is tracked on sdk-hardening and is the reason this
  removal is strictly a subtraction on this arm.

  ⚠ **A second breaking config removal on a patch-shaped change**, the same
  pre-1.0 deviation as `defaultAgentRuntime` below, recorded rather than taken
  quietly.

  **The suite could not see this removal, and that is itself the finding.**
  290 tests before, 290 after: `resolveSessionId` had no coverage at all here,
  and deleting the surviving `extra.sessionId` rung outright also passed all
  290. `test/integrations/mcp/sessionResolution.test.ts` is new and covers the
  residue — both rungs, the empty-string and non-string guards — verified by
  two mutants that each red it.

- **`agent_runtime` answers for every client, not just Claude Code.**
  Detection was a single `claudecode/*` key-prefix scan — the pre-B1-R order
  with the top two tiers missing — so Claude Desktop, Cursor, and anything
  behind a gateway that strips `_meta` all reported `unknown`. It is now
  Python's 4-tier ladder: the client's declaration on the request, then its
  declaration on the `initialize` handshake, then the heuristic, then
  `unknown`. **Declared before inferred**: `claudecode/toolUseId` is a
  per-call tool-use id, and a proxy forwards `_meta` verbatim, so its prefix
  says where the metadata ORIGINATED, not who the caller is.

  Client-supplied names (the two declared tiers) are scrubbed and capped at
  128 characters; a scrubber that redacts one loses that tier and falls
  through rather than shipping a stringified redaction. The heuristic's own
  answer is an SDK constant and is neither scrubbed nor capped.

  ⚠ **`agent_runtime` values will CHANGE for existing servers** — that is the
  point of the release, but it is a data change and not only a code one. A
  client that was `unknown` now reports the name it declares; a Claude Code
  client that was `claude-code` by heuristic now reports whatever it declares
  in `clientInfo`, which for a direct connection is `claude-code` and behind a
  gateway is the gateway. Any saved query grouping on `agent_runtime` spans
  both populations across the upgrade. No wire-format change: the field, its
  type and its nullability are unchanged.

- **REMOVED: `BatonConfig.defaultAgentRuntime`.** A vendor set it once at
  install, for every connection, so it could only ever be right in a
  single-client deployment — and with the declared tiers in place it would
  assert a runtime over a client that had just named itself. Python removed
  its `default_agent_runtime` counterpart on 2026-09-09; this is that removal,
  not a port of the old behaviour. When no tier answers, the event reports the
  literal `unknown`.

  ⚠ **A breaking removal on a patch-shaped change, deliberately.** Pre-1.0
  policy says breakage rides a minor bump; the deviation is recorded here
  rather than taken quietly, and its consequence is that a `~0.3.0` /
  `>=0.3.0` range auto-adopts it where a minor would have required a move.
  Same call, and the same reasoning, as 0.8.1 on the Python side. TypeScript
  refuses the key at compile time; a JavaScript consumer carrying it across
  the upgrade finds it inert rather than honoured, which is pinned by a test.

- **`call_id` on the event envelope.** The per-call correlation key Python has
  minted since 0.7.x, absent here entirely: TS servers paired their
  `tool_call_start` and `tool_call_end` on session plus arrival order — the
  FIFO floor the mint exists to leave — and SPEC §11.5.4's tier 1, which keys
  on `(call_id, tool_name)`, was unreachable from every one of them. Minted as
  a UUIDv7 per tool call and carried on both legs.

  Null on `annotation` and `surface_snapshot`, which SPEC defines no `call_id`
  for. **Additive and nullable**, so a consumer that does not read it is
  unaffected — but the console's pairing improves only for events emitted by
  this release or later, and null on an older event is never an error.

## 0.3.1 — 2026-09-11

- **A server can be configured by ONE string.** `withBaton(server, { dsn })` is
  now the whole wrap block, replacing five `BATON_*` values with the packed
  connection string from `/account`. This is not ergonomics: a **stdio** server
  runs on every user's machine, so values that live in an operator's `.env`
  are values that never arrive, and the TypeScript arm writing five of them
  left that defect live for every TypeScript server. Port of Python's
  `baton/_dsn.py` and `integrations/_config.py::resolve_config` — S1-S3 of the
  publishable-key lane. `BatonConfig` gains `dsn`; `vendorId`,
  `vendorDisplayName` and `consentToken` become optional because the string
  supplies the first two and `DEFAULT_CONSENT_TOKEN` the third. **Public type
  change, no wire change**: the envelope is untouched, so no consumer deploy is
  implied.

  **Everything a DSN supplies lands at the EXPLICIT tier, above the
  environment.** The shape it exists for is a RE-onboarded server whose old
  `.env` sits beside the new inline value; if these fell through to
  `BATON_TENANT_ID` the way an unset field does, the stale file would win
  silently and the events would arrive under the previous server's name.
  Asserted on the POSTed envelope, not the config object — a resolver that
  computes the right values and a sink that never carries them are the same
  outcome for the customer.

  **Three deliberate divergences from Python, each measured rather than
  argued.** (1) The DSN is split by hand rather than by `new URL`: WHATWG
  percent-encodes userinfo, so `new URL("https://a@b@host/x/y").username` is
  `"a%40b"` — an ALTERED key, which the collector hashes whole and matches to
  no row — and `decodeURIComponent` cannot undo it, because the tail is
  deliberately unvalidated and a literal `%` in one is legal. `new URL` is kept
  as the HOST validator only, after the credential is split off, since Node's
  `ERR_INVALID_URL` carries the string it was handed on `error.input`. (2) An
  explicitly empty `dsn` is treated as unset rather than as supplied — the
  rule this package already applies to `BATON_TENANT_ID` and to `BATON_DSN`
  itself — because `dsn: process.env.MY_DSN ?? ""` otherwise kills the install
  naming a value the vendor never filled. Python uses `is not None` and still
  has that behaviour. (3) No `BATON_CONSENT_TOKEN` is read: Python resolves
  that variable on its `Client` door, while `VendorConfig` — the door this
  package mirrors — takes a plain default, so reading it here would honour a
  variable the equivalent Python door ignores. Pinned by a test that exports it
  and asserts it loses, because the obvious future "fix" is to add the read.

- **The SDK no longer prints a credential it was handed.** Four leaks, three of
  them ported in from the Python original and fixed here first, all reproduced
  before being touched:
  a key in the AUTHORITY slot (`https://baton_pk_…` — the RETRY the bare-key
  refusal steers people into, since it says "copy the full value, which starts
  with `https://`"); a key GLUED to a path segment (`srv-baton_pk_…`, which
  always exceeds the 48-character ceiling and so always reached the raw
  interpolation); the parsed DSN printing its own bearer under `console.log`,
  `util.inspect` and any structured logger's `JSON.stringify`; and `HttpSink`
  doing the same, which matters now in a way it did not before — the SDK builds
  that sink from a key the vendor never handles and hangs it off
  `BatonHandle.sink`.

  The redaction is one scan of the finished string at the single throw site,
  rather than a list of slots that each remember to elide, because "a slot
  added later forgets" was the shape of all three. The scan has a floor on the
  tail (8+ key-alphabet characters) so it can run over finished sentences
  without eating this module's own `https://baton_pk_...@host/…` example.
  ⚠ That sweep and the key-in-slot refusal cover the glued case JOINTLY and
  neither is load-bearing alone — measured: removing either reds no test,
  removing both reds three. Written into the source, because a reader who
  deletes one of them sees green and concludes it was dead.

- **Three ways a DSN could fail silently AFTER a clean install**, which is the
  one thing the parser exists to prevent. A backslash is folded to `/` by
  WHATWG for special schemes, so `host\evil` passed as a host with a path while
  the split kept it whole as the authority — `HttpSink` appended `/v0/events`
  and `fetch` resolved it to `host/evil/v0/events`. Whitespace and control
  characters are REMOVED rather than folded, so `ingest.example.com` plus a
  stray space parsed clean with `pathname` still `/`, and the character then
  landed mid-string once `/v0/events` was appended, making `fetch` throw on
  every send into `HttpSink`'s bare catch: retried, dropped, forever. And a
  line break inside the KEY built an `Authorization` header that `Headers`
  refuses, failing the same silent way — the key is the longest part of a DSN,
  so it is where a wrap most likely lands.

  ⚠ **The first fix for the second case listed `\t`, `\n`, `\r` and called the
  set CLOSED — measured in ONE POSITION and generalised.** WHATWG strips those
  three anywhere, and leading/trailing C0 controls and the space as well, so
  the guard missed exactly the likeliest input. The rule is now a character
  class over the whole authority, and it is `baton`'s `_NOT_IN_A_HOST`
  character for character rather than a second guess at the same question: two
  parsers answering one question differently is how a DSN that works in Python
  fails in TypeScript. The key's class is narrower and measured too — `Headers`
  rejects exactly NUL, LF and CR — because the tail's alphabet belongs to the
  console's mint, and a parser stricter than the mint refuses valid keys in the
  field.

- **An explicitly emptied `vendorDisplayName` is refused rather than replaced
  by the server slug.** With no dsn that input is rejected by validation,
  citing the SPEC §5.4 whitelabel obligation; with one, `||` quietly
  substituted. One input, two answers, decided by whether a dsn happens to be
  present — and this string reaches the calling agent in the server
  instructions and the annotation tool description, so the quiet substitution
  was the worse half. ⚠ Python uses `or` here and still has the
  inconsistency.

- **REMOVED, not shipped:** the first backslash fix asserted on what the URL
  parser MADE of the authority (`pathname === "/"`, no search, no hash). The
  character class above is the better answer to the same question, which left
  that assertion unreachable by any input — shown by mutation, where deleting
  it reddened nothing. Deleted rather than kept as a backstop: two rules
  answering for one input is what the class exists to stop being.

- `test/setup.ts` clears `BATON_DSN` and `BATON_DISABLED` alongside
  `BATON_TENANT_ID`. An ambient DSN does not merely change a tenant id: it
  replaces the vendor id, the tenant id and the SINK, so a developer with one
  exported for a real server would have this suite POST its fixtures at a live
  collector. And every capture assertion in the suite passes VACUOUSLY while
  the off switch is on — green, and testing nothing — which is the shape that
  cost the Python repo 203 failing tests for one contributor's globally
  exported variable.

## 0.3.0 — 2026-09-11

- **A caller can no longer assert its own runtime.** `detectAgentRuntime` honoured an `_meta.baton.agent_runtime` override, and the Python SDK it mirrors removed that override in both its spellings — the nested form at B5, the reverse-DNS `io.baton/*` form on 2026-09-09, leaving SPEC §5.2 reading "Recognized keys: none". This package kept reading the nested one, so **two sensors watching the same client could disagree about what it is**, which is the one thing a detector shared across sensors must not do. `agent_runtime` is self-reported and never attested; an override lets the thing being measured choose its own label.

  ⚠ **Nothing ever sent either form**, so deleting the branch reddened no test and could not have — the dead code and the coverage gap were one fact. That is why the removal ships with `test/integrations/mcp/runtimeAdapter.test.ts` rather than as a deletion on its own: an absence nothing asserts is one edit from coming back. It mirrors Python's `test_no_client_override_is_honoured_in_any_form` case for case, covers the reverse-DNS spelling this package never read (a forward guard, so the two sensors cannot diverge again from the other side), and pins that an override cannot *suppress* the `claudecode/` heuristic either. Verified by restoring the branch: the nested-form case and the suppression case both red.

  The module's donor citation pointed at `baton/integrations/fastmcp/runtime_adapter.py`, a path that stopped existing at the adapter rename; it now names `integrations/runtime_adapter.py`. The `SPEC §5.2` reference is kept and was re-read rather than assumed — the per-runtime `_meta` table it cites is still there; only the override paragraph died.

## 0.2.0 — 2026-09-08

- **`tenant_id` is the ACCOUNT, and no longer a second copy of `vendor_id`.** Every envelope this package emitted set `tenant_id: config.vendorId` — `withBaton.ts:642` on the surface snapshot, `ctx.tenantId` on both tool-call legs, and the annotation tool inheriting the same value — so one account's several servers collapsed into one: two servers in a workspace render as a single row whose label flips to whichever deployed last, and a server ends up naming itself with its workspace's opaque id. `config.ts`'s comment documented the copy as intentional ("mirrors Python's `install_baton` setting `tenant_id=config.vendor_id`"), so that comment is part of the change rather than a bystander. New optional `BatonConfig.tenantId`, resolved **explicit → `BATON_TENANT_ID` → `vendorId`** by `resolveTenantId`, a port of Python's `integrations/_config.py::_resolve_tenant_id` (baton `aea84a8`) — falsy-means-unset included, so an empty string falls through rather than shipping a blank tenant, which the wire schema would happily accept. **Resolved once per install** and shared by all three emit paths: two resolutions could disagree, and an annotation landing under a different tenant than the call it annotates is unjoinable. The `vendorId` tail is a migration shim for our own fixtures mid-change, not a supported configuration — it reproduces exactly the collapse the split exists to end — and is pinned by its own test so deleting it is a decision rather than an accident. **No wire-shape change**: both fields already exist on the envelope (SPEC §11.4), so no consumer deploy is implied. **One deliberate divergence from Python**: the environment read is guarded by `typeof process !== "undefined"`, because this package otherwise reads no environment at all and is expected to load on edge/worker runtimes where `process` is absent — a missing `process` is a miss, not a crash inside the vendor's server startup. Six tests, and the assertions are per-event rather than on a sample, because `emitSurface` builds its envelope from `config` directly while the wrapper reads `ctx`: a fix applied to only one leaves the snapshot under the old tenant in the same session as calls under the new one. Mutation-verified five ways — reverting the snapshot site reddens 5, reverting the `ctx` site reddens 5, `if (explicit)` → `!== undefined` reddens exactly the empty-string test, dropping the env read reddens 3, and resolving at emit time instead of install time reddens the case written for it. That last test is the one worth describing, because its first version asserted nothing: holding the environment constant across a session and checking that one tenant appears stays green under a regression that re-resolves per event, since it re-reads the same value. It now changes `BATON_TENANT_ID` mid-session, between the tool call and the annotate call, and asserts the install-time value on both.
- **Test runs no longer depend on the developer's environment** (`test/setup.ts`, wired via `vitest.config.ts`). Reading `BATON_TENANT_ID` made suites that have nothing to do with tenancy env-sensitive: `BATON_TENANT_ID=ten_x npm test` reddened 6 — `withBaton.test.ts`'s `tenant_id === "acme"` and all five `emitterConformance` vectors, which match the Python run only because both sides take the `vendorId` fallback. Cleared centrally rather than per suite. **Cleared twice, and the module-scope clear is the load-bearing half:** setup files run before a file's hooks, but `beforeEach` does not run before `beforeAll`, and `emitterConformance` builds every envelope it compares inside a `beforeAll` — with only the hook that suite stayed red. Verified by running the full suite both with the variable set and unset; 134 pass either way.

## 0.1.0 — 2026-09-02

- **`intentParamMode: "required"` no longer refuses the vendor's own calls — and cannot advertise either, which is a fact about zod rather than a choice.** It built a non-optional zod field on the **vendor's own schema**, so an agent that omitted `user_goal` had its call rejected by the vendor's server: Baton breaking a customer's product to collect a telemetry string. Python appends the name to a tool's *advertised* `required` list, validates nothing, and strips the param before forwarding, so the omitting call is served — `required` means **advertised-as-required, never enforced**, and this package moves to match (baton-internal `intent_param_injection.md` §D7, 2026-09-01; SPEC §13 2026-09-01). **The advertisement half is unreachable here.** Measured across both supported zod majors: v4 `.optional()` advertises nothing and parses a missing key, v4 `union([string, undefined])` advertises `user_goal` required and *rejects* the missing key, v3 `.optional()` parses and advertises nothing, v3 `union([string, undefined])` parses and still advertises nothing. In v4 the two properties are one bit; in v3 the advertisement does not exist. Python holds them apart only because it rewrites the rendered JSON Schema of a `tools/list` **response**, and this package has no `tools/list` hook — so `required` and `optional` now produce identical schemas and identical behaviour. **Breaking for anyone relying on the rejection**, which was never a documented guarantee and is the behaviour being removed on purpose. The `mode` parameter is **removed from `injectGoalParams` and `injectGoalParamsV2`** rather than left ignored: a parameter that selects nothing reads as a knob. `BatonConfig.intentParamMode` is unchanged — it still gates `"off"` in `withBaton` and is still reported in `seam_augmentations.intent_param.mode`. Pinned in `emitterConformance.test.ts` as X-2, the producer-parity check, because the spec vectors carry no intent-bearing call and are structurally blind to this: one assertion that the omitting call is served and captured with `call_intent: null` (stated as the semantic, fail-open, so it survives any future advertising mechanism), one that the advertised schema is identical under both modes (so the divergence stays known). Mutation-verified: restoring the enforcing field fails both.

- **Code-review pass on the dual-major work — four defects, each reproduced with a live round trip before it was touched.** None invalidated the port; three were silent-degradation shapes of the same family the port itself exists to eliminate.
  - **Injection no longer discards the vendor's own object semantics (v2).** `injectGoalParamsV2` rebuilt the schema as `zV4.object({ ...shape, ...injected })`, which recovers the field map and nothing else. Measured: a tool declared `z.object({a,b}).refine(v => v.a !== v.b)` accepted `{a:"x", b:"x"}` and the vendor's handler received arguments its own schema rejects, with no error anywhere; a `z.strictObject` silently stripped unknown keys instead of refusing them. Installing Baton must not weaken a vendor's validation. Now `vendorSchema.extend(injected)`, which keeps checks and `additionalProperties` — the violating call is rejected at the protocol layer, exactly as on the unwrapped tool — and still advertises the intent params on `tools/list` (verified over the wire, since an unrenderable schema would have poisoned the whole list the way a zod v3 schema does). A schema with no `.extend` — every non-zod `StandardSchemaWithJSON` — now **skips injection** rather than falling back to a rebuild, because the rebuild is the loss. Consequence worth knowing, documented: the vendor's refinements now run over arguments that still include `user_goal`/`expected_result`/`overall_task`, since v2 validates before dispatch and the strip happens in our wrapper after. The 1.x path has the same rebuild gap, already documented on `injectGoalParams`, and is unchanged.
  - **`disable()` left a phantom tool in `surface_snapshot`.** It is `update({enabled:false})` on both majors, so it reaches the same patched `update` that removal does — and the patch branched on `name` and `paramsSchema` but not `enabled`, though the module comment claimed otherwise. Measured: `tools/list` returned `['keep','acme_annotate']` while the snapshot still listed `['echo','keep']`. `SurfaceState` now tracks a per-tool `disabled` flag and filters at snapshot build, rather than pruning — re-enabling then costs nothing and, crucially, needs no re-capture, which would re-read Baton's own injected schema as if it were vendor-true.
  - **Two `$schema` spellings could appear in one snapshot.** v2's `toolInputSchemaJson` returns `undefined` for a *disabled* tool, so one captured while disabled fell through to the 1.x converter: measured `"http://json-schema.org/draft-07/schema#"` for that tool beside `"https://json-schema.org/draft/2020-12/schema"` for its sibling, breaking the "converts the way THIS server renders `tools/list`" guarantee. The v2 path now falls back to the schema's own `~standard.jsonSchema.input({target:"draft-2020-12"})` — verified canonically equal to the wire output — and the final `catch` returns `{type:"object",properties:{}}`, both majors' empty-schema constant, instead of a third `{}` spelling.
  - **The packaging guard could not see the regression it exists to catch.** Its regex was line-anchored, so a multi-line `import type {\n  X,\n} from "@modelcontextprotocol/…"` — the house style in this repo — matched on no single line. Now matched over whole-file text with a `;` guard that stops a match crossing statements and a line anchor that still skips JSDoc examples. Mutation-tested: adding exactly that import turns it red, removing it turns it green.
  - Re-verified after the fixes, since source changed: `npm run ci` green at 122 tests, `npm pack` installed into a v2-only tree and a 1.x-only tree with a real round trip and `tsc --noEmit` in each, and the 1.x `surface_snapshot` hash still byte-identical to `HEAD`.

- **Both SDK majors are now OPTIONAL peerDependencies, and neither is imported — at runtime or as a type.** Previously `@modelcontextprotocol/sdk ^1.30.0` was a required peer and `schemaCompat.ts` *runtime*-imported its `server/zod-compat.js`, so a vendor building on the v2 packages could not install this package at all: their `node` would fail on a module they have no reason to have, and (separately) their `tsc` would fail on `dist/index.d.ts`'s line-2 `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"`, which tsup's declaration rollup hoisted out of a type-only import. Now: `peerDependenciesMeta` marks both optional — which matters mechanically, since npm 7+ auto-installs a non-optional peer and would have pulled 1.x into every v2-only tree, masking the very breakage this removes — and `src/` contains no import specifier for either package. `withBaton` takes the exported structural `SupportedMcpServer` that both majors' nominally distinct `McpServer` classes satisfy; `Extra` is declared locally (three fields, all of them things we read). Verified the only way that means anything: `npm pack`, then install the tarball into a tree carrying **only** v2 and one carrying **only** 1.x, and in each run a real `tools/list` + `tools/call` round trip *and* `tsc --noEmit` a consumer file. Both green, `@modelcontextprotocol/sdk` genuinely absent from the v2 tree. A committed `test/packaging.test.ts` keeps it true, because the way this regresses is one convenient `import type` with every other test still passing.
  - **1.x's zod v3/v4 bridge is vendored into `src/integrations/mcp/zodCompat.ts` rather than imported.** ~90 lines: `isZ4Schema`, `objectFromShape`, `getObjectShape`, `normalizeObjectSchema`, `toJsonSchemaCompat`. The alternatives were worse — an `async import()` behind a synchronous `withBaton`, or a `createRequire` shim that has to survive a dual ESM/CJS build — and the copy deletes a reach-in this module used to document as a swap point. Ported faithfully, warts included: `objectFromShape` still returns `zod/v4-mini` objects, because 1.x renders and validates through those same Mini shapes and "improving" it would change 1.x output, not preserve it (the v2 path avoids them via `injectGoalParamsV2`). One deliberate divergence, pinned by test: 1.x's `isZ4Schema` reads `s._zod` unguarded and throws on nullish input; the port keeps an optional chain rather than copy a crash into a module whose callers would be the ones to hit it. `zod-to-json-schema@^3.25.2` — 1.x's own pin — becomes a direct dependency, for the zod-v3 conversion branch.
  - **The copy is held by differential test, not by inspection** (`test/integrations/mcp/zodCompat.test.ts`, 8 tests): every ported function diffed against 1.x's original over a shared corpus — v3 and v4 object schemas, described/optional/union/enum/nested/empty, raw shapes, non-schemas, the mixed-major throw, and a schema carrying Baton's own injected params. Same discipline as the scrub parity test; 1.x stays a devDependency for exactly this. End-to-end proof that 1.x behaviour is unchanged: the `surface_snapshot` hash for a fixed 1.x server is **byte-identical between `HEAD` and this tree** (`sha256:638f1f21…`), rendered tools JSON included — which is the guarantee that matters, since that hash is what a pinned recipe compares against.
  - Residual worth knowing: the vendored converter resolves `zod` from *our* dependency tree while 1.x's own `tools/list` resolves it from *its* tree. Deduped in any normal install, divergent only where a vendor carries two zod v4 copies — the same class of risk 1.x already runs internally.

- **Interception ported to `entry.executor`, because on the official SDK's v2 packages the 1.x handler patch is a silent no-op.** v2 (`@modelcontextprotocol/server@2.0.0`) dispatches tool calls through `RegisteredTool.executor`, a closure built at registration over the handler (`createToolExecutor(inputSchema, handler)`; `executeToolHandler` is `return tool.executor(args, ctx)`). Replacing `entry.handler` there leaves that closure holding the vendor's original function, so the vendor handler runs, `withBaton`'s wrapper never fires, and the server emits **zero events with no error** — indistinguishable from a server nobody used. Worse than a clean break, because the schema half kept working: such an install would advertise the injected intent params, collect a goal from the agent, and capture none of it. `wrapIfNeeded` now detects `typeof entry.executor === "function"` and wraps the executor by capture-and-delegate (never both, or `update({callback})`'s executor regeneration double-wraps). Measured with a real `Client`/`McpServer` round-trip; new `test/integrations/mcp/withBatonV2.test.ts` (10 tests) fails with `expected [] to deeply equal [...]` against the old code. 1.x behaviour is unchanged — v2 is a devDependency only, the peerDependency stays `^1.30.0` until the imports are re-pointed.
  - **Four more v2 divergences the same port had to close, all of the silent kind.** (1) `_meta` moved to `ctx.mcpReq._meta` — v2's `ServerContext` is `{sessionId, mcpReq, http}` — so reading only the 1.x top-level location would have degraded every v2 session to `agent_runtime: "unknown"` with no `runtime_meta`; `mcpTypes.extraMeta` now reads either. (2) `_toolInputSchemaJson` is memoised at registration and a direct `inputSchema` assignment leaves it stale forever — `tools/list` re-converts per request so it looks fine, but that memo is what the HTTP entry's SEP-2243 `Mcp-Param-*` **pre-dispatch** validation reads, which would have made injected params work over stdio and vanish over `createMcpHandler` HTTP; the injection now busts it. (3) `remove()` is `update({name: null})` and `disable()`/`enable()` are `update({enabled})`, all routed through the entry's `update` property, so the update patch branches instead of looking only for `paramsSchema` — otherwise a v2 removal leaves the phantom tool in the surface snapshot that the `.remove()` patch exists to prevent. (4) `update({name})` renames in place, keeping the same entry object *and* the same wrapper: the surface snapshot, the param registry and the wrapper's own `tool_name` now all follow the rename (the wrapper reads a live name box rather than capturing the string). That closes the "rename isn't reconciled" gap this module used to document for 1.x as well.
  - **`schemaCompat.ts` is not used on the v2 path, and using it there was actively wrong.** v2 refuses zod v3 outright — a v3 schema registers silently and then throws inside the `tools/list` handler, failing the *entire* list and every other tool with it — so the v3/v4 bridge has no mixed-major case to solve. `injectGoalParamsV2` builds the merged object with plain `zod` v4 instead: 1.x's `objectFromShape` returns a `ZodMiniObject`, which carries no `~standard.jsonSchema`, so v2 fell back to `z.toJSONSchema()` and printed "Your zod version does not implement `~standard.jsonSchema`" to the **vendor's** stderr on every `tools/list` — our noise, blamed on their zod version (measured against zod 4.4.3, which does implement it). Both majors share one `buildIntentFields` so the two paths cannot drift on which params exist or when a vendor's own field of that name wins. Stated limit: v2's primary `registerTool` overload takes any `StandardSchemaWithJSON` (ArkType, Valibot, hand-rolled) and the `ZodRawShape` overload is `@deprecated`; a non-zod schema has no `.shape` to splice, so those tools are wrapped and emit `tool_call_*` but carry no injected params.
  - The surface snapshot now converts each tool's schema the way *that* server renders `tools/list` — v2's own memo (draft-2020-12, `$schema` included) where available, 1.x's `toJsonSchemaCompat` otherwise — keeping `surface.ts`'s byte-for-byte promise true on both, and failing closed to `{}` rather than throwing inside the vendor's `registerTool` call.
  - `withBaton` now takes a structural `SupportedMcpServer` (`{server, registerTool}`) that both majors' nominally distinct `McpServer` classes satisfy, and the reach-ins are declared on one named `internals` shape instead of per-site `any` casts — which let the module-wide `no-explicit-any`/`no-unsafe-member-access` eslint suppression go, so an upstream rename now lands as a compile error.

- **`overall_task` → `call_workflow` + per-call `call_expected` (0.6.0 wire parity), and the stale-submodule bug that hid the gap.** `baton-spec` was pinned at the initial schema commit; Python had since shipped `d5e25ea` adding `call_expected`/`call_workflow` to `tool_call_start`. Both conformance levels were therefore passing against a superseded contract — the same shape as the 2026-08-10 A5 incident (proving which build you ran, not which spec you targeted). Bumping the submodule failed three tests and exposed the real gap: `withBaton` injected only `user_goal`/`expected_result`, so a TS-sourced session emitted no `call_workflow` at all — the exact-string task-label key the Console's rung 3b segments sessions on. A TS-instrumented server would have produced sessions the Console could not split into tasks. Now ported: `overall_task` is injected as a third param (optional regardless of `intentParamMode`, matching Python — only `user_goal` is promoted to required), stripped before the vendor handler, and emitted as `call_workflow`, with `call_expected` alongside it; `seam_augmentations.intent_param.names` carries all three. The param description is a byte-for-byte port of Python's, including its repeat-the-exact-string stability contract — verified by diffing both implementations' rendered output, not by eye.
- **`workflow` is now scrubbed in the annotation path.** It was passed through raw while every sibling field (`intent`, `expected_outcome`, `suggested_improvement`, `context`) was scrubbed — invisible while the default was identity, a real hole once scrubbing defaults on, since `workflow` is agent-authored free text. Python's `annotation.py` has the same gap; fixed here and flagged for the sibling rather than mirrored. Not a wire divergence (scrubbing changes content, not shape) and it's deterministic, so the exact-string continuity the grouping key needs survives — covered by a test that asserts a scrubbed label stays identical across calls.
- **PII scrubbing, on by default.** `src/scrub.ts` ports Python's `baton.scrub` rule-for-rule (email, `Bearer` values, `sk-*`, `AKIA*`, JWTs, phones, Luhn-filtered card numbers, ordered so JWT precedes bearer and the key patterns precede email; plus force-redaction on `{email, phone, ssn, api_key, token, secret, password, user_name}` keys, propagating into nested containers, depth-capped at 10). `BatonConfig.scrubber` now defaults to `new Scrubber().scrub` instead of identity — matching Python's `install_baton` and baton-proxy, so an untouched integration gets scrubbing without the operator opting in. `identityScrub` is exported as the explicit opt-out. Parity was verified two ways: Python's `tests/test_scrub.py` matrix ported case-for-case, and both implementations run over a shared 21-case corpus with byte-identical output including per-category counts. Port divergences, each tested: JS regexes carry `g` (Python's `re.sub` is replace-all); only *plain* objects are walked, so a `Date`/`Map`/class instance passes through rather than being flattened to `{}` (Python leaves those alone too, as they aren't `dict`s); `counts` is a `Map` with a `count()` zero-default reader rather than a `Counter`.
- **Phase 3 — cross-SDK emitter conformance** (`test/emitterConformance.test.ts`). The existing conformance test only checked this repo's Zod *schemas* against `baton-spec`'s vectors; it never ran `withBaton`, so no test covered what the emitter actually puts on the wire. The new test replicates `baton-spec/scripts/generate.py`'s scenario through `withBaton` and diffs the emitted events against the vectors that script produced from the Python SDK — key sets exactly, values except an individually-justified exemption list, plus event ordering and `sequence_number`. Deliberately no Python subprocess (the design note's original shape): the vectors are already real Python-emitted envelopes, so requiring a Python toolchain and a `baton` checkout in this repo's CI would re-derive committed bytes and add a silently-wrong-build failure mode. Validated by mutation — reverting `sdk_version` to Python's, starting sequence numbers at 0, changing the `agent_runtime` default, and corrupting `seam_augmentations` each fail it. Known gap, documented in the file: `generate.py` never calls a tool carrying intent params, so every vector has `call_intent`/`intent_source` null and this test can't diff that path; it's covered locally instead, and closing it means changing `generate.py` and regenerating vectors for all four producer repos.
- **CORRECTED 2026-08-28 — MRTR was never "blocked upstream"; the check was scoped to the wrong package name.** The 2026-08-09 entry concluded that the official TypeScript SDK had not shipped MCP 2026-07-28 support, citing `npm view @modelcontextprotocol/sdk` → latest `1.30.0`, published 2026-07-27, with no `2.0.0`/beta/`next` tag. The release exists: on 2026-07-28, the same day as the spec, upstream **split the SDK** into `@modelcontextprotocol/server`, `@modelcontextprotocol/client` and `@modelcontextprotocol/core`, all `2.0.0`, from the same `modelcontextprotocol/typescript-sdk` repo. Querying the old name could not have seen it, and the fact recorded as reassuring — 1.30.0 landing one day *before* the spec — was really the last release before the rename. `@modelcontextprotocol/server@2.0.0`'s type declarations carry `InputRequired` and `requestState` throughout, so there is now a real shape to port against. Found while surveying the MCP registry for a Phase 4 fork target: `ankimcp/anki-mcp-server` (★458, active) imports `McpServer` from `@modelcontextprotocol/server`, which is what surfaced the package. **Consequence for this package:** `withBaton` targets 1.x internals (`_registeredTools`, `server/zod-compat.js`), so a v2-based server wraps to nothing, silently. v2 support is now its own deferred item and MRTR sits behind it, not behind upstream — see README "What's deferred". Unchanged and still true: 1.x Tasks/`createTask` object handlers never reach the plain-function tools `wrapIfNeeded` wraps.
- MRTR handling investigated 2026-08-09, not implemented — **superseded by the correction above; kept for the trace.** Reasoning at the time: MCP 2026-07-28 is a real, released spec revision whose MRTR mechanism (`InputRequiredResult`/`input_responses`/`request_state`) shipped in Python's official `mcp==2.0.0` the same day, while the official TypeScript SDK appeared not to have released its side (npm latest `1.30.0`, 2026-07-27, no 2.0/beta/next tag as of 2026-08-09) — so there seemed to be nothing to duck-type against. Separately, and independent of that error: the Tasks mechanism 1.x does have for multi-round-trip calls (object handlers with `createTask`) doesn't reach the plain-function tools `withBaton` wraps at all (confirmed by tracing `mcp.js`'s `CallToolRequestSchema` handler). No code change; see README "What's deferred" for the full trace.
- Intent-param injection + `surface_snapshot`: `withBaton` now splices `user_goal`/`expected_result` onto every wrapped tool's advertised Zod schema (`BatonConfig.intentParamMode`: `"optional"` default / `"required"` / `"off"`), strips them before the vendor handler runs, and surfaces them as `tool_call_start.payload.call_intent`/`intent_source` plus a synthesised proactive `annotation` (at most one per session, shared dedup with the annotate tool via `ProactiveTracker`). Also captures a `surface_snapshot` of the vendor-true (pre-injection) surface, hashed and emitted once per observed hash. **Neither gap listed below in the prior entry is missing anymore** — MRTR handling (mcp>=2.0 multi-round-trip pause/continuation, which Python's adapter special-cases) is a separate, still-open gap, not part of this pair; see README "What's deferred".
  - Splicing into a vendor's existing Zod object schema (which may be zod v3 or v4) required reaching into `@modelcontextprotocol/sdk`'s internal `server/zod-compat.js`/`server/zod-json-schema-compat.js` — the same helpers the SDK itself uses to bridge zod majors, isolated to `src/integrations/mcp/schemaCompat.ts` as a single swap point, same discipline as the existing `_registeredTools`/`_instructions` reach-ins.
  - A tool registered with no `inputSchema` at all is left alone regardless of mode — adding one would flip the SDK's handler-calling convention from `(extra)` to `(args, extra)` and break the vendor's own zero-arg handler.
  - A tool's `.update()`/`.remove()` are now also patched (mcp.js mutates the same `RegisteredTool` object in place for both): an unpatched `.update()` replacing `paramsSchema`/`callback` would silently wipe injected params and swap back to an unwrapped handler with no re-sweep able to detect it: the entry object identity never changes, so a naive wrapped-entry check would miss it. An unpatched `.remove()` would leave a phantom tool in the surface snapshot forever.
  - `buildServerMeta` (the snapshot's vendor-true baseline) now runs before `withBaton` sets its own `_instructions` suffix — capturing after would have recorded Baton's own text instead of the vendor's.
- Instructions + annotation tool: `withBaton` now injects server `instructions` (SPEC §5.1.2) and registers the `<vendor>_annotate` tool (SPEC §5.1.1). Templates are a byte-for-byte port of Python's `integrations/_llm_text.py` — verified by rendering both sides with identical inputs and diffing. `BatonConfig` gains a required `vendorDisplayName` and an optional `annotationToolName` override. This clears the npm-publish blocker below — **the instructions+annotate-tool pair is no longer missing.**
- Phase 2 scaffold: `withBaton(server, config)` — MCP interceptor for `@modelcontextprotocol/sdk`'s `McpServer`. Wraps tool calls (registered before or after `withBaton` runs) and emits `tool_call_start`/`tool_call_end`/`tool_call_error`. In-process tests via `InMemoryTransport`.
- Phase 1 scaffold: event types (`src/events.ts`), `StdoutSink` + `HttpSink` (`src/sinks.ts`), `baton-spec` submodule + wire-conformance test.

**Remaining gap before a real `npm publish`**: the design note's Phase 4 — fork a real OSS MCP server, add `withBaton` in 3 lines, run a live Claude Code session against it and confirm the events land in a Console alongside Python-sourced ones. That's the success criterion the design note names, and it's a decision to make (which server, which org, which Console) rather than code to write. Scrub rules and Phase 3 are done, above. Tracked in the `sdk-hardening` thread, `baton-internal`.
