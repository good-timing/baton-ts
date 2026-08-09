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
    },
  },
  {
    ignores: ["dist/**", "baton-spec/**", "node_modules/**"],
  },
);
