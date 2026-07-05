# components/

Molecules — composed, reusable components lifted from `/marketing/ads` and
generalized (ads-specific assumptions stripped) so they work platform-wide.

Planned (Phase 4): `DataGrid` (the universal grid), `FilterDropdown` family +
`HoverCard`, `Modal`/`Drawer`/`Popover`/`Menu`, `Tabs`, `Card`, `Toast`,
`EmptyState`, `Pagination`, `DateRangePicker`, `SearchInput`, `ProgressBar`,
charts (`PerformanceGraph`, `Heatmap`), `MetricStrip`/KPI tiles.

`/marketing/ads` imports these back (or via a thin shim) and must render
identically afterward.

> **Phase 4 COMPLETE — all 17 composites shipped:** `Card`, `EmptyState`,
> `Tabs`, `Pagination`, `ProgressBar`, `Modal`, `Drawer`, `Menu`,
> `ToastProvider`/`useToast`, `MultiSelect`, `Combobox`, `MetricStrip`,
> `HoverCard`, `DateRangePicker`, `PerformanceGraph`, `Heatmap`, `DataGrid`
> (+ `useClickAway`, `../styles/components.css`). Next: Phase 5 patterns
> (AppShell / PageHeader / Builder framework) consume these.

## ⚠ Modals & dialogs — always use `<Modal>` (do NOT hand-roll)

Every popup/dialog **must** use `<Modal>` from this directory — never a bespoke
`<div className="...-modal">` with app-level CSS. The `Modal` owns the backdrop,
portal, Esc/backdrop-close, symmetric body padding, and the bordered
header/footer, so it can't drift or mis-space.

Inside it, use the primitives — `Button` (footer actions), `Input`, **`Textarea`**
(multi-line / paste), `Radio`, `Checkbox`, `Select`. Only layout/label spacing
should be route CSS, and it must be namespaced to that feature.

```tsx
import { Modal } from '@/design-system/components'
import { Button, Input, Textarea } from '@/design-system/primitives'

<Modal open={open} onClose={close} size="md" title="Add keywords"
  footer={<><Button onClick={close}>Cancel</Button>
           <Button variant="primary" onClick={apply}>Add</Button></>}>
  <Textarea value={v} onChange={e => setV(e.target.value)} placeholder="One per line" />
</Modal>
```

**Why this rule exists:** a wizard once hand-rolled bulk modals with
`className="h10-modal bulk"` — a class that already belonged to the Ad-Manager
bulk dialog. It inherited that dialog's `padding: 0` body (textarea border
touched the edges) and silently resized the other dialog. The DS `Modal` is
namespaced (`.h10-ds-*`), so reusing it is collision-proof. If a needed control
is missing (as `Textarea` was), **add the primitive here** rather than hand-roll.
