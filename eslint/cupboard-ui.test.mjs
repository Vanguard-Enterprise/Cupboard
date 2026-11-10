import { RuleTester } from "eslint";
import { describe, it } from "vitest";
import plugin from "./cupboard-ui.mjs";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

tester.run("class-tokens", plugin.rules["class-tokens"], {
  valid: [
    '<div className="rounded-lg bg-card text-sm font-semibold" />',
    '<div className="pb-[max(1rem,env(safe-area-inset-bottom))]" />',
    'cn("forced-colors:text-[HighlightText]", "rounded-[inherit]")',
    {
      code: '<div className="rounded-xl text-[13px]" />',
      options: [{ off: ["radius", "font-size"] }],
    },
    // Strings outside class names are not class names.
    'const label = "uppercase";',
  ],
  invalid: [
    {
      code: '<p className="md:text-[13px] text-muted-foreground" />',
      output: '<p className="md:text-xs text-muted-foreground" />',
      errors: 1,
    },
    {
      code: 'cn("rounded-xl border", open && "rounded-b-2xl")',
      output: 'cn("rounded-lg border", open && "rounded-b-lg")',
      errors: 2,
    },
    {
      code: "<div className={`bg-[#0d0e0f] ${x}`} />",
      errors: [{ message: /raw color/ }],
    },
    {
      code: '<span className="text-red-500" />',
      errors: [{ message: /semantic/ }],
    },
    { code: '<h2 className="uppercase font-bold" />', errors: 2 },
    { code: '<div className="mt-[13px]" />', errors: [{ message: /spacing/ }] },
  ],
});

tester.run("control-size", plugin.rules["control-size"], {
  valid: [
    '<Button size="sm" className="w-full" />',
    '<div className="h-11" />',
    '<Input className="min-h-0" />',
  ],
  invalid: [
    {
      code: '<Button className="h-11 w-full sm:h-9">Save</Button>',
      output: '<Button className="w-full">Save</Button>',
      errors: 1,
    },
    {
      code: '<Button variant="ghost" className="h-8 px-2">Edit</Button>',
      output:
        '<Button size="sm" variant="ghost" className="px-2">Edit</Button>',
      errors: 1,
    },
    {
      code: '<Button className="size-8 [@media(any-pointer:coarse)]:size-11" />',
      output: '<Button size="icon-sm" />',
      errors: 1,
    },
    {
      code: '<Input className={cn("h-11", invalid && "border-destructive")} />',
      output: '<Input className={cn("", invalid && "border-destructive")} />',
      errors: 1,
    },
  ],
});
