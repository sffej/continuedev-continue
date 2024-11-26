import typescriptEslint from "@typescript-eslint/eslint-plugin";
import _import from "eslint-plugin-import";
import strictNullChecks from "eslint-plugin-strict-null-checks";
import { fixupPluginRules } from "@eslint/compat";
import tsParser from "@typescript-eslint/parser";

export default [{
    ignores: ["**/out", "**/dist", "**/*.d.ts"],
}, {
    plugins: {
        "@typescript-eslint": typescriptEslint,
        import: fixupPluginRules(_import),
        "strict-null-checks": strictNullChecks,
    },

    languageOptions: {
        parser: tsParser,
        ecmaVersion: 6,
        sourceType: "module",

        parserOptions: {
            project: "./tsconfig.strictNullChecks.json",
        },
    },

    rules: {
        "@typescript-eslint/semi": "warn",
        "strict-null-checks/all": "warn",
        curly: "warn",
        eqeqeq: "warn",
        "no-throw-literal": "warn",
        semi: "off",

        "import/order": ["warn", {
            groups: [
                "builtin",
                "external",
                "internal",
                "parent",
                "sibling",
                "index",
                "object",
                "type",
            ],

            alphabetize: {
                order: "asc",
                caseInsensitive: true,
            },

            "newlines-between": "always",
        }],
    },
}];