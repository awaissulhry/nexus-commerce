# Industry research: how the rest of the market does formulas, bulk edit, round-trips and per-cell provenance

Date: 2026-09-02 · **Revision 2 (RS.1, ruled #493).** Revision 1 was written by an agent that read
no code; every "Nexus today" block below is new, and each of its lines cites `file:line` measured in
this working tree. The market research in revision 1 is kept as filed.

## Summary for the Owner (one minute)

**The short version: Nexus is further ahead than revision 1 of this document said, and the three
things worth building next are not the three it named.** Measured in the tree tonight: the formula
engine is **built** — ~32 functions in five groups (`expr.ts:836-871`), a per-cell formula *and* a
master rule (the two tiers this research recommended), a zero-database one-row preview endpoint
(`cell-formula.routes.ts:45`), and two things no competitor studied here has at all: a **Pricing**
group (`margin`, `markup`, `vat`, `exvat`) and `rule("name")`, which calls a saved business rule by
name where Rithum's own custom functions explicitly cannot call each other. Per-cell provenance is
**finer than the market's**, not coarser: 11 layers with distinct glyphs in the drawer chip and 8
cell states in the classifier, against Plytix's three — so revision 1's advice to adopt Plytix's
vocabulary is **withdrawn as a downgrade** (what was worth taking was the *filter*, and the hub has
taken exactly that as D14.3). The server-side row model is **live** on `/products/next`, saved views
are a **real server object**, undo, find-and-replace, version-restore, AI quarantine and the ⌘K
command palette are all **already shipped** — five of revision 1's fifteen "day one" gaps were built
before it was filed.

What is actually open is narrower, and more urgent than anything on the old list. **Paste and
fill-drag are live on the studio sheet and carry no validation whatsoever** — `writeGate`'s verdicts
are `no-column | grid-data | self-inflicted | unchanged`, with no concept of validity — so a value
over a channel's byte cap or off a closed list, one an operator *could not type*, is committed by a
corner-drag across a hundred rows. **Export is built and unusually honest** (it refuses outright
under the server-side row model rather than hand over a partial file — no competitor here documents
that), but **import is not on the sheet at all**: the toolbar has an Export button and zero
occurrences of the word Import, so data goes out and cannot come back. And **undo exists on exactly
one surface** (`/bulk-operations`), as a client-side stack, with nothing server-side and nothing
revertible about a bulk write or an import. So: **(1) validate the paste/fill path, (2) close the
round-trip with an import on the sheet, (3) make a bulk job revertible.** All three are already
ruled in the wave-4 design (D15.12, D15.1–15.6, D15.13); none is built. The market half of this
document stands unchanged and is below.

## The market, as filed in revision 1 (one minute)

Nobody in this market has solved the whole problem, and the gaps are consistent enough to be a plan. The **rule/formula syntax war is over and the winner is boring**: spreadsheet-shaped functions (`IF`, `CONCAT`, `LEFT`, `ROUND`) that reference attributes **by name, not by cell** — Plytix uses `$attribute`, Airtable `{Field Name}`, Baserow `field('name')`, Rithum `$itembrand` — with a `$` or `{` keystroke that opens an autosuggest picker. Every serious tool also keeps a **second, simpler tier** for the 80% case, which is pure concatenation, and Excel-literate operators reach for that tier first. The genuinely differentiated ideas are elsewhere: **Channable** shows the affected-item count and a **"Before this rule" / "After this rule"** comparison before you commit; **Rithum** lets you preview a rule against a named SKU and upload a preview file against a template, and draws a hard line between *inventory* rules (run on ingest, **stored**) and *marketplace* rules (run at export, **never stored** — "the output of the rules won't show in our system outside of rule and template previews"); **Plytix** has already invented the vocabulary Nexus needs for per-cell provenance — an attribute is tagged **Inheriting / Inherited / Overwritten**, you click **Resync** to drop back to the parent value, and you can *filter the attribute list by that status*. Against that, the omissions are glaring and shared: **Akeneo bulk actions show no preview and have no undo**; Shopify's bulk editor documents no undo either; Plytix documents no preview, no progress and no undo. And the single most expensive detail in the whole category is sparse-update semantics — Shopify: an *omitted* CSV column leaves the field unchanged, a *present but blank* cell overwrites it with blank; Amazon: `Update` treats your file as the complete picture and wipes empty cells, `PartialUpdate` only reads the cells you filled. Operators have been burned by that distinction for a decade, and no tool surfaces it in the UI at the moment of decision. So the openings for Nexus are: preview-and-revert as a first-class primitive, one Excel-shaped formula language with a per-SKU test bench, and an export file that *is* the import file with blank-means-ignore stated on screen.

**How to read the citations.** `[doc]` = I read the vendor's own documentation page. `[snip]` = the claim comes from a search-result snippet quoting vendor docs, which I could not open directly. `[3rd]` = third-party blog or community post. `[unverified]` = I could not confirm it either way; treat as a hypothesis to test, not a fact. Salsify's help centre (`getstarted.salsify.com`) refused TLS on every attempt and Quizlet returned 403, so **every Salsify line below is `[snip]` at best**.

---

## 1. Formulas, rules and transformations

### The three syntaxes that exist in the wild

**(a) Spreadsheet functions over named attributes.** The dominant form.

- **Plytix formula attributes** — `$` opens attribute autosuggest; you do not type the `ATT.` prefix yourself. Example given in the docs: `CONCAT($ATT.ATTRIBUTE, " ", JOIN($ATT.MULTISELECT, ","))` and `JOIN($YOUR_ATTRIBUTE, "your_separator")`. Operations are grouped Date / Info / Logical / Lookup / Math / Text / Statistical, and include `IF`, `AND`, `OR`, `NOT`, `DLOOKUP`, `INDEX`, `MULTIPLY`, `ROUND`, `CONCAT`, `UPPER`, `REPLACE`, `SUM`. Crucially there are `IFERROR` and `IFBLANK` operations, and formulas can be **validated before saving**. `[doc]` https://help.plytix.com/en/formula-cheat-sheet-and-guide
- **Rithum / ChannelAdvisor business rules** — attributes are `$`-prefixed: `IF($itembrand="Acme Co.", "Acme", $itembrand)`. `SELECTCASE(Cond1, Val1, Cond2, Val2, …, Default)` supports up to five condition/value pairs and evaluates in order. `CONTAINS("Girl scout cookies", "scout")` is case-sensitive. Reusable functions exist with a strict shape: `FUNCTION (VARS(@x,@y,@z), <a complete business rule> )`, called by name with parameters; quotes around text and lookup-list names, no quotes on numerics, `$` for stored fields. Custom functions **cannot nest or call each other**, and don't work in eBay template rules. `[doc]` https://www.rithum.com/blog/business-rules-101-common-functions/ · https://www.rithum.com/blog/business-rules-301-custom-functions/
- **Salsify** — `VALUE("propertyID")` is the building block; concatenation as `CONCATENATE('Red/Maroon', ' ', VALUE('Product Size'), ' ', 'Umbrella')`. In **templated exports only**, every function takes a `SALSIFY_` prefix: `SALSIFY_IF(SALSIFY_VALUE("Category"), "R/C Cars", "Y")`. `#` starts a comment. The same language is reused in Readiness Reports, Computed Properties, Templated Exports and Bulk Edit. `[snip]` https://getstarted.salsify.com/help/formulas-cheat-sheet-1c4ea6e
- **Airtable** — `{Field Name}` in braces, `IF(expression, value1, value2)`, e.g. `IF({Status} = 'Complete', '✓ Done', 'In Progress')`. `[snip]` https://support.airtable.com/articles/7330071120-airtable-formula-field-functions-reference
- **Baserow** — `field('field_name')`, case-sensitive, e.g. `concat('Number', field('text field'))`. **NocoDB** uses `{column_name}`. `[snip]` https://baserow.io/user-docs/understanding-formulas · https://docs.nocodb.com/0.109.7/setup-and-usages/formulas/
- **Notion Formulas 2.0** — dropped the mandatory `prop("Name")` wrapper in favour of inline property tokens, added `let(name, value, body)` for named intermediates and `ifs(cond, val, …, default)` to kill nested ifs. `[snip]` https://www.notion.com/help/guides/new-formulas-whats-changed

**(b) IF/THEN rule builders (no text syntax).**

- **Channable** — "IF the items meet X criteria, THEN do Y", extendable with ELSE. Thirteen THEN actions: Build item group, Calculate, Calculate formula, Copy value, Deduplicate items, Deduplicate list, Exclude, Modify text, Reformat number, Replace value, Search for value, Set to value, Split items. Only "Calculate formula" is a text expression: arithmetic `+ - * /` over project fields. `[doc]` https://helpcenter.channable.com/manage-improve-product-data/rules-bulk-edit-and-enrich/how-to-use-actions-then-in-rules
- **Akeneo** — a condition/action builder that is also importable as YAML. Action types: set, add, copy, concatenate, calculate, remove, clear, plus map, replace, convert and an AI generate. `[doc]` https://help.akeneo.com/serenity-build-your-catalog/manage-your-rules

**(c) Declarative field mapping with no expression language at all.**

- **Linnworks** — no formulas. Channel-specific values live as **Extended Properties**; built-ins are addressed with a `Product.` prefix (e.g. `Product.Weight`); the **Configurator → Specifications tab** picks, per listing field, whether to read the product value or a named Extended Property. `[doc]` https://help.linnworks.com/support/solutions/articles/7000058965-listings-extended-properties-instead-of-product-details
- **Sellercloud** — Product Summary → **Toolbox → Channel Properties**; "when you post or update the product, the Channel-specific UPC overrides the UPC from the Product Properties Page." `[doc]` https://help.sellercloud.com/omnichannel-ecommerce/using-different-upcs-for-channels/

### Where rules live, and the master/channel split

- **Channable** has exactly two tiers, and it is the cleanest model I found: **master rule groups** run on the *source feed* **before** each channel's own Categories and Rules steps. `[doc]` (same Channable URL as above, via `?ask=`)
- **Rithum** splits by direction, not by scope: **inventory rules** act on data *coming in*, can read the upload file but not existing Rithum SKU data, and their output is **stored** in inventory fields; **marketplace rules** act on data *going out*, can read stored inventory fields, and are **computed at export only**. A rule is attached per template field: open the template, click the field, click **Business Rule**, pick the rule, **Done**, save. `[doc]` https://www.rithum.com/blog/business-rules-101-introduction-to-business-rules/
- **Plytix** splits by persistence: a **formula attribute** is a stored attribute like any other; an **attribute transformation** is attached to a specific Channel or Brand Portal, is tagged **TRA** in that channel's Attributes tab, is edited via **Settings → Edit formula**, and *changes only the exported value — it does not alter stored product data*. `[doc]` https://help.plytix.com/en/create-computed-attributes
- **Akeneo** rules carry scope and locale on both sides of a copy, which is the closest thing in the market to Nexus's scope model:
  ```yaml
  actions:
    - type: copy
      from_field: description
      from_locale: en_US
      from_scope: print
      to_field: description
      to_locale: en_US
      to_scope: ecommerce
  ```
  `[doc]` https://help.akeneo.com/serenity-build-your-catalog/manage-your-rules

### Rule vs manual override: how it is shown in a cell

This is the weakest area in the entire category and Nexus's clearest opening.

- **Plytix is the only tool I found that names the states.** On a variant, an inherited attribute carries an **"Inherited"** tag; edit it and the tag becomes **"Overwritten"**, at which point it "will no longer inherit the value from the product levels above"; **Resync** restores it, warning that "resyncing variants will cause the inherited values to be restored. This will replace any overwritten value." On a parent, an attribute with inheritance on is tagged **"Inheriting"**. And the attribute list can be *filtered* by status: "Attributes inherited from the parent", "Attributes overwritten with individual product values", "Non-inherited attributes", "Attributes that don't belong to the product family". `[doc]` https://help.plytix.com/en/product-editing-overview · https://help.plytix.com/en/manage-product-variations
- **Akeneo** stores rule output as an ordinary attribute value. The docs describe conditions, actions and execution modes and say nothing about marking a value as rule-set, nor about what happens to a manual edit before the next run. `[unverified — the documentation does not address it in either direction]` https://help.akeneo.com/v7-build-your-catalog/v7-get-started-with-the-rules-engine
- **Airtable draws the opposite conclusion and enforces it**: a formula field computes for every record and **an individual cell cannot be manually overridden**. Purity at the cost of the override an operator actually needs. `[doc]` https://support.airtable.com/docs/formula-field-overview
- **Excel's precedent is the best one nobody has copied into a PIM.** A cell whose formula differs from its neighbours gets a green triangle — "the formula in the cell doesn't match the pattern of the formulas nearby" — and the fix menu offers **Copy Formula From Above** or **Ignore Error**. That is *exactly* pinned-vs-derived: mark the deviation, offer "resync" and "keep it, stop telling me". `[snip]` https://support.microsoft.com/en-us/office/fix-an-inconsistent-formula-5dd940a1-4f87-44bd-91dd-bf45ed828f05

### Empty sources, errors, and evaluation timing

- Explicit null/error handling exists only where the language is Excel-shaped: Plytix ships `IFBLANK` and `IFERROR` `[doc]`. Airtable does not degrade — an empty referenced field pipes null into the function and the cell returns `#ERROR!`; documented error states are `#ERROR`, invalid formula, `NaN`, circular reference, infinity `[snip]`.
- Akeneo conditions include an `EMPTY` operator, which is how the canonical "only fill it if it is blank" rule is written:
  ```yaml
  conditions:
    - field: family
      operator: IN
      value: [camcorders]
    - field: camera_model_name
      operator: EMPTY
  actions:
    - type: copy
      from_field: name
      to_field: camera_model_name
  ```
  `[doc]` (Akeneo rules URL above)
- **Timing.** Airtable and Baserow recompute on change (live) `[snip]`. Akeneo runs rules scheduled, on-save-triggered, workflow-triggered or manually, and "only processes products whose Last update date has changed since the previous run"; one help page states automatic runs at 05:00, 11:00, 17:00 and 23:00 UTC and after bulk actions or imports with rules enabled `[doc, but treat the exact times as unverified — a single page, not cross-checked]`. Rithum marketplace rules evaluate at export time only `[doc]`. Plytix transformations evaluate at export time; recalculation timing for *formula attributes* is not documented `[unverified]`.
- **Ordering at scale.** Channable states plainly that rules apply "from top to bottom, one after the other", and that "if an early rule excludes items, later rules won't affect those excluded items" `[doc]`. Akeneo rules carry an integer `priority` `[doc]`. Feedonomics markets the ability to "freely sequence the rules in the order you prefer" and to assign a transformer to one export or all of them `[3rd/marketing]` https://feedonomics.com/data-capabilities/optimization/. Nobody documents a dependency graph or topological recompute — ordering is the operator's problem everywhere.

### Which syntax an Excel-literate operator handles best

Two tiers, and the ordering matters:

1. **A template string for the concatenation case** — `{brand} {product_type} — {colour}, {pack_size}` — because the overwhelming majority of channel-derived fields (Amazon title, eBay title, handle, SEO title) are concatenations with separators. An Excel user reads this instantly and has nothing to learn. Channable's "Set to value" with field insertion and Plytix's `$`-picker both serve this case without the user writing a function.
2. **Escalate to a function expression only when the template cannot express it** — `IF(ISBLANK({colour}), {product_type}, CONCAT({product_type}, " - ", {colour}))`.

Then three rules for the expression tier, all borrowed from tools that got it right:
- **Reference by attribute name, never by coordinate.** Cell coordinates are the one thing about Excel that does *not* transfer to a product grid, because a row is a variation, not a position.
- **Insert references with a keystroke and an autosuggest list** (`$` in Plytix, `{` in Airtable). Typed names are how `field('field_name')` case-sensitivity bites people.
- **Ship `IFBLANK` and `IFERROR` on day one and show them in the editor's default snippet.** Every empty-source bug in this category is a missing one of those.

Avoid the `SALSIFY_` split (same function, two spellings depending on where it runs) and avoid Rithum's "custom functions cannot call custom functions" — both are seams the operator has to memorise.

---


### Nexus today — BUILT, and it already implements this section's recommendations

Timing matters for reading this: revision 1 of this document was filed at **06:12**, `expr.ts` was
written at **06:18**, `cell-formula.routes.ts` at **06:24** and the wave-4 design at **06:26** (file
mtimes). Section 1 above therefore describes a market Nexus had already caught, and in places passed,
within the hour.

- **The two tiers this section recommended both exist.** A per-cell formula (`GET/PUT/DELETE
  /pim/formulas/product/:productId`) and a global master field rule with revisions (`GET/PUT/DELETE
  /pim/formulas/master`) — `cell-formula.routes.ts:1-12`, routes at `:139/:144/:160/:185` and
  `:218/:222/:242/:254`. That is Channable's clean two-tier model, expressed as scope rather than as
  pipeline position.
- **~32 functions, grouped Logic / Text / Number / Pricing / Rules** — `EXPR_FUNCTIONS`,
  `expr.ts:836-871`. Names are lower-case and spreadsheet-shaped: `if`, `concat`, `left`, `right`,
  `substr`, `replace`, `split`, `join`, `pad`, `round`, `floor`, `ceil`, `min`, `max`.
- **The "ship it on day one" recommendation landed:** `ifblank` (`:838`), plus `coalesce` (`:839`),
  `isblank` (`:840` — documented as "0 and false are NOT empty", which is the trap in every other
  implementation) and `notblank` (`:841`).
- **`contains` is case-INSENSITIVE** (`:842`), the opposite of Rithum's documented case-sensitive
  `CONTAINS`, and the better default for operator-typed text.
- **Two capabilities no tool in this study has.** A **Pricing** group — `margin(cost, pct)`,
  `markup`, `discount`, `vat`, `exvat` (`:866-870`) — which turns the single most common
  channel-pricing formula into one named call instead of an arithmetic expression an operator has to
  get right; and **`rule("name")`** (`:871`), which runs a saved business rule from inside an
  expression. Rithum's docs state its custom functions *cannot* nest or call each other; this is the
  composition Rithum ruled out.
- **The rule test bench that revision 1 ranked #7 is built.** `POST /pim/formulas/preview`
  (`cell-formula.routes.ts:45`), described in its own header as "the cell editor's live line (zero-DB
  core)": it resolves the row's attributes once and calls `simulateFieldForCandidate` — pure,
  synchronous, writes nothing. That is Rithum's per-SKU preview as a live editor line rather than a
  separate screen.
- **`=` is a mode switch stripped on the SERVER too**, not only in the browser (`stripLeadingEquals`,
  `:33-36`) — the seam that would otherwise appear the first time anyone posts to the API directly.
- **A formula is restorable from its audit row**: `POST /pim/formulas/restore` re-creates one from a
  `formula.pinned` audit entry (`:205`), and the studio's restore pane routes to it
  (`useRestorePoints.ts:49,58,132-143`).

**One difference from this section's advice, and it looks deliberate — a QUESTION for the hub, not a
defect.** There is no `iferror` (`grep -c iferror expr.ts` → `0`), though `ifblank` is present. A
formula error surfaces as a cell error state rather than being swallowed inside the expression. That
is arguably the more honest choice and it agrees with this codebase's standing rules, but it is a
conscious divergence from every Excel-shaped language surveyed above, so it should be a decision on
the record rather than an omission.

---

## 2. Bulk editing at scale

| Capability | Akeneo | Plytix | Shopify | Channable | Rithum |
|---|---|---|---|---|---|
| Select all across pages | **Yes** — "Select **All** to apply changes on **all your products**, **All visible** for … (ongoing page)" `[doc]` | Filtered selection; cross-page select-all not documented `[unverified]` | Not documented `[unverified]` | Rules act on the whole filtered set `[doc]` | Template-wide `[doc]` |
| Preview before apply | **No** `[doc]` | Not documented `[unverified]` | n/a (direct edit) | **Yes** — affected count + before/after `[doc]` | **Yes** — per-SKU and preview file `[doc]` |
| Per-row outcomes | Execution details on the job `[doc]` | Not documented `[unverified]` | "If any errors occur, then you need to fix them, and then click **Save** again" `[doc]` | Item counts `[doc]` | Preview output per SKU `[doc]` |
| Undo | **No** `[doc]` | Not documented `[unverified]` | Not documented `[unverified]` | Rules are editable/re-runnable `[doc]` | Rules are editable `[doc]` |
| Background job + progress | Yes — "processed as a background task", notification, execution details `[doc]` | Not documented `[unverified]` | Synchronous save `[doc]` | Scheduled feed runs `[doc]` | Scheduled `[doc]` |
| Find & replace | `replace` rule action `[doc]` | **Yes**, with **"Match case"** `[doc]` | No `[unverified]` | "Replace value" action `[doc]` | `REPLACE`-style functions `[doc]` |
| Arithmetic on numerics | `calculate` action `[doc]` | Math operations in formula attributes `[doc]` | No — typed values only `[3rd]` | "Calculate" and "Calculate formula" `[doc]` | Math functions `[doc]` |

Details worth stealing:

- **Akeneo** offers 14 bulk operations (edit/add attribute values, change family, change status, groups, categories ×3, attach to or change a product model, convert to simple, associate, publish/unpublish), and states "Changes will be applied on the scope and the locale selected in the product grid" — the bulk action inherits the grid's channel/locale context rather than asking again. `[doc]` https://help.akeneo.com/v7-take-the-power-over-your-products/v7-bulk-actions-on-products
- **Plytix** bulk edit covers attributes (including a **"Clear content"** action), media, categories (Add / Replace / Remove), relationships (capped at 300 products per action) and find-and-replace on text attributes, with **"Include all variants of selected parent products"** as a checkbox. `[doc]` https://help.plytix.com/en/bulk-edit-products
- **Shopify's bulk editor** is the closest thing to Nexus's studio in a mainstream admin: select rows → **Bulk edit** → a spreadsheet where each row is a product or variant and each column a property, chosen via **Columns**. Type into cells, copy/paste, **drag the corner of a cell to apply the same value to multiple products**, Tab between cells. Changes are *not* auto-saved — you click **Save**, fix errors, Save again. `[doc]` https://help.shopify.com/en/manual/shopify-admin/productivity-tools/bulk-editing · fill-handle/Ctrl+Z detail `[3rd]` https://resources.storetasker.com/blog/how-to-use-the-shopify-bulk-editor-for-multiple-products
- **Channable's preview is the pattern to copy verbatim**: "The top bar shows how many items are affected", and **"Before this rule"** / **"After this rule"** toggles let you compare item state around the rule you are editing. `[doc]`
- **Undo, where it exists at all, is versioning rather than undo.** Akeneo has a per-product History tab; **restore a previous version is Enterprise-only**, with a 90-day default history length on Cloud. `[snip]` https://help.akeneo.com/serenity-take-the-power-over-your-products/serenity-restore-a-previous-product-version

---


### Nexus today — the affordances are built; the safety around them is not

- **Undo exists, on exactly one surface.** `/bulk-operations` has a real undo/redo history
  (`useBulkUndoRedo`, `BulkOperationsClient.tsx:140`, wiring at `:931-951`). It is a **client-side
  stack**: the studio sheet has no undo, and no bulk write or import is revertible server-side. So
  Nexus is ahead of Akeneo, Plytix and Shopify (none of which document undo at all) on one page, and
  level with them everywhere else.
- **Find & replace exists on that same surface** — `_shared/bulk-edit/components/FindReplaceBar.tsx`
  and `bulk-operations/components/FindReplaceBar.tsx`. The studio `SheetToolbar` has **Find**
  (`:208`) and no replace.
- **Shopify's most-praised affordance is already here.** Paste and drag-the-corner fill are live on
  the studio sheet: `GridSheet.tsx:126` sets `cellSelection: { handle: { mode: 'fill' } }`,
  `modules.ts:125-126` registers `CellSelectionModule` and `ClipboardModule`, and header-matched
  paste is wired through `processDataFromClipboard` (`MasterSheet.tsx:925,1485`).
- **🔴 And nothing validates either of them — the largest open risk in this document.** `writeGate`
  answers only "is this an operator's edit?", with verdicts `no-column | grid-data | self-inflicted |
  unchanged` and no concept of validity; `sheetWriter.ts` holds zero validation references; and
  `validation` in the sheet's `columns.tsx` is display-only (the tint at `:195`, a tooltip at
  `:204`). A value over a channel's byte cap or off a closed list — one that **could not be typed**,
  because the editor prevents it — is committed by a fill drag across a hundred rows. Ruled D15.12
  (validation moves into the write gate for every source; a refused cell renders refused and keeps
  the pasted text visible as unsaved); not built.
- **Writes batch per row and carry a version.** `PATCH /api/products/bulk` CAS-bumps inside its
  transaction and the batcher exists because a 20 × 5 paste from Excel fires 100 `cellValueChanged`
  events (`sheetWriter.ts:8-21`). The same header records that **124 other write sites** — sync jobs,
  bulk operations, the pricing engine — never bump the version (`:30`).
- **Select-all-across-pages is a knob that exists and is off.** `presets.ts:34` declares
  `selectAll?: 'all' | 'filtered' | 'currentPage'`, defaults to `'currentPage'` (`:46`), and
  `/products/next` passes `'currentPage'` (`ProductsNextClient.tsx:809`). Akeneo's headline "select
  All / All visible" is one preset value away.

---

## 3. Import / export round-trips

- **Is the export the import?** Akeneo comes closest: **Quick Export** from the grid offers CSV or XLSX, a **"Export with codes or labels"** choice (**Codes** for identifiers, **Labels** for human names), and "columns in the exported file follow the same order as the columns displayed in your Product grid", with "only the working Channel taken into account". `[doc]` https://help.akeneo.com/en_US/import-export-data/13-serenity-quick-export-your-products
- **Headers as keys, not labels.** Akeneo's file format encodes scope and locale in the header itself: `attribute-locale-scope`, e.g. `description-en_US-mobile`; localisable-only is `name-en_US`; currency is `price-EUR`. `[snip]` https://docs.akeneo.com/1.5/reference/import_export/formats/product.html — this is the single most transferable idea in this section for a tool with master / Amazon-per-market / eBay-per-market scopes.
- **Sparse-update semantics are where money is lost.** Shopify: with "Overwrite products with matching handles", "if an optional column is omitted from the CSV, Shopify leaves that existing field unchanged", but a column that is *present and blank* can overwrite the existing value with blank. `[snip]` https://help.shopify.com/en/manual/products/import-export/using-csv. Amazon's flat file makes the same distinction an explicit column: `Update` treats your row as the complete picture and blanks anything you left empty (this is how bullets, backend keywords and browse nodes vanish), while **`PartialUpdate` reads only the cells you filled**. `[3rd — Amazon's own help was not read; treat as operationally true but unverified against Amazon docs]` https://flatfile.pro/ffp/amazon-flat-file-update-vs-partial-update/
- **Dry run / diff:** none of the PIMs document one. Rithum is the exception in spirit — **Upload Preview File** on an inventory template, under 100 KB, renders the mapped output before anything is committed. `[snip]` https://www.rithum.com/blog/business-rules-101-introduction-to-business-rules/
- **Partial failure:** Akeneo runs imports as jobs with a live-refreshing execution page and accepts CSV and XLSX up to 5 GB, first sheet only; whether a bad row is skipped or aborts the job, and whether there is a downloadable error report, is not stated on the page I read `[doc for the formats/limits, unverified for the failure semantics]` https://help.akeneo.com/import-export-data/import-your-data. Akeneo does ship distinct job profiles named "Product import with rules in XLSX/CSV", i.e. **whether rules fire during an import is a property of the import profile**, which is a clean way to express it `[doc]`.
- **Per-product-type templates** are the norm on the channel side (Amazon flat files are per product type; Rithum templates are per marketplace) and the exception on the PIM side, where the family/family-variant plays that role `[doc]`.
- **How formulas export:** they don't, and that is deliberate. Rithum: marketplace-rule output "won't show in our system outside of rule and template previews". Plytix transformations affect the exported value only, never stored data. Airtable formula columns export as computed values. `[doc]` — the implication for Nexus is that a round-trip export must decide, per column, whether it emits the *derived* value or the *pinned/own* value, and must say which on screen.
- **Plytix's import has the override switch Nexus needs**: when assigning products to families by import you choose **"Ignore for variants"** (keep the inherited value) or **"Overwrite"** (give the variant its own). `[snip]` https://help.plytix.com/en/manage-product-variations

---


### Nexus today — the outbound leg is built and unusually honest; the return leg does not exist

- **Export is wired on both studio sheets** — `exportGridCsv` at `MasterSheet.tsx:1243` and
  `ChannelSheet.tsx:820`, surfaced as the toolbar's **Export** button (`SheetToolbar.tsx:190`).
- **🟢 And it refuses rather than lie, which nothing in this study does.** Under a server-side or
  infinite row model it throws `GridExportRefused` (`exportGrid.ts:79`): *"This grid loads rows from
  the server as you scroll, so the file would silently hold only the part already loaded. Export the
  query instead."* Every competitor surveyed would hand over the partial file. It also refuses to
  print the literal `[object Object]` for a structured cell, having met exactly that in the first
  real export of the readiness column (`exportGrid.ts:~92`) — "that string is not a value, it is the
  ABSENCE of one".
- **🔴 Import is not on the sheet.** `SheetToolbar.tsx` contains **zero** occurrences of the word
  Import. Import machinery exists elsewhere in the product (`flat-file-import.routes.ts`,
  `import-wizard.routes.ts`, `flat-file-unified.routes.ts`, `scheduled-imports.routes.ts`), but not
  as the return leg of the file the sheet just produced. Data goes out and cannot come back, which is
  the worst of the three possible states — worse than having neither, because the operator has a file
  and an expectation.
- **The round-trip is fully designed and unbuilt.** D15.1 makes the export file the import file with
  a mechanical acceptance test (export a view, re-import unmodified, **zero changes**); D15.2 puts
  the human label on row 1 and the key on row 2 as `key@channel:market:locale` — precisely this
  section's recommendation, Akeneo's `attribute-locale-scope` in Nexus's vocabulary; D15.4 makes
  import preflight-first and dry-run by default with a per-cell `unchanged / changed / refused /
  would-pin` diff; **D15.5 answers the sparse-update question this section calls the most expensive
  detail in the category** — one option, "Blank cells: ignore (default) / clear", echoed in the diff
  summary; D15.6 makes every import a revertible job storing `(job, entity, field, scope, before,
  after)`; D15.13 fixes the diff/job contract, with **`partial` as its own state** so a job that
  finished with refusals is never reported as completed.

---

## 4. Channel mapping and override precedence

- **Akeneo — scope × locale as first-class dimensions.** An attribute is *scopable* (a value per channel) and/or *localizable* (a value per locale); localised and scoped values surface in the product form's right-hand **Compare / Translate** panel, where you can select "all localized values", "all visible" or "none" and hit **Copy** to push them into the form. The channel and locale selectors sit in the product form header, and you can edit several channels in sequence and save once. `[doc]` https://help.akeneo.com/serenity-take-the-power-over-your-products/serenity-enrich-your-product
- **Plytix — parent → variant, per attribute, with named states.** Inheritance is set ON/OFF per attribute in the family; turning it ON overwrites the variant's current value with the parent's; the states are **Inheriting / Inherited / Overwritten** and the escape hatch is **Resync**. `[doc]` (Plytix URLs above)
- **Sellercloud — channel wins if populated.** Channel Properties override Product Properties at post time; what happens when the channel field is *blank* is not documented `[unverified]`. This is the trap Nexus already avoids with an explicit pin.
- **Linnworks — the override is a separately named field.** You create an Extended Property and point the Configurator at it instead of the product value; there is no documented fallback if it is empty, and no documented preview of which value will actually be sent `[unverified]`. Two failure modes for free.
- **Channable — precedence by pipeline position**, not by field: master rules on the source feed, then per-channel rules; last write wins because rules run top to bottom. `[doc]`
- **Nobody found displays a locale tier under a market tier.** Akeneo has channel × locale but no notion of "market"; the marketplace tools have market but no locale. A master → channel → market → locale chain, shown per cell, is genuinely unclaimed ground `[unverified — absence of evidence across the eight tools I looked at, not proof]`.

**Vocabulary recommendation.** Plytix's words are already in operators' mouths and map onto Nexus's marks almost one-to-one: `inherited` = **Inherited**, `pinned` = **Overwritten**, `mapped` = **Derived/TRA**, and the unpin action should be called **Resync**, not "unpin". The one Nexus mark with no market precedent is `AI-drafted`; keep it visually distinct because it is the one an auditor will ask about.

---


### Nexus today — ahead of the market, and revision 1's recommendation here was wrong

- **Nexus's vocabulary is finer than Plytix's, not coarser.** The drawer chip carries **11 layers**,
  each with a distinct glyph *and* a distinct word, with colour explicitly demoted to the third
  signal because "a chip that means something only by its colour means nothing in a screenshot, in
  forced-colours mode, or to an operator who does not separate blue from green"
  (`ProvenanceChip.tsx:1-48`): master 🔗, variant ✎, alias ✎, aliasVariant ✎✎, channel ✎, linked ⇄,
  default ·, locale 🌐, mapped ƒ, locked 🔒, unknown ?.
- **The cell classifier carries 8 states** (`provenance.ts:49-50`): `own | inherited |
  inheritedOverride | pinned | ai | aiStale | mapped | mappedShared`.
- **🔴 Revision 1's advice to adopt Plytix's Inheriting / Inherited / Overwritten is withdrawn — it
  is a downgrade.** Three states cannot express `aliasVariant` (pinned on one alias *and* one
  variation — "a second mark, not a shade of the first"), `mappedShared` ("editing one changes all of
  them"), or `aiStale`. What was genuinely worth taking from Plytix was not the words but the
  **filter**, and the hub has taken exactly that: **D14.3 turns the §9.6 marks into filter chips**.
  That item is therefore neither a gap nor a downgrade — it is adopted, as a capability rather than
  as a vocabulary.
- **The layer is server-authoritative.** `provenance.ts:58-63`: the server's verdict is
  "AUTHORITATIVE when present … a client re-deriving it from `source` strings is guessing at
  something already decided." That is the discipline Sellercloud (channel-wins-if-populated, blank
  behaviour undocumented) and Linnworks (an override that is a separately named field with no
  documented fallback) both lack.
- **The marks reach the grid as per-state CSS classes**, so the sheet and the drawer cannot drift
  apart (`provenance.ts:237-243`).
- The one place the market is still ahead: Plytix ships **Resync** as a verb on the value. Nexus has
  the states and (under D14.3) the filter; the one-click "drop back to what it follows" action is
  worth naming as a verb rather than leaving it to a clear-the-cell gesture.

---

## 5. Scale UX

- **Akeneo's advanced product grid** is the most complete reference point: Locale and Channel dropdowns at the top of the left panel driving the whole page; 25 rows per page by default with 50 and 100 options; a Filters Management Panel; **Saved Views** that preserve filters, columns, sort order, channel and locale under a name; a **Manage Columns** picker limited to attributes flagged "Usable as grid filter"; a four-level hierarchy (Model / Submodel / Variant / Simple) with **Grouped**, **Ungrouped**, **Flat** and **Consolidated by Model** display modes; a Selection Toolbar offering mass edit, sequential edit, quick export and delete. The page also states a 10,000-item ceiling across all pages, a maximum of 30 active filters, and that inline editing disables past 50 columns. `[doc for the shape; treat the three numeric ceilings as unverified — single page, not cross-checked]` https://help.akeneo.com/serenity-take-the-power-over-your-products/serenity-get-familiar-with-the-product-grid
- **Plytix** has a **Levels Selector** ("All levels" / "Parents" / "Variants"), an **Edit columns** manager with search, drag-reorder and **Apply**, AND/OR filter combination, and saved **Table Views** — with the detail worth copying that **"unsaved filter changes are flagged at the top of the page until you save them as part of a view"**. `[doc]` https://help.plytix.com/en/navigating-the-product-overview-page
- **A product page at 500 variations:** nobody renders it. Akeneo caps *axes*, not variants — a family variant may have up to ten variant axes across at most two levels — and the product form edits one level at a time with variants reached through the hierarchy `[snip]` https://api.akeneo.com/documentation/products-with-variants.html. Plytix puts variants on a separate **Variants** tab listing SKUs as links `[doc]`. **Nexus's variations × attributes sheet is the differentiated artefact here**, which also means there is no prior art to copy for its performance envelope — it has to be measured, not assumed.
- **Client-side grids hit a wall well below the Owner's target.** Airtable caps a table at 100,000 records with a base-wide 500,000 on Enterprise, and community reports put practical grid degradation nearer 20,000 once formula, rollup and linked fields are in play `[3rd]` https://www.whalesync.com/blog/airtable-record-limit. AG Grid's own guidance is that the Client-Side Row Model suits datasets that fit in the browser (its worked example is 10,000 rows) and that the **Server-Side Row Model** — blocked lazy loading, server-side sort/filter/group/pivot, lazy group expansion — is for data "too large to load entirely into a browser". At hundreds of thousands of SKUs the row model is not a tuning choice, it is the architecture. `[doc]` https://www.ag-grid.com/react-data-grid/server-side-model/
- **Completeness at scale** is Akeneo's, and it is computed rather than stored per cell: it compares filled required attributes against total required attributes **for each channel/locale combination**, with "required" declared per family under the Attributes tab. A product is 100% when the family's required attributes have values for that channel and locale. `[snip]` https://help.akeneo.com/v7-your-first-steps-with-akeneo/v7-understand-product-completeness. Salsify's equivalent is the Readiness Report, which maps content to a retailer's requirements and reports "required attributes missing sources" and "required attributes missing data" `[snip]`.

---


### Nexus today — the architecture question is already answered

- **The server-side row model is not a plan, it is live.** `/products/next` runs
  `rowModelType="serverSide"` with a `serverSideDatasource` (`ProductsNextClient.tsx:1025-1026`);
  the modules are registered in the shared engine (`modules.ts:69-70,79-80`). Against Airtable's
  100,000-row table ceiling and AG's own guidance that the client-side model suits what fits in the
  browser, Nexus is already on the architecture this section says the scale target requires.
- **The studio sheet is deliberately the other model** — `MasterSheet.tsx` sets no `rowModelType`,
  i.e. client-side — which is correct for one family, and is precisely what SC.1 has to measure at
  500 variations. As revision 1 noted, there is no prior art to copy for that envelope: nobody else
  renders it, so it has to be measured rather than assumed.
- **Saved views are a real server object, not local state.** `useGridViews.ts:11` rides "the
  `SavedView` table and the `/api/saved-views` CRUD that already exist"; `useGridState.ts:11` gives a
  **server default view** (`isDefault`) that wins on first load.
- **Not found: Plytix's unsaved-view banner.** Neither `useGridViews.ts` nor `useGridState.ts`
  contains `dirty` or `unsaved`. This is the cheapest item on the whole list and it stays open.
- **Column state ↔ the Customise dialog is one tested bridge**, and it reads *from the grid* rather
  than from a copy the page keeps, so a column dragged in the header shows up in that order when the
  dialog opens (`columnPrefs.ts:1-13`).
- **Completeness exists per scope** with a four-state vocabulary — `ready | warn | blocked | absent`
  (`readiness.ts:13`) — and the parser is deliberately strict in one direction, because "the failure
  mode is silent: a coerced `null`, a numeric string, or a `NaN` that renders as `0%` states 'we
  checked and everything required is missing' about a scope nobody scored" (`readiness.ts:1-8`).
  That is Akeneo's per-channel/locale completeness with an honesty rule Akeneo does not document.

---

## 6. App chrome in operator tools

- **Shopify admin (Polaris)** — a `Frame` that houses primary navigation in a **left sidebar** plus a persistent **top bar** carrying search, the user menu and the logo; navigation items are grouped into titled sections; the Frame also owns toasts and the **contextual save bar** that appears when there are unsaved changes. Global search lives in the top bar. `[doc]` https://polaris.shopify.com/components/frame · https://polaris.shopify.com/components/top-bar
- **Amazon Seller Central** — a persistent top header carrying the logo, notifications flag, the **Marketplace Switcher**, a **search bar**, messages/help/settings, plus a hamburger at top-left opening the main menu and a horizontal nav bar (Catalog, Inventory, Orders, Advertising, Reports, Performance). No full-height left rail; the market switcher and search are both in the header. `[3rd]` https://www.ecomengine.com/blog/amazon-seller-central · https://feedvisor.com/university/navigations-tabs/
- **Linear** — full-height left sidebar, **fully collapsible** via the `[` shortcut, clicking the sidebar border, or the command menu; navigation is dominated by ⌘K rather than by chrome. `[doc]` https://linear.app/changelog/unpublished-collapsible-sidebar
- **Airtable** — its 2025 base redesign consolidated sidebars and sub-navigations to be consistent across Data, Automations, Interfaces and Forms, put the AI panel on the left as the primary interaction model, and *was still working on making the left navigation collapsible* in response to space complaints. `[3rd]` https://community.airtable.com/product-discussions-71/new-base-ui-45686

**What this says for Nexus.** The consensus for a data-dense operator tool is: **full-height left sidebar, collapsible with a single keystroke; a thin persistent top bar that owns global search, the account/market switcher and notifications; and a page header that does *not* scroll away when the header carries the scope selector or the save state.** Two specifics: the market/marketplace switcher belongs in the persistent chrome (Seller Central puts it there because operators change market constantly and mis-scoped edits are expensive), and unsaved state belongs in a contextual bar pinned to the viewport (Polaris), not in a header that scrolls off — a sheet with per-cell autosave still needs a persistent place to say "3 writes in flight".

---


### Nexus today — largely built; what D17 decides is geometry, not search

- **`AppTopBar.tsx:7`** already owns "the brand, per-screen context (TB.5), the search trigger and
  the identity/utility" group — the Polaris/Seller Central consensus shape this section describes.
- **There is one search, and the header does not duplicate it.** The field *dispatches*
  `nexus:open-command-palette` and "is never a second search" (`AppTopBar.tsx:13-15`, trigger at
  `:88-96`) — the same class of seam this document warned about in Salsify's two spellings of one
  function, avoided by construction.
- **⌘K is shipped.** `CommandPalette.tsx` carries chords, "On this page" context commands, and live
  remote search across listings / shipments / pending orders; it is mounted globally at
  `layout.tsx:137` and kept there deliberately as "a keyboard surface with no resting UI".
- The rail is `AppRail.tsx` / `AppNavRail.tsx` with its model in `app-nav.ts`.
- **So revision 1's #13 was already shipped when it was filed as a gap.** What D17 is actually
  deciding is the Owner's geometry question — the sidebar running to the top-left and the header
  scrolling away, Seller-Central-style — not whether there is a palette. The one substantive point
  from this section that still applies is the market/marketplace switcher belonging in persistent
  chrome, and the unsaved/in-flight state needing a pinned place to say "3 writes in flight".

---

## 7. Ranked: what a best-in-class operator expects on day one — RE-RANKED against the measured tree

Revision 1 ranked fifteen items without reading the code. Measured, **five were already built**
(#5 find & replace, #7 rule test bench, #9 saved views, #12 version restore, #13 command palette),
**one was built and unmentioned** (AI quarantine, #15, which it half-credited), **two were already
adopted by the hub as designs** (#6 as D14.3, #4 as D15.5), and **one was inverted** — #3 named the
round-trip as a gap when the outbound half is not only built but deliberately refuses to produce a
misleading file. What it *missed entirely* is now the top item: the sheet's two fastest bulk-editing
gestures write unvalidated values.

Ranked by (frequency of use × cost of being wrong), highest first. **BUILT** = measured in the tree ·
**DESIGNED** = ruled in `docs/2026-09-02-wave4-design.md`, not built · **OPEN** = neither.

| # | Item | Status | Where it stands |
|---|---|---|---|
| 1 | **Validation on the paste / fill-drag path** | DESIGNED (D15.12) | Paste and fill are live (`GridSheet.tsx:126`); `writeGate` has no concept of validity; a hundred-row corner-drag commits untypeable values |
| 2 | **Import on the sheet — the round-trip's return leg** | DESIGNED (D15.1–15.6) | Export wired and honest; `SheetToolbar` has **zero** occurrences of "Import" |
| 3 | **A revertible bulk / import job** | DESIGNED (D15.6, D15.13) | Undo exists only as a client-side stack on `/bulk-operations` (`useBulkUndoRedo`) |
| 4 | **Blank-cell semantics stated on screen** | DESIGNED (D15.5) | The category's most expensive detail; one option, default ignore, echoed in the diff |
| 5 | **Find & replace on the studio sheet** | OPEN (built elsewhere) | `FindReplaceBar.tsx` exists on `/bulk-operations`; `SheetToolbar:208` has Find only |
| 6 | **Per-row outcomes + a downloadable failure file** | DESIGNED (D15.13(5)) | `partial` is its own job state; the failure CSV is the half still missing everywhere in the market |
| 7 | **The unsaved-view banner** | OPEN | No `dirty`/`unsaved` in `useGridViews.ts` or `useGridState.ts`; cheapest item on the list |
| 8 | **A `resync` verb on a cell** | OPEN | 11 layers and 8 states exist; the one-click "drop back to what it follows" is unnamed |
| 9 | **Select-all across pages** | OPEN (one preset value) | `presets.ts:34` offers `'all'` / `'filtered'`; everything passes `'currentPage'` |
| 10 | **A stated scale envelope** | OPEN | Competitors hide their ceilings until you hit them; publish the measured numbers where the limit binds |
| 11 | **`iferror`, or a ruling that its absence is deliberate** | OPEN (question) | `ifblank` shipped, `iferror` absent; errors surface as cell state — likely correct, but undecided on the record |
| 12 | Per-cell provenance **filter** | ADOPTED as D14.3 | Neither gap nor downgrade — taken as a capability, not as Plytix's vocabulary |
| 13 | Preview before apply | BUILT for formulas | `POST /pim/formulas/preview`, zero-DB, live editor line |
| 14 | Rule test bench against a real SKU | BUILT | Same endpoint; `simulateFieldForCandidate`, pure and synchronous |
| 15 | Saved views carrying scope/columns/filters/sort | BUILT | `SavedView` + `/api/saved-views` + a server default view |
| 16 | Per-product version history with restore | BUILT | `useRestorePoints`, `HistoryPane`, `RestoreMode`; restorable set shared with the endpoint (`restorable-fields.ts`) so pane and API cannot drift |
| 17 | Global search + command palette | BUILT | `CommandPalette.tsx`, one search, mounted at `layout.tsx:137` |
| 18 | Fill handle and paste-a-column | BUILT | …which is exactly why #1 is #1 |
| 19 | AI output quarantined until accepted | BUILT | `AiDraftReview.tsx`, `ai`/`aiStale` provenance states, `drafts.ts` |
| 20 | Completeness / readiness per market | BUILT | `readiness.ts`, four-state scope vocabulary, strict wire parsing |

### The three to build first

1. **Validate the paste and fill path** (D15.12). It is the only item on this list where a *shipped*
   capability actively creates bad data, it needs no new UI, and the validator it needs already
   exists as display-only rules in `columns.tsx`. Everything else on this list can wait behind it.
2. **Put Import on the sheet** (D15.1–15.6). Export is built, wired and honest; the return leg is the
   single largest functional hole, and D15.2's two-row header (`key@channel:market:locale`) is the
   one idea in this whole research worth copying verbatim.
3. **Make a bulk job revertible** (D15.6). Undo is why operators do bulk edits in a spreadsheet
   instead of in the tool — Akeneo, Plytix and Shopify all document none — and Nexus already stores
   the `before` values it would need, in the audit rows the formula restore path already replays.

### Method and limits

Every "Nexus today" line above cites `file:line` read in this working tree on 2026-09-02. Absence
claims are the weak ones and are worded as such: "not found" means a scoped grep over the named files
came back empty, which is evidence about those files and not about the product. One such claim failed
during this pass and is worth recording — an early `head`-truncated grep made `cellSelection` look
absent from the studio, i.e. made paste and fill look *unbuilt*, which would have inverted item #1
into "add a fill handle". `GridSheet.tsx:126` settled it. The market half of this document (§1–§6
above the "Nexus today" blocks, and every `[doc]`/`[snip]`/`[3rd]`/`[unverified]` tag) is revision 1's
work, re-read but not re-verified against the vendors; those tags remain its own claim, not mine.

## Sources

Akeneo: https://help.akeneo.com/serenity-build-your-catalog/manage-your-rules · https://help.akeneo.com/v7-build-your-catalog/v7-get-started-with-the-rules-engine · https://help.akeneo.com/serenity-take-the-power-over-your-products/serenity-get-familiar-with-the-product-grid · https://help.akeneo.com/v7-take-the-power-over-your-products/v7-bulk-actions-on-products · https://help.akeneo.com/serenity-take-the-power-over-your-products/serenity-enrich-your-product · https://help.akeneo.com/import-export-data/import-your-data · https://help.akeneo.com/en_US/import-export-data/13-serenity-quick-export-your-products · https://docs.akeneo.com/1.5/reference/import_export/formats/product.html · https://help.akeneo.com/v7-your-first-steps-with-akeneo/v7-understand-product-completeness · https://api.akeneo.com/documentation/products-with-variants.html
Salsify (all unread — TLS/403): https://getstarted.salsify.com/help/formulas-cheat-sheet-1c4ea6e · https://getstarted.salsify.com/help/formula-building-basics
Plytix: https://help.plytix.com/en/formula-cheat-sheet-and-guide · https://help.plytix.com/en/create-computed-attributes · https://help.plytix.com/en/manage-product-variations · https://help.plytix.com/en/product-editing-overview · https://help.plytix.com/en/navigating-the-product-overview-page · https://help.plytix.com/en/bulk-edit-products
Rithum / ChannelAdvisor: https://www.rithum.com/blog/business-rules-101-introduction-to-business-rules/ · https://www.rithum.com/blog/business-rules-101-common-functions/ · https://www.rithum.com/blog/business-rules-301-custom-functions/
Linnworks: https://help.linnworks.com/support/solutions/articles/7000058965-listings-extended-properties-instead-of-product-details
Channable: https://helpcenter.channable.com/manage-improve-product-data/rules-bulk-edit-and-enrich/how-to-use-actions-then-in-rules · https://helpcenter.channable.com/readme.md
Feedonomics: https://feedonomics.com/data-capabilities/optimization/ · https://docs.feedonomics.com/
Sellercloud: https://help.sellercloud.com/omnichannel-ecommerce/using-different-upcs-for-channels/
Shopify: https://help.shopify.com/en/manual/shopify-admin/productivity-tools/bulk-editing · https://help.shopify.com/en/manual/products/import-export/using-csv · https://polaris.shopify.com/components/frame · https://polaris.shopify.com/components/top-bar
Amazon: https://flatfile.pro/ffp/amazon-flat-file-update-vs-partial-update/ · https://www.ecomengine.com/blog/amazon-seller-central
Grids: https://support.airtable.com/docs/formula-field-overview · https://support.airtable.com/articles/7330071120-airtable-formula-field-functions-reference · https://www.whalesync.com/blog/airtable-record-limit · https://community.airtable.com/product-discussions-71/new-base-ui-45686 · https://baserow.io/user-docs/understanding-formulas · https://docs.nocodb.com/0.109.7/setup-and-usages/formulas/ · https://www.notion.com/help/guides/new-formulas-whats-changed · https://support.microsoft.com/en-us/office/fix-an-inconsistent-formula-5dd940a1-4f87-44bd-91dd-bf45ed828f05 · https://www.spreadsheetclass.com/using-arrayformula-to-apply-a-formula-to-an-entire-column-in-google-sheets/
Other: https://linear.app/changelog/unpublished-collapsible-sidebar · https://www.ag-grid.com/react-data-grid/server-side-model/
