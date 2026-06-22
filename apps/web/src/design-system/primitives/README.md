# primitives/

Atoms — the smallest reusable building blocks, fully tokenized at the H10 look.

Planned (Phase 3): `Button`, `IconButton`, `Input` (+ money input), `Select`,
`MultiSelect`, `Checkbox`, `Radio`/`RadioCard`, `Toggle`, `Chip`/status `Pill`,
`Badge` (program + targeting), `Tooltip` (InfoTip), `Spinner`, `Skeleton`,
`Kbd`, `Divider`, and `icons/` (Lucide wrappers + the ads `builder-icons`).

The existing `apps/web/src/components/ui/*` primitives are **aliased** to these
during migration (Phase 9) — not duplicated.

> **Wave 1 shipped:** `Button`, `Pill`, `Badge` (+ `../styles/primitives.css`,
> `.h10-ds-*`). Remaining waves: Input/Select/MultiSelect · Checkbox/Radio/Toggle
> · Tooltip/Spinner/Skeleton/Kbd/Divider · icons. Sources are mapped in
> `../studies/00-ads-inventory.md`.
