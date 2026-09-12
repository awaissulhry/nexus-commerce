# 15 — Amazon CATEGORY / product type / browse node picker + AI category suggestion (dark) + SCHEMA-CHANGE banner

> ⚠ Volatility note, up front: `apps/api/src/services/pim/studio-sheet.service.ts` was modified at
> **2026-09-05 00:59:13** while I was reading it (AM.1's lane). One finding I had written down —
> "the studio never passes `ebayCategoryIds`, so the eBay category cannot drive eBay columns" — was
> **TRUE on my first read and FALSE on my second**; `ebayCategoryIdsFor` landed at `:754` and is wired
> at `:821/:826/:851`. I corrected it rather than shipping it. Every line number below was taken
> after 01:00 on 2026-09-05; re-grep before quoting one.

## 1. What it is (one paragraph, in operator terms)

The **product type** is the single value that decides *what Amazon will accept for this product at
all*: it selects the cached Product Type Definition, and that definition is the source of every
Amazon column, every length cap, every closed list and the whole required-field set. Change it and
the sheet is a different sheet. The **browse node** is a different fact wearing the same word
"category": it is where the listing gets *placed* in Amazon's browse tree — a list attribute
(`recommended_browse_nodes`, up to 232 permitted values on OUTERWEAR/IT), not a schema selector.
The **schema-change alert** is the operator's warning that Amazon revised the definition since they
last looked — a field became required, a field vanished, an enum value was deprecated — because
the required set they satisfied last week may not be the required set that publishes today. The
users are the listing operator setting up a new family (product type first, then everything else
becomes answerable) and the catalogue owner doing a Monday sweep (did Amazon move the goalposts on
any of my types?). eBay has the *same shape* under a different name: its leaf category id selects
its aspect set exactly as Amazon's product type selects its properties.

## 2. Old UI — inventory

**Amazon side, entry point:** `AmazonCockpit.tsx:704-716` mounts `CategoryCard`; `:284` calls
`useSchemaChangeDetector(marketInfo.code, productType)`; `:601-616` renders `SchemaChangeBanner`.

| piece | file:line | what it does | round-trip? |
|---|---|---|---|
| `CategoryCard` (530 lines) | `tabs/amazon-cockpit/category/CategoryCard.tsx` | read-only display of productType / browse node / breadcrumb + two actions | yes |
| "Detect from Amazon" | `:126-151`, url `:136` | `GET /api/categories/browse-path?channel=AMAZON&marketplace&productType` | server |
| "Search alternatives…" | `:153-179`, url `:164` | `GET /api/categories/suggestions?...&keyword=` — up to 12 `(productType, displayName, pathParts, browseNodes, count)` | server |
| Apply a suggestion | `:269-287` → `persistChanges` `:190-267` | TWO parallel writes: `PATCH /api/products/bulk` (`productType`, `:206`) and `PATCH /api/listings/:id` with `platformAttributes:{browseNodeId}` (`:230`) | server ×2, **not transactional** |
| Save detected node | `:289-301` | listing-side write only | server |
| Draft-bus preview | `:43`, `:273-276` | `setDraftField(productId,'productType'|'browseNodeId', …)` so the cockpit repaints before the PATCH lands | browser-local |
| Failure fallback | `:255-266` | clipboard-copy the value + `onJumpToClassic()` scroll to the classic field editor | browser-local |
| Self-describing footer | `:486-490` | prints its own write plumbing at the operator | — |

**Schema banner:** `schema/useSchemaChangeDetector.ts` (134 lines) fetches
`GET /api/amazon/flat-file/template?marketplace&productType` (`:78`), fingerprints the
non-OPTIONAL `fieldRef` set (`:44-51`), and diffs it against **`localStorage`**
(`cockpit:schema-fp:{marketplace}:{productType}`, `:40-42`). `SchemaChangeBanner.tsx:20-79` renders
amber with "Review fields" (scrolls to `AdditionalFieldsCard`, `AmazonCockpit.tsx:609-614`) and
"Mark as reviewed" (writes the new fingerprint).

**eBay side, for comparison:** `ebay-cockpit/cards/CategoryCard.tsx` (115 lines) + a **3-mode
picker** `CategoryPickerModal.tsx` (556 lines): Search (`:106`
`/api/ebay/flat-file/category-search`), "AI suggest" (`:133` `POST /api/ebay/cockpit/suggest-categories`,
tab at `:271`), Browse, plus copy-to-sibling-markets (`:178` `/api/ebay/cockpit/category-map`) and
Apply (`:211` `PATCH /api/ebay/cockpit/category`).

**Dead / stranded in the old tree:**
- `categories.routes.ts:317-333` — `function buildPath(node)` is declared after `export default` and
  has **no caller anywhere** (grep: one definition, zero uses). CODE-READ.
- `GET /api/categories/changes` (`categories.routes.ts:283-310`) has **zero clients** in
  `apps/web` or `apps/api`. A complete, indexed, cross-operator schema-change log that nothing reads.
- The old banner's "removed fields" list can only print raw `fieldRef`s — the labels come from the
  *current* manifest, which by definition no longer contains the removed field
  (`useSchemaChangeDetector.ts:120-122`, comment admits it).

## 3. Backend that exists

**Routes** (all under `/api`, `index.ts:742` registers `categoriesRoutes`):

| method + path | file:line | notes |
|---|---|---|
| `GET /api/categories/schema` | `categories.routes.ts:22-71` | cached or fresh `CategorySchema`; `?lite=1` drops the 50–500KB body; `?force=1` bypasses the 24h TTL |
| `GET /api/categories/browse-path` | `:87-160` | 🔴 see §5 D1 |
| `GET /api/categories/suggestions` | `:181-277` | 🔴 see §5 D2 |
| `GET /api/categories/changes` | `:283-310` | `SchemaChange` rows for `(channel, marketplace, productType)` since a timestamp. **Zero clients.** |
| `GET /api/listing-wizard/product-types` | `listing-wizard.routes.ts:1623-1670` | the real picker feed; error-classified (`auth_missing`/`auth_failed`/`upstream`) |
| `POST /api/listing-wizard/:id/suggest-product-types` | `:1678-1728` | keyed on a **ListingWizard row**, not a productId |
| `GET /api/products/:id/listings/AMAZON/:mk/detect-type` | `marketplaces.routes.ts:808-863` | ASIN or SKU → `{productType, variationTheme, browseNodes, categoryPath, asin, source}`; 503 when SP-API unconfigured (`:820`) |
| `POST /api/products/:id/listings/:ch/:mk/save-browse-nodes` | `:899-945` | writes `platformAttributes.attributes.recommended_browse_nodes` + `detectedCategoryPath`; **CREATES a ChannelListing if none exists** (`:935-943`) |
| `GET /api/products/:id/ebay-sibling-categories` | `:871-893` | reads the eBay category from `platformAttributes.**productType**` (`:883-886`) |
| `PATCH /api/ebay/cockpit/category` | `ebay-cockpit.routes.ts:242-310` | writes `platformAttributes.**categoryId**` + `_categoryHistory` (10 deep), find-or-create |
| `POST /api/ebay/cockpit/suggest-categories` | `:128-172` | eBay Taxonomy `get_category_suggestions` — **not an LLM** |
| `GET /pim/channel-mapping/:ch/:code/channel-categories` | `channel-mapping.routes.ts:331-340` | the cached product types, `{id,label,hasSchema}` |
| `PUT /pim/channel-mapping/:ch/:code/categories/:categoryId` | `:342-370` | taxonomy-level mapping incl. `browseNodeId` |
| `GET /api/products/:id/studio/columns` | `product-studio.routes.ts:150-176` | already returns `schemaMissing` + `schemaAge` (`:168-169`) |

**Services**
- `CategorySchemaService` (`services/categories/schema-sync.service.ts`, 502 lines):
  `getSchema` `:78-91`, fresh-cache read `:155-166`, same-version expiry bump `:241-271`, new-version
  insert + diff `:275-299`, `detectAndLogChanges` `:302-397` emitting **six** change types —
  `FIELD_ADDED :330`, `FIELD_TYPE_CHANGED :343`, `FIELD_REMOVED :359`, `REQUIRED_CHANGED :374/:389`,
  `FIELD_DEPRECATED :410`, `ENUM_DEPRECATED :421`. The Prisma comment (`schema.prisma:8239`) lists
  only four — **the model's own doc under-states what the writer emits**.
- `ProductTypesService` (`services/listing-wizard/product-types.service.ts`): `listProductTypes`
  `:111-188`. **Amazon** fetches the FULL `searchDefinitionsProductTypes` list once per marketplace,
  caches it in memory, and filters client-side (`:152-188`) — so the whole list is servable to a
  browser and locally filterable. **eBay** is search-as-you-type against a tens-of-thousands-node
  taxonomy, 20 results max (`:125-146`). Fallback = 84 bundled Amazon types
  (`product-types.constants.ts`, `grep -c 'productType:'` = 84).
- `extractBrowseNodes(schema, marketplaceId)` (`services/amazon/browse-nodes.ts:78-90`) — **the
  browse-path lookup already exists as a pure function.** It walks the cached definition's
  `recommended_browse_nodes → items → properties.value` enum, skipping marketplace-scoped
  `allOf/anyOf` blocks that pin a different market (`:10-44`), and returns `{id, path}[]` from
  `enum`/`enumNames`. `flat-file.service.ts:938-948, 2011-2018` already turns that into a dropdown
  with `selectionOnly:false`.
- `resolveCategoriesForProducts` (`services/pim/mapping/category-mapping.service.ts:115+`) — the
  taxonomy resolver. Its 5-step order (`:11-21`) ends at `Product.productType` as the *legacy* answer,
  reported honestly as `source:'productType'`. `listChannelCategories:416-438` is Amazon-only and
  returns `[]` for eBay.
- Column build: `getSheetColumns` (`services/pim/sheet-columns.service.ts:850-960`).
  `productTypes` is **in the cache key** (`:858-869`, 5-min TTL `:847`); per type it calls
  `loadAmazonSpec` and pushes to `schemaMissing` (`:918`, `:935`) or `schemaAge` (`:920`).
  `studio-sheet.service.ts:810` derives `productTypes` as the **SET over the whole family**;
  `:928` pins one only when the family has exactly one.
- AM.1 adapter, already built: `services/pim/channel-specs/amazon.ts:60-101` walks **every**
  property with no exclusion list; `walkArray:135-148` reads `maxUniqueItems` into
  `cardinality.max`, so `recommended_browse_nodes` becomes a `list` spec by construction.

**Prisma** — `CategorySchema` `schema.prisma:7241-7267` (unique on
`channel+marketplace+productType+schemaVersion`, `expiresAt` index); `SchemaChange` `:8234-8251`
(`affectedProducts String[] @default([])` with the comment "Empty until we wire the lookup" — it is
still empty); `CategoryChannelMapping` `:17387-17430` (`channelCategoryId` = Amazon productType,
separate nullable `browseNodeId`, `confidence`, `reviewedAt`).

**Jobs / crons**
- `schema-refresh.job.ts` — nightly 04:00 UTC, gate `NEXUS_ENABLE_SCHEMA_REFRESH_CRON=1` (`:97`).
  Re-fetches every in-use `(marketplace, productType)` (`collectInUseSchemaTargets :40-58`), 300 ms
  apart, which **runs `detectAndLogChanges` for real** (`:60-90`). Its header records the finding
  that motivated it: *"94% of cached Product Type Definition schemas were past their 24h TTL (some
  50+ days stale)"* (`:4-6`).
- `browse-node-predictor.job.ts` — 12h, gate `NEXUS_ENABLE_BRAND_BRAIN` (`:41`), 50 listings/tick.
  `services/feed/browse-node-predictor.service.ts` calls **Claude Haiku** (`:22-24`) against a
  **hardcoded 9-node Italian motorcycle taxonomy** (`:39-59`) and writes
  `platformAttributes.browseNodeId/browseNodePath/browseNodeConfidence` (`:251-257`).
- Neither gate var is set anywhere in the repo (searched `.ts/.json/.env*/.md/.yml/.toml`, only
  worktree copies and the source's own comments matched). **Whether they are set on Railway is
  unknown to me** — I have no Railway access under this brief. Do not read this as "dormant in prod".

**Permissions** (`lib/auth/permissions-manifest.ts`)
- `:389` — `RW(F.pimManage, F.pimManage, pfx('/api/categories'))`. **Read and write are the same
  permission**: a read-only "what category is this?" lookup demands full PIM manage.
- `:345` — `RW(F.listingsView, F.listingsPublish, pfx('/api/listing-wizard'))`, so the product-type
  list reads under `listingsView` and the suggest POST needs `listingsPublish`.
  Two different permission stories for two halves of one operator question.

## 4. Studio today

- **`productType` is already a cell**: `field-registry.service.ts:73` —
  `{ id:'productType', label:'Product Type', type:'text', category:'universal', editable:true, width:160 }`.
  **`type:'text'`, free text.** It is in the bulk-PATCH allow list (`master-field-gate.ts:43-46`,
  with the comment that a per-listing override lives at `platformAttributes.productType`), and in the
  restorable set (`restorable-fields.ts:17`). It earns a permanent place in the Essentials view
  ("`productType` earns it twice: it decides which schema applies to every other column",
  `_studio/sheet/views.ts:212-213`, `COMMERCE_SPINE :230`).
- **Readiness already treats a missing product type as an ERROR** —
  `readiness.service.ts:204-215`: *"without this the row's required-field set is empty, so it scores
  100% ready while literally nothing has been validated"* (**hub ruling #15.3**). `:104` records
  **42 products with a null productType on prod (measured 2026-09-01)**.
- **`amazon_browseNode` exists and is dead** — `field-registry.service.ts:154`,
  `editable:false`, helpText `"No backing column yet"`. It renders on every scope
  (`_studio/sheet/views.vitest.test.ts:198`) and is one of the five dead columns AM.1 §2 counted.
- **The schema mark is HALF built, and the parity row is now stale.** Parity **3.32** says
  *"`schemaMissing`/`schemaAge` come back in `meta` and nothing renders them"* — but
  `_studio/sheet/master/MasterSheet.tsx:1720` computes `staleTypes` (>7 days) and `:1786-1801`
  renders an `⚠ caps` Pill in the toolbar's `trailing` slot with a tooltip. What is missing is
  (a) the same mark on the **channel** scope — `ChannelSheet.tsx` has no `schemaMissing`/`schemaAge`
  reference at all (grep: 0 hits) — and (b) the **change diff**, which no surface has. Hub ruling
  **#370** already cites this pill as the reason a cap-less cell must not imply a cap
  (`pes-claims.md:12105-12110`), and **#388/#390** found the pill made the toolbar's height *a
  function of the catalogue* — 41px on GALE-JACKET, 47px on GLOVES (`pes-claims.md:28762-28775`).
- **AM.1 §A.2 already assigns the replacement**: `amazon_browseNode` → `recommended_browse_nodes`
  (`docs/2026-09-04-channel-attribute-model-design.md:140-141`), and §A.3 `:153` puts it in the
  **"list, max > 10 or unbounded (`recommended_browse_nodes` 232)"** row → *ONE column, chip-list
  cell (count + first values, full list in the tooltip); DS `MultiSelect` when options exist*.
  §A.3a `:161-169` (**Owner ruling 2026-09-05**) deletes the `excluded` field entirely.
- **The confirm machinery exists**: `ActionImpact` (`design-system/grid/actions/registry.ts:84-127`,
  levels `none|confirm|type-to-confirm` at `:69`) and the precedent for a
  "this discards typing" question, `reloadGuard.ts:34-60` + `MasterSheet.tsx:585-601`.
- **The view-chip contract exists**: `ViewChip` (`_studio/types.ts:264-282`) with the
  `count: number|null` rule (*"`null` is NOT zero"*) and `cells.byRow` for the filter.
- **Bindings.** Parity **3.22** 🕳 (*"the Amazon category system is unreachable"*), **3.40** 🕳 (eBay
  picker), **3.29** 🔁, **7.4** 🕳 + **7.5** 🕳 — 7.4 explicitly declines to fold this into cell
  enrichment (*"it resolves a node in a category TREE, not a text cell"*) and proposes PES.2 without
  claiming it. **Parity 2.22 ⛔ N/A** rules that *"per-channel category stays with PES.3's channel
  scopes; master has no category editor in either tree"* — which is in tension with 7.4's PES.2
  proposal; §9 Q1.
- 🔴 **Hub ruling #86** (`pes-claims.md:21040-21056`) puts *"category/aspect pickers"* and the
  *"schema-change banner"* in the **22 structural gaps** and rules: **"No lane builds any of the 22
  until the Owner disposes"** — options (a) drawer panes under PES.4, (b) a new channel-operations
  surface, (c) accept the loss at swap. **This report is input to that disposition, not a mandate.**

## 5. Defects and slowness

**D1 🔴 `GET /api/categories/browse-path` answers about the WRONG PRODUCT.** CODE-READ,
`categories.routes.ts:87-160`. The route takes `productType` (`:99`) and then never uses it. Step 1
(`:106-113`) is `channelListing.findFirst({ where: { channel, marketplace, platformAttributes: {
path:['detectedCategoryPath'], not: null } } })` — **no `productId`, no `productType`** — so it
returns the first row *in the entire catalogue* on that coordinate that happens to carry a
breadcrumb. Step 2's ASIN lookup (`:132-142`) is equally unfiltered. The old card presents that as
*this* product's detected category (`CategoryCard.tsx:139-145`). Never port this contract.

**D2 🟠 `/api/categories/suggestions` is a keyword search that returns one path per candidate.**
CODE-READ, `:234-267`. Because `searchCatalogItems(keywords)` is a restricted operation, the route
takes each of up to 6 matched product types, finds *any* ASIN of that type in the DB, and classifies
**that ASIN** — falling back to *any ASIN on the marketplace* (`:218-224`, used at `:247`). So the
`pathParts`/`browseNodes` on a suggestion describe a neighbour listing, not the product being
edited, and `count: listing ? 2 : 1` (`:262`) is a two-valued "in your catalog" flag dressed as a
score. Up to 6 concurrent SP-API calls per keystroke-driven search (`Promise.all`, `:234`).

**D3 🔴 FOUR encodings of one browse node.** CODE-READ.
| store | writer | shape |
|---|---|---|
| `platformAttributes.browseNodeId` | `CategoryCard.tsx:230-238`; predictor `:251-257`; `import.service.ts:220/251/268`; `browse-nodes.ts:69-76` | `string` |
| `platformAttributes.attributes.recommended_browse_nodes` | `marketplaces.routes.ts:916-917` | `number[]` |
| same key, flat-file | `flat-file-unified.routes.ts:547` | `[{ value: string }]` |
| `CategoryChannelMapping.browseNodeId` | `channel-mapping.routes.ts:364` | `string?` |
Consequence, exact: **`CategoryCard`'s Apply writes `browseNodeId` (`:235`) and its own Detect reads
`attributes.recommended_browse_nodes` (`categories.routes.ts:119-120`) — a card that cannot read
back what it just wrote.** And `browse-path:120` casts the array `as number[]` while the flat-file
writer stores `[{value}]`, so a flat-file-authored node reaches the UI as `[object Object]`.

**D4 🟠 The predictor's sweep may skip exactly the rows it exists for.** HYPOTHESIS (structural,
not measured). `browse-node-predictor.service.ts:272-286` selects
`NOT: { platformAttributes: { path:['browseNodeId'], not: null } }`. Per
`reference_prisma_not_excludes_null`, Prisma's `NOT` excludes NULL rows — so listings whose
`platformAttributes` is NULL or JSON-null (the ones with *nothing* set) plausibly fall out of the
sweep. Needs one read-only count to settle; I did not run it.

**D5 🟠 The predictor writes via `as never` and clobbers the JSON.** CODE-READ, `:255`:
`data: { platformAttributes: attrs as never }` — per `reference_as_never_hides_write_failures` that
cast is exactly what hides a rejected write; and `{...existing, …}` at `:252` is a whole-document
replace, not a jsonb merge, so a concurrent cockpit write is lost. Its no-key fallback (`:226-246`)
returns a **keyword-guessed Italian node with `confidence: 0.6`** and the reasoning string
"Keyword-matched fallback (no API key)" — honest in the payload, but the confidence number is
invented and nothing downstream distinguishes it from a model answer.

**D6 🔴 `localStorage`-only schema detection, when a server log already exists.** CODE-READ.
`useSchemaChangeDetector.ts:40-42, 92, 99, 105`. Four failures follow from the store, not the logic:
(i) per-browser — a change reviewed on the laptop reappears on the desktop and vice versa;
(ii) per-operator — one person dismissing it hides it from nobody else, and hides it from *themself*
on one machine only; (iii) **first visit is silent** (`:103-106` stores the fingerprint and returns) —
so the *first* operator to open a family after Amazon's change sees nothing at all, which is the
visit that mattered; (iv) a private window or blocked site data returns early (`:92-96`) and the
banner never fires. Meanwhile `SchemaChange` rows are written server-side with six change types and
`GET /api/categories/changes` reads them — and **nothing consumes it**.

**D7 🟠 The fingerprint and the column set are built from different sources.** CODE-READ. The old
detector fingerprints the **flat-file manifest** (`/api/amazon/flat-file/template`,
`useSchemaChangeDetector.ts:78`); the studio's columns come from `loadAmazonSpec` over the same
cached `CategorySchema` (`sheet-columns.service.ts:917`). Two walkers over one definition — the exact
drift AM.1 §2 was written to end (`reference_two_column_builders_drift`). A studio alert must read
the *column set's own* requirement flags, or it will warn about a field the sheet does not show.

**D8 🟠 A stale schema is invisible on the scope chip; a missing one is invisible unless the whole
required set is empty.** CODE-READ, `scope-readiness.service.ts:214` and `:252`:
`const noSchema = schemaMissing.length > 0 && total === 0`. On a mixed family (one type cached, one
missing) `total > 0`, so the chip shows a confident percentage computed over *the types that did
resolve* and the note never fires. `schemaAge` is not read by this service at all (grep: 0 hits) —
a 50-day-old definition scores identically to a fresh one.

**D9 🟠 Nothing re-reads the columns after a `productType` write.** CODE-READ. The cell autosaves
through the one `SheetWriter` → `PATCH /api/products/bulk`; `MasterSheet.tsx` calls `reload()` only
from `onReload` (`:585-601`), `onFamilyChanged` (`:504`) and the formula path (`:1239`). But
`productTypes` is in the column-set cache key (`sheet-columns.service.ts:858-869`) and derived from
the family (`studio-sheet.service.ts:810`), so after the write **the operator is editing the previous
product type's column set** — right caps, wrong schema — until they press Reload. This is the single
strongest argument for the confirm in §6.

**D10 🟡 `productType` is free text.** CODE-READ, `field-registry.service.ts:73` (`type:'text'`).
A typo silently produces `schemaMissing` (`sheet-columns.service.ts:918`), which under D8 produces
*no* visible warning on the chip, while readiness's error only fires on **null**, not on garbage
(`readiness.service.ts:209`). Meanwhile the closed list is available two ways —
`listChannelCategories` (`category-mapping.service.ts:416-438`) and the cached full SP-API list
(`product-types.service.ts:152-188`).

**D11 🟠 `productType` is NOT on the never-draft list.** CODE-READ,
`services/ai/enrichment/constraints.ts:64-107`. `browse_node` **is** a never-draft pattern (`:85`),
so `recommended_browse_nodes` can never carry a ✦ draft — correct. But `productType` matches neither
`NEVER_DRAFT_EXACT` nor any pattern, and its kind is `text`, so an explicit
`only: ['productType']` run would pass `draftableConstraints` (`:207-237`). Bounded: the default set
excludes it (`:136-190`), and that set's own comment excludes `*_variationTheme` because *"a
variation theme is listing STRUCTURE, not copy"* — a product type is structure by the same argument
and belongs beside it.

**D12 🟡 `save-browse-nodes` creates a listing as a side effect.** CODE-READ,
`marketplaces.routes.ts:935-943`: no listing → `channelListing.create`
with no `listingStatus`. A category action that materialises a channel row is the
`reference_ebay_draft_still_live` shape; do not reuse this endpoint from a cell.

**D13 🟡 `SchemaChange.affectedProducts` is permanently empty** (`schema.prisma:8245-8247`, comment
says so). Any cross-family console must derive affected rows from `(channel, marketplace,
productType)`, never from this column.

**D14 🟡 The AM.1 adapter's `enumOf` does not walk `allOf`.** HYPOTHESIS, CODE-READ.
`channel-specs/amazon.ts:212-224` handles `enum`, `anyOf`, `oneOf`. The browse-node enum is
specifically the case `browse-nodes.ts:10-44` walks **`allOf` with marketplace-scoped blocks** for.
If the cached OUTERWEAR/IT definition nests it that way, `recommended_browse_nodes` will come out of
the adapter with `options: undefined` while `extractBrowseNodes` finds 232 — an empty picker with no
error. Settle it by printing both for one cached row before building the editor.

## 6. Proposed home in the studio

### 6.1 Primary home + mirrors

**Product type → H1 (the cell), as a `select` on EVERY row, with a preflighted CONFIRM.**
It is a value the operator edits per row and the sheet already carries it in the Essentials spine
(`views.ts:212-213`) — H1 is where the layout puts a category (§3's own table). **I disagree with
one word of the brief's hypothesis: it is not "on the parent".** `Product.productType` is per
product row, `productTypes` is a SET over the family (`studio-sheet.service.ts:810`), and 42 prod
rows carry a null one (`readiness.service.ts:104`); a parent-only cell would make a divergent child
uneditable and unfixable. Keep the cell on every row — that is honest to the store — and get the
family-level *behaviour* from the confirm, which offers "apply to the other N rows" as a checkbox.
The change from today is not the placement, it is three things: `text` → `select` (D10), a
**CONFIRM** (D9), and a **re-read of the column set** after it lands.

**Browse nodes → H1 list cell (`recommended_browse_nodes`), Amazon channel scope only.**
AM.1 §A.3 `:153` already specifies the shape and the editor for this exact key — chip-list cell, DS
`MultiSelect` when options exist. The options are not new work: `extractBrowseNodes` returns
`{id, path}` per marketplace from the same cached definition the columns come from
(`browse-nodes.ts:78-90`), which *is* the "browse-path lookup" and needs no SP-API call on a
page-load path. The dead `amazon_browseNode` column (`field-registry.service.ts:154`) is deleted, and
`recommended_browse_nodes` comes off `NON_ATTRIBUTE_KEYS` (`master-schema.service.ts:72`) because
§A.3a abolished exclusions. **AI suggest is DARK and the never-draft list already enforces it**
(`constraints.ts:85`): the cell offers a disabled "Suggest" affordance in its editor footer that
names why (no live generation, Owner ruling #13) and, where a suggestion *is* deterministic —
eBay's own `get_category_suggestions` returns a `matchPercentage` from eBay, not from a model
(`ebay-cockpit.routes.ts:154-164`) — it is offered as **"eBay's suggestion"**, never labelled AI.

**Schema alerts → H9 primary (Errors & Sync), H6 mirror (view chip), H2 mirror (scope chip).**
H9 because the alert is a **queue-shaped fact grouped by cause, spanning rows** — §3's own
definition names "schema alerts across many rows" for H9, and the console is already grouped by
cause with rows that jump to the sheet (`channel-ops/ErrorsSyncConsole.tsx:174`, `syncQueue.ts:254`).
H6 because the operator needs to *reach the affected columns from the sheet*: a
`useRegisterViewChip('schema-changed', …)` chip labelled **"Schema changed (n)"** whose
`cells.byRow` is every row × the changed column keys, so clicking it filters the sheet to exactly
the cells the change touched. H2 on the scope chip because "this coordinate's rules moved" is a
scope-level fact the frame already renders (`StudioBar.tsx:57-84` reads `ScopeReadiness`), and D8's
`&& total === 0` guard has to go anyway. **And it is read from `SchemaChange`, not from
`localStorage`** — `GET /api/categories/changes` already exists (`categories.routes.ts:283-310`).
No banner: hub ruling #86 lists the banner among the 22, and a chip + a queue row beats a dismissible
strip whose dismissal was per-browser (D6).

### 6.2 What the sheet shows at rest, per scope

| scope | product type | browse nodes | schema |
|---|---|---|---|
| **master** | `Product Type` select cell, Essentials spine, every row. `—` + readiness ⚠ when null (already: `readiness.service.ts:209`) | **no column** — it is a channel placement, not a master attribute | the existing `⚠ caps` pill (`MasterSheet.tsx:1786-1801`) **plus** a `Schema changed (n)` view chip when the log has rows for any of the family's types |
| **Amazon × market** | same cell, `masterKey`-joined, 🔗 inherited (the value *is* master's; a per-listing override exists at `platformAttributes.productType` and stays out of v1) | `Recommended browse nodes` chip-list cell: `2 nodes` + first path in the tooltip, `—` when empty. Never a ✦ | the same chip, plus the `caps` pill which the channel sheet does not have today (D8) |
| **eBay × market** | `eBay category` cell — **new, and missing today**: `platformAttributes.categoryId` drives the aspect set (`studio-sheet.service.ts:754-771`, `:821`) and has no column, so the sheet hides the value that selects its own columns | none (eBay has no browse-node concept) | same chip once eBay schema-change detection exists (it does not: `schema-sync.service.ts:87-88` throws `'eBay schema sync is not implemented yet'`) |
| **Shopify / single-store** | no column — no channel category cached, `loadAmazonSpec`/`loadEbaySpec` are the only adapters | none | none |

### 6.3 The interaction, step by step

**Changing the product type.**
1. **Open** — double-click or type on the cell (§5.5: double-click EDITS). A DS `Combobox`-shaped
   popup editor opens (`cellEditorPopup: true` — `reference_ag_grid_probe_traps`), seeded from
   `GET /api/listing-wizard/product-types?channel=AMAZON&marketplace=IT`. The whole list arrives once
   and filters locally (`product-types.service.ts:152-188`), so the DS `Combobox`'s local-filter-only
   design (`Combobox.tsx:22-52`, 75 lines, no async) is sufficient **for Amazon**; each row shows the
   code + display name and a `hasSchema` tick from `listChannelCategories`
   (`category-mapping.service.ts:430`). A disabled `✨ Suggest` row sits at the foot of the panel
   naming the ruling. `mode: 'open'` — a code not in the list is still accepted (a market can carry a
   type SP-API did not return), matching the flat-file's own `selectionOnly:false`.
2. **Collect** — the editor returns the code via `props.onValueChange`
   (🔴 `reference_ag36_react_editor_onvaluechange`; a ref `getValue` is discarded).
3. **PREFLIGHT** — one call, `GET /api/products/:id/studio/columns?market=IT&productTypes=<new>`
   (a thin additive override on `product-studio.routes.ts:150-176`), diffed against the columns on
   screen. It answers, in facts rather than adjectives: how many columns appear, how many disappear,
   **how many disappearing columns hold a value**, whether the new type has a cached schema at all,
   and how many other rows share the old type.
4. **CONFIRM** — `ActionImpact` from that preflight, level **from the finding, never fixed**
   (`registry.ts:79-83`): `confirm` normally; **`type-to-confirm` when a column that holds data
   disappears**, phrase = the SKU (`:123-124`). Title: *"Change Product Type on GALE-KAN-PRO-M from
   OUTERWEAR to COAT?"*. `consequences`: *"14 Amazon columns are replaced by 21 — this whole sheet
   re-projects."* / *"3 columns holding a value are not part of COAT: CE Certification, Armor Type,
   Waterproof. Their stored values remain in the database but stop being editable or published."* /
   *"COAT has no cached Amazon schema on IT — the new columns will carry no caps and no closed lists
   until the nightly refresh."* `sideEffects` (`:93-99`): *"Readiness and the Missing-required count
   are recomputed for every row of this family."* A checkbox — *"Apply to the other 20 rows"* — is
   what makes the cell behave family-level without lying about the store.
5. **RUN** — the write goes through the **one** `SheetWriter` (`PATCH /api/products/bulk`,
   `expectedVersion`), so provenance, the save reporter and the conflict path are unchanged.
6. **REPAINT** — on `saved`, the sheet **re-reads its column set and rows**, reusing
   `reloadImpact` (`reloadGuard.ts:34-60`) so a re-read that would discard other pending typing asks
   first. This is the fix for D9. Column state is frozen at mount
   (`reference_grid_column_state_frozen_at_mount`), so the re-projection must go through the same
   remount path `onFamilyChanged` uses (`MasterSheet.tsx:504`), not a prop tweak.

**Editing browse nodes.** Double-click → popup `MultiSelect` over `extractBrowseNodes`' `{id,path}`
list for (market, productType), searchable by path, chips for what is chosen, count in the header
against the declared `maxUniqueItems`. No preflight, no confirm — it is an ordinary list-shape cell
edit; autosave, ✎ pinned on the listing store. Enter/Tab/Esc belong to the popup
(`reference_ag_popup_editor_owns_keys`) — the panel commits on Enter and the grid moves after it
closes. If the enum is empty (D14), the cell must say *"Amazon declares no node list for this type
on this market"* and accept free text — never render an empty picker.

**Keyboard.** Type-to-open on both cells; ⌘Z on the browse-node cell undoes the whole array (one
store, one cell); the product-type confirm is a DS `Modal` and traps focus, and its cancel changes
nothing (the typed value stays in the cell, per `reloadGuard`'s doctrine).

**With the drawer open.** The drawer is non-modal and the sheet stays live (§5). A product-type
change re-projects the sheet *under* an open drawer, so the drawer's Record pane must re-derive its
field list from the new columns — `onDrawerWrite` already resolves a column by `writeField`
(`MasterSheet.tsx:1703-1714`) and returns `refused` when it cannot, so the failure mode is a clear
refusal rather than a mis-routed write. The drawer's **Record pane is the mirror surface** for the
category *detail* an 160px cell cannot hold: the breadcrumb path, the node list in full, the
`ResolvedCategory.source` (`categoryExact` / `ancestorWildcard` / **`productType`**, which on prod is
always the last because the taxonomy has 0 rows — `CategoryMappingPane.tsx:6-9`,
`studio-sheet.service.ts:349-351`, hub ruling #15), and a link out to `/channels/mapping`.

### 6.4 Per-scope rules

- **Master vs channel.** The product-type cell is the *same cell* on both — one value, `masterKey`
  joined (`channel-specs/amazon.ts:45-50` is where such links live), 🔗 on the channel scope. The
  browse-node cell exists **only** on Amazon coordinates: it is `ownedBy` the listing store, has no
  `masterKey`, and must not appear on master (unlike today's `amazon_browseNode`, which does).
- **Alias band.** Browse nodes are per (product, coordinate) — `platformAttributes` hangs off the
  `ChannelListing`, and the resolver is product-level today (`studio-sheet.service.ts` mapping meta
  `productLevelOnly`), so **every alias projection of one product shows the same nodes**. Say so in
  the tooltip rather than implying per-alias control. The product type is NOT an alias-group verb:
  it is master truth.
- **Market channels vs single-store.** Browse nodes are per market by construction — the enum itself
  is marketplace-scoped (`browse-nodes.ts:17-22` skips blocks pinning another `marketplace_id`), and
  `reference_contract_field_varies_by_market` is the standing warning that a rule keyed on one
  coordinate's shape fires on one coordinate only. Amazon's images are global per ASIN; its **browse
  nodes are not** — do not borrow that intuition. Shopify/Etsy/Woo get no column until they have an
  adapter (§A.1).
- **Mixed-type families.** The union column set already carries per-coordinate caps with `capFrom`
  (§A.2 `:142-145`); the product-type cell must show which rows share a type, and the mapping
  resolver loses its `pinnedType` optimisation the moment two types coexist
  (`studio-sheet.service.ts:928`) — a real cost to name in the confirm, not to hide.

### 6.5 Provenance / autosave / readiness / publish

- **Provenance.** Product type: 🔗 on a channel scope (it comes from master). Browse nodes: ✎ when
  the listing carries its own array, `—` otherwise. **Neither ever shows ✦** — `browse_node` is a
  never-draft pattern (`constraints.ts:85`) and `productType` must be added to it (D11).
- **Autosave.** Both are ordinary `SheetWriter` cells. The product-type write is the one cell on the
  sheet whose *success* invalidates the sheet's own contract, so the re-read is part of the write's
  definition of done — and it needs the nav guard (`reference_autosave_still_needs_a_nav_guard`) plus
  the delayed re-read discipline (`reference_read_before_the_write_arrived`: 8 s, `expectedVersion`
  as the discriminator) for anyone verifying it.
- **Readiness.** One server definition (`readiness.service.ts`) already errors on a null product
  type (#15.3). Two additions: (i) grade a product type whose schema is **absent** as an error too
  (it is the same vacuous-100% failure with a different cause — D8/D10); (ii) `required` on the
  browse-node array follows §A.3's list rule (`≥ min` non-empty), never per slot.
- **Publish.** A product type is part of the JSON_LISTINGS_FEED envelope, so a change is a
  publish-affecting change: the preflight for `Publish ▾` must re-derive against the new type, and
  the confirm's `payload` (`registry.ts:109-122`) carries the preflight snapshot so run applies
  exactly what was approved. Mode from the server (`getAmazonPublishMode`), never env.

### 6.6 ASCII mockup

```
┌ Amazon · IT ─────────────────────────────────────────────────────────────────────────┐
│ 21 rows · 1 selected  [View ▾][Missing required (7)][⚠ Schema changed (3)]  Find… ⋯  │
├──────────────┬──────────────┬───────────────────┬──────────────────────────┬─────────┤
│ SKU          │ Product Type │ Recommended browse│ Item name                │ Bullet 1│
├──────────────┼──────────────┼───────────────────┼──────────────────────────┼─────────┤
│ GALE-KAN-PRO │ OUTERWEAR ▾  │ 🔗 2 nodes        │ 🔗 GALE Pro Racing Suit  │ 🔗 CE…  │
│  ├ …-PRO-S   │ OUTERWEAR ▾  │ ✎ 1 node          │ ✎ GALE Pro — S           │ 🔗 CE…  │
│  ├ …-PRO-M   │ ┌──────────────────────────────────────────────┐             │ 🔗 CE…  │
│  └ …-PRO-L   │ │ coat▊                                        │             │ 🔗 CE…  │
└──────────────┤ │ COAT              Coat                    ✓  │ ─────────────┴─────────┘
               │ │ COAT_LINER        Coat Liner              ✓  │
               │ │ RAIN_COAT         Rain Coat               ·  │  ✓ = schema cached
               │ ├──────────────────────────────────────────────┤
               │ │ ✨ Suggest a type — off (no live AI)         │
               │ └──────────────────────────────────────────────┘
  ┌ Change Product Type on GALE-KAN-PRO-M? ─────────────────────────────────┐
  │ OUTERWEAR → COAT. This re-projects the whole sheet.                     │
  │ • 14 Amazon columns are replaced by 21.                                  │
  │ • 3 columns holding a value are not part of COAT: CE Certification,      │
  │   Armor Type, Waterproof. Stored, but no longer editable or published.   │
  │ • Readiness is recomputed for all 21 rows of this family.                │
  │ ☐ Apply to the other 20 rows        Type GALE-KAN-PRO-M to confirm: [ ]  │
  │                                              [Cancel]  [Change type]     │
  └─────────────────────────────────────────────────────────────────────────┘
```

## 7. Contracts and data

**Reused unchanged** — `GET /api/listing-wizard/product-types` (the picker feed);
`GET /api/categories/changes` (the alert source, currently unread);
`GET /api/products/:id/studio/columns` (the preflight, already returns `schemaMissing`/`schemaAge`);
`PATCH /api/products/bulk` (the product-type write, already allow-listed);
`extractBrowseNodes` (the node enum — promote it out of `services/amazon/` into the AM.1 adapter
rather than calling it twice).

**New / changed, all additive**
1. `GET /products/:id/studio/columns?productTypes=<override>` — read-only what-if for the preflight.
   *No schema change.* **PES.5**.
2. `GET /products/:id/studio/schema-changes?market&channel` — the studio-shaped projection of
   `SchemaChange` for this family's types, joined to the **column set's own** keys so the chip filters
   real columns (D7), with a `since` derived from a per-user acknowledgement. **PES.5**.
3. `SchemaChangeAck { userId, channel, marketplace, productType, ackedAt }` — one additive table so
   "reviewed" survives a browser (D6). Additive migrations are pre-approved; **PES.5**.
4. `recommended_browse_nodes` as a `list` `ChannelFieldSpec` with `options` from the node enum, and
   `productType` re-typed `select` with the cached list — **AM.1's adapter work, PES.3 + PES.5**.
   Delete `amazon_browseNode` (`field-registry.service.ts:154`) and drop
   `recommended_browse_nodes` from `NON_ATTRIBUTE_KEYS` (`master-schema.service.ts:72`).
5. **One browse-node encoding.** Pick `overrideData.recommended_browse_nodes: string[]` per §A.4
   and make `platformAttributes.browseNodeId` a **read-compat layer only** (as
   `Product.bulletPoints` already is). The producer and the consumer land together
   (`feedback_producer_and_consumer_land_together`); the 4-way divergence in D3 is what happens
   otherwise. **PES.5**, with a sweep of the 4 writers.
6. Add `productType` to `NEVER_DRAFT_EXACT` (`constraints.ts:64-79`) — **PES.8**, one line.
7. Chip-list cell renderer + `MultiSelect` popup editor for the `list` shape — **PES.2**
   (`design-system/grid` has neither: no chip-list renderer in `renderers/`, no multi editor in
   `editors/`). One `check-editor-open.mjs` parity reading per §A.3.
8. Scope-chip schema state: extend `ScopeReadiness` with `{ schemaMissing[], schemaStale[] }` and
   drop the `&& total === 0` guard — **PES.5** (`scope-readiness.service.ts:214, 252`);
   **PES.1** renders it.
9. H9 group: a synthetic `schema-changed` cause in the console. 🔴 The console reads **only**
   `OutboundSyncQueue` (`syncQueue.ts:5`), so this is a second source, not a filter — it needs the
   Owner's nod under #86 before anyone builds it. **PES.4** (console owner) + **PES.5**.
10. **Do NOT port** `/api/categories/browse-path` or `/api/categories/suggestions` (D1, D2), and do
    not reuse `save-browse-nodes` (D12). Leave `/api/categories/*` alone until someone owns its
    `pimManage`-for-a-read permission (`permissions-manifest.ts:389`).

## 8. Risks and traps

- **Local dev writes PROD.** Every one of these is a live write path
  (`reference_local_dev_hits_prod_api`, `reference_local_handler_writes_prod_db`). A product-type
  change on a listed family changes what publishes; an eBay row is live even as a DRAFT
  (`reference_ebay_draft_still_live`). Any verification uses the fixture family and stays inside it
  (`reference_transport_failure_write_is_unknown_outcome`).
- **Endpoint safety ≠ interaction safety.** `reference_endpoint_safety_is_not_interaction_safety`: a
  *blur* on a category picker in a browser probe commits. The product-type editor is the highest-cost
  cell on the sheet to leave open — the confirm must sit between commit and write, not after it.
- **Hub ruling #86 gates the whole feature.** Category pickers and the schema-change banner are two
  of the 22; **no lane builds them until the Owner disposes.** Treat §6 as a proposal.
- **AI dark (ruling #13).** Amazon's `suggest-product-types` is a **live Gemini call** gated only by
  `GEMINI_API_KEY` (`product-types.service.ts:253-259, 282-336`) — it must not be wired. The
  browse-node predictor is a **live Claude Haiku write cron** (`browse-node-predictor.service.ts:22-24,
  251-257`). eBay's `suggest-categories` is eBay's own taxonomy API, not a model — a separate call
  (§9 Q2).
- **Untouchables.** The flat-file editors own `decorateBrowseNodeColumn` and
  `flat-file-unified.routes.ts`'s `[{value}]` encoding; the compat layer in item 5 must be read-only
  toward them. The existing import flow writes `browseNodeId` (`import.service.ts:220/251/268`) and is
  untouchable too — which is precisely why the *new* store must read the old key.
- **A stale `.d.ts`** in `design-system/grid/{editors,renderers}` will make the next lane's build
  worse (`reference_stale_dts_makes_the_next_lane_build_worse`) — both directories carry checked-in
  `.d.ts` beside every source file.
- **Measurement traps for whoever verifies this.** The `caps` pill *renders only for a family whose
  types have a stale or missing schema* (#388/#390) — a single-product measurement cannot see it, and
  a fixture pins that dimension (`reference_a_fixture_pins_a_dimension`). `schemaAge` is empty
  whenever the schema is missing (`sheet-columns.service.ts:918` `continue`s before pushing), so
  "no stale types" and "no schema at all" produce the same empty array
  (`reference_could_not_measure_vs_measured_empty`).
- **Unregistered AG modules fail silently** (`reference_ag_module_silent_omission`) and the fill
  handle swallows a double-click on the cell below the selection
  (`reference_ag_fill_handle_swallows_dblclick`) — a browse-node cell dragged down would overwrite
  20 rows' placement with no editor ever opening.

## 9. Open questions for the Owner (max 3)

**Q1 — Does the product type belong to master or to the channel scope?** Parity **2.22** rules ⛔
*"per-channel category stays with PES.3's channel scopes; master has no category editor"*, while
**7.4** proposes PES.2 and *master* `productType`, and the store is a master column
(`field-registry.service.ts:73`) with an unused per-listing override
(`platformAttributes.productType`). Two ratified rows point opposite ways.
**Recommended:** ONE cell, master-stored, shown on master *and* joined onto the Amazon scope as 🔗 —
because that is what the data is and what `readiness` already grades. The per-listing override stays
unbuilt in v1. This satisfies 7.4 (a picker exists) without a master "category editor" surface, which
is what 2.22 actually refused.

**Q2 — Is a channel's own suggestion endpoint covered by the AI-dark ruling?** Amazon's is Gemini and
plainly is. eBay's `get_category_suggestions` returns eBay's own `matchPercentage`
(`ebay-cockpit.routes.ts:154-164`) — deterministic, from the marketplace, no generation. So is the
rule-based ranking inside `suggestProductTypes` (`product-types.service.ts:250-259`), which runs with
no API key at all.
**Recommended:** dark means **no model generation**. Ship eBay's suggestion and the rule-based hint,
labelled by their real source ("eBay's suggestion", "matched from your catalogue") and never as AI;
keep the Gemini path and the Haiku predictor off. The 100%-honest-UI rule is satisfied by naming the
source, not by hiding the feature.

**Q3 — Where does the schema alert live: a queue row, a chip, or both?** #86 lists the banner among
the 22 undisposed capabilities, and the Errors & Sync console reads only `OutboundSyncQueue`
(`syncQueue.ts:5`), so an H9 entry means giving the console a second source.
**Recommended:** both, and in this order — **H6 chip first** (it is a `useRegisterViewChip` call
against an endpoint that already exists and needs no console change), **H9 second** once the Owner
accepts a second source. Do not build a banner: its dismissal was per-browser and per-operator (D6),
which is the defect, not the presentation.

## 10. Effort and dependencies

| piece | lane | effort | depends on |
|---|---|---|---|
| `productType` `text` → `select` (cached list, open mode) | PES.5 + PES.3 | **S** | `listChannelCategories` (exists) |
| Column-set what-if preflight (`?productTypes=` override) | PES.5 | **S** | — |
| Product-type CONFIRM + post-write column re-read (**fixes D9**) | PES.2 + PES.3 | **M** | `ActionImpact`, `reloadImpact` (both exist) |
| `recommended_browse_nodes` as a `list` spec with the node enum | PES.5 | **S** | AM.1 adapter (built); **settle D14 first** |
| Chip-list renderer + `MultiSelect` popup editor for `list` | **PES.2** | **M** | AM.1 §A.3; blocks features 2 (bullets) and eBay MULTI aspects — **share it, do not fork it** |
| One browse-node encoding + read-compat sweep (4 writers) | PES.5 | **M** | D3; producer+consumer in one write |
| `Schema changed (n)` view chip from `SchemaChange` | PES.5 + PES.3 | **M** | endpoint (exists) + the ack table |
| `SchemaChangeAck` table | PES.5 | **S** | additive, pre-approved |
| Scope-chip schema state (**fixes D8**) | PES.5 + PES.1 | **S** | — |
| H9 schema group in Errors & Sync | PES.4 + PES.5 | **M** | **Owner Q3 / #86** |
| `productType` → never-draft (**fixes D11**) | PES.8 | **S** | — |
| eBay category cell (`platformAttributes.categoryId`) | PES.3 + PES.5 | **L** | needs an **async** Combobox the DS does not have (`Combobox.tsx:22-52`); eBay schema-change detection does not exist (`schema-sync.service.ts:87-88`) |
| Drawer Record-pane category detail (path, node list, resolution source) | PES.4 | **S** | mapping meta (exists) |

**Cross-feature dependencies.** The list/chip-list cell is shared with feature 2 (bullet points) and
the eBay MULTI aspects — **one engine rule, both builders**
(`reference_two_column_builders_drift`, `feedback_shared_components_no_copy_props`). The
product-type confirm is the first cell-level `ActionImpact` on the sheet and sets the pattern for
every other schema-affecting cell. The schema chip shares its ack table and its endpoint with any
future deprecation surface (`FIELD_DEPRECATED` / `ENUM_DEPRECATED` are already written,
`schema-sync.service.ts:410, 421`, and nothing shows them either).
