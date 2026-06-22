# primitives/

Atoms — the smallest reusable building blocks, fully tokenized at the H10 look.

Planned (Phase 3): `Button`, `IconButton`, `Input` (+ money input), `Select`,
`MultiSelect`, `Checkbox`, `Radio`/`RadioCard`, `Toggle`, `Chip`/status `Pill`,
`Badge` (program + targeting), `Tooltip` (InfoTip), `Spinner`, `Skeleton`,
`Kbd`, `Divider`, and `icons/` (Lucide wrappers + the ads `builder-icons`).

The existing `apps/web/src/components/ui/*` primitives are **aliased** to these
during migration (Phase 9) — not duplicated.

> **Waves 1–2 shipped:** `Button`, `Pill`, `Badge`, `Input`, `Select`,
> `Checkbox`, `Toggle` (+ `../styles/primitives.css`, `.h10-ds-*`). Remaining:
> Radio/RadioCard · Tooltip/Spinner/Skeleton/Kbd/Divider · icons (MultiSelect +
> Combobox are composite → Phase 4). Sources are mapped in
> `../studies/00-ads-inventory.md`.
