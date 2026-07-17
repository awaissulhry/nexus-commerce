# Amazon Flat-File — Custom Collapsible SKU Groups — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add operator-defined, collapsible SKU groups (plus a built-in Fulfillment FBA/FBM preset) to the Amazon flat-file grid, as a pure render-layer view feature that never touches the data/feed.

**Architecture:** One new pure module (`group-model.ts`, TDD) holds types + grouping logic + localStorage. The editor gains group state, a "Group by" toolbar control, a `renderRows` memo that reorders data rows into group sections and injects header rows at render time only, a `GroupHeaderRow` component, a context-menu "Group selected…" action, and a `ManageGroupsModal`. Grouping is whole-families-atomic and strictly view-only.

**Tech Stack:** Next.js/React (client), TypeScript, Vitest (run from repo root: `npx vitest run <file>`), Tailwind + design-system primitives.

## Global Constraints (every task inherits these)
- **Untouchable editor:** `/products/amazon-flat-file` is operator-flagged untouchable. This work is the explicitly-approved exception. Make **surgical, additive** changes only.
- **View-only, zero feed leak:** group id/name/colour/membership/header-rows must NEVER enter `rows`, `data`, paste, serialize, submit (`handleSubmitToMarkets` ~2916), export (`exportFile` ~3586), or the Amazon feed. Header rows exist only in the render output, never in `displayRows`/`rows`. Removing all groups must leave the sheet byte-identical.
- **Preserve `ri`/`ci` index mapping:** paste/selection/keyboard-nav map `data-ri`/`data-ci` to `displayRows` indices. The `rowIdx` passed to `SpreadsheetRow` must remain the index into the pure data-row array. Header rows do NOT consume a `rowIdx`.
- **Arbitrary per-SKU grouping (revised 2026-07-01):** a group holds any set of SKUs the operator picks — including a subset of a variation family (e.g. only the `_FBM` GALE variants). Grouping is strictly view-only, so splitting a family across groups NEVER affects `parent_sku`/the feed/submit. `memberSkus` are `item_sku` strings (stable across sessions, unlike `_rowId`).
- **Persistence:** localStorage per-market, keys `ff-amazon-${market}-groups`, `ff-amazon-${market}-group-mode`, `ff-amazon-${market}-collapsed-groups`. SSR-safe try/catch init + useEffect persist (match existing pattern at 845/895/1115).
- **Reuse:** `FAMILY_PALETTE`/`FamilyColor` (354), `collapsedParents` pattern (843/4936), selection `selectedRows` from `core` (783), context menu (4640/8735), `allColumns` (1254) for colSpan.
- **Quality:** best-in-class density/polish matching the editor; i18n via the existing catalog; WCAG AA (keyboard + aria); memoize (no per-render recompute of grouping).

---

### Task 1: `group-model.ts` — pure types, grouping logic, persistence (TDD)

**Files:**
- Create: `apps/web/src/app/products/amazon-flat-file/group-model.ts`
- Test: `apps/web/src/app/products/amazon-flat-file/group-model.vitest.test.ts`

**Interfaces (Produces — later tasks consume these exact names):**
```ts
export type GroupMode = 'family' | 'fulfillment' | 'custom'
export type FlatFileGroup = { id: string; name: string; color: FamilyColorName; order: number; memberKeys: string[] }
export type FamilyColorName = 'blue' | 'purple' | 'emerald' | 'orange' | 'teal' | 'amber'

/** A family's stable key = parent item_sku for a family, or the item_sku for a standalone. */
export function familyKeyOf(row: { parentage_level?: unknown; item_sku?: unknown; parent_sku?: unknown }): string
/** Fulfillment bucket from the row's channel code: FBA if /^(AMAZON|AFN|FBA)/, else FBM. */
export function fulfillmentBucket(row: { fulfillment_availability__fulfillment_channel_code?: unknown; item_sku?: unknown }): 'FBA' | 'FBM'
/** localStorage (SSR-safe). */
export function loadGroups(market: string): FlatFileGroup[]
export function saveGroups(market: string, groups: FlatFileGroup[]): void
export function loadGroupMode(market: string): GroupMode
export function saveGroupMode(market: string, mode: GroupMode): void
export function loadCollapsedGroups(market: string): Set<string>
export function saveCollapsedGroups(market: string, ids: Set<string>): void
/** Assign/remove families to a custom group (returns new array; a family belongs to ≤1 group). */
export function assignFamiliesToGroup(groups: FlatFileGroup[], groupId: string, familyKeys: string[]): FlatFileGroup[]
export function makeGroupId(existing: FlatFileGroup[]): string   // stable, no Math.random at module scope
```

- [ ] **Step 1:** Write failing tests: `familyKeyOf` (parent→item_sku, child→parent_sku, standalone→item_sku); `fulfillmentBucket` (AMAZON_EU/AFN/FBA→FBA, DEFAULT/MFN/empty→FBM); `assignFamiliesToGroup` (adds keys, removes them from any other group, dedups); `makeGroupId` (unique vs existing ids); load/save round-trips with a mocked `localStorage` (and returns defaults on parse error / absent). Use deterministic ids (e.g. `g${maxExistingNumericSuffix+1}`), no `Math.random`.
- [ ] **Step 2:** Run `npx vitest run apps/web/src/app/products/amazon-flat-file/group-model.vitest.test.ts` — expect FAIL.
- [ ] **Step 3:** Implement `group-model.ts` (mirror `category-model.ts` style; `FamilyColorName` mirrors the editor's `FamilyColor`; localStorage helpers wrapped in try/catch returning safe defaults).
- [ ] **Step 4:** Run tests — expect PASS.
- [ ] **Step 5:** `cd apps/web && npx tsc --noEmit` clean. Commit `feat(flat-file): group-model — types + grouping logic + persistence (CG.1)`.

---

### Task 2: Group state + "Group by" toolbar control

**Files:** Modify `AmazonFlatFileClient.tsx` (state block near ~843; toolbar near the existing view controls).

**Interfaces (Consumes Task 1; Produces state used by Tasks 3-7):**
- `groupMode: GroupMode`, `setGroupMode`; `customGroups: FlatFileGroup[]`, `setCustomGroups`; `collapsedGroups: Set<string>`, `setCollapsedGroups` — all hydrated from localStorage per `marketplace`, persisted via useEffect (pattern at 1115).

- [ ] **Step 1:** Add the three state hooks with SSR-safe localStorage init keyed on `marketplace` + persistence effects. Re-hydrate on `marketplace` change (like `ff-amazon-${m}-*`).
- [ ] **Step 2:** Add a "Group by" segmented control / dropdown to the toolbar: **Family** (default) · **Fulfillment** · **Custom**. Wiring only — selecting a mode sets `groupMode`; no render behaviour yet (Family renders exactly as today). Disable "Custom" with a tooltip when `customGroups.length === 0` until Task 5 adds creation (or show it and let Ungrouped hold everything).
- [ ] **Step 3:** `cd apps/web && npx tsc --noEmit` clean. Manual reasoning check: with `groupMode='family'`, `displayRows`/render are untouched. Commit `feat(flat-file): group state + Group-by toolbar control (CG.2)`.

---

### Task 3: `renderRows` memo + `GroupHeaderRow` + render-loop switch (CORE)

**Files:** Modify `AmazonFlatFileClient.tsx` — new memo after `displayRows` (~1487); new `GroupHeaderRow` component; change the `<tbody>` map (~4877).

**Interfaces (Consumes group state; Produces the grouped render):**
```ts
type RenderItem =
  | { kind: 'header'; groupId: string; name: string; color: FamilyColorName; count: number; collapsed: boolean }
  | { kind: 'row'; row: Row; dataIdx: number }   // dataIdx = index into displayRows (unchanged ri mapping)
```

- [ ] **Step 1:** Add `renderRows = useMemo<RenderItem[]>(...)`. When `groupMode==='family'`, return every `displayRows[i]` as `{kind:'row', row, dataIdx:i}` (NO headers — byte-identical to today). When `fulfillment`/`custom`: bucket **families** (via `familyKeyOf`) into ordered sections (Fulfillment: FBA then FBM; Custom: `customGroups` by `order`, then an "Ungrouped" section), emit a `header` item per section, then that section's rows **in displayRows order** with their original `dataIdx`, skipping a section's rows when `collapsedGroups.has(groupId)`. A family's parent+children stay contiguous (they already are in `displayRows`). Deps: `[displayRows, groupMode, customGroups, collapsedGroups]`.
- [ ] **Step 2:** Build `GroupHeaderRow` — a full-width `<tr>` with a single `<td colSpan={allColumns.length + 2}>` (data cols + Category col + row-number col; confirm the exact +N against the current header render). Content: colour band (reuse `FC_PARENT_BORDER`/palette), chevron (▸/▾ from collapsedGroups), group name (semibold), `· N SKUs`, and a `⋯` affordance placeholder (menu wired in Task 7). Sticky-left safe (must not break horizontal scroll of the sticky columns).
- [ ] **Step 3:** Change `<tbody>{displayRows.map(...)}` → `<tbody>{renderRows.map(item => item.kind==='header' ? <GroupHeaderRow key={'h'+item.groupId} .../> : <SpreadsheetRow key={item.row._rowId} row={item.row} rowIdx={item.dataIdx} ... />)}`. **`rowIdx` stays `item.dataIdx`** (index into `displayRows`) so `data-ri`/paste/selection are unchanged. Keep the synthetic Category column injection exactly as-is.
- [ ] **Step 4:** Verify (reason through, no test runner for the page): with `family` mode → `renderRows` is 1:1 with `displayRows`, zero headers, identical DOM. `familyColorByRowId` still keyed on `displayRows` (unchanged). Header rows are NOT in `displayRows`/`rows` → serialize/submit/export (2916/3586, iterate `rows`) unaffected. Selection/keyboard nav use `data-ri`=dataIdx (unchanged).
- [ ] **Step 5:** `cd apps/web && npx tsc --noEmit` clean; `npm --prefix apps/web run build` compiles. Commit `feat(flat-file): renderRows sections + GroupHeaderRow (render-only) (CG.3)`.

---

### Task 4: Fulfillment preset grouping

**Files:** Modify `AmazonFlatFileClient.tsx` (the `renderRows` bucketing for `groupMode==='fulfillment'`).

- [ ] **Step 1:** In `renderRows`, for `fulfillment` mode, bucket each family by the fulfillment of its rows: a family is **FBM** if any of its rows `fulfillmentBucket()===  'FBM'` (covers the `_FBM` GALE variants); else **FBA**. Two fixed sections: "FBA" (blue) then "FBM" (amber), stable group ids `__fba`/`__fbm`. Empty section → omitted.
- [ ] **Step 2:** Verify against live data reasoning: GALE-JACKET's 38 variants split into FBA (20) + FBM (18) sections; AIREON (all FBA) shows one FBA section. Commit `feat(flat-file): Fulfillment (FBA/FBM) preset grouping (CG.4)`.

---

### Task 5: Custom groups — "Group selected…" + create + persist

**Files:** Modify `AmazonFlatFileClient.tsx` (context menu ~8735 + handler ~4640; a small inline name/colour popover or reuse a DS `Modal`).

- [ ] **Step 1:** Add `onGroupSelected` to the `ContextMenu` component + render a "Group selected…" item, enabled when `selectedRows.size>0`. Resolve the selected rows → their **family keys** (`familyKeyOf`), so selecting any variant selects its whole family.
- [ ] **Step 2:** On trigger, open a tiny create popover (name input + 6-colour swatch from `FAMILY_PALETTE`). On confirm: `assignFamiliesToGroup(customGroups, makeGroupId(...), keys)` with the name+colour; `setGroupMode('custom')`; persist. New group appears as a section (Task 3).
- [ ] **Step 3:** `tsc` clean; reason-verify a family moved into a custom group leaves `rows`/feed untouched. Commit `feat(flat-file): create custom group from selection (CG.5)`.

---

### Task 6: Group collapse + collapse-all/expand-all

**Files:** Modify `AmazonFlatFileClient.tsx` (`GroupHeaderRow` chevron wiring + toolbar).

- [ ] **Step 1:** Wire the header chevron to toggle `collapsedGroups` (mirror `onToggleCollapse`). Collapsed section: header shows with count, its row items are skipped in `renderRows` (already handled in Task 3 Step 1 — verify).
- [ ] **Step 2:** Add toolbar "Collapse all / Expand all groups" (sets `collapsedGroups` to all group ids / empty). Persist. Commit `feat(flat-file): per-group + all collapse/expand (CG.6)`.

---

### Task 7: ManageGroupsModal (rename / recolor / reorder / delete / membership)

**Files:** Create `apps/web/src/app/products/amazon-flat-file/ManageGroupsModal.tsx`; wire from a toolbar "Manage groups" button + the header `⋯` menu.

- [ ] **Step 1:** DS `Modal` (sibling to `SetCategoryModal`): list `customGroups` by `order` with rename (input), recolour (swatch), reorder (up/down), delete (removes group; members fall to Ungrouped), and a member count + "remove member" list. All operations go through `group-model` helpers + persist.
- [ ] **Step 2:** Header `⋯` menu (Task 3 placeholder) → Rename / Recolor / Move up-down / Ungroup-all → same helpers.
- [ ] **Step 3:** `tsc` clean; warm-import the modal (hover/focus) per the existing `SetCategoryModal` prefetch pattern. Commit `feat(flat-file): Manage Groups modal (CG.7)`.

---

### Task 8: Filter/sort interaction + i18n + a11y + perf + regression verify

**Files:** Modify `AmazonFlatFileClient.tsx`; i18n catalog.

- [ ] **Step 1:** Empty-under-filter: a section whose visible member count is 0 (all filtered out) renders a **dimmed** header showing "0 shown" (not hidden). Sort applies within sections (already, since sections read `displayRows` order which is sorted). Group order is manual (custom) / fixed (fulfillment).
- [ ] **Step 2:** i18n: all new strings ("Group by", "Family/Fulfillment/Custom", "Group selected…", "Ungrouped", "N SKUs", "0 shown", "Manage groups", "Collapse/Expand all") via the catalog; add to every locale (push hook parity gate). a11y: header row `role`/`aria-expanded` on the chevron, keyboard toggle, `aria-label`s.
- [ ] **Step 3:** Regression verification (reason + spot-check): (a) `groupMode='family'` → DOM identical to pre-feature; (b) submit/export still iterate `rows` (headers absent); (c) paste/fill into a grouped view targets the correct cells (ri = dataIdx); (d) freeze columns + horizontal scroll unaffected by header rows; (e) removing all groups + mode='family' → byte-identical sheet. Memoize all group derivations (no recompute when unrelated state changes).
- [ ] **Step 4:** `tsc` + `apps/web` build clean. Commit `feat(flat-file): grouping filter/sort + i18n + a11y + regression hardening (CG.8)`.

---

## Self-review (author)
- Coverage: spec's D1-D6 + UI + all resolved decisions map to tasks (D1→T3/T5 family-atomic; D2→T2/T4/T5 modes; D3→T1 shape; D4→T1/T2 persistence; D5→every editor task's view-only constraint + T8 verify; D6→T3/T6 collapse). ✅
- No placeholders: Task 1 has real interfaces + TDD; editor tasks cite exact integration lines + the render-item contract.
- Type consistency: `FamilyColorName` (T1) mirrors editor `FamilyColor`; `RenderItem.dataIdx` = displayRows index used as `rowIdx` throughout.
- Risk: Task 3 is the crux — gated by the "render-only, ri-preserved, family-mode-identical" checks before any custom-group behaviour lands.
