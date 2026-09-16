# Contributing to @goodtiming/baton-sdk

Read [`docs/CHARTER.md`](https://github.com/good-timing/baton/blob/main/docs/CHARTER.md)
and [`docs/SPEC.md`](https://github.com/good-timing/baton/blob/main/docs/SPEC.md)
in the `baton` repo before making architectural changes. This package has no
CHARTER or SPEC of its own; those two apply here too.

## Setup

```sh
git clone --recurse-submodules https://github.com/good-timing/baton-ts.git
cd baton-ts
npm install
npm run ci   # lint + typecheck + test + build — the canonical gate, matches CI
```

If you cloned without `--recurse-submodules`, run `git submodule update --init`
before `npm test`: the conformance tests read fixtures from `baton-spec/`.

## Wire compatibility — the constraint this package is built around

Events emitted here must be JSON-identical in shape to the Python SDK's, so a
collector never has to branch on which SDK produced an event (CHARTER §3 rule
3). [`baton-spec`](https://github.com/good-timing/baton-spec), submoduled at
`baton-spec/`, is the neutral schema repo both SDKs are checked against, and it
is enforced at two levels:

- **Schema** (`test/conformance.test.ts`) — validates every event type against
  `baton-spec/events.schema.json` with ajv, and round-trips the real,
  Python-captured fixtures in `baton-spec/vectors/*.json` through this
  package's Zod schemas byte-for-byte.
- **Emitter** (`test/emitterConformance.test.ts`) — drives a real tool call
  through `withBaton` and diffs the *emitted* events against those same
  vectors, field-for-field. The scenario mirrors
  `baton-spec/scripts/generate.py`, the script that produced the vectors by
  driving the identical scenario through the Python SDK. Envelope and payload
  key sets must match exactly; values must match except for a short,
  individually-justified exemption list (`event_id`, `session_id`,
  `captured_at`, `sdk_version`, timings, and the genuinely language-specific
  bits like `error_type` and the FastMCP-vs-Zod-derived tool schemas). Event
  ordering and `sequence_number` assignment are asserted against the Python run
  too.

The schema check alone cannot catch an emitter that populates a field Python
leaves null, starts `sequence_number` at 0, or orders events differently —
hence the second level. No Python toolchain is needed in CI: the vectors are
themselves real Python-emitted envelopes, so they *are* the cross-SDK
reference. When the Python SDK's wire output changes, `generate.py` is re-run
and the updated vectors arrive through a submodule bump — which is exactly what
should fail these tests.

> **Keep the submodule current.** That is not hypothetical. The pin sat at the
> initial schema commit while Python had moved on to `call_expected` /
> `call_workflow`, so both conformance levels were passing against a superseded
> contract. Bumping it failed three tests and surfaced the real gap —
> `overall_task` injection was missing entirely, meaning a TypeScript-sourced
> session carried no `call_workflow` for the Console to group tasks by. **A
> stale pin makes these tests pass loudly and prove nothing.**

## Docs

User-facing documentation lives on the website, not in this repo:
[goodtiming.ai/docs.html#typescript](https://goodtiming.ai/docs.html#typescript).
`README.md` is the npm page and stays short — what the package is, install, one
working example, and links. A new configuration field is documented on the
site; the README changes only if the quickstart changes.
