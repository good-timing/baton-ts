# @goodtiming/baton-sdk

**Pre-1.0.** The public API is not yet stable.

MCP standardizes how agents discover and call your tools. It does not capture *why* a call happened or whether it helped the user. Baton instruments those interactions on the vendor side by wrapping your MCP server. It captures intent, the tool calls, expected outcomes and observed outcomes, plus friction signals, and hands each one to a sink.

**The docs are at [goodtiming.ai/docs.html#typescript](https://goodtiming.ai/docs.html#typescript)**: the configuration reference, what this package captures, and what is not here yet. This page is the short version. The [Python SDK](https://pypi.org/project/baton-sdk/) takes the same DSN and emits the same events.

## Install

```sh
npm install @goodtiming/baton-sdk
```

Node 20+. Both major versions of the official MCP TypeScript SDK are supported, and both are **optional** peer dependencies: `@modelcontextprotocol/sdk` **1.30+** or `@modelcontextprotocol/server` 2.x. You install whichever one your server already uses and nothing else. The 1.x floor is `^1.30.0`; an older 1.x will not satisfy the peer range.

## Quickstart

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withBaton } from "@goodtiming/baton-sdk";
import { z } from "zod";

const server = new McpServer({ name: "your-vendor-mcp", version: "1.0.0" });
const handle = withBaton(server, {
  dsn: "https://baton_pk_...@baton.goodtiming.ai/ten_.../your-vendor",
});
// handle.annotationToolName === "your-vendor-mcp_annotate", from the server's own name

// register tools before or after withBaton; both are captured
server.registerTool("lookup", { inputSchema: { name: z.string() } }, async ({ name }) => {
  /* ... */
});
```

Copy the DSN from **/account**. It packs four values: the collector to send to, your workspace, this server, and the key that binds them. The SDK unpacks them and builds the sink itself.

**If you distribute your server, put the DSN in your source.** A stdio server runs on your user's machine, spawned by their MCP client. The official client SDKs pass it a fixed six-variable allowlist (`HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER`), plus whatever that user wrote in their own client config. Nothing from your `.env` is in either list, so a server configured that way captures nothing while appearing to work.

For a hosted server, where the process starts from your own environment, set `BATON_DSN` and call `withBaton(server)` with no config. An explicit `dsn` wins over `BATON_DSN`, and both win over every other `BATON_*` variable. That ordering matters when you **re-onboard** a server: the new DSN beats the old install's leftover `.env`, rather than filing your events under the previous server's name.

Sending to your own collector instead, or trying the package before you have a key, means naming the parts rather than passing a DSN: [Without a DSN](https://goodtiming.ai/docs.html#without-dsn). That section's examples are Python. The config field names carry over as camelCase, and `HttpSink` takes its options as an object: `new HttpSink(url, { apiKey })`. Its timeouts do **not** carry over. Python's `request_timeout_seconds` / `backoff_base_seconds` / `backoff_max_seconds` / `circuit_breaker_reset_seconds` are `requestTimeoutMs` / `backoffBaseMs` / `backoffMaxMs` / `circuitBreakerResetMs` here, in milliseconds rather than seconds, and there is no equivalent of `shutdown_flush_timeout_seconds`.

## A server per request

A stateless HTTP server builds a new `McpServer` for every request. Create one Baton at startup and wrap each server with it:

```ts
import { createBaton } from "@goodtiming/baton-sdk";

const baton = createBaton(); // reads BATON_DSN, like withBaton

app.post("/mcp", async (req, res) => {
  const server = buildServer();
  baton.wrap(server);
  // connect a transport and handle the request as before
});
```

Call `await baton.aclose()` in your own shutdown path, after the HTTP server stops taking requests. It sends what is still buffered.

`createBaton` takes the same config as `withBaton`. The Baton owns the sink, so there is nothing to close per request. Calling `withBaton` per request instead builds a new sink each time and re-sends the tool surface on every request.

What a stateless server costs, with either function:

- **Every request is its own session.** The protocol gives a stateless server no session id, so the SDK does not invent a join between two requests. To see one person's requests together, return a principal from `resolvePrincipal` ([Who is calling](#who-is-calling)): the Console lists sessions by person. Signals that need several calls in one session, such as a retry loop, do not fire across requests.
- **The client's name is often `unknown`.** A client states its name in the `initialize` handshake, and a per-request server never sees the handshake of the call it is serving. The exception is a client the SDK can recognise from the request itself: Claude Code's tool calls are named `claude-code`. Resource and prompt requests are not. The request's `User-Agent` header is still sent with each of those events, in `client_observed`, so the client can be named from it.

## PII scrubbing

**On by default**, a rule-for-rule port of the Python SDK's ruleset: email, `Bearer` values, `sk-*` and `AKIA*` keys, JWTs, phone numbers, Luhn-checked card numbers, plus force-redaction on sensitive field names. Pass `identityScrub` to opt out, or supply your own `(value: unknown) => unknown`.

**It is pattern matching, not a guarantee.** `{"name": "Jane Doe"}` passes through untouched. Decide what your server puts in tool params and results on that basis. [What it does and does not catch](https://goodtiming.ai/docs.html#pii).

**The scrubber is not the only lever.** If some tool results cannot be recorded at all, `resultCaptureMode` below withholds them outright rather than transforming them.

## Who is calling

**Nothing is captured about the person behind a call unless you say how to find them.** Pass `resolvePrincipal`: it receives the call's headers, `_meta`, tool name, arguments and validated `authInfo`, and returns a `Principal` or `null`. Two ready-made hooks cover OAuth:

```typescript
import { withBaton, principalFromOAuthEmail } from "@goodtiming/baton-sdk";

withBaton(server, {
  dsn: "https://baton_pk_...@baton.goodtiming.ai/ten_.../your-vendor",
  resolvePrincipal: principalFromOAuthEmail, // or principalFromOAuthSub
});
```

`principalFromOAuthEmail` keys on the token's `email` claim (the whole address); `principalFromOAuthSub` on its subject. Each returns `null` when the claim is missing, so they compose: `(ctx) => principalFromOAuthEmail(ctx) ?? principalFromOAuthSub(ctx)`. Set `displayName` on the returned `Principal` to choose what your dashboard shows for a person; it is sent as-is. The email hook sets it to the part before `@`.

⚠ **They read the claims from `authInfo.extra`.** The MCP SDK's `AuthInfo` has no `claims` field, so these hooks expect your token verifier to put the decoded JWT claims (`sub`, `iss`, `email`) at the top level of `extra`. If yours keeps them elsewhere, write the three-line hook that reads them from there. A token exists only on HTTP with auth configured; on stdio, write a hook that names the user from whatever you authenticated them with.

The hook runs on every call, before your handler. If it has not answered after 5 seconds, the SDK stops waiting and that call is sent without a principal. That covers an async hook waiting on a slow lookup. A hook that blocks synchronously cannot be interrupted, so keep the work in it async.

The id is sent exactly as your hook returns it, so the hook decides what is safe to send. To send a pseudonym instead, hash the id inside your hook and return `form: "hashed"` with it.

## Not capturing responses at all

`resultCaptureMode: "off"` and nothing **derived from what your tool returns** leaves your process — not the result, and not the reason text on a failure your handler returns rather than throws. Requests are unaffected: `params` are captured either way.

```ts
withBaton(server, { dsn, resultCaptureMode: "off" });
```

Each affected event says so, in its own field (`result_capture: "off"`), rather than leaving a reader to guess from what is missing. That is the difference between the two levers: a scrubber TRANSFORMS a value that still crosses the network, this DECLARES that nothing crosses.

**What is still captured, and it is deliberate:** the tool name, the duration, and whether the call failed — so failure detection, pairing and timing all keep working. Also the message of an error your handler **throws**, which is your own code speaking about a call that never returned, and the most useful diagnostic the product has. ⚠ Thrown messages are a classic leak channel — a failed query echoed back, a record id in the message. If that is also a problem for you, say so and we will add a stricter setting.

**What it costs you:** anything that needs to read a response body. A call that returns `200` with a useless body can no longer be detected, and those calls sit outside the denominator of body-level analysis rather than counting as passes or failures.

## Failures your handler never saw

A wrapper around your tool executor only sees calls that reach it. Three kinds
never do — the MCP SDK rejects them above your handler — and a fourth used to be
recorded as a success:

| what happened | what you get |
|---|---|
| no tool by that name | `tool_call_error`, `failure_kind: "unknown_tool"` |
| the tool exists and you disabled it | `tool_call_error`, `failure_kind: "tool_disabled"` |
| the arguments failed your schema | `tool_call_error`, `failure_kind: "invalid_argument"` |
| your output schema rejected what the tool returned | `tool_call_error`, `failure_kind: "output_schema_mismatch"` |

The first three emitted **nothing at all** before `0.5.0`, and the fourth emitted
`tool_call_end` — a success, for a call your caller saw fail. `failure_kind` names
which one it was, so nothing downstream has to pattern-match the message.

⚠ **A tool declaring `execution.taskSupport` gets a `tool_call_error` with NO
`failure_kind`, and the failures it can hit are not in that table.** On 1.x a
tool declaring `"required"` or `"optional"` is rejected before argument
validation if it was not registered as a task tool, and a `"required"` one is
rejected when called without task augmentation; an `"optional"` task tool called
without one goes to automatic polling instead, which is not a failure at all.
This package omits the member for either declared value rather than guessing,
because it cannot distinguish those rejections from a rejected argument without
mislabelling every ordinary tool on that peer — 1.x stamps `taskSupport` on all
of them. The event still carries the SDK's own message. A consumer reading
`failure_kind` must handle its absence, which SPEC §11.4.3 requires anyway.

**Why a separate field and not `error_type`.** `error_type` reports the SHAPE the
SDK handed us, and the two MCP majors disagree about it for the same failure: 1.x
converts an unknown tool into a returned error flag (`"tool_error"`), v2 throws
(`"ProtocolError"`). Both are accurate about what happened at the protocol level,
and neither tells you a tool was missing. `failure_kind` is the same on both.

**`failure_kind` survives `resultCaptureMode: "off"`.** It is this package's
judgement about the shape of a failure, not anything derived from what your tool
returned — so for the first three the SDK's own message is kept too, and for the
fourth the message is withheld and the named kind is the only signal left.

## Resources and prompts

`registerResource` and `registerPrompt` are instrumented as well as tools, at the
request level: `resources/list`, `resources/read`, `prompts/list` and
`prompts/get` each emit a start and then an end or an error — twelve event types.

**No SUCCESSFUL read or get captures a body.** Not a read's content, not a
prompt's rendered messages. A resource URI and a prompt name ARE captured, and
both go through the scrubber whole — they are text your caller supplied, so they
can carry paths, query strings and account identifiers.

⚠ **A FAILING one captures the message your code threw, and
`resultCaptureMode: "off"` does not withhold it.** These twelve events never
carry the `result_capture` marker — the rule is that nothing on them is derived
from a result — so a failing read's `error_body` is kept in both modes and the
wire says nothing either way. That is the same leak channel as a thrown tool
error above, with one difference worth your attention: for a tool the marker
tells a consumer what happened, and here there is no marker. If your read fails
with `could not parse ${body.slice(0, 200)}`, that content leaves your process
under a mode you set to stop exactly that. Throw a message that names the
resource, not its contents.

## Turning capture off entirely

Not the same thing as **Not capturing responses at all**: that one keeps the signal and drops the response bodies, this one emits nothing at all. It also belongs to a different person — `resultCaptureMode` is set by whoever WRAPS the server, in code; this is set by whoever RUNS it, in the environment.

`BATON_DISABLED=1` in the environment of the process running the server, and the SDK installs nothing at all. [The long version](https://goodtiming.ai/docs.html#off-switch).

Checking it worked: `handle.sink` is still an object, so finding one there is not a sign the switch failed. It is the sink you passed if you passed one, and a `DisabledSink` otherwise. Either way nothing writes to it, because nothing is wrapped.

## What is not here yet

None of it blocks the quickstart above.

- Only `StdoutSink` and `HttpSink`. `FileSink` and `MultiSink` are deferred; the Python package has all four.
- Only the high-level `McpServer`. The low-level `Server` is not wrapped.
- **Task-based tools are not wrapped, and are not left alone either.** A 1.x tool registered with an object at `.handler` rather than a function produces no `tool_call_*` events at all, and nothing reports that. It still gets the intent parameters added to its advertised schema, because injection runs before the wrap is skipped and the strip only happens inside the wrapper. So `user_goal`, `expected_result` and `overall_task` can arrive in your own handler's arguments. Tools on the same server registered the ordinary way are unaffected. ⚠ **The request-level seam above does not rescue this one**: it reports only on tools this package wrapped, so a task-based tool emits nothing even for a rejected argument, where an unknown tool now emits a `tool_call_error`.
- Intent parameters need a Zod schema. On the 2.x SDK a tool registered with a non-Zod standard schema is still wrapped and still emits `tool_call_*`; it just advertises no intent parameters.
- v2's `createMcpHandler` is untested. A server built per request by your own code is supported: see [A server per request](#a-server-per-request).

## Wire compatibility

Events from this package must be JSON-identical in shape to the Python SDK's, so a collector never branches on which SDK produced one. Both are checked against [baton-spec](https://github.com/good-timing/baton-spec), a neutral schema repo: every event type is validated against the shared JSON Schema, and this package's emitter is diffed field-by-field against captured Python output for the same scenario.

Keeping that submodule current is load-bearing for contributors: a stale pin makes these tests pass loudly and prove nothing. See [`CONTRIBUTING.md`](https://github.com/good-timing/baton-ts/blob/main/CONTRIBUTING.md).

## More

| | |
|---|---|
| [goodtiming.ai/docs.html#typescript](https://goodtiming.ai/docs.html#typescript) | The docs: configuration, what it captures, the Console |
| [`docs/SPEC.md`](https://github.com/good-timing/baton/blob/main/docs/SPEC.md) | The wire protocol, in the `baton` repo. Applies here too |
| [`docs/CHARTER.md`](https://github.com/good-timing/baton/blob/main/docs/CHARTER.md) | Why the SDK is thin. Read before architectural changes |
| [`CHANGELOG.md`](https://github.com/good-timing/baton-ts/blob/main/CHANGELOG.md) | What has shipped |

Apache-2.0.
