# Matrix polish — group colours and consistency (Owner 2026-10-08, PLAN — build after the Owner's yes)

The Owner asked: colour the Matrix column groups like the Product Information page, make the Matrix "AAA quality",
and leave no inconsistency. Research 2026-10-08: how the Information page colours groups, and a read-only visual audit
of the Matrix (GALE-JACKET, AIR-MESH-JACKET-MEN; 1440 / 390; light / dark; every group and dialog). Screens and logs:
`~/nexus-archive/2026-10-07-matrix-inventory/check/step7-*` and `check/shots/step7-*`.

## How the Information page does it
- It tints the COLUMN HEADER cells of each group (no band row), with a 2 px edge on a group's first column; cells stay
  white. Classes `nds-ag-head-tone nds-ag-head-tone--<tone>` (+ `--start`), DS `grid/theme/grid.css:2015-2044`.
- Ten fixed tones (`design-system/tokens/groupTones.ts`): slate, purple, emerald, pink, orange, blue, yellow, red,
  violet, cyan. The tone follows the group's KIND (Offer = emerald, Images = pink, …), the same on every channel.
- The class-picking code is private to the sheet (`_studio/sheet/sheetGroups.ts:81-109`); the Matrix must SHARE it
  (move it into the DS grid), not copy it. Customise shows the same tone on its group headings.
- Contrast: light text on 6 tones is 6.4–6.8:1 (AA, not AAA); dark is ≥ 8.6:1.

## The plan
1. **Group colours** — the Information page's classes and tokens, through ONE shared helper in the DS grid (the sheet
   moves to it too). The Matrix tints its column headers AND its group row (a DS rule for `.ag-header-group-cell`), with
   the start edge. One tone per channel, the same everywhere (Customise headings too):
   Product — none · Progress — slate (as on the Information page) · Shared — emerald (price and stock are "Offer" on the
   Information page) · Amazon — orange · eBay — blue · Shopify — purple · Etsy — pink · WooCommerce — violet ·
   any other channel — cyan. (Red and yellow stay free: they mean danger and warning.)
2. **AAA contrast** — the light tone text goes from colour-800 to colour-900 (every tone ≥ 7:1); the Information page
   gets the same, so the two pages stay identical.
3. **The consistency list** (from the audit, most visible first):
   1. Group labels: one alignment (left) and one wording ("Amazon EU · Inventory" vs "Amazon · IT").
   2. Listing cell: the ASIN always sits left, the note after it.
   3. Product column: the Information page's identity renderer (tree chevron, indent); at 390 px the SKU stays readable.
   4. Header ⋮ menu: on every column, the Information page's menu (today only 3 columns have it).
   5. Empty cells: one muted "—" everywhere (today blank and "—" mix).
   6. Tooltips: 300 ms like the Information page and the stock editor (today 2 s).
   7. One name per thing: "FBA shipments" (drawer said "FBA plans"); "variants" (Information says "children");
      the stock editor names the FBA column like the Matrix; the eBay header count matches the rows' status.
   8. Footer: no second "20 variants" (the toolbar says it).
   9. Focus: a dialog focuses its first field or title, rings only on keyboard focus (no ring on ✕, no blue panel edge).
   10. Dialog titles: "<Thing> · <SKU>" everywhere; the stock editor too (the product name as subtitle).
   11. Stock editor at 390 px: toolbar and footer wrap; notes placeholder "Notes (optional)".
   12. Segmented controls: one look in every dialog.
   13. The two cell pop-ups (Case, Sells from): one width and one placement.
   14. Customise: Progress under PROGRESS; the long "Not offered here…" paragraph shortened; the locked row on one line
       with readable text.
   15. Send to FBA table: no ⋮ header menus (a 1–5 row table).
   16. Bulk edit: no empty dashed box until a value is typed.
   17. Own value vs followed value: two clearly different looks (today two near-identical blue tints).
   18. "⚠" becomes an SVG icon like the lock (a phone may draw the text ⚠ as a colour emoji).
- DS changes reach other grids (the Information page above all): each is checked there too.
- Checks: typecheck, the matrix / sheet / grid / DS tests, the DS guards, a browser pass light/dark 1440/390 on both
  pages with screenshots, contrast measured again.
