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

## Token naming

`--<tier>-<role>[-<variant>][-<state>]`, lower-kebab.

- **Primitive:** `--h10-blue-600`, `--h10-grey-100` (raw scale; not consumed by
  components directly).
- **Semantic:** `--text-primary`, `--text-secondary`, `--surface-canvas`,
  `--surface-card`, `--border-subtle`, `--border-default`, `--border-strong`,
  `--status-success-soft|line|strong`, `--color-primary`. These reuse the
  platform's existing semantic names so both systems share one vocabulary.
- **Component:** `--grid-row-height`, `--modal-width`, `--rail-width` (only when
  the semantic layer can't express it).

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
