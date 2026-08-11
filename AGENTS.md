# Cupboard UI conventions

- Reuse the installed shadcn components in `apps/web/src/components/ui` before creating
  any new UI primitive. Do not hand-roll buttons, dialogs, menus, inputs, tables, cards,
  tooltips, navigation, or equivalent controls when an installed component covers it.
- `apps/web/components.json` is authoritative. Keep `rtl: true`, the Radix Nova style,
  CSS-variable theming, Lucide icons, and pointer cursor support enabled.
- Add or refresh official components from `apps/web` with
  `npx shadcn@latest add <component>`; use `--all` when intentionally refreshing the
  complete catalog. Preserve local product-level compositions outside the `ui` folder.
- Cupboard brand tokens live in `apps/web/src/app/globals.css`. Use semantic tokens such
  as `bg-background`, `bg-card`, `text-foreground`, and `text-muted-foreground` instead
  of introducing one-off palette values. Mirror those variables in non-React frontends.
- All new layouts and interactions must work in both `dir="ltr"` and `dir="rtl"`. Prefer
  logical spacing/alignment utilities (`ms`, `me`, `ps`, `pe`, `start`, `end`) and keep
  the direction provider intact.
- The shared shadcn `Card` has a default flex gap between its children. When a
  `CardHeader` sits directly above `CardContent` containing a table or other flush
  surface, use `className="gap-0"` on that card to avoid an unintended blank strip.

# Local development stack

- When the user asks to start, spin up, restart, or check the local Cupboard stack, use
  `./scripts/dev-stack.sh start`, `restart`, or `status` from the repository root. Do
  not assemble an ad-hoc set of background commands.
- The launcher keeps PostgreSQL and Redis in Podman, runs every Rust service through
  `cargo watch`, runs the dashboard with Next.js development mode, and runs the
  marketing server with Node watch mode. It binds all HTTP services to `0.0.0.0` and
  prints the detected LAN/NetBird URLs after startup.
- The Discord bot joins the hot-reload stack when `DISCORD_BOT_TOKEN` is present in
  `.dev-stack/stack.env`; otherwise the launcher reports that it was skipped. Never
  print or commit that private environment file.
- Use `./scripts/dev-stack.sh logs <component>` for diagnostics and
  `./scripts/dev-stack.sh stop` to stop application watchers. Use `down` only when the
  user also wants the PostgreSQL and Redis containers stopped; data volumes are kept.
