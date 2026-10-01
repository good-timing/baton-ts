// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Mirrors baton (Python)'s ruff T20 rule: no console output in src/.
    // The MCP stdio transport reserves stdout for JSON-RPC framing, and
    // even stderr writes should go through StdoutSink, not ad hoc logging.
    files: ["src/**/*.ts"],
    rules: {
      "no-console": "error",
      // Fail-open enforcement, not style. A vendor scrubber called OUTSIDE an
      // `emit()` build thunk must go through `scrubOrNull` (SPEC §11.2) — a bare
      // call there returns `isError: true` to the agent for a tool call that
      // worked. That rule lived in a doc comment and a site was missed within the
      // same change, so the compiler-adjacent version is the rule itself: a bare
      // call is refused everywhere, and the legitimate in-thunk sites opt out on
      // a visible line a reviewer sees. Both spellings are banned because the
      // scrubber is reached as a property (`ctx.scrubber(`) and as a bare
      // parameter (`scrubber(`).
      "no-restricted-syntax": [
        "error",
        {
          selector: 'CallExpression[callee.property.name="scrubber"]',
          message:
            "Call the vendor scrubber through scrubOrNull (safeScrub.ts) unless this is inside an emit() build thunk — if it is, add an eslint-disable-next-line with that reason.",
        },
        {
          selector: 'CallExpression[callee.name="scrubber"]',
          message:
            "Call the vendor scrubber through scrubOrNull (safeScrub.ts) unless this is inside an emit() build thunk — if it is, add an eslint-disable-next-line with that reason.",
        },
      ],
      // The Sink interface requires every method to return a Promise
      // uniformly across implementations, even ones (StdoutSink) that are
      // synchronous in practice — forcing a pointless await to satisfy this
      // rule would be worse than the rule.
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    // Test fixtures are dynamic JSON (JSON.parse, ajv) by nature — typing
    // every intermediate as `unknown` and narrowing it back down would add
    // ceremony without catching real bugs here.
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      // Test doubles implement async interfaces (Sink, MCP tool callbacks)
      // that don't always need to await — same rationale as StdoutSink.
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    ignores: ["dist/**", "baton-spec/**", "node_modules/**"],
  },
);
