# Per-repo guidance for AI coding agents

*Follows the [AGENTS.md](https://agents.md) convention — discovered automatically by Claude Code, Cursor, OpenAI Codex CLI, and other AI coding agents.*

This is the TypeScript counterpart to [`baton`](https://github.com/good-timing/baton) (the Python `baton-sdk`). It has no `CHARTER.md` or `SPEC.md` of its own — **read `baton`'s `docs/CHARTER.md` and `docs/SPEC.md` first**; every boundary rule and ADR there applies here too. This file only adds what's TypeScript-specific.

## Status

Phase 2 of the design note in `baton-internal` (private — read it before touching `src/integrations/mcp/`). `withBaton` wraps `@modelcontextprotocol/sdk` `McpServer` tool calls (`tool_call_*` events), injects server `instructions`, and registers the `<vendor>_annotate` tool (SPEC §5.1.1–§5.1.2) — ported byte-for-byte from Python's templates, verified against the Python SDK's actual rendered output. **Deliberately not built yet:** see README.md's "What is not here yet".

**Known divergences from the Python SDK** — deliberate, and recorded here because a parity audit opens this file before it opens a docstring:

1. **No attested identity SOURCE.** Every principal this SDK emits carries `source: "asserted"`; `BatonConfig.resolvePrincipal` is the only identity mechanism here. Python reads a principal off a verified access token's `claims["sub"]`; TypeScript's `AuthInfo` has no `claims` field, so the nearest carrier is the untyped `extra` bag and nothing specifies a subject lives there. ⚠ **Do not describe this as "no `h1:` rung" — that is now false in the dangerous direction.** This SDK does emit `h1:`: the prefix is the HMAC KEY GENERATION and is identical on both provenances. The missing thing is the `source` VALUE, and SPEC §11.4 requires a consumer to read `source` rather than the prefix, precisely so an asserted principal is never presented as verified.
2. **Vendor hooks run INLINE with no timeout.** Python runs them off the event loop under a 5s budget (`integrations/_hooks.py`); a blocking hook here stalls its own request. Applies to `resolvePrincipal` and `scrubber`.
3. **A malformed (lone-surrogate) `issuer` drops the issuer and still hashes**, where Python drops the principal entirely. The generated corpus cannot pin this — Python's generator cannot emit a vector for an input that raises.

## Wire compatibility — non-negotiable

Every event this package can construct must serialize to the same JSON shape the Python SDK produces (`baton`'s `src/baton/events.py`). The schema of record is `baton-spec` (submoduled at `baton-spec/`), not this repo's `src/events.ts` — if the two disagree, `baton-spec` wins and `src/events.ts` is wrong. `test/conformance.test.ts` enforces this against real Python-captured vectors; a change to `src/events.ts` that isn't schema-conformant should fail CI, not get waved through.

## Tooling

- Node 20+, TypeScript, `npm` (not pnpm/yarn — keep it boring)
- `tsup` for the dual ESM/CJS + `.d.ts` build
- `eslint` (flat config, `typescript-eslint` recommendedTypeChecked) for lint
- `vitest` for tests
- `zod` for runtime validation of the event schemas; `ajv` only in the conformance test, to check against `baton-spec/events.schema.json` independently of our own Zod definitions

Use `npm run ci` as the canonical gate (matches GitHub Actions).

## Boundary rules carried over from `baton` (Python)

1. No vendor-specific imports in `src/`. Same reasoning as the Python SDK — this package must work for any MCP server, not one vendor's.
2. No `console.*` in `src/` (`eslint.config.js` enforces this — mirrors Python's ruff `T20`). MCP stdio transport reserves stdout for JSON-RPC framing; use `StdoutSink` for anything that needs to reach a stream.
3. Public API is the contract. Anything exported from `src/index.ts` is what vendors integrate against; breaking changes need the same `SPEC.md §13` changelog discipline as the Python SDK.
4. Tests use fake fixtures only — `ajv` against the schema, in-process fetch mocks for `HttpSink`, a real `McpServer`/`Client` pair over `InMemoryTransport` for `withBaton` (the MCP SDK's own in-process test transport — not a mock of it). No real vendor MCP server in this repo, ever.
5. `src/integrations/mcp/withBaton.ts` reaches into `McpServer`'s private `_registeredTools` / `RegisteredTool.handler`, and `server.server`'s private `_instructions` — undocumented internals, not the public `.d.ts` surface. This is deliberate (see that file's module docstring — retroactive tool wrapping and post-construction instructions injection both require it; the TS SDK, unlike Python's FastMCP, has no settable `instructions` at all) and isolated to one file/one `eslint-disable` block, mirroring Python's `_registry.py` "single swap point for upstream rename" pattern. If `@modelcontextprotocol/sdk` restructures `McpServer`/`Server` internals, this is the one place to fix.

## What lives where

- `src/events.ts` — Zod schemas + types for the event envelope and its five payload types.
- `src/identity.ts` — principal derivation (`Principal`, `PrincipalWire`, `hashPrincipalId`, `principalFor`). Byte-identical to Python's `baton/identity.py`, asserted by a GENERATED corpus (`test/identityVectors.json`, regenerated by `scripts/gen_identity_vectors.py` against the Python repo). The MCP-facing half is `src/integrations/mcp/principalResolution.ts`.
- `src/_text.ts` — the shared code-point truncation both capped fields use.
- `src/sinks.ts` — `Sink` interface, `StdoutSink`, `HttpSink`.
- `src/version.ts` — `SDK_VERSION`, spelled `ts-<package.json version>` so the Console can tell TS- from Python-sourced events apart in `sdk_version`. No number here on purpose: this line said `"ts-0.1.0"` through the whole of 0.2.0. The two spellings are hand-maintained and `test/version.test.ts` is the only thing connecting them — bump both in the release commit.
- `src/integrations/mcp/` — `withBaton`, `BatonConfig`, `BatonHandle`, `SessionCounter`, runtime-detection heuristics, `annotation.ts` (the `<vendor>_annotate` tool), `llmText.ts` (instructions + tool-description templates, ported from Python's `_llm_text.py`). Re-exported flat from `src/index.ts` (design note's `import { withBaton } from '@goodtiming/baton-sdk'` shape — no Python-style `baton.integrations.mcp` subpackage, since there's only one MCP SDK to target in TS).
- `test/conformance.test.ts` — the wire-compatibility gate described above.
- `test/integrations/mcp/withBaton.test.ts` — in-process interceptor tests.
- `baton-spec/` — git submodule, schema of record. Never hand-edit; it's regenerated from `baton`'s Pydantic models.

## When in doubt

Read `baton`'s `docs/CHARTER.md` first. It's the North Star for this repo too.
