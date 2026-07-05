# Accessibility

The standards every DS component meets. Cross-cutting motion + focus live in
`../styles/a11y.css`; per-component ARIA/keyboard live in the components.

## Focus
- Every interactive element shows a visible `:focus-visible` ring
  (`--h10-focus-ring`). Patterns without their own ring inherit it via
  `a11y.css`.
- Focus order follows DOM order; overlays (Modal/Drawer/Builder) trap visually
  via the backdrop and close on Esc.

## Keyboard
- **Esc** closes overlays (Modal, Drawer, Builder) and dropdowns (Menu,
  MultiSelect, Combobox).
- **Outside-click** closes Menu / MultiSelect / Combobox (`useClickAway`).
- Sortable DataGrid headers, Tabs, Pagination, nav items are real `<button>`s
  (Enter / Space).
- Toggle is a `role="switch"` button (Space/Enter); Checkbox/Radio are native.

## ARIA (applied per component)
`dialog`/`aria-modal` (Modal, Drawer, Builder) · `switch`/`aria-checked` (Toggle)
· `tablist`/`tab`/`aria-selected` (Tabs) · `menu`/`menuitem` + `aria-haspopup`/
`aria-expanded` (Menu) · `listbox`/`option` + `aria-multiselectable` (MultiSelect/
Combobox) · `progressbar` + `aria-valuenow/min/max` (ProgressBar) · `status`
(Spinner, Toast) · `tooltip` (Tooltip, HoverCard) · `aria-current` (nav, paging).

## Motion
`prefers-reduced-motion: reduce` neutralizes DS animations + transitions
(`a11y.css`). Durations otherwise stay fast (120–200ms).

## Contrast — WCAG AA
Target 4.5:1 body / 3:1 large+UI. The H10 palette mostly passes; the audit
(`../studies/02-contrast-audit.md`) flags **`--h10-text-3` (~3.2:1)** as
secondary/large-only — **use `--h10-text-2` for body copy**. Phase 7 lint encodes
this rule.

## Targets
Nav rows 44px; controls ≥30px; modal/drawer close hit-area padded. (Checkboxes
are native 15px — paired with a full-width clickable `<label>`.)
