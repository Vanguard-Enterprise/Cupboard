"use client";

import { useState } from "react";

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

// A color input paired with a hex text fallback; the two stay in sync via local state.
// Only the text input carries `name` so the form submits a single value.
export function ColorField({
  label,
  name,
  defaultValue,
}: {
  label: string;
  name: string;
  defaultValue: string;
}) {
  const [value, setValue] = useState(defaultValue);
  return (
    <label className="flex flex-col gap-1 text-xs text-neutral-400">
      {label}
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={HEX_RE.test(value) ? value : "#000000"}
          onChange={(e) => setValue(e.target.value)}
          aria-label={`${label} picker`}
          className="h-9 w-9 rounded border border-neutral-700 bg-neutral-900 p-1"
        />
        <input
          name={name}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={defaultValue}
          className="w-28 rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100"
        />
      </div>
    </label>
  );
}
