// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { builtinModules } from "node:module";

const NODE_BUILTINS = builtinModules.filter((name) => !name.includes("/")).join("|");

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
    // The MCP stdio transport reserves stdout for JSON-RPC framing; write to
    // stderr through `stderrLine` or `warn` (warn.ts).
    files: ["src/**/*.ts"],
    rules: {
      "no-console": "error",
      // A vendor scrubber called outside an `emit()` build thunk must go through
      // `scrubOrNull` (SPEC §11.2), or a tool call that worked returns
      // `isError: true`. In-thunk sites opt out on a visible line. Both
      // spellings are banned: `ctx.scrubber(` and a bare `scrubber(`. It matches
      // the name at the call, so an alias (`const r = ctx.scrubber`) escapes it.
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
        {
          selector: `ImportDeclaration[importKind!="type"][source.value=/^(node:|(${NODE_BUILTINS})(\\/|$))/] > ImportSpecifier[importKind!="type"]`,
          message:
            "Import a Node built-in as a namespace (`import * as x`): some Workers test runners give a module without every export, and a named import of a missing one fails as the module loads (check-bare-fs.mjs).",
        },
        {
          selector: 'MemberExpression[object.name="process"][property.name=/^(stderr|on|off|once|addListener|removeListener)$/]',
          message:
            "Use stderrLine (warn.ts) or onProcess (runtime.ts): a test runner's stand-in `process` may lack these, and a throw from Baton's own catch block reaches the client (workersRuntime.test.ts).",
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
