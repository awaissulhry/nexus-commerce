# components/

Molecules — composed, reusable components lifted from `/marketing/ads` and
generalized (ads-specific assumptions stripped) so they work platform-wide.

Planned (Phase 4): `DataGrid` (the universal grid), `FilterDropdown` family +
`HoverCard`, `Modal`/`Drawer`/`Popover`/`Menu`, `Tabs`, `Card`, `Toast`,
`EmptyState`, `Pagination`, `DateRangePicker`, `SearchInput`, `ProgressBar`,
charts (`PerformanceGraph`, `Heatmap`), `MetricStrip`/KPI tiles.

`/marketing/ads` imports these back (or via a thin shim) and must render
identically afterward.

> **Waves 1–3 shipped:** `Card`, `EmptyState`, `Tabs`, `Pagination`,
> `ProgressBar`, `Modal`, `Drawer`, `Menu`, `ToastProvider`/`useToast`,
> `MultiSelect`, `Combobox` (+ `useClickAway`, `../styles/components.css`).
> Remaining: `HoverCard`, `DateRangePicker`, charts (`PerformanceGraph`/
> `Heatmap`), `MetricStrip`, and the `DataGrid` centerpiece.
