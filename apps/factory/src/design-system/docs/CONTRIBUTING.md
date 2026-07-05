# Contributing

How to add to the design system without creating drift.

## Extending the design system with every build

**Standing rule.** Every new platform feature is **composed FROM** the design
system, and any reusable UI a feature needs is **contributed BACK** here as a
primitive / component / pattern — never hand-rolled as a one-off in the feature
folder. The DS is the source of ideas: before building a screen, shop the
inventory below for what already exists; build the screen out of those parts.

Concretely, when you build anything:

1. **Compose, don't reinvent.** Reach for an existing primitive/component/pattern
   first. If 80% of what you need exists, use it and extend it — don't fork.
2. **Maximize shared components.** If you find yourself writing UI a second
   feature could want (a chip, a panel, an overlay, a control), it belongs in the
   DS. Promote it here — generalized, tokenized, cataloged — and import it back
   into the feature.
3. **Keep it platform-consistent.** New UI uses `.h10-ds-*` classes + the
   **semantic** tokens (`--text-*` / `--surface-*` / `--border-*` / `--status-*` /
   `--color-primary`); no raw hex, no raw `--h10-*-NNN` ramp, no raw Tailwind
   palette. One `Tone` vocabulary (`neutral · info · success · warning · danger`),
   one `Size` scale (`sm · md · lg · xl`), `variant` only for emphasis.
4. **Page-specific one-offs stay out** of the system — they live in the feature's
   own `_shared/`. The bar for "reusable" is "a second feature would want it."

The system grows by accretion: each feature both *consumes* the DS and *feeds* it.
That is how the look stays uniform across the ~290 pages as they rebuild onto it.

### What already exists — shop here first

**Primitives (19)** — `primitives/index.ts`

| Component | Purpose |
|---|---|
| `Button` | Primary / secondary / ghost action (`variant` × `size` sm·md) |
| `Pill` | Entity *status* chip (Active→success · Paused→warning · Archived→neutral · Error→danger), `tone` |
| `Badge` | Ad-*program* chip (SP / SD / SB / Auto / Manual), `program: AdProgram` |
| `Tag` | Neutral / semantic metadata chip for everything else you label inline (`tone`) |
| `Input` | Text field — plain / leading-icon / `€`-prefix / `%`-suffix |
| `Textarea` | Multi-line text field |
| `Select` | Styled native `<select>` + chevron |
| `Checkbox` | Accent-tinted native checkbox with optional label |
| `Toggle` | `role="switch"` on/off control |
| `Radio` | Native radio with optional label |
| `RadioCard` | Selectable card (border + wash when chosen) — the rich radio |
| `Tooltip` | Hover/focus bubble around a child |
| `Spinner` | Indeterminate ring spinner (`size` in px) |
| `Skeleton` | Shimmering loading placeholder |
| `Kbd` | Keyboard-key chip (⌘, K) |
| `Divider` | Hairline rule (horizontal / vertical) |
| `TagInput` | Editable chip list — type-to-add, suggestions, remove |
| `SegmentedControl` | Compact 2–4-way single-select toggle (List/Board, Live/Official) |
| `ToolbarButton` / `ToolbarDivider` | Icon button (tooltip + shortcut + count badge) + 1px group separator |

**Components (21)** — `components/index.ts`

| Component | Purpose |
|---|---|
| `Card` | Panel + optional header / header-action slot |
| `EmptyState` | Icon + title + description + CTA for empty/zero views |
| `Tabs` | Underline-indicator tab strip (controlled) |
| `Pagination` | Windowed page list with ellipses + prev/next |
| `ProgressBar` | Determinate + indeterminate progress |
| `Modal` | Centered dialog (`size` sm·md·lg·xl; Esc + backdrop close) |
| `Drawer` | Right slide-over dialog |
| `Menu` | Anchored dropdown menu (outside-click close, disabled items) |
| `Toast` | `ToastProvider` + `useToast()` portaled notifications (`tone`) |
| `MultiSelect` | Checkbox dropdown — All / N-selected + select-all |
| `Combobox` | Single-select typeahead (filter + pick) |
| `MetricStrip` | Row of KPI tiles with up/down deltas |
| `HoverCard` | Rich hover/focus panel |
| `DateRangePicker` | Dual-month calendar + preset rail, two-click range |
| `PerformanceGraph` | Recharts dual-axis line chart, tokenized |
| `Heatmap` | Intensity grid (cell opacity scales with value) |
| `DataGrid<T>` | Generic sortable/selectable table with sticky header + totals |
| `ImageUpload` | Image dropzone — preview, criteria panel, format/size/dimension validation |
| `Banner` | Inline status banner (`tone`; `role="alert"` for danger) |
| `Stepper` | Numbered step progress (`<ol>`, current/done/upcoming) |
| `FileDropzone` | Generic file drop + click-to-pick with type/size guard |
| `useClickAway` | Shared outside-click hook (utility) |

**Patterns (8)** — `patterns/index.ts`

| Pattern | Purpose |
|---|---|
| `AppShell` | The H10 nav rail (icon rail hover-expands; groups + items + footer) + `<main>` |
| `PageHeader` | Eyebrow + title + subtitle + actions for a top-level page |
| `DetailHeader` | Back link + badge + title + actions for a detail view |
| `FilterPanel` / `FilterField` | Collapsible filter accordion (presets + responsive field grid + reset/apply) |
| `BulkActionBar` | Sticky "N selected" + actions + Clear (renders nothing at 0) |
| `EditModeBar` | Sticky discard/apply bar for unsaved edits |
| `Builder` | Full-screen wizard — top bar + scroll-spy left nav + scrolling sections |
| `ColumnCustomizer` | Column visibility + reorder inside a Modal (draft-then-Apply) |

> The exhaustive map (props, tone/size axis, catalog + a11y coverage per
> component) is `docs/AUDIT.md`; the `/marketing/ads` source inventory is
> `studies/00-ads-inventory.md`.

## Golden rules

1. **Never hardcode a value.** Color, size, radius, shadow, duration, z-index →
   a token. If the token doesn't exist, add it to `tokens/` first.
2. **Reuse before you build.** Check `primitives/` and `components/` (and the
   inventory in `studies/00-ads-inventory.md`) before writing anything new.
3. **One concept, one home.** Don't add a second button/modal/select. Extend the
   existing one or reconcile.
4. **Match the surrounding code.** Comment density, naming, and idiom should read
   like the file next to it.
5. **Keep it portable.** No hard dependency that breaks if the folder is copied
   out; relative imports inside the system.

## Adding a **token**

1. Add the value to the right tier in `tokens/` (primitive → semantic →
   component). Reuse an existing semantic alias if the role already exists.
2. Add the CSS-var row to `tokens/css-vars.ts` (hex lives in `tokens/colors.ts`,
   referenced once) — then **`npm run tokens:gen`** rewrites `styles/tokens.css`.
   **Do not hand-edit `tokens.css`** (it's GENERATED); `npm run tokens:check`
   fails CI if it's stale.
3. Record the mapping in `docs/TOKEN-RECONCILIATION.md` if it comes from an H10
   hardcoded value.
4. Surface it in the catalog token section.

## Adding a **primitive / component / pattern**

1. Find its source in `/marketing/ads` via the inventory; note its current
   `.h10-*` classes and props.
2. Lift it into the right folder; replace hardcoded values with tokens.
3. **Generalize**: strip ads-specific assumptions (campaign fields, hardcoded
   labels) so it's reusable platform-wide.
4. Keep `/marketing/ads` working — have it import the new home (or a thin shim).
5. Add a catalog example covering every state (default/hover/focus/disabled/
   loading/empty/error as applicable).
6. Run the Definition of Done checklist in `GOVERNANCE.md`.

## Adding a **study**

Copy `studies/_TEMPLATE.md` to `studies/NN-<feature>.md`, fill it in, and add it
to the index in `studies/README.md`.

## Verifying

```bash
# from repo root
npx tsc -p apps/web --noEmit         # types
npm run build --workspace apps/web   # structural (or next build)
```

Then the visual gate: render in the catalog, screenshot-diff at native res vs
the H10 reference, measure alignment/borders/spacing numerically, and confirm
`/marketing/ads` is unchanged. Verify on the live deploy (Vercel/Railway), not a
local scratch DB.

## Committing

Commit + push after each verified unit of work. On a shared tree with concurrent
sessions, stage explicitly and use `git commit --only <paths>` to avoid index
collisions. Don't bundle unrelated changes.
