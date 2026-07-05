// Theme picker: a radio group over the shared theme catalog (which mirrors the tenant
// service's ALLOWED_THEMES).
import { THEME_CHOICES } from "@/themes/catalog";

export function ThemePicker({ defaultValue }: { defaultValue: string }) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-xs text-neutral-400">Theme</legend>
      <div className="flex flex-wrap gap-3">
        {THEME_CHOICES.map((theme) => (
          <label
            key={theme.id}
            className="flex items-center gap-2 rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100"
          >
            <input
              type="radio"
              name="theme_id"
              value={theme.id}
              defaultChecked={defaultValue === theme.id}
              className="h-4 w-4"
            />
            {theme.name}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
