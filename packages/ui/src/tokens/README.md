# tokens/

The single source of truth for all design **values**, as TypeScript. Wires into
`../styles/tokens.css` (CSS vars) and `apps/web/tailwind.config.ts` (utilities).

**Tiers:** `primitive → semantic → component` (see `../docs/TOKENS.md`).
Components consume the **semantic** tier only — never primitives, never raw hex.

Planned files (Phase 1): `colors.ts`, `typography.ts`, `spacing.ts`,
`radius.ts`, `shadow.ts`, `motion.ts`, `zindex.ts`, `breakpoints.ts`, `index.ts`.

> Empty until **Phase 1**. Values come from `../docs/TOKEN-RECONCILIATION.md`.
