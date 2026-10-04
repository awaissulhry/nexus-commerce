# Channel cell marks — one part for both sheet scopes (PLAN, 2026-10-04)

Branch `fix/channel-cell-marks`, from origin/main `02f30039e`.
Status: **APPROVED 2026-10-04** ("yes to the plan"; AAA mark colours IN this PR; Cell details on Shared = next PR).

## Owner decisions during the build (2026-10-04)

- eBay item specifics with one value per listing: KEEP the `listingLevel` mark on every variation cell (about 500 on
  GALE eBay IT) — like Shared marks child rows that take the parent's value. (Lead had recommended header + real cases.)
- Stock columns from the Matrix (Mode / Qty / Buffer, "Follows the pool" 🔗): LEAVE as they are on the sheet; handle
  later together with the Matrix page.
- Fix-round rules (lead): channel-only fields = no mark; content-adding transforms (template/prepend/append/replace)
  = Σ, format conversions = no mark; empty + required = "⚠ required" text, no mark (as Shared); every mark reads its
  full sentence `provenanceTooltip(member, from)`, `from` = what the value follows / came from / no longer follows.

## Contract (fixed by the lead before the build agents start — already in the tree)

- `packages/shared/cell-provenance.ts`: `+ 'pending' | 'attention' | 'listingValue' | 'listingLevel'` (dist rebuilt).
- `grid/renderers/MarkedValue.tsx` (web + factory, exported from `renderers/index.ts`): `<MarkedValue provenance
  tooltip? from? trail? after?>{value}</MarkedValue>` = Shared's `withMark` markup. Both scopes draw it.
- `provenanceMark.tsx`: first versions of the 4 members — `pending` Clock "Waits for Publish" `nds-cell-prov-pending`;
  `attention` AlertCircle "Needs attention" `nds-cell-prov-attention`; `listingValue` Store "Listing value"
  `nds-cell-prov-listing`; `listingLevel` Layers "One value for the whole listing" `nds-cell-prov-listing-level`.
  apps/web resolves lucide-react **0.469.0** now (the 0.263.1 note in provenanceMark.tsx is out of date).
- **Where the channel verdict lives (lead's change to the plan):** NOT a channel branch inside the DS
  `classifyProvenance`. That function with layer `'channel'` also serves the Variants tab (`variationTheme.tsx:307`),
  which is out of scope. The product sheet's channel verdict is ONE sheet function, `channelCellProvenance(cell,
  { productLevelOnly, refusedReason })`, used by CascadeCell, the cell tint, the bullets mark and Cell details.
  It may call `classifyProvenance` for the generic members. Shared and the Variants tab keep today's verdicts.
- Hover words: one sentence per member for both scopes — `provenanceTooltip(member, from)`. `pending` / `attention` /
  `refused` carry the server's sentence as `from`, verbatim. Cell details keeps its longer explanation.

## Summary

- The Owner's choice (2026-10-04): the channel scopes (eBay, Amazon, Shopify, Etsy) draw their cells with the SAME part
  as the Shared scope (`ProvenanceMark`) and the SAME rule: no mark on a cell that simply follows Shared; a small mark
  only on a cell that differs from Shared or whose next action differs. New mark: "waits for Publish" (clock).
- Today channel cells draw `SourceIndicator` in every cell (`sheet/channel/CascadeCell.tsx:148`, PR #193).
- **A simple swap is NOT honest.** The verdict the channel cell would feed the mark (`classifyProvenance(…,'channel')`)
  is wrong for the channel sheet in three common cases (checked in the code):
  1. Every cell with a mapping rule counts as "derived" (`studio-sheet.service.ts:1568`, `derived = … && !!m.rule`),
     so a plain "copy the Shared field" path would draw Σ on nearly every mapped cell.
  2. A variant's own Shared value is sent as `pinned: true` (`:1589`), so it would draw ✎ "Pinned".
  3. An old eBay listing text (`channelSnapshot`, differs from Shared on 80 of 82 listings) arrives as a following pin,
     which the classifier turns into `inherited` — it would draw 🔗 "Inherited", the false claim #193 fixed.
  So the product sheet gets its own channel verdict in the same PR — `channelCellProvenance` (see "Contract": not a
  channel branch inside the DS classifier, which the Variants tab keeps). That one verdict feeds the mark, the cell tint,
  the bullets mark and Cell details (today Cell details uses a second verdict, `describeValueSource`, and the two disagree).

## What the channel cell shows after the change

| Cell state | Mark | Hover / screen reader |
|---|---|---|
| Follows Shared (plain path, Shared value, variant's own Shared value) | none | — (Cell details explains) |
| Channel-only field ("Channel value") | none | — |
| Empty / no mapping | none (empty or "required" text, as Shared) | — |
| Listing override | ✎ pinned | the full sentence `provenanceTooltip('pinned', from)`, as on Shared: "Pinned on this row — it no longer follows the Shared product" |
| Waits for Publish | **🕒 new `pending`** | server's note + "Live until you publish: X" |
| Saved, not sent · Amazon reports FBA · mapping error | **⚠-circle new `attention`** | server's sentence |
| Old listing text (differs from Shared) | **new `listingValue`** | "This listing's own older text …" |
| eBay item specific on a variation row (one value per listing) | **new `listingLevel`** | "One value for the whole listing, from {sku} …" |
| Mapping rule with a transform / expression / constant / default | Σ mapped (Share2 if product-level) | rule name |
| Linked field / alias band value | 🔗 inherited / ↳ inheritedOverride | the source |
| Formula · refused formula · AI draft · out-of-date translation | ƒ · ⚠ · ✦ · History | same as Shared |

New members follow ruling #16 (a new member only when the next action differs; a different glyph, not a colour).
Glyphs (all already imported in apps/web): `Clock`, `AlertCircle`, `Store`, `Layers`.

## Build — one PR, two parallel build agents on separate files, then review

**Contract fixed before the agents start:** member names `pending | attention | listingValue | listingLevel`
(additive in `packages/shared/cell-provenance.ts`); new optional inputs on `ProvenanceLike`; one DS part `MarkedValue`.

**Agent A — design-system engine** (`apps/web/src/design-system/**`, `packages/shared/cell-provenance.ts`, factory copies)
1. `provenance.ts`: the 4 members in `provenanceTooltip`, `provenanceClassRules` (cell tints) and `describeCellSource`;
   user words say "the Shared product", never "the master". `classifyProvenance` itself unchanged (tests prove it).
   Bullets (`SlotListEditor.tsx` `slotListProvenance`): mixed slots must still show a mark (both scopes).
2. `provenanceMark.tsx`: the 4 new members; one text for `title` AND `aria-label` (today a screen reader hears only
   "Inherited", never the source or the refusal reason) — both scopes gain this.
3. New `MarkedValue` renderer (`grid/renderers`): the exact markup of Shared's `withMark` (mark left, text, trail slot,
   save marks). One gap rule in `grid.css`, so the chevron never touches the ellipsis.
4. Mark colours to 7:1 (AAA) in light and dark — new `--nds-prov-*` tokens via `tokens/css-vars.ts` + `npm run
   tokens:gen` (never hand-edit the generated CSS). Today 4 marks are below 4.5:1 in light mode on the worst row ground.
5. Byte-identical copies in `apps/factory/src/design-system` (`check-ds-fork-drift.mjs`); CHANGELOG, catalog
   (`PresenceExample`, catalog README), `.claude/DS-GAPS.md` (append), `/design/language-axis` legend.
6. Tests: classifier cases per state above, precedence chain, mark labels, Shared-scope no-change.

**Agent B — the sheet** (`apps/web/src/app/products/[id]/edit/_studio/sheet/**`)
1. `CascadeCell.tsx`: drop `SourceIndicator`; render `MarkedValue` + the verdict; keep chevron, CellAction, save marks.
   The red "!" mapping-error pill becomes the `attention` mark (today screen readers do not read it; 3.9:1 contrast).
2. `master/columns.tsx` `withMark` → the same `MarkedValue` (Shared looks the same as today; one part, not two copies).
3. `channelCellProvenance` (new, in `sheet/channel/`) = the ONE channel verdict, in this order: refused › attention ›
   pending › ai/aiStale › outdated › formula › listingLevel › listingValue › mapped/mappedShared (only a real
   transform: expression, shared rule, constant/default, a rule with no plain source path) › inheritedOverride ›
   inherited (linked, language fallback) › pinned (listing override, saved Shopify pin) › own. A plain path that
   copies Shared, a variant's own Shared value, a channel-only field and an empty cell = own (no mark).
   `describeValueSource` (Cell details) switches on that member; `isRoutineSource` / `sourceHoverText` go if unused.
4. Cell tint (`master/channelColumns.tsx:158,186`), bullets mark (`:222`), Cell details (`useChannelSheetAdapter
   .tsx:910`) read `channelCellProvenance`.
5. Shopify `nexusDraft`: unsent draft → `pending`; saved pin → `pinned` (to check on the wire).
6. Tests: `master/channelColumns.vitest.test.ts`, `channel/CascadeCell.mounts.vitest.test.ts`,
   `cellDetailsSource.vitest.test.ts`, `cellTooltipWiring.vitest.test.ts` rewritten to the new rule.

**Review (after A + B):** one correctness review of the diff; one consistency pass that renders the same product on
Shared and on eBay / Amazon / Shopify and compares the marks and words; then the local checks below.

## Checks (LOCAL FIRST — LIGHT)

- `npm run typecheck -w @nexus/web` (baseline on 02f30039e: pass), `-w @nexus/api` (shared type), factory tsc.
- `cd apps/web && npx vitest run CascadeCell.mounts channelColumns.vitest cellDetailsSource cellTooltipWiring
  provenanceMark provenance.vitest provenanceLanguage provenanceMapped buildSheetColumns listingLevel
  live-channel-scope cascade-substrate SourceIndicator`
- Guards: `check-ds-fork-drift --check`, `check-nds-contrast` (both token files), `token-guard`, `check-token-resolution`,
  `ds-conformance-guard`, `check-raw-primitives-ratchet`, `check-css-*`, `check-ds-gaps-append-only`.
- One local browser check (big screen change): local API + local DB, `NEXT_PUBLIC_API_URL` set; Shared + eBay IT +
  Amazon IT + Shopify; light and dark; keyboard (Shift+F10 → Cell details); phone width.

## Not in this PR (the Owner decides later)

- **Cell details on the Shared scope.** Shared has no Cell details today (only hover). Recommended next PR: one
  "Cell details…" item in the shared right-click menu for both scopes.
- **Variants tab projection** (`variants/channel/projectionColumns.tsx`): its source icon IS the pin/edit button.
- **Matrix page marks**: the same code draws the Matrix page; 🔗 there means "follows the pool".
- `TooltipPortalProvider disabled` on the channel grid: the icon was its main reason; re-enable only after a speed check.

## Risks

- Phone: the one-tap icon to Cell details goes away; tap the cell, then the toolbar ⋯ → "Cell details…" (and long-press).
- `History` (outdated) and `Clock` (pending) are both clock faces at 11px — check by eye in the browser.
- `appliedTransforms` lists transforms that ran, not ones that changed the value — the "real transform" test must use
  the rule (expression / constant / fallback / transform list), never "the value differs".
