import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // .trail/ holds local agent-tool artifacts (hooks, caches), never product code.
  { ignores: ["dist/**", "node_modules/**", "fixtures/**", ".lattice-audit/**", "tmp/**", ".trail/**"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true },
      ],
    },
  },
  {
    ...tseslint.configs.disableTypeChecked,
    files: ["tests/**/*.ts", "tests/**/*.mjs", "scripts/**/*.mjs", "*.config.*"],
  },
  {
    files: ["scripts/**/*.mjs", "tests/**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        fetch: "readonly",
        globalThis: "readonly",
      },
    },
  },
);
