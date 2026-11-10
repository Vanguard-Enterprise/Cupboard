// UI consistency rules. Tokens and shared components decide how Cupboard
// looks; these rules stop screens from quietly overriding them. Run
// `npx eslint --fix` to apply the mechanical fixes.

const variantPrefix = /^(?:(?:[^:[\]\s]|\[[^\]]*\])+:)+/;
const sides = "(?:-(?:t|r|b|l|s|e|tl|tr|br|bl|ss|se|es|ee))?";
const fontSteps = [
  [10, "text-2xs"],
  [12, "text-xs"],
  [14, "text-sm"],
  [16, "text-base"],
  [18, "text-lg"],
  [20, "text-xl"],
  [24, "text-2xl"],
  [30, "text-3xl"],
  [36, "text-4xl"],
  [48, "text-5xl"],
  [60, "text-6xl"],
];

function nearestFontStep(token) {
  const match = /^text-\[(\d*\.?\d+)(px|rem)\]$/.exec(token);
  if (!match) return null;
  const px = Number(match[1]) * (match[2] === "rem" ? 16 : 1);
  // Round down between steps: an agent reaching for 13px wanted small text.
  let step = fontSteps[0][1];
  for (const [size, name] of fontSteps) if (px >= size - 0.5) step = name;
  return step;
}

const classChecks = [
  {
    id: "color",
    test: /^-?(?:bg|text|border(?:-[trblxyse])?|ring|ring-offset|fill|stroke|outline|shadow|from|via|to|divide|decoration|caret|accent|placeholder)-\[(?:#|rgba?\(|hsla?\(|oklch\(|oklab\(|lab\(|lch\(|color-mix\(|color:(?!(?:Canvas|CanvasText|Highlight|HighlightText|ButtonText|ButtonFace|ButtonBorder|LinkText|GrayText|Field|FieldText|Mark|MarkText|currentColor)\]))/,
    message: "Use a semantic color token instead of a raw color value.",
  },
  {
    id: "color",
    test: /^(?:bg|text|border(?:-[trblxyse])?|ring|ring-offset|fill|stroke|outline|from|via|to|divide|decoration|shadow|caret|accent|placeholder)-(?:white|black|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3})(?:\/\d+)?$/,
    message:
      "Use a semantic color token (primary, warning, destructive, muted-foreground, ...) instead of a palette color.",
  },
  {
    id: "font-size",
    test: /^text-\[(?:\d|\.|calc\(|clamp\(|min\(|max\(|length:)/,
    message:
      "Use the type scale (text-2xs, text-xs, text-sm, text-base, ...) instead of an arbitrary font size.",
    fix: nearestFontStep,
  },
  {
    id: "radius",
    // Named radii outside the allowed set (option `radius`) snap to the
    // largest allowed one.
    named: true,
    test: new RegExp(`^rounded${sides}-(?:xs|sm|md|lg|xl|2xl|3xl|4xl)$`),
    message: "Use an allowed radius",
  },
  {
    id: "radius",
    test: new RegExp(`^rounded${sides}-\\[(?!inherit\\])`),
    message:
      "Use rounded-sm, rounded-md, rounded-lg, or rounded-full instead of an arbitrary radius.",
  },
  {
    id: "weight",
    test: /^font-(?:thin|extralight|light|bold|extrabold|black)$/,
    message: "Use font-normal, font-medium, or font-semibold.",
  },
  {
    id: "case",
    test: /^uppercase$/,
    message: "Use sentence case. Do not set labels in all caps.",
  },
  {
    id: "spacing",
    test: /^-?(?:p|px|py|pt|pb|pl|pr|ps|pe|m|mx|my|mt|mb|ml|mr|ms|me|gap|gap-x|gap-y|space-x|space-y)-\[(?![^\]]*(?:env\(|--spacing\(|%|vw\b|cqw\b))/,
    message: "Use the spacing scale instead of an arbitrary spacing value.",
  },
];

const classCallees = new Set(["cn", "cva", "cx", "clsx"]);

function splitToken(raw) {
  const prefix = (variantPrefix.exec(raw) ?? [""])[0];
  const rest = raw.slice(prefix.length);
  const important = rest.startsWith("!") ? "!" : "";
  const bare = rest.slice(important.length).replace(/!$/, "");
  return { prefix, bare };
}

function rawTokens(text) {
  return text.split(/\s+/).filter(Boolean);
}

// Replace or drop whole class tokens inside a string or template chunk.
function rewrite(text, change) {
  return text.replace(
    /(^|[\s`"'}])([^\s`"'$]+)(?=$|[\s`"'$])/g,
    (all, lead, raw) => {
      const next = change(raw);
      return next === undefined ? all : lead + next;
    },
  );
}

function tidy(text) {
  return text
    .replace(/(["'`}])\s+/, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+(["'`$])/g, (m, end) => (end === "$" ? ` ${end}` : end));
}

function insideClassContext(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === "JSXAttribute")
      return current.name.name === "className";
    if (
      current.type === "CallExpression" &&
      current.callee.type === "Identifier" &&
      classCallees.has(current.callee.name)
    )
      return true;
    if (
      current.type === "Property" &&
      current.key.type === "Identifier" &&
      current.key.name === "className"
    )
      return true;
    if (
      current.type === "Program" ||
      current.type === "FunctionDeclaration" ||
      current.type === "ArrowFunctionExpression"
    )
      return false;
  }
  return false;
}

const classTokensRule = {
  meta: {
    type: "problem",
    fixable: "code",
    docs: { description: "Keep class names on Cupboard's design tokens." },
    // Checks can be switched off by id while a part of the design is undecided:
    // color, font-size, radius, weight, case, spacing.
    schema: [
      {
        type: "object",
        properties: {
          off: { type: "array", items: { type: "string" } },
          radius: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const source = context.sourceCode;
    const off = new Set(context.options[0]?.off ?? []);
    const radius = context.options[0]?.radius ?? ["sm", "md", "lg"];
    const active = classChecks
      .filter((check) => !off.has(check.id))
      .map((check) =>
        check.named
          ? {
              ...check,
              test: {
                test: (token) =>
                  check.test.test(token) &&
                  !radius.includes(token.split("-").pop()),
              },
              message: `Use ${radius.map((size) => `rounded-${size}`).join(", ")}, or rounded-full.`,
              fix: (token) => token.replace(/-[a-z0-9]+$/, `-${radius.at(-1)}`),
            }
          : check,
      );
    function check(node, text) {
      if (!insideClassContext(node)) return;
      for (const raw of rawTokens(text)) {
        const { prefix, bare } = splitToken(raw);
        const found = active.find(({ test }) => test.test(bare));
        if (!found) continue;
        const replacement = found.fix?.(bare);
        context.report({
          node,
          message: `${bare}: ${found.message}`,
          fix: replacement
            ? (fixer) =>
                fixer.replaceText(
                  node,
                  rewrite(source.getText(node), (token) =>
                    token === raw ? prefix + replacement : undefined,
                  ),
                )
            : null,
        });
      }
    }
    return {
      Literal(node) {
        if (typeof node.value === "string") check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value.cooked ?? "");
      },
    };
  },
};

// Shared controls own their height, including the 44 pixels they grow to on
// touch screens. A screen that sets h-11 on one Button makes every other
// screen look wrong next to it.
const sizedControls = new Set([
  "Button",
  "Input",
  "InputFrame",
  "InputGroup",
  "ComboboxInput",
  "SelectTrigger",
  "Toggle",
  "ToggleGroupItem",
  "TabsTrigger",
  "TabsList",
]);
const sizeToken = /^(?:h|min-h|size)-(?:[1-9]|\[)/;
const desktopOrder = ["lg:", "md:", "sm:", ""];

function inferSize(element, removed) {
  if (!["Button", "Toggle", "ToggleGroupItem"].includes(element)) return null;
  for (const prefix of desktopOrder) {
    const token = removed.find(
      (item) => item.prefix === prefix && !item.bare.startsWith("min-h-"),
    );
    if (!token) continue;
    const value = Number(/-(\d+)$/.exec(token.bare)?.[1]);
    if (token.bare.startsWith("size-"))
      return element === "Button"
        ? value <= 7
          ? "icon-xs"
          : value === 8
            ? "icon-sm"
            : "icon"
        : null;
    if (value <= 7) return element === "Button" ? "xs" : "sm";
    if (value === 8) return "sm";
    return null;
  }
  return null;
}

const controlSizeRule = {
  meta: {
    type: "problem",
    fixable: "code",
    docs: { description: "Let shared controls set their own height." },
    schema: [],
  },
  create(context) {
    const source = context.sourceCode;
    return {
      JSXAttribute(node) {
        if (node.name.name !== "className") return;
        const opening = node.parent;
        const element = opening.name;
        if (
          element.type !== "JSXIdentifier" ||
          !sizedControls.has(element.name)
        )
          return;
        const chunks = [];
        const collect = (value) => {
          if (!value) return;
          if (value.type === "Literal" && typeof value.value === "string")
            chunks.push(value);
          else if (value.type === "JSXExpressionContainer")
            collect(value.expression);
          else if (value.type === "TemplateLiteral")
            chunks.push(...value.quasis);
          else if (value.type === "CallExpression")
            value.arguments.forEach(collect);
          else if (value.type === "ConditionalExpression") {
            collect(value.consequent);
            collect(value.alternate);
          } else if (value.type === "LogicalExpression") collect(value.right);
        };
        collect(node.value);
        const removed = [];
        for (const chunk of chunks) {
          const text =
            chunk.type === "Literal" ? chunk.value : (chunk.value.cooked ?? "");
          for (const raw of rawTokens(text)) {
            const parts = splitToken(raw);
            if (sizeToken.test(parts.bare))
              removed.push({ ...parts, raw, chunk });
          }
        }
        if (!removed.length) return;
        const hasSize = opening.attributes.some(
          (attribute) =>
            attribute.type === "JSXAttribute" && attribute.name.name === "size",
        );
        const size = hasSize ? null : inferSize(element.name, removed);
        context.report({
          node,
          message: `${removed.map((item) => item.bare).join(", ")}: ${element.name} sets its own height. Use its size prop instead of overriding it.`,
          fix(fixer) {
            const fixes = [];
            for (const chunk of new Set(removed.map((item) => item.chunk))) {
              const drop = new Set(
                removed
                  .filter((item) => item.chunk === chunk)
                  .map((item) => item.raw),
              );
              const next = tidy(
                rewrite(source.getText(chunk), (token) =>
                  drop.has(token) ? "" : undefined,
                ),
              );
              if (chunk === node.value && (next === '""' || next === "''")) {
                // The whole className was heights: drop it, or swap it for
                // the size prop in the same place.
                fixes.push(
                  fixer.replaceTextRange(
                    [source.getTokenBefore(node).range[1], node.range[1]],
                    size ? ` size="${size}"` : "",
                  ),
                );
                return fixes;
              }
              fixes.push(fixer.replaceText(chunk, next));
            }
            if (size)
              fixes.push(fixer.insertTextAfter(element, ` size="${size}"`));
            return fixes;
          },
        });
      },
    };
  },
};

const plugin = {
  rules: {
    "class-tokens": classTokensRule,
    "control-size": controlSizeRule,
  },
};

export default plugin;
