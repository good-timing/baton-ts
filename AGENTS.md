# Per-repo guidance for AI coding agents

*Follows the [AGENTS.md](https://agents.md) convention — discovered automatically by Claude Code, Cursor, OpenAI Codex CLI, and other AI coding agents.*

This is the TypeScript counterpart to [`baton`](https://github.com/good-timing/baton) (the Python `baton-sdk`). It has no `CHARTER.md` or `SPEC.md` of its own — **read `baton`'s `docs/CHARTER.md` and `docs/SPEC.md` first**; every boundary rule and ADR there applies here too. This file only adds what's TypeScript-specific.

## Status

Phase 2 of the design note in `baton-internal` (private — read it before touching `src/integrations/mcp/`). `withBaton` wraps `@modelcontextprotocol/sdk` `McpServer` tool calls (`tool_call_*` events), injects server `instructions`, and registers the `<vendor>_annotate` tool (SPEC §5.1.1–§5.1.2) — ported byte-for-byte from Python's templates, verified against the Python SDK's actual rendered output. **Deliberately not built yet:** intent-param injection, `surface_snapshot`. See README.md's "What's deferred".

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
- `src/sinks.ts` — `Sink` interface, `StdoutSink`, `HttpSink`.
- `src/version.ts` — `SDK_VERSION` (`"ts-0.1.0"` — TS-prefixed so the Console can tell TS- from Python-sourced events apart in `sdk_version`).
- `src/integrations/mcp/` — `withBaton`, `BatonConfig`, `BatonHandle`, `SessionCounter`, runtime-detection heuristics, `annotation.ts` (the `<vendor>_annotate` tool), `llmText.ts` (instructions + tool-description templates, ported from Python's `_llm_text.py`). Re-exported flat from `src/index.ts` (design note's `import { withBaton } from '@baton/sdk'` shape — no Python-style `baton.integrations.mcp` subpackage, since there's only one MCP SDK to target in TS).
- `test/conformance.test.ts` — the wire-compatibility gate described above.
- `test/integrations/mcp/withBaton.test.ts` — in-process interceptor tests.
- `baton-spec/` — git submodule, schema of record. Never hand-edit; it's regenerated from `baton`'s Pydantic models.

## When in doubt

Read `baton`'s `docs/CHARTER.md` first. It's the North Star for this repo too.
