# Amazon Flat-File — Custom Collapsible SKU Groups — Design Spec

**Date:** 2026-07-01
**Status:** APPROVED 2026-07-01 — decisions resolved (see below); proceeding to implementation plan
**Surface:** `/products/amazon-flat-file` (operator-flagged **untouchable** — building this requires explicit approval)

## Goal
Let the operator organise the flat-file grid into **their own named, collapsible groups** of SKUs — beyond the existing variation-family grouping — so large sheets (265+ rows) are easier to navigate and manage. Absorbs the pending **FBA/FBM sub-group** follow-up as a built-in preset.

## What already exists (reuse, don't rebuild)
- **Collapsible variation families** — `collapsedParents: Set<rowId>` (AmazonFlatFileClient.tsx:843); the visible-rows memo (~1453) pushes a parent then its children unless collapsed.
- **Family colour banding** — `FAMILY_PALETTE` / `FC_PARENT_ROW` / `FC_CHILD_ROW` (~355-399).
- **Per-market localStorage view state** — `ff-amazon-${m}-row-order`, `ff-amazon-${m}-sort`, `ff-frozen-cols`, `ff-col-widths`, etc.
- **View-only isolation pattern** — the synthetic Category column "NEVER enters data/paste/serialize paths" (BN.2.1, ~421); ghost rows "excluded from counts, save, submit and export" (~430). Groups follow the same rule.

---

## Core design decisions

### ★ D1 — Grouping granularity: **whole families are atomic**
A custom group contains **families and standalone products**, never a loose half of a variation family. The atomic unit is:
- a variation family (parent + all its children), or
- a standalone product.

**Why:** Amazon needs a family's parent+children together to submit. Letting you drop only `BLACK-M` into a group while `BLACK-L` sits elsewhere would risk a broken submit and a confusing grid. You still collapse *within* a family as today.
*Alternative (not recommended): allow per-variant grouping — more flexible, but breaks the family-integrity guarantee.*

### ★ D2 — Grouping modes (one active at a time)
A toolbar **"Group by"** selector:
1. **Family** (default — today's behaviour, unchanged).
2. **Fulfillment** (preset — auto-groups into "FBA" / "FBM" using `ChannelListing.fulfillmentMethod` + `_FBM` SKU; this is the GALE follow-up, for free).
3. **Custom** — your named groups; anything unassigned falls into an **"Ungrouped"** section.

Only one mode is active at a time (no nested modes in v1) — keeps the mental model and the render logic simple.

### ★ D3 — A custom group's shape
```ts
type FlatFileGroup = {
  id: string          // stable, generated
  name: string        // "Winter 2026"
  color: FamilyColor  // from the existing 6-colour palette
  order: number       // manual ordering of groups
  memberKeys: string[] // family keys = parent item_sku OR standalone item_sku
}
```
A family/product belongs to **at most one** custom group (moving it re-assigns).

### ★ D4 — Persistence: **localStorage, per market** (v1)
Key `ff-amazon-${market}-groups` (definitions) + `ff-amazon-${market}-collapsed-groups` (collapse state) — matching every other view-pref in this editor.
*Trade-off:* per-browser, not shared across devices/teammates. If you want groups shared, that's a **DB-backed** variant (a `FlatFileGroup` table keyed by user+market) — more plumbing; propose as a fast-follow, not v1.

### D5 — Strictly view-only
Group id/name/colour/membership **never** enter `data` / paste / serialize / submit / export / the Amazon feed. Same isolation as the Category column. Removing all groups leaves the sheet byte-identical to today.

### D6 — Collapse mechanism
Add `collapsedGroups: Set<groupId>` alongside `collapsedParents`, and extend the visible-rows memo to emit **group header rows** and skip a group's members when collapsed — a direct parallel of the existing parent-collapse code.

---

## UI

```
┌ Toolbar ─────────────────────────────────────────────────────────┐
│  … existing controls …     Group by: [ Custom ▾ ]   [Manage groups]│
└───────────────────────────────────────────────────────────────────┘

  ▾ 🟦  FBM items                                   18 SKUs   ⋯
        GALE_JACKET_BLACK_M_FBM   …row…
        GALE_JACKET_BLACK_L_FBM   …row…
        …
  ▸ 🟩  Winter 2026                                 12 SKUs   ⋯   (collapsed)
  ▾ ⬜  Ungrouped                                   235 SKUs
        … all families not in a custom group (normal family view) …
```

- **Group header row:** colour chip · name · SKU count · ▸/▾ collapse · `⋯` menu (Rename, Recolor, Move up/down, Ungroup all).
- **Create a group:** select rows/families (existing multi-select) → right-click → **"Group selected…"** → name + colour → done. (Same selection you use for "Set category".)
- **Manage groups modal** (a DS `Modal`, sibling to `SetCategoryModal`): list groups with rename/recolor/reorder/delete + membership counts.
- **Collapse-all / expand-all** affordance in the toolbar.
- Group headers are visually distinct from family parent rows (thicker band, all-caps name) so the two levels don't read the same.

---

## Behaviour details
- **Search / filter:** filtered-out members are hidden; a group whose members are all filtered out shows a dimmed "0 shown" header (or hides — operator preference; default: dim).
- **Sort:** sort applies *within* each group; group order is manual (D3.order) or A→Z toggle.
- **Row-order localStorage:** custom grouping layers on top of the existing per-market row order.
- **Family collapse still works** inside a group.
- **New/imported rows:** land in "Ungrouped" until assigned.
- **A member family deleted/deactivated** → silently drops from the group.

## Non-goals (v1)
- No change to the Amazon variation structure or feed.
- No nested groups (flat list only).
- No cross-market groups (per-market only).
- No DB sharing (localStorage only) — fast-follow if wanted.

## Drawbacks / risks
1. **Untouchable editor** — a real change to a ~7,000-line component; needs sign-off + careful regression testing of paste, freeze, sort, serialize, submit, export.
2. **`ci`-index fragility** — the grid maps columns/rows by index in several places; group header rows must be injected at the render layer only (like the Category column), never into `allColumns`/data arrays.
3. **localStorage = per-browser** — groups don't follow you to another machine (accepted v1).
4. **Perf** — re-grouping 265+ rows on each change; must stay inside the existing `useMemo`.
5. **Scope creep** — keep modes to Family / Fulfillment / Custom; resist deeper hierarchy.

## Implementation sketch
- **New:** `amazon-flat-file/group-model.ts` — types + pure helpers (assign, collapse, section-build), with unit tests (mirrors `category-model.ts`).
- **New:** `amazon-flat-file/ManageGroupsModal.tsx` — DS modal.
- **Edit:** `AmazonFlatFileClient.tsx` — group state + localStorage; extend visible-rows memo (~1453) to emit sections + honor `collapsedGroups`; "Group by" toolbar control; group header render; context-menu "Group selected…". Reuse `FAMILY_PALETTE`, `collapsedParents` pattern, existing selection.

## Suggested phases (each independently shippable + testable)
- **P1 — Fulfillment preset** (Group by → Fulfillment): smallest slice, delivers the GALE FBA/FBM sub-group need immediately, proves the section/collapse rendering with zero persistence.
- **P2 — Custom groups**: create via selection, collapse, localStorage persistence, Ungrouped section.
- **P3 — Manage-groups modal**: rename/recolor/reorder/delete + membership editing.
- **P4 (optional) — DB-backed sharing**, if per-browser proves too limiting.

## ★ Resolved decisions (operator, 2026-07-01)
1. **Persistence:** localStorage per-market (v1). DB-shared = optional fast-follow (P4), not now.
2. **Granularity:** whole-families-only (submit-safe).
3. **Start point:** go straight to **full custom groups**. Fulfillment stays as a built-in preset *mode*, not a separate phase.
4. **Empty-group-under-filter:** **dim** the header (show "0 shown"), don't hide.

Quality bar: best-in-class, **zero inconsistencies** — matches the density/polish of the rest of the editor; every interaction (paste, freeze, sort, filter, serialize, submit, export) verified unchanged.
