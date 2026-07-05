# primitives/

Atoms — the smallest reusable building blocks, fully tokenized at the H10 look.

Planned (Phase 3): `Button`, `IconButton`, `Input` (+ money input), `Select`,
`MultiSelect`, `Checkbox`, `Radio`/`RadioCard`, `Toggle`, `Chip`/status `Pill`,
`Badge` (program + targeting), `Tooltip` (InfoTip), `Spinner`, `Skeleton`,
`Kbd`, `Divider`, and `icons/` (Lucide wrappers + the ads `builder-icons`).

The existing `apps/web/src/components/ui/*` primitives are **aliased** to these
during migration (Phase 9) — not duplicated.

> **Phase 3 complete — all 14 primitives shipped:** `Button`, `Pill`, `Badge`,
> `Input`, `Select`, `Checkbox`, `Toggle`, `Radio`, `RadioCard`, `Tooltip`,
> `Spinner`, `Skeleton`, `Kbd`, `Divider` (+ `../styles/primitives.css`,
> `.h10-ds-*`). Lucide is the icon standard (see `icons/`). The searchable/portal
> dropdowns (MultiSelect/Combobox), the adaptive InfoTip, and the custom
> builder-icons land in Phase 4 / the migration.
