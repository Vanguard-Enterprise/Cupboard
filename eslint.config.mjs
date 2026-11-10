import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import cupboardUi from "./eslint/cupboard-ui.mjs";

const nativeMenu =
  "Use the shared Select, Combobox, DatePicker, or TimeField from src/components/ui. Browser-native menus and pickers are not allowed.";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["src/hooks/use-mobile.ts"],
    rules: {
      "react-hooks/set-state-in-effect": "off",
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/**/*.test.{ts,tsx}", "src/test/**"],
    plugins: { "cupboard-ui": cupboardUi },
    rules: {
      "cupboard-ui/class-tokens": [
        "error",
        { radius: ["xs", "sm", "md", "lg", "xl"] },
      ],
      "cupboard-ui/control-size": "error",
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXOpeningElement[name.name='select']",
          message: nativeMenu,
        },
        {
          selector: "JSXOpeningElement[name.name='datalist']",
          message: nativeMenu,
        },
        {
          selector:
            "JSXOpeningElement[name.name='input'] > JSXAttribute[name.name='type'][value.value=/^(date|time|datetime-local|month|week)$/]",
          message: nativeMenu,
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "dist/**",
    "out/**",
    "build/**",
    "coverage/**",
    // Local, gitignored agent artifacts (capture and review scripts).
    ".dev-stack/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
