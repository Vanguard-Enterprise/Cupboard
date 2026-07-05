"use client";

import { useRef, useState } from "react";

type LinkRow = { id: number; label: string; url: string };

// Editable list of nav links (label + URL). Renders bare `link_label`/`link_url`
// inputs directly into the parent <form> so they submit as a positional pair; rows
// with an empty label or url are dropped server-side when the config is built.
export function LinkFields({ initial }: { initial: { label?: string; url?: string }[] }) {
  const nextId = useRef(initial.length);
  const [rows, setRows] = useState<LinkRow[]>(() =>
    initial.map((l, i) => ({ id: i, label: l.label ?? "", url: l.url ?? "" })),
  );

  function addRow() {
    setRows((prev) => [...prev, { id: nextId.current++, label: "", url: "" }]);
  }
  function removeRow(id: number) {
    setRows((prev) => prev.filter((r) => r.id !== id));
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs text-neutral-400">Links</span>
      {rows.map((row) => (
        <div key={row.id} className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs text-neutral-400">
            Label
            <input
              name="link_label"
              defaultValue={row.label}
              placeholder="Discord"
              className="w-40 rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-400">
            URL
            <input
              name="link_url"
              defaultValue={row.url}
              placeholder="https://discord.gg/..."
              className="w-64 rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100"
            />
          </label>
          <button
            type="button"
            onClick={() => removeRow(row.id)}
            className="rounded bg-neutral-800 px-3 py-2 text-sm hover:bg-neutral-700"
          >
            Remove
          </button>
        </div>
      ))}
      <div>
        <button
          type="button"
          onClick={addRow}
          className="rounded bg-neutral-800 px-3 py-2 text-sm hover:bg-neutral-700"
        >
          Add link
        </button>
      </div>
    </div>
  );
}
