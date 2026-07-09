"use client";

import { useActionState } from "react";
import { updateSiteAction } from "@/lib/actions";
import { ColorField } from "./color-field";
import { LinkFields } from "./link-fields";
import type { Site } from "./page";
import { ThemePicker } from "./theme-picker";

// Full edit surface: slug, theme, publish state, and the structured config editor.
// Everything submits together via updateSiteAction, which rebuilds the whole config
// object server-side (the API replaces config wholesale, not field-by-field).
export function SiteEditor({ site, defaultHost }: { site: Site; defaultHost: string }) {
  const [state, action, pending] = useActionState(updateSiteAction, {});
  const config = site.config;

  return (
    <form action={action} className="flex flex-col gap-6">
      <section className="rounded border border-neutral-800 p-5">
        <h2 className="text-base font-medium text-neutral-100">Public URL</h2>
        <p className="mt-2 text-sm">
          <a
            href={`https://${defaultHost}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-indigo-400 hover:underline"
          >
            https://{defaultHost}
          </a>
        </p>
        <p className="mt-1 text-xs text-neutral-500">
          Edits can take up to a minute to appear (cache).
        </p>
      </section>

      <section className="flex flex-col gap-4 rounded border border-neutral-800 p-5">
        <label className="flex flex-col gap-1 text-xs text-neutral-400">
          Slug
          <input
            name="slug"
            required
            minLength={3}
            maxLength={40}
            pattern="[a-z0-9][a-z0-9-]*[a-z0-9]"
            defaultValue={site.slug}
            className="w-64 rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100"
          />
        </label>
        <p className="text-xs text-yellow-400">
          Changing the slug changes your site&apos;s URL.
        </p>
        <ThemePicker defaultValue={site.theme_id} />
        <label className="flex items-center gap-2 text-sm text-neutral-300">
          <input type="checkbox" name="published" defaultChecked={site.published} className="h-4 w-4" />
          Published
        </label>
      </section>

      <section className="flex flex-col gap-4 rounded border border-neutral-800 p-5">
        <h2 className="text-base font-medium text-neutral-100">Content</h2>
        <label className="flex flex-col gap-1 text-xs text-neutral-400">
          Site name
          <input
            name="name"
            defaultValue={config.name ?? ""}
            placeholder={site.slug}
            className="w-72 rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-neutral-400">
          Logo URL
          <input
            name="logo_url"
            defaultValue={config.logo_url ?? ""}
            placeholder="https://.../logo.png"
            className="w-96 rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100"
          />
        </label>
        <div className="flex flex-wrap gap-4">
          <ColorField
            label="Primary color"
            name="color_primary"
            defaultValue={config.colors?.primary || "#f97316"}
          />
          <ColorField
            label="Background color"
            name="color_background"
            defaultValue={config.colors?.background || "#0a0a0a"}
          />
          <ColorField
            label="Foreground color"
            name="color_foreground"
            defaultValue={config.colors?.foreground || "#fafafa"}
          />
        </div>
        <label className="flex flex-col gap-1 text-xs text-neutral-400">
          Hero title
          <input
            name="hero_title"
            defaultValue={config.hero?.title ?? ""}
            placeholder={`Welcome to ${site.slug}`}
            className="w-96 rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-neutral-400">
          Hero subtitle
          <input
            name="hero_subtitle"
            defaultValue={config.hero?.subtitle ?? ""}
            className="w-96 rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-neutral-400">
          About
          <textarea
            name="about"
            defaultValue={config.about ?? ""}
            rows={4}
            className="w-full max-w-2xl rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100"
          />
        </label>
        <LinkFields initial={config.links ?? []} />
      </section>

      <div className="flex flex-col gap-2">
        <div>
          <button
            type="submit"
            disabled={pending}
            className="rounded bg-indigo-600 px-3 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
          >
            {pending ? "Saving…" : "Save changes"}
          </button>
        </div>
        {state.error && <p className="text-sm text-red-400">{state.error}</p>}
        {state.ok && <p className="text-sm text-green-400">Saved.</p>}
      </div>
    </form>
  );
}
