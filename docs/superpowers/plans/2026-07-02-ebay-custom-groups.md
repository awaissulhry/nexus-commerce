# eBay custom named groups (shared FlatFileGrid) — implementation plan

**Goal:** Bring Amazon's named custom SKU groups to the shared `FlatFileGrid` so eBay (and bulk-operations, opt-in) can create/name/assign groups from checkbox selections.

**Decisions (approved 2026-07-02):** grouping modes are **Family | Custom | None** (one active at a time, a toggle like Amazon's); group members keyed by **SKU (`item_sku`)**.

**Safety:** the whole feature is gated behind a new opt-in prop `enableCustomGroups` (+ scope from `storageKey`). Until P4.6 flips it on for eBay, behavior is UNCHANGED for eBay and bulk-operations. Every intermediate commit is safe.

**Shipped already:** P1 checkbox shift-range fix (`c5cb0304`), P2 Amazon group-name keydown guard (`5abca47b`), P3 Amazon group-by-checkbox button (`e2d98989`), P4.1 shared `group-model.ts` (committed).

---

## P4.2 — Grid state + mode toggle + persistence
**File:** `apps/web/src/components/flat-file/FlatFileGrid.tsx`
- Add prop `enableCustomGroups?: boolean`. Scope = `storageKey` (e.g. `ebay-IT`). Feature active only when true.
- State (init from `group-model` load* using `storageKey`): `customGroups`, `groupMode: 'family'|'custom'|'none'`, `collapsedCustomGroups`, `groupCreate: {skus}|null`, `manageGroupsOpen`.
- Persist on change via `saveGroups/saveGroupMode/saveCollapsedGroups(storageKey, …)`.
- Render a segmented "Group by: Family · Custom · None" control (only when `enableCustomGroups`). Place in the toolbar/header row near the existing controls; reuse design-system segmented/Button.

## P4.3 — "Group {N}…" from checkbox selection + Create popover
- Create shared `apps/web/src/components/flat-file/GroupCreatePopover.tsx` (port of Amazon `CreateGroupPopover`, importing the shared `group-model`; name input already stops Enter/Escape — it works in the shared grid because the shared grid's keydown already has the field-guard).
- Add a `groupFromSelection()` in the grid: collect `item_sku` from `selectedRows` (∪ `normSel` range), `setGroupCreate({skus})`.
- Add a "Group {N}…" button when `selectedRows.size>0` (a shared selection action bar — the grid currently has none; add a minimal one, or place beside the existing add-row/footer area). On create: `assignSkusToGroup` + `setGroupMode('custom')`.

## P4.4 — Render the 3 modes (the crux)
- Generalize the grouping used by `displayRows`/render:
  - `family` (and when feature disabled): CURRENT behavior via `resolvedGetGroupKey` + variation `GroupHeader`. Unchanged.
  - `custom`: group rows by `groupIdForSku(customGroups, String(row.item_sku))`; render a **nameable, collapsible, colored** custom-group `GroupHeader` per group (label = group name) + an "Ungrouped" section last. Order by `group.order`.
  - `none`: no grouping — flat list, no headers.
- Keep `ri = displayRows index` invariant (already fixed) so selection/fill stay aligned across all modes.
- Custom-group header collapse uses `collapsedCustomGroups` (persisted).

## P4.5 — Manage Groups modal
- Create shared `apps/web/src/components/flat-file/ManageGroupsModal.tsx` (port of Amazon's): rename (works — field-guard), recolor, delete, show member counts, reassign/remove. Wire to `customGroups` setters + persistence.
- Add a "Manage groups" affordance (button near the mode toggle) when in Custom mode.

## P4.6 — Wire eBay + verify
**File:** `apps/web/src/app/products/ebay-flat-file/EbayFlatFileClient.tsx`
- Pass `enableCustomGroups` to the `<FlatFileGrid>` (scope already flows via `storageKey`).
- Verify: create group from checkboxes → name it (types into the popover, NOT a cell) → rows section under the named header → collapse/expand → reload persists → Manage rename/delete → mode toggle Family/Custom/None.
- Confirm bulk-operations is unaffected (does not pass `enableCustomGroups`).

## Notes / risks
- The shared grid render loop is complex (contentVisibility rows, sticky cols, cell memo, ri-alignment). The 3-mode grouping must not disturb the `ri`↔`displayRowsRef` invariant. Test cell-selection + fill after the render change.
- `GroupHeader` currently shows the family parent; the custom header is a different variant (name + color + collapse + count). Add a `variant`/props rather than overloading.
- Do NOT touch `AmazonFlatFileClient.tsx`'s own group-model/popovers (its feature keeps working independently).
