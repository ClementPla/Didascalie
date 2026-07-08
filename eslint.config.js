// @ts-check
const eslint = require("@eslint/js");
const { defineConfig } = require("eslint/config");
const tseslint = require("typescript-eslint");
const angular = require("angular-eslint");
// Turns off ESLint rules that would conflict with Prettier's formatting.
const prettier = require("eslint-config-prettier");

module.exports = defineConfig([
  {
    files: ["**/*.ts"],
    extends: [
      eslint.configs.recommended,
      tseslint.configs.recommended,
      tseslint.configs.stylistic,
      angular.configs.tsRecommended,
      prettier,
    ],
    processor: angular.processInlineTemplates,
    rules: {
      "@angular-eslint/directive-selector": [
        "warn",
        {
          type: "attribute",
          prefix: "app",
          style: "camelCase",
        },
      ],
      "@angular-eslint/component-selector": [
        "warn",
        {
          type: "element",
          prefix: "app",
          style: "kebab-case",
        },
      ],

      // ── Adoption baseline ────────────────────────────────────────────────
      // ESLint was added to a mature codebase. The rule set below keeps the
      // bug-catching rules as errors (a real CI gate), turns off the few
      // conventions this project deliberately diverges from, and marks the
      // rest as `warn` — a visible backlog to ratchet toward `error` over
      // time. `ng lint` stays green (exit 0) as long as no new *error*-level
      // violation is introduced.

      // Deliberate house style — not bugs:
      "@angular-eslint/prefer-inject": "off", // constructor injection throughout
      "@typescript-eslint/no-empty-function": "off", // intentional no-op overrides
      "@typescript-eslint/class-literal-property-style": "off",

      // Quality debt to ratchet (kept visible as warnings):
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/prefer-for-of": "warn",
      "@typescript-eslint/ban-ts-comment": "warn",
    },
  },
  {
    files: ["**/*.html"],
    extends: [
      angular.configs.templateRecommended,
      angular.configs.templateAccessibility,
    ],
    rules: {
      // Legacy templates use *ngIf/*ngFor; migrate to @if/@for over time.
      "@angular-eslint/template/prefer-control-flow": "warn",
      // Accessibility backlog — worth fixing, not worth blocking on today.
      "@angular-eslint/template/label-has-associated-control": "warn",
      "@angular-eslint/template/click-events-have-key-events": "warn",
      "@angular-eslint/template/interactive-supports-focus": "warn",
      "@angular-eslint/template/elements-content": "warn",
    },
  },
]);
