// UI consistency checks for what ESLint cannot see: stylesheets. Colors and
// fonts are defined once in src/app/globals.css and src/app/layout.tsx; every
// other stylesheet uses them through var(--token).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const tokenSheet = "src/app/globals.css";
const rawColor =
  /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/g;

export function definedFontVariables(layout, globals) {
  const names = new Set();
  for (const match of layout.matchAll(/variable:\s*"(--font-[\w-]+)"/g))
    names.add(match[1]);
  for (const match of globals.matchAll(/(--font-[\w-]+)\s*:/g))
    names.add(match[1]);
  return names;
}

export function checkStylesheet(file, css, fonts, { colors = true } = {}) {
  const problems = [];
  const lines = css.split("\n");
  let inComment = false;
  lines.forEach((text, index) => {
    // Comments may mention colors; only declarations count.
    let code = "";
    for (let i = 0; i < text.length; i++) {
      if (!inComment && text.startsWith("/*", i)) {
        inComment = true;
        i++;
      } else if (inComment && text.startsWith("*/", i)) {
        inComment = false;
        i++;
      } else if (!inComment) code += text[i];
    }
    if (colors && file !== tokenSheet)
      for (const match of code.matchAll(rawColor))
        problems.push(
          `${file}:${index + 1}: ${match[0]} is a raw color. Use var(--token) or color-mix() with a token, and add new colors to ${tokenSheet}.`,
        );
    for (const match of code.matchAll(/var\((--font-[\w-]+)/g))
      if (!fonts.has(match[1]))
        problems.push(
          `${file}:${index + 1}: ${match[1]} is not a loaded font. Use var(--font-sans) or var(--font-mono).`,
        );
  });
  return problems;
}

function main() {
  const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "src/**.css"],
    {
      encoding: "utf8",
    },
  )
    .split("\n")
    .filter(Boolean);
  const fonts = definedFontVariables(
    readFileSync("src/app/layout.tsx", "utf8"),
    readFileSync(tokenSheet, "utf8"),
  );
  const problems = files.flatMap((file) =>
    checkStylesheet(file, readFileSync(file, "utf8"), fonts),
  );
  if (problems.length) {
    console.error(problems.join("\n"));
    console.error(`\nUI check failed: ${problems.length} problem(s).`);
    process.exitCode = 1;
  } else console.log(`UI check passed for ${files.length} stylesheet(s).`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
