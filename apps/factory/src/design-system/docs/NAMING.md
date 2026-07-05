# Naming conventions

## CSS class prefix — `.h10-*` (transitional)

The extracted CSS keeps its `.h10-*` prefix **for now**. This is deliberate:

- Zero churn during extraction; no collisions with live ads WIP.
- The rename is a single mechanical codemod once the system is stable.

**Planned (Phase 9):** `.h10-*` → a neutral platform prefix (`.nx-*`) via codemod
across `styles/` + all consumers, in one reviewed sweep. Until then, treat
`.h10-` as "Nexus DS" — not a feature-scoped name.

Do **not** introduce new prefixes. New classes use `.h10-` to stay consistent
until the rename.

**Component sub-namespace.** DS primitive/component styles use `.h10-ds-*`
(e.g. `.h10-ds-btn`, `.h10-ds-pill`, `.h10-ds-badge`) so they never collide with
the route-scoped `.h10-*` utility classes in `ads.css`. Still under the `h10`
umbrella; both are renamed together in Phase 9.

## Token naming

`--<tier>-<role>[-<variant>][-<state>]`, lower-kebab.

- **Primitive (raw ramp):** `--h10-blue-600`, `--h10-grey-100` (raw scale; **not**
  consumed by component CSS directly — a `var(--h10-*-NNN)` reach in a `.h10-ds-*`
  rule is a defect).
- **Semantic (live):** `--text-primary`, `--text-secondary`, `--text-tertiary`,
  `--text-disabled`, `--text-link`, `--surface-canvas`, `--surface-card`,
  `--surface-sunken`, `--border-subtle`, `--border-default`, `--border-strong`,
  `--status-{success,warning,danger,info}-{soft,line,strong}`, `--color-primary`,
  `--color-primary-soft`. These are the platform's existing semantic names, so
  both systems share one vocabulary.
- **Component (DS-only):** the knobs the semantic layer doesn't express stay under
  `--h10-*` — `--h10-radius-*`, `--h10-shadow-*`, `--h10-focus-ring`,
  `--h10-pill-*`, `--h10-badge-*`, `--h10-targeting-*`, `--h10-rail-*`,
  `--h10-row-nav`, `--h10-icon-zone`, plus DS-only roles like `--h10-text-strong`
  / `--h10-surface-raised`.

### Semantic layer — LIVE

The platform-semantic tier is **wired**, not aspirational: `styles/tokens.css`
declares each `--text-*` / `--surface-*` / `--border-*` / `--status-*` /
`--color-primary` as a **value-preserving alias** over the corresponding
`--h10-*` role (e.g. `--text-secondary: var(--h10-text-2)`,
`--status-danger-soft: var(--h10-danger-soft)`), and **every** component CSS rule
consumes the alias. `--h10-*` is now strictly the layer **underneath** —
the raw colour ramp + the DS-only component tokens. The full alias map lives in
`docs/AUDIT.md` §2 and `docs/TOKEN-RECONCILIATION.md`. (`/marketing/ads` keeps
reading `--h10-*` directly and is unaffected.)

## Component & file naming

- Components: `PascalCase`; one component per file; filename == component name
  (`Button.tsx` exports `Button`).
- Hooks: `useThing.ts`.
- Pure helpers/types: `camelCase.ts` / `kebab-model.ts` (match existing, e.g.
  `rank-grid-model.ts`).
- Barrels: each folder ships an `index.ts` re-exporting its public surface.

## Folder conventions

- `tokens/`, `primitives/`, `components/`, `patterns/`, `styles/`, `catalog/`,
  `studies/`, `docs/` — see root `README.md`.
- Co-locate a component's sub-parts in a folder when it grows beyond ~1 file;
  keep page-specific one-offs out of the system (they belong in the feature's
  own `_shared/`).

## Imports

- Inside the system: **relative** imports (keeps the folder portable).
- From the app: `@/design-system/<area>` via the barrel.
- Icons: `lucide-react` is the default set; custom SVGs live in
  `primitives/icons/` (the ads `builder-icons.tsx` lands here).
