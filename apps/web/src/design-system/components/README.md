# components/

Molecules — composed, reusable components lifted from `/marketing/ads` and
generalized (ads-specific assumptions stripped) so they work platform-wide.

`SourceIndicator` shows a value’s origin in dense cells or labelled legends. Supply
`kind`, `label` and `description` from the server’s provenance. To offer an action,
supply both `actionLabel` and `onAction`; otherwise it is a focusable informational
mark. Hover/focus explanations use `Tooltip portal`. Icons, target size and focus
styling belong to this component; the feature owns resolution and write routing.

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
namespaced (`.nds-*`), so reusing it is collision-proof. If a needed control
is missing (as `Textarea` was), **add the primitive here** rather than hand-roll.

`Drawer` footer actions wrap within narrow panels and retain their full height while the body scrolls. Consumers can compose Buttons directly in the existing `footer` slot.

Neutral Banner descriptions use `--nds-text` so account and availability notices retain AAA normal-text contrast in both themes.


### Media galleries — 2026-09-07

`MediaCard` presents an uncropped image with a separately focusable preview, optional selection, metadata and actions. Failed images show “Image unavailable”. `MediaGallery` composes cards into a controlled sequence with drag grips, standard ToolbarButton move/first/remove controls and position announcements. Provide unique stable IDs and update the controlled order in `onChange`. Removing assignments must be handled by the host; the component does not delete source assets.

Media uses the normal Nexus control sizes and semantic text hierarchy, including 28px ToolbarButton actions. No page wrapper resizes or restyles shared controls. Arrange action containers with layout; choose component sizes through their documented props.

`MediaGalleryExample` (`#media-gallery-example` in Web) demonstrates reordering, source selection and an unavailable image using clearly synthetic catalog assets. Factory carries the same component and specimen source.

`PressableRow.leading` accepts a decorative thumbnail or icon before the labelled action. It is hidden from assistive technology and does not receive pointer events; keep interactive content in `actions`. The Media catalog demonstrates the row. Existing row and control sizes are unchanged.

Embedded Drawer header text wraps within the available text column; Close retains its own column. Modal owns the default semantic text color, including plain footer content outside the originating shell.

### Asynchronous choices — 2026-09-07

`AsyncListboxPanel` combines a labelled search field, externally supplied options and explicit loading/error/empty states. Supply controlled `query`, `onQueryChange`, filtered `options`, `onCommit` and `onCancel`; optional `onRetry` adds Refresh/Try again. The host owns fetching, stale-response protection, ID validation and popup placement. Loading/error states hide choices and Enter cannot commit. Arrow keys skip disabled choices and track grouped order; Escape cancels. Options remain outside the Tab sequence through `ListboxPanel.optionTabIndex=-1`, so Tab reaches actions. `value` is a stable ID, never a display label. The Web catalog specimen `#async-listbox-example` demonstrates loading, failure/retry and a disabled option; its source is mirrored to Factory.

### AccountsPanel — business ownership (2026-09-08)

The host supplies only the current business’s accounts. Several accounts may use the same channel. The panel explains account selection for publishing/syncing and uses plain language when connection activity tracking is unavailable. Ownership and credential checks remain server responsibilities.
### AccountsPanel — Amazon Seller migration (2026-09-08)

When the host supplies `onReconnect`, an ENV-managed row offers **Replace environment credentials**. `permissionModel="application_roles"` describes Amazon’s approved app roles without displaying a false OAuth-scope count. The ENV grant remains visibly active until website authorization or private-app self-authorization import succeeds.
