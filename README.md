# @goodtiming/baton-sdk

**Pre-1.0** — the public API is not yet stable.

MCP standardizes how agents discover and call your tools. It does not capture *why* a call happened or whether it helped the user. Baton instruments those interactions on the vendor side — wrapping your MCP server — and captures intent, the tool calls, expected outcomes and observed outcomes, plus friction signals. It hands each one to a sink.

**The docs are at [goodtiming.ai/docs.html#typescript](https://goodtiming.ai/docs.html#typescript)**: the configuration reference, what this package captures, and what is not here yet. This page is the short version. The [Python SDK](https://pypi.org/project/baton-sdk/) takes the same DSN and emits the same events.

## Install

```sh
npm install @goodtiming/baton-sdk
```

Node 20+. Both major versions of the official MCP TypeScript SDK are supported and both are **optional** peer dependencies — `@modelcontextprotocol/sdk` 1.x or `@modelcontextprotocol/server` 2.x — so you install whichever one your server already uses and nothing else.

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

// register tools before or after withBaton — both are captured
server.registerTool("lookup", { inputSchema: { name: z.string() } }, async ({ name }) => {
  /* ... */
});
```

That one string is the whole configuration. Copy it from **/account**, where it is labelled DSN. It packs four values — the collector to send to, your workspace, this server, and the key that binds them — and the SDK unpacks them and builds the sink itself.

**If you distribute your server, put the DSN in your source.** A stdio server runs on your user's machine, spawned by their MCP client — and the official client SDKs pass it a fixed six-variable allowlist (`HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER`), plus whatever that user wrote in their own client config. Nothing from your `.env` is in either list, so a server configured that way captures nothing while appearing to work.

For a hosted server, where the process starts from your own environment, set `BATON_DSN` and call `withBaton(server)` with no config. An explicit `dsn` wins over `BATON_DSN`, and both win over every other `BATON_*` variable — which matters when you **re-onboard** a server, so the new DSN beats the old install's leftover `.env` rather than filing your events under the previous server's name.

Sending to your own collector instead, or trying the package before you have a key, means naming the parts rather than passing a DSN: [Without a DSN](https://goodtiming.ai/docs.html#without-dsn).

## PII scrubbing

**On by default**, a rule-for-rule port of the Python SDK's ruleset: email, `Bearer` values, `sk-*` and `AKIA*` keys, JWTs, phone numbers, Luhn-checked card numbers, plus force-redaction on sensitive field names. Pass `identityScrub` to opt out, or supply your own `(value: unknown) => unknown`.

**It is pattern matching, not a guarantee** — `{"name": "Jane Doe"}` passes through untouched. Decide what your server puts in tool params and results on that basis. [What it does and does not catch](https://goodtiming.ai/docs.html#pii).

## Turning capture off

`BATON_DISABLED=1` in the environment of the process running the server, and the SDK installs nothing at all. The switch belongs to whoever RUNS the server. [The long version](https://goodtiming.ai/docs.html#off-switch).

## What is not here yet

Stated so you find out now rather than later. None of it blocks the quickstart above.

- Only `StdoutSink` and `HttpSink`. `FileSink` and `MultiSink` are deferred; the Python package has all four.
- Only the high-level `McpServer`. The low-level `Server` is not wrapped.
- Intent parameters need a Zod schema. On the 2.x SDK a tool registered with a non-Zod standard schema is still wrapped and still emits `tool_call_*`; it just advertises no intent parameters.
- The per-request `createMcpHandler` deployment shape is unscoped.

## Wire compatibility

Events from this package must be JSON-identical in shape to the Python SDK's, so a collector never branches on which SDK produced one. Both are checked against [baton-spec](https://github.com/good-timing/baton-spec), a neutral schema repo: every event type is validated against the shared JSON Schema, and this package's emitter is diffed field-by-field against captured Python output for the same scenario.

Keeping that submodule current is load-bearing for contributors — a stale pin makes these tests pass loudly and prove nothing. See [`CONTRIBUTING.md`](https://github.com/good-timing/baton-ts/blob/main/CONTRIBUTING.md).

## More

| | |
|---|---|
| [goodtiming.ai/docs.html#typescript](https://goodtiming.ai/docs.html#typescript) | The docs — configuration, what it captures, the Console |
| [`docs/SPEC.md`](https://github.com/good-timing/baton/blob/main/docs/SPEC.md) | The wire protocol, in the `baton` repo. Applies here too |
| [`docs/CHARTER.md`](https://github.com/good-timing/baton/blob/main/docs/CHARTER.md) | Why the SDK is thin. Read before architectural changes |
| [`CHANGELOG.md`](https://github.com/good-timing/baton-ts/blob/main/CHANGELOG.md) | What has shipped |

Apache-2.0.
