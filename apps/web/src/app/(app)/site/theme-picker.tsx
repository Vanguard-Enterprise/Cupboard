// Theme picker: a radio group over the themes the tenant service accepts (mirrors
// services/tenant/src/domain/sites.rs ALLOWED_THEMES and src/themes/registry.ts). Only
// "ember" exists today; add more themes to this list alongside those two places.
const THEMES = [{ id: "ember", name: "Ember" }];

export function ThemePicker({ defaultValue }: { defaultValue: string }) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-xs text-neutral-400">Theme</legend>
      <div className="flex flex-wrap gap-3">
        {THEMES.map((theme) => (
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
