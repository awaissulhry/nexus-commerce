# Variation theme + categories on the Information sheet — rebuild plan (VTR)

Branch `feat/variation-theme-rebuild` · worktree `/private/tmp/nexus-variation-theme` · from `origin/main` 8a345981f · 2026-09-26.
Status: **APPROVED 2026-09-26 — D1 (a) save in Nexus + "publish needed" + the publish door does the channel work; D2 (a) values are dictionary options.** Step 0 BUILT locally (not committed) — see `HANDOFF.md`.
Evidence: `RESEARCH-1-shared.md`, `RESEARCH-2-channels.md`, `RESEARCH-3-categories.md` (this folder; every claim has file:line).

## Summary

- **What the Owner asked:** perfect the variation theme and everything category-related on the Information sheet; bulk changes;
  every scenario; no inconsistencies; the most control while staying simple. Then remove the Variants tab.
- **Why things "fell off":**
  - **The same fact is stored in several places, with many writers.**
    - Axes are kept in 3 places, and values in 3–4.
    - At least 5 writers change the axes, and 8 or more change values, each with different rules.
    - eBay follows an old theme string that the Information sheet never updates.
  - **Many actions exist only on the Variants tab:** generating combinations, the coverage check, including or excluding a variant per listing, value order, and the channel details panel.
  - **Other actions are missing everywhere:** renaming an axis, renaming or merging a value, value codes and labels, copying to other markets, bulk editing a theme, bulk editing categories, and a Shopify category picker.
  - **Some controls are dead:** split, fold, "Broadcast to other markets", "+ Add listing alias", and a theme-change plan with no way to apply it.
  - **Publishing can differ from the screen.** eBay sends the Shared values instead of the channel values the sheet shows. Amazon and eBay count a variant with no listing row as included; the sheet counts it as excluded.
- **The plan, in one line:** one store and one writer per fact; one panel on the Information sheet for the whole theme; a preview for every change that touches a live listing; bulk and "copy to markets" everywhere; publishing sends exactly what the sheet shows.
- **Build order (6 steps, each its own tested pull request):**
  1. Live bugs first.
  2. One data model.
  3. The Shared panel.
  4. The channel side and publish.
  5. Categories.
  6. Delete the Variants tab.

---

## 1. Rules the rebuild follows

1. **One store per fact.**
   - Family axes are an ordered list of dictionary attribute codes.
   - Each variant's value lives in `categoryAttributes.variations[code]`, and nowhere else.
   - Value order and labels have one home.
   - Everything else becomes read-only history.
2. **One writer and one validator.** Every path that changes axes or values goes through the same service: the sheet, bulk edit, add child, attach, import, generate, flat-file, auto-detect and catalog refresh. It does four things:
   - normalises values (trim, case, synonyms);
   - refuses a duplicate combination;
   - bumps the version, with a compare-and-set guard;
   - sends the event and refreshes the read cache.
3. **One panel.** The variation theme, on Shared and on each channel, opens one docked panel on the Information sheet. Each section shows what matters and nothing else.
4. **A preview before a change that touches a live listing.** This covers adding or removing an axis, renaming or merging a value, and changing a theme or category. The preview shows exactly what changes, where, and what the channel will need. You confirm, it applies, and Undo is available.
5. **Bulk everywhere.** Each of these has one verb with a preview:
   - many variants in one go (a single atomic save, not one request per row);
   - many families (from the `/products` selection);
   - copy to other markets and accounts.
6. **Publishing sends what the sheet shows.** The sheet and publishing share one definition of "included" and one source for channel values, and the channel limits are enforced in both.
7. **Full control per channel (the Owner, 2026-09-26: "if I want different [axes] for a specific channel, I should be able to do so
   … without any extensive efforts").** Every channel × market × account × listing alias can FOLLOW Shared or use its OWN axis set
   (choose which Shared axes, add channel-only ones where the channel allows), its own names, order and value labels. The panel
   always shows which it is ("Follows Shared" / "Own setup"), "Reset to Shared" is one click, and "Copy to markets" copies an own
   setup to other markets/accounts in one preview-and-confirm step.
8. **No dead controls.** Every control either works or is not shown. Etsy variations say plainly that Nexus keeps them but does not publish them yet.

## 2. What you will see (simple, and in full control)

**Shared view, parent row: the "Variation theme" cell opens the Variation panel.**
- **Axes:**
  - add, remove, rename and reorder axes;
  - each axis is linked to a dictionary attribute;
  - removing an axis that still holds values opens a preview ("12 variants hold values; 3 live listings affected").
- **Values, per axis:**
  - the list of values with code, label per language and order (drag to reorder);
  - add, rename (applied everywhere, with a preview), merge two values into one, and archive.
- **Coverage:** for example "18 of 20 combinations exist · 2 missing · 1 duplicate", plus two buttons:
  - **Generate missing variants** (preview first; the SKU pattern is filled in for you);
  - **Show duplicates**.
- **Channels:** one line per channel × market: its theme, status and problems. Each line opens that channel's section.

**Shared view, child rows**
- Each axis column offers the axis's values as a dropdown. A new value is added to the list after you confirm it.
- Fill, paste and select-then-set work on many variants, saved in one atomic request.
- New filter chips: **Missing values**, **Duplicate combinations**, **Not in every listing**.
- The toolbar's **Variants** menu holds: Add variant, Generate combinations, Attach existing, Move, Promote, Demote, Unlink.

**Channel view (Amazon, eBay, Shopify, Etsy per market): the theme cell opens the same panel's channel section**
- Theme picker, with only the themes valid for the product type.
- Map each axis to a channel attribute, and set channel names and channel value labels.
- Value order, where the channel uses it.
- Live limit checks with counts, for example "eBay: 5 axes · 250 variants · 65 characters".
- Collisions, with a fix for each.
- **Copy to other markets**, with a preview.
- A new **Included** column (one row per variant × listing alias): tick or untick; bulk include or exclude for the selected rows; limits and collisions are checked on each change.

**Classification (family and categories): a Classification panel that replaces the dialog**
- Family, searchable.
- Internal categories, from a searchable tree.
- A table with one row per channel × market, showing:
  - the category that is actually used;
  - where it comes from: own, mapping, inherited or legacy;
  - its status: OK, conflict or missing.
- Each row can be edited with that channel's picker. Shopify gets a real picker, not typed ids.
- **Copy to markets** is available.
- **Preview before a category change:** values that no longer apply, whether the theme still works, and what live listings need.
- **Bulk from `/products`:** select products, then **Classify…**. The same panel handles many products through one bulk endpoint, with one clear rule for parents and variants.

## 3. Build steps (each is its own pull request with tests and a browser check)

| Step | What | Proof |
|---|---|---|
| **0. Live bugs** | eBay "Restore inherited order" empties every eBay axis (it leaves `_variationAxesMode='override'`); eBay studio publish sends Shared values instead of the channel cell (pins, value maps, labels); one definition of "included" for the sheet and publish; validate a live eBay re-publish; re-check Amazon theme deprecation at publish; runtime-check Shopify value order | a failing test per bug, then green; publish payload equals sheet cells on a private copy |
| **1. One data model** | Axis definition = ordered dictionary codes (+ family value order and labels); values only in `variations[code]` linked to `AttributeOption` (code, labels, synonyms); ONE family writer + validator; every writer re-routed; retire `Product.variationTheme` as an axis store (eBay follows the axes); a backfill that reconciles the old stores and **reports every conflict** before writing (ADDITIVE migration) | backfill report on a private copy (all 338 products): 0 unexplained conflicts; every old writer's test goes through the new writer; duplicate combinations refused |
| **2. Shared panel** | Variation panel (axes, values, coverage, generate) + axis columns with value lists + atomic bulk value save + filter chips + preview gate for live-listing changes + Undo | browser: every scenario in §5 on GALE / VENTRA; 200-variant bulk edit in one request |
| **3. Channel side** | channel section (theme, mapping, labels, order, limits, collisions), **Included** column + bulk, Copy to markets, one eBay order writer, real limits (eBay 250/65/40, Shopify 2048 + value length, eBay category variation check), remove dead controls (split/fold/resolver until built), Etsy honest note; publish parity for Amazon, eBay, Shopify | parity test: for each channel, the payload built from the sheet == the payload publish sends; limits refused before publish |
| **4. Categories** | Classification panel, ONE bulk classification endpoint (replaces `bulk-attach-family`), `/products` "Classify…", Shopify picker, Copy to markets, correct source labels for all 4 channels, preview before a category change, a check that a family's variants share one product type, legacy `Product.productType` writers labelled or retired | browser + tests; category change preview lists exactly the values that stop applying |
| **5. Remove Variants tab** | delete the tab, its dock and the old variants CSV engine (~4,000 lines); redirect `?tab=variants` to Information; update gates and tests | no dead links; all gates green |

Steps 0 and 1 come first, because every later step depends on them. Steps 2, 3 and 4 then build on step 1 and can move in parallel lanes.

## 4. What is reused

- **Engine:** the resolver (`variation-rules.service.ts`, 52 tests) and the projection read/write with its gates.
- **Theme change:** the theme-change plans.
- **Editors:** `AxesPanelEditor` (71 tests) becomes the channel section's editor.
- **Generate and coverage:** Generate (dry run, then commit; 14 tests), `coverage.ts` and `generatePlan.ts` (25 + 25).
- **Writers and locks:** the `variation-axes` compare-and-set lock and `writeVariationValues`.
- **Categories:** the category resolver, the taxonomy search and `ChannelCategoryEditor`, the mapping impact review, and the classification save transaction.
- **Import/export:** the new file gets an "Included" column in step 3.

## 5. Every scenario, and what it will do

- **Families**
  - **Create a family from a standalone product:** the panel offers "Make this a family", then axes, then values, then Generate.
  - **Add an axis to a live family:** preview (existing variants need a value; the listings affected) → confirm → the new axis column is filled in bulk.
  - **Remove an axis:** preview (the variants that hold values, the listings affected) → confirm. The values are archived, not orphaned.
  - **Rename an axis, or rename a value used by live listings:** the change applies everywhere. The preview names the channels that need a republish (eBay may relist).
  - **Merge two values ("Nero" + "nero "):** one step, and every variant is updated.
  - **Duplicates, casing and whitespace:** normalised on save; duplicate combinations are refused.
  - **Reorder values:** one order on Shared, which channels follow unless you override it for a channel.
- **Bulk editing**
  - **Edit 200 variants:** one atomic save, with Undo.
  - **Many families at once:** select them on `/products`, then use **Variation theme…** or **Classify…**, with a preview.
  - **The same theme or category on 11 Amazon markets:** **Copy to markets** does it in one go.
- **Channels**
  - **Channel limits** (eBay 250 variants and 5 axes, Shopify 3 options and 2048 variants, value lengths): checked while editing and again at publish.
  - **A theme narrower than the family:** exclude variants per listing, or use a listing alias. The panel shows this clearly.
  - **Include or exclude a variant per alias:** the **Included** column; publish uses the same answer.
- **Categories**
  - **Change the category on a draft:** preview the values that stop applying, then confirm. The columns refresh.
  - **Change the category on a live listing:** preview, plus a note that it needs a republish (or a new listing on Amazon).
  - **A family whose variants have mixed product types:** flagged, with a fix.
- **Moving variants and Etsy**
  - **Move a variant between families:** its axes and duplicates are checked, and a preview shows the result.
  - **Etsy:** editable, and clearly marked as not published yet.

## 6. Coordination

- **Attributes session (`docs/attributes/PLAN.md`):**
  - **P3b (attribute scope)** owns placement and the "no family shows the core" behaviour.
  - **P8** owns moving readers onto `resolveBatch`.
  - Step 1 links values to `AttributeOption` and uses the dictionary, so we agree the value-code shape with them first.
  - The source-label fix (`resolve-batch.service.ts:338`) is coordinated with P8.
- **Product-sheet views session:** the sheet toolbar and preferences. We only add a panel and columns.
- **Claims:** a claim row is written in `docs/pes-claims.md`. Every file is named there before its first edit.

## 7. Decisions for the Owner

**D1 — What happens to a LIVE listing when its structure changes?** A structure change is adding or removing an axis, renaming a value, or changing the theme or category.
- **(a) Recommended:** Nexus shows the preview and saves the change in Nexus. The listing is then marked "structure changed — publish needed". The publish step does the channel work (eBay relist, Amazon new parent) with its own confirmation. This is safe, and it uses the one publish door.
- **(b)** Build automatic per-channel executors now. It is fully automatic, but slower to build and riskier (relists and new ASINs).

**D2 — Variation values: shared vocabulary or free text?**
- **(a) Recommended:** values become dictionary options (a code, a label per language, synonyms and an order), shared by all families that use the attribute. This makes "rename everywhere", merge, languages and clean duplicates possible.
- **(b)** Keep values as free text per family. It is simpler to build, but rename, merge and languages stay weak.
