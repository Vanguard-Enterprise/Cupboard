import { expect, test } from "vitest";
import { checkStylesheet, definedFontVariables } from "./ui-check.mjs";

const fonts = definedFontVariables(
  'Archivo({ variable: "--font-archivo" })',
  "--font-sans: var(--font-archivo);",
);

test("stylesheets use color tokens, not raw colors", () => {
  const css = [
    ".a { color: var(--foreground); }",
    ".b { background: color-mix(in srgb, var(--primary) 7%, transparent); }",
    "/* #fff in a comment is fine */",
    ".c { color: #8371cb; box-shadow: 0 0 4px rgb(0 0 0 / 0.5); }",
  ].join("\n");
  const problems = checkStylesheet("src/components/x.module.css", css, fonts);
  expect(problems).toHaveLength(2);
  expect(problems[0]).toMatch(/x\.module\.css:4: #8371cb is a raw color/);
});

test("the token sheet may define colors", () => {
  expect(
    checkStylesheet(
      "src/app/globals.css",
      ":root { --primary: #7cb58d; }",
      fonts,
    ),
  ).toEqual([]);
});

test("font variables must be loaded", () => {
  const problems = checkStylesheet(
    "src/components/x.module.css",
    ".a { font: 10px var(--font-geist-mono); } .b { font-family: var(--font-sans); }",
    fonts,
  );
  expect(problems).toEqual([
    "src/components/x.module.css:1: --font-geist-mono is not a loaded font. Use var(--font-sans) or var(--font-mono).",
  ]);
});
