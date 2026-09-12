# 03 — eBay CATEGORY picker

> ⚠ **The working tree moved under this research.** `apps/api/src/services/pim/studio-columns.ts` and
> `studio-sheet.service.ts` are untracked and were edited by another session DURING this read: my
> first read of `StudioColumnsInput` had no `ebayCategoryIds` field; my second (≈15 min later) did.
> Every line number below is from the LAST read. Re-verify before acting.

## 1. What it is (operator terms)

An eBay listing cannot exist without a leaf category. The category id is the single key that decides
(a) whether eBay will accept the listing at all, (b) which item specifics (aspects) eBay demands and
recommends, (c) which aspects may be variation axes, and (d) which item conditions are legal. An
operator listing a new jacket on eBay·IT must pick one leaf out of ~20k, and when they re-file a
listing into a different leaf, the entire aspect *column family* changes underneath them. Today
they do it in a modal on the old eBay cockpit tab, once per marketplace, one product at a time.
It is a **per-listing filing decision with a whole-sheet consequence** — which is why it cannot be
only a cell and cannot be only a drawer pane.

## 2. Old UI — inventory

**Entry point:** eBay cockpit tab → `CategoryCard` → "Change" / "Pick a category" button.

| piece | file:line | what it does |
|---|---|---|
| `CategoryCard` | `apps/web/src/app/products/[id]/edit/tabs/ebay-cockpit/cards/CategoryCard.tsx:33-115` | 115-line card. Shows `categoryName`, `categoryPath` (mono), bare `id: <n>`, market name. Button opens the modal (`:100-112`). Footer is a static i18n string with a History icon — **there is no history UI**; the `_categoryHistory` the server writes is never read anywhere. |
| `CategoryPickerModal` | `.../cards/CategoryPickerModal.tsx:60-363` | 556 lines, hand-rolled `fixed inset-0` overlay (no DS Modal), three mode tabs, one `pendingPick` slot, `[Apply category]`. ESC handled locally (`:87-93`). |
| — Search mode | `:96-122` | 250 ms debounce → `GET /api/ebay/flat-file/category-search?q&marketplace=EBAY_<CODE>`. |
| — AI-suggest mode | `:125-163` | `POST /api/ebay/cockpit/suggest-categories` seeded with the listing title (description only as fallback). **Not an LLM** — it is eBay's own `get_category_suggestions`. Owner ruling #13 (AI dark) does not bind it. |
| — Sibling-market mode | `:167-198` | `GET /api/ebay/cockpit/category-map?source&categoryName&targets` — read-only preview; the modal itself tells the operator to go to each other market's tab to apply (`:470-472`). |
| — Apply | `:206-232` | `PATCH /api/ebay/cockpit/category`, then `router.refresh()`. |
| `AspectsCard` | `.../cards/AspectsCard.tsx:129-161` | Re-fetches `GET /api/ebay/flat-file/category-schema?categoryId` on **every** `categoryId` change; renders only aspects present in the NEW schema (`:172-184`). |
| `category-gates.ts` | `.../health/category-gates.ts:32-108` | 11 hardcoded soft gates matched by **substring on the category name/path** ("helmet"/"casco", "jacket"/"giacca"…) against hardcoded English+Italian aspect-label lists. `applicableGates` caps at 4 (`:113-134`). |
| `useHealthScore` | `.../health/useHealthScore.ts:98-121,203-215,330-355,366` | Client-side 0–100. "Category picked" = 10 pts, hard-fail if absent (`:204-211`); required-aspects gate from the schema fetch; category gates worth ≤10 (`:330-348`); `canPublish = hardFails.length===0 && hasCategory && hasPrice` (`:366`). |

**Round-trips vs local:** everything round-trips; nothing is in `localStorage`. `pendingPick` is
transient component state.

**Dead in the old tree:** the `History` footer on `CategoryCard.tsx:94-97` (no reader for
`_categoryHistory`); `getCategoryBreadcrumbs` is never called by the cockpit — only by the
flat-file grid (`EbayFlatFileClient.tsx:1196-1206, 2809-2812`), so the cockpit's path is whatever
the picker happened to persist and is blank on any listing filed by another path.

## 3. Backend that exists

**Routes** (all under `/api`, registered `apps/api/src/index.ts:694`):

| method + path | file:line | notes |
|---|---|---|
| `POST /api/ebay/cockpit/suggest-categories` | `routes/ebay-cockpit.routes.ts:135-171` | wraps `searchCategories(title)`, `throwOnError: false`, limit 8. |
| `GET /api/ebay/cockpit/category-map` | `:187-233` | for each target market, `searchCategories(targetTree, categoryName, limit 1)`. |
| `PATCH /api/ebay/cockpit/category` | `:250-322` | `findFirst({productId, channel:'EBAY', marketplace})` (`:272`) → merge `categoryId/categoryName/categoryPath` + push `_categoryHistory` (cap 10) into `platformAttributes`; creates a `DRAFT` listing when none exists. `itemSpecifics` deliberately untouched. |
| `GET /api/ebay/flat-file/category-search` | `routes/ebay-flat-file.routes.ts:709-737` | ⛔ **untouchable file.** |
| `GET /api/ebay/flat-file/category-schema` | `:545-703` | rich aspects + allowed conditions, `throwOnError: true`, 24 h in-route cache, falls back to a stored copy. ⛔ untouchable. |
| `GET /api/ebay/flat-file/category-breadcrumbs` | `:3588-3600` | `{ en, local }` paths for ≤200 ids. ⛔ untouchable. |
| `GET /api/pim/fields?ebayCategoryIds=` | `routes/products.routes.ts:66-90` | merges cached aspects as `attr_*`. |
| `POST /api/pim/ebay-prewarm` | `routes/products.routes.ts:99-131` | warms the aspect cache for N ids in parallel; returns `{warmed, skipped}`. |

**Services.** `services/ebay-category.service.ts` is the one taxonomy client:
`searchCategories` (`:123-272`, `get_category_suggestions`, 24 h cache per (market, query)),
`loadTreeMap` + `buildPath` (`:301-367`, one full-tree fetch per treeId, 24 h),
`getCategoryBreadcrumbs` (`:375-395`, `en` from the UK tree because **ids are shared across EU
sites for most categories** — `:293-298`), `getCategoryAspects` / `getCategoryAspectsRich`
(`:623`, `:766`, supports `cacheOnly`), `getItemConditionPolicies` (`:949`). Marketplace→treeId is
a 6-entry table (`:22-29`). Its own comment names the defect this feature must fix: *"the grid's
category cell shows bare numeric IDs; operators are blind"* (`:294`).

`services/pim/ebay-schema-sync.service.ts:28-100` — collects the distinct
`platformAttributes.categoryId` across a marketplace's listings and **unions** their aspects into
`ChannelSchema` as `aspect_<EnglishName>`, flattening the per-category dependency by design.

**Prisma.** `CategorySchema` (`schema.prisma:7241-7267`, `(channel, marketplace, productType,
schemaVersion)` unique; eBay abuses `productType` as the category id and `marketplace` is nullable);
`ChannelSchema` (`:14485-14498`); `CategoryChannelMapping` (`:17387-17420`, our taxonomy node →
`channelCategoryId` + `channelCategoryPath` + `confidence`/`reviewedAt`); `EbayListingIndex.categoryId`
(`:13089`) written from Trading `GetItem` XML (`services/marketing/ebay-listing-index.service.ts:117,224`)
— eBay's own answer for the live item; `SchemaChange` (`:8234-8251`). The chosen category is
**not a column**: it lives in `ChannelListing.platformAttributes` (`:1491-1493`), and each alias is
its own `ChannelListing` row (`:1663-1701`, `aliasKey` in both unique indexes) — so it is **per-alias**.

**External calls + safety.** Every taxonomy call goes to live `api.ebay.com` and is **not** behind
`getEbayPublishMode()` — correctly, they are catalogue READS (`get_category_suggestions`,
`category_tree`, `get_item_aspects_for_category`) that write nothing to eBay. They do burn the
seller's OAuth token and eBay's rate limit, and they run from local dev too. The only write is the
PATCH to our own (production) DB. Publish itself hard-fails without a category:
`services/listing-wizard/ebay-publish.adapter.ts:251-252` → `"categoryId is required for eBay publish."`
The sheet's publish is preview-only regardless (`services/pim/sheet-publish.service.ts:125-141`).

**Permissions** (`lib/auth/permissions-manifest.ts`, first-match-wins). One dialog spans **three**:
Search → `listings.flatfile.edit` (`:339`); AI-suggest, being a **POST**, falls to the write side of
`RW(listingsView, channelsSync, pfx('/api/ebay'))` (`:354`) so a pure read demands
`channels.sync`; `category-map` (GET) → `listings.view`; Apply (PATCH) → `channels.sync`.
There is no read-shaped-POST override for the eBay prefix. Memory: `reference_family_verbs_split_permissions`.

**Jobs/crons:** none for category. The aspect cache is warmed only by a page visit or the prewarm
endpoint; `syncEbayCategoryAspects` has no scheduler in this path.

## 4. Studio today

**Category IS already a column — read-only, showing the raw id.** `services/pim/channel-specs/ebay.ts:93`:

```ts
listing('categoryId', 'Categoria', 'Category', { kind: 'text', channelStore: pa('categoryId'),
  helpText: 'The eBay leaf category id this listing is filed under.' }),
```

- No `masterKey` ⇒ `listingOnly` ⇒ `storage: 'listing'` and **`editable: !listingOnly` = false**
  (`sheet-columns.service.ts:485`), skipped entirely on the master scope (`:459`).
- The cell VALUE reads the bag: `studio-sheet.service.ts:1123-1136` (`store.kind ===
  'platformAttributes'` → `readPath`), with the code's own note *"`read store = write store`
  (#674): when the write route for these lands (**phase 2**) it writes the same path."*
- The refusal is honest: `studio-sheet.service.ts:1184-1186` →
  *"Read from the listing — editing this channel field lands with the next build."*
- **The category drives the column family, and that wiring is live:**
  `ebayCategoryIdsFor` (`studio-sheet.service.ts:753-767`) reads every family listing's
  `platformAttributes.categoryId` for the market → `getStudioColumns({ ebayCategoryIds })`
  (`:821-834`) → the cache key includes the sorted id list (`studio-columns.ts:48`) →
  `loadEbaySpec(market, ids)` (`channel-specs/index.ts:122-208`) unions the cached
  `CategorySchema` aspects across those ids.
- **The fallback is silent:** with no id, or an id with no cached row, `loadEbaySpec:183-204`
  substitutes the **marketplace-wide** `aspect_*` `ChannelSchema` rows. The sheet then shows a
  plausible aspect family that is **not this category's**, with nothing on screen saying so.
- No breadcrumb: nothing on the studio path calls `getCategoryBreadcrumbs`.
- No readiness gate: `services/pim/readiness.service.ts` (220 lines) contains **zero** occurrences of
  "categor" or "ebay". A listing with no category can read green and then be refused at publish.

**Parity audit.** 3.40 (CategoryCard + 3-mode picker) 🕳 MISSING. 7.5 (eBay AI category suggestion)
🕳 MISSING — *"Channel-scope category is PES.3 territory; flagged, not claimed."* 3.41 (AspectsCard)
✅ PARITY — but that grade predates AM.1; under AM.1 the aspects are `listingOnly` too and are
therefore currently **read-only**. 3.51 (HealthScoreRail incl. category gates) 🔁. 2.22 ⛔ N/A —
category stays per-channel, master gets no category editor.

**Hub rulings that bind this.** **#86** — category/aspect pickers are *"per-LISTING operations, not
per-cell edits; a sheet is the wrong shape for them"*, disposition → drawer panes (PES.4).
**#110** (D1 decided, three-legged hybrid) — category/aspects pickers are **WAVE 2, queued, not
dispatched**. **#333** — eBay·IT 35 columns, channel-writable 2, *"the eBay coordinate contributes
NO category-attribute columns"*. **#513** — `resolveWriteRouting` returns `writable: true`
unconditionally while refusal happens through `editable:false`; ruled that every `editable:false`
carries a `writeBlockedReason` and the client gates on the REASON. **#282** — `SNAPSHOT_FIELDS`
listed `channelCategoryId`, a column `ChannelListing` does not have; Prisma threw on every
`captureState`, so snapshot/restore was dead for all of D1 wave-1. Fixed by removing it:
*"a channel category lives in `platformAttributes`, already captured."* **#15** — the internal
`Category`/`ProductCategory`/`CategoryClosure` taxonomy is **0 rows on prod**; routing is
`Product.productType` (42 nulls). So `CategoryChannelMapping` has nothing to map from today
(`apps/web/src/app/channels/mapping/_shared/CategoryMappingPane.tsx:1-16` says exactly this on screen).

## 5. Defects and slowness

1. **The Apply PATCH sends no cookie.** `CategoryPickerModal.tsx:211-221` omits
   `credentials: 'include'` — the only one of the modal's four fetches that does. The route needs
   `channels.sync` (`permissions-manifest.ts:354`). **CODE-READ**; whether it 401s depends on
   enforcement state, which I did not measure.
2. **Three read paths convert an eBay failure into "no results".** `suggest-categories:154`,
   `category-map:212` and `category-search:719` all pass `throwOnError: false`, and
   `searchCategories:140-164, 218-235` returns `[]` on an unknown marketplace, a missing/expired
   token and any HTTP/network error. The modal then paints *"No suggestions returned. Try Search or
   refine the listing title."* / *"No matches. Try a different keyword."* Its `aiError` branch
   (`:148-151`) only fires on a non-2xx, which the route never returns in that case — so the error
   state is unreachable in the common failure mode. **CODE-READ.** (Memory:
   `reference_could_not_measure_vs_measured_empty`.) `category-schema` already got this right
   (`throwOnError: true`, `ebay-flat-file.routes.ts:562-566`) — the picker never did.
3. **The sibling map matches a LOCALISED name against a FOREIGN tree.** `category-map` searches the
   DE/FR/ES/UK trees for the name the IT tree returned (`ebay-cockpit.routes.ts:212-215`;
   `searchCategories` sets no `Accept-Language`, so names come back in the tree's language), then
   reports a `matchScore` %. The same service already proves ids are shared across EU sites
   (`ebay-category.service.ts:294-298, 383-387`) and has the primitive to verify one
   (`loadTreeMap`/`buildPath`). **CODE-READ on the mechanism; the miss rate is a HYPOTHESIS.**
4. **`findFirst` cannot address an alias.** `ebay-cockpit.routes.ts:272` writes an arbitrary
   `ChannelListing` for (product, EBAY, market), but aliases are separate rows
   (`schema.prisma:1699-1700`) each with their own `platformAttributes`. **CODE-READ.**
5. **The write route for `platformAttributes` does not exist, and the generic one points at a bag
   nobody reads.** `resolveWriteRouting` (`studio-sheet.service.ts:522`) sends any
   `storage !== 'column'` channel cell to `overrideData` via `attr_* + target:'channel'`
   (`routes/products.routes.ts:1292, 2375, 2450`). Every reader of the category — the publish
   adapter (`:251`), `ebay-schema-sync:36`, `ebayCategoryIdsFor:766`, the cell's own read
   (`:1125`) — reads `platformAttributes`. Today the column is `editable:false` so the mismatch is
   latent; making it editable without the phase-2 store would write to a dead bag and repaint the
   old value. **CODE-READ.** (Memory: `reference_write_predicate_must_match_its_readers`,
   `reference_channellisting_mapped_fields_are_columns`.)
6. **Client/server type drift, right now.** Server `SheetStorage` has four members including
   `'listing'` (`sheet-columns.service.ts:65`); the studio channel client's mirror has three
   (`_studio/sheet/channel/types.ts:50`). No compiler sees the wire boundary. **CODE-READ.**
   (Memory: `reference_wire_parse_boundary_rules`.)
7. **The category gates are a hardcoded bilingual set-claim.** `category-gates.ts:32-108`: 11 rules,
   substring-matched on category name/path, satisfied by hardcoded English+Italian aspect labels.
   A DE/FR/ES market matches nothing; an eBay label rename silently drops a gate; the whole thing
   runs client-side so no server surface agrees with it. **CODE-READ.** (Memory:
   `reference_a_list_of_members_is_a_set_claim`.)
8. **`_categoryHistory` is write-only** — 10 entries persisted per listing (`:278-290`), zero
   readers repo-wide. **CODE-READ.**
9. **Re-categorising orphans aspect values invisibly.** The PATCH preserves `itemSpecifics` (good),
   `AspectsCard` renders only the new schema's aspects (`:172-184`), and the publish path still
   sends the bag. Values for aspects the new leaf does not declare become invisible and still ship.
   Under AM.1 the same happens to columns: `loadEbaySpec` unions only the declared aspects. **CODE-READ.**
10. **Cold-cache column gap.** `field-registry.service.ts:325-336` uses `cacheOnly: true` and its own
    comment admits *"cold cache means the user has to visit the per-product editor's eBay tab once"*;
    `loadEbaySpec` substitutes the marketplace-wide union instead. A freshly picked category has no
    cached schema, so the sheet shows the wrong family until something warms it. **CODE-READ.**
11. **A 556-line modal with three sequential waterfalls** (mode switch → fetch → render) and no
    request coalescing; the sibling tab fires N parallel taxonomy searches (`:213`) each of which may
    trigger a full tree fetch. Column builds cost ~1.4 s each (`studio-columns.ts:5-8`).
    **MEASURED-IN-DOC** for the 1.4 s; the modal's cost is **HYPOTHESIS**.
12. **No tests.** No `*.vitest.test.ts` covers the category routes, `category-gates.ts` or
    `useHealthScore`. The only category test near the new model is
    `channel-specs/__tests__/channel-specs.test.ts:264` (an aspect's store path). **CODE-READ.**

## 6. Proposed home in the studio

### 6.1 Primary home + mirrors

**PRIMARY: H1 — the `Category` cell on the eBay channel scope, with an async lookup popup editor.**
The engine already emits the column (`ebay.ts:93`) and already keys the whole aspect family off its
value (`studio-sheet.service.ts:821` → `studio-columns.ts:48`). The Owner's framing — *"do we
integrate it directly in the description cell of eBay, or …"* — is answered by the grid itself
here: unlike a description, a category is a **short, closed, per-row value with one canonical
answer**, exactly the H1 shape ("a policy id, a category" is H1's own example). Making it a cell
also buys the two things the modal can never have: it is visible **at rest on every row** (an
operator sees at a glance that alias ② is filed in a different leaf), and it is **fillable down a
selection** like any other cell. This supersedes ruling #86's blanket "a sheet is the wrong shape"
for the *assignment* half — #86 predates AM.1, which made every channel property a column
(`docs/2026-09-04-channel-attribute-model-design.md` §A.2/§A.3a, approved 2026-09-05) and
re-graded the sibling case (aspects, parity 3.41) from 🕳 to ✅ on exactly that argument.

**MIRROR 1: H7 — a `Category` section in the record drawer.** The depth #86 was right about does
not fit a cell popup: the full tree browser (expand/collapse from root, the only way to find a leaf
you cannot name), the sibling-market map, `_categoryHistory` (a table that exists and has never been
shown), the cached-schema age and the aspect diff between the current and candidate leaf. Non-modal,
so the sheet stays live and the operator watches the aspect columns change behind the drawer.

**MIRROR 2: H3 — `pick-category` ROW verb** in the one action registry, so the same operation is on
the row context menu, the ⋯ column and the drawer actions (channel-ops research §3.2: a verb must
never live only in the drawer). It is the verb that opens the H7 pane on the right row, and it is
also where the CONFIRM step lives (§6.3).

**MIRROR 3: H4 + H5 — `apply-category` on SELECTION and on `CONTEXT(alias-group)`.** Filing 20
children into one leaf, or "file this whole alias here", is the same verb over N rows. The old
tree's cross-market story was a dead end (the modal tells the operator to visit each market's tab);
`CONTEXT(alias-group)` plus the market switch replaces it honestly.

**MIRROR 4: H2 — a `Category state` status column.** Read-only, filterable, derived: `—` no
category (publish-blocked), `⚠ schema not cached` (the aspect columns on screen are the
marketplace fallback, not this leaf's), `⚠ drift` when `platformAttributes.categoryId` ≠
`EbayListingIndex.categoryId` (`schema.prisma:13089`, fed by
`ebay-listing-index.service.ts:117,224`). Facts the channel reports belong in H2, not in the
assignment cell.

**MIRROR 5: H9 — Errors & Sync rows** grouped by cause: "no category (N listings)", "category
schema not cached (N)", "category drift (N)", "orphaned item specifics after re-file (N)". A queue
must never be inline-only.

**NOT H11, yet.** `CategoryChannelMapping` is the right long-term home for "our taxonomy node →
eBay leaf, per market", but ruling #15 measured the internal taxonomy at **0 rows**, and
`CategoryMappingPane.tsx:8-16` already says so on screen. Design the H1 cell to be *overridable by*
a future mapping default (provenance `🔗 inherited` from the mapping rule, `✎ pinned` when the
operator picked), and leave H11 to PES.6 when the taxonomy is populated.

**Nothing is dropped (no H12).** The one thing I would retire is `category-map` in its current
name-search form — replaced by an id-existence check against each target tree.

### 6.2 What the sheet shows at rest

| scope | column | at rest |
|---|---|---|
| **master** | none | Correct as built (`sheet-columns.service.ts:459` skips `listingOnly` on master); parity 2.22 ⛔. The master's categorisation axis is `productType`. |
| **eBay × market** | `Category` (group *Listing*) | **The breadcrumb path, not the id** — `Motorcycle Gear › Jackets` (English preferred, market-localised fallback), from `getCategoryBreadcrumbs`. Leaf id, market and `n aspects declared` in the tooltip. Empty cell + `⚠` when unset. Provenance `✎` (a per-listing pinned value), never `🔗`, until a mapping default exists. |
| | `Category state` (H2) | `✓` / `— none` / `⚠ schema not cached` / `⚠ drift vs eBay`. |
| | alias band | The alias's own leaf path as a `Pill` beside its readiness %; two aliases in different leaves is the fact the band must surface. |
| **Amazon / Shopify × market** | none | The column comes from the eBay adapter only. |

The `n aspects` count and the ⚠ are the honest answer to the silent fallback in defect 10: when
`loadEbaySpec` substituted the marketplace-wide rows, the cell must say so, because the column
family on screen is then not this category's.

### 6.3 The interaction, step by step

1. **OPEN.** On the `Category` cell, `Enter` / type / double-click opens the editor
   (layout-v2 §5.5: double-click EDITS; the record opens only from the identity cell). ⚠ AG's
   fill handle is a 6×6 child of the selected cell and swallows the double-click while filling the
   column down — `reference_ag_fill_handle_swallows_dblclick`; the gate
   `scripts/check-editor-open.mjs` must cover this column. The editor is an AG **popup** editor
   (`cellEditorPopup: true`, `reference_ag_grid_probe_traps`) so it can be wider than a 160px cell,
   and it must report through `props.onValueChange` — a ref `getValue` is never read
   (`SelectPanelEditor.tsx:64-80`, `reference_ag36_react_editor_onvaluechange`).
2. **COLLECT (in the editor).** One input, three result groups in one list — **Suggested** (eBay's
   `get_category_suggestions`, seeded from the row's title, fired on open with no keystroke),
   **Matches** (debounced search as the operator types), **Recent** (`_categoryHistory` + leaves
   already used by this family). Each row: path, leaf id, match %. `↑↓` moves, `Enter` picks,
   `Esc` cancels — and AG's popup owns all three keys, so no React handler competes
   (`reference_ag_popup_editor_owns_keys`). A failure is a `Banner`, never an empty list — the
   editor must distinguish *no matches* from *eBay unreachable* (defect 2). `Browse the tree…` as
   the last row escalates to the H7 pane.
3. **PREFLIGHT.** Picking does not commit. `preflight(rows)` builds an `ActionImpact`
   (`design-system/grid/actions/registry.ts:84-120`): warm the candidate leaf
   (`POST /api/pim/ebay-prewarm`) and compute, from the two specs, **columns gained**, **columns
   lost**, **item-specific values that will be orphaned** (named, never counted — the registry's
   own rule at `:88-92`), **required aspects newly missing**, and the readiness delta. The fetched
   spec rides in `impact.payload` (`:110-120`) so RUN applies the snapshot the operator approved.
4. **CONFIRM.** `ActionConfirm` at the level the preflight returns, never a fixed flag. Losing
   filled item specifics is a real confirm; an empty draft is a plain one.
5. **RUN.** `PATCH /api/products/bulk` through the ONE `SheetWriter` with `expectedVersion`, writing
   `platformAttributes.categoryId/categoryName/categoryPath` **for the addressed alias**, and
   appending `_categoryHistory`. No parallel endpoint.
6. **REPAINT.** The write changes `ebayCategoryIdsFor`, which changes the column-set cache key
   (`studio-columns.ts:48`), so the sheet must **re-fetch the column set**, not just the row —
   a repaint that only refreshes cells would leave the old aspect columns standing. Column state is
   frozen at mount (`reference_grid_column_state_frozen_at_mount`), so this is a controlled
   remount of the column model with scroll position and selection preserved, an `EditModeBar`-style
   inline notice naming what changed, and the readiness chips re-derived from the server.
   ⚠ `reference_ag_react_inline_options_rerun_column_model`.

**DS components:** `Banner`, `Pill`, `Tooltip`, `HoverCard` (the aspect diff), `PressableRow`,
`Kbd`, `Button`, `EmptyState`, plus the grid's `ActionConfirm` / `useActionPress` and
`ListboxPanel` geometry. **One new DS component is needed: `LookupCombobox`** — an async
remote-search combobox with `onQuery`, `loading`, `error`, grouped sections and a footer action.
`Combobox` filters a local `options` array only (`design-system/components/Combobox.tsx:22-31`):
no async, no loading, no error state. `LookupCombobox` then backs both a form field and a new
`LookupPanelEditor` beside `SelectPanelEditor`, so forms and grid share one popover
(`SelectPanelEditor.tsx:19-20`). Every other market-facing lookup (browse node, policy id,
description theme) reuses it.

**With the drawer open:** the drawer is non-modal at 520px and the sheet stays live
(layout-v2 §5), so picking in the drawer's tree browser repaints the sheet's columns behind it.
⚠ an in-flight autosave has undone an API revert before; the nav guard and a delayed re-read apply
(`reference_autosave_still_needs_a_nav_guard`).

### 6.4 Per-scope rules

- **Master:** no category column, no verb. The Owner sign-off already exists (parity 2.22 ⛔).
- **eBay × market (the only channel with this column):** the cell is **per-alias** — the value lives
  on the `ChannelListing` row, and each alias is its own row (`schema.prisma:1699-1700`). Child SKU
  rows inherit the alias's leaf and show it `🔗 inherited`, read-only: eBay files a multi-variation
  listing under ONE leaf, so a per-child category is not a thing. The verb is therefore
  `CONTEXT(alias-group)` on the band and `ROW` on the parent row, never `ROW` on a child.
- **The column family is per-scope, not per-alias.** `ebayCategoryIdsFor:760-766` unions across the
  whole family for the market; `loadEbaySpec` unions their aspects and each column records which
  categories declared it (`sheet-columns.service.ts:681`). So a family split across two leaves shows
  the union, and each aspect column's tooltip must name the leaf(s) that declare it — otherwise
  alias ① sees a column only alias ② needs. **This is the one place where per-alias and
  per-family collide, and the tooltip is the only honest resolution short of per-alias column sets.**
- **Amazon:** the analogous feature is `productType` + browse node (parity 3.22 / 7.4, unowned).
  Same H1+H7 shape, different adapter — do not fold them into one control.
- **Single-store channels (Shopify/Etsy/Woo):** no category column, because their adapters do not
  declare one. Per #513, a channel-scope cell that cannot be written must say why; a channel with
  no category concept shows no column at all, which is the honest version.

### 6.5 Provenance / autosave / readiness / publish

- **Provenance:** `✎ pinned` — the value is the listing's own, from `platformAttributes`. It is never
  `🔗 inherited` from master (there is no master category) until an H11 mapping default exists, at
  which point `🔗` means "from the category mapping" and `✎` means "the operator overrode it".
- **Autosave:** the one `SheetWriter` with `expectedVersion`, like every other cell — but the write
  needs the **phase-2 `platformAttributes` store** that `studio-sheet.service.ts:1121-1122` names as
  not yet built. Until that lands the column must stay `editable:false` with its existing honest
  reason (`:1185-1186`); shipping the picker on the `overrideData` route would write where nothing
  reads (defect 5). **Producer and consumer must land in one write**
  (`feedback_producer_and_consumer_land_together`).
- **Readiness:** one server definition (`services/pim/readiness.service.ts`) gains its **first**
  eBay rule: no category ⇒ the eBay coordinate is `blocked`, with the publish adapter's own sentence
  (`ebay-publish.adapter.ts:252`); category set but schema uncached ⇒ `warn` (the aspect
  denominator is not this leaf's, so a % would be a lie). The 11 client gates
  (`category-gates.ts`) move server-side and become **derived** from the leaf's own
  `recommended`/`guidance: RECOMMENDED` aspects, which the cache already carries
  (`ebay-category.service.ts:766+`, `channel-specs/ebay.ts:150,156`) — not a hardcoded bilingual
  list. Keep them as a distinct `recommended` tier; never fold them into `required`
  (`reference_amazon_requirement_levels_derivation`'s discipline, applied to eBay).
- **Publish:** eBay is preview-only from the sheet (`sheet-publish.service.ts:125-141`) and the
  mode comes from `getEbayPublishMode()`, never env. The category preflight is a *readiness* gate,
  not a publish gate — but `previewPublish` must list "no category" as a blocker per coordinate so
  the operator meets it in the preview, not in eBay's rejection.

### 6.6 ASCII mockup — the H1 cell with its editor open

```
eBay · IT              │ Category                    │ Category state │ Marca   │ Stile  │
───────────────────────┼─────────────────────────────┼────────────────┼─────────┼────────┤
▾ ① GALE Pro · 3958…   │ Motorcycle Gear › Jackets ✎ │ ✓              │ Xavia   │ Sport  │
    GALE-BLK-M         │ Motorcycle Gear › Jackets 🔗│ ✓              │ Xavia   │ Sport  │
▾ ② GALE Pro · 4471…   │ ┌──────────────────────────────────────────────────────┐
    GALE-YLW-M         │ │ jack                                            [⌕]  │
                       │ ├──────────────────────────────────────────────────────┤
                       │ │ SUGGESTED (from this listing's title)                │
                       │ │ ▸ Motorcycle Gear › Jackets            57988   96%   │
                       │ │ ▸ Men's Clothing › Coats & Jackets     57990   71%   │
                       │ │ MATCHES                                              │
                       │ │ ▸ Motorcycle Gear › Jackets › Textile  177104   —    │
                       │ │ RECENT ON THIS FAMILY                                │
                       │ │ ▸ Motorcycle Gear › Jackets            57988   —     │
                       │ ├──────────────────────────────────────────────────────┤
                       │ │ ⌕ Browse the eBay tree…            ↑↓ move · ⏎ pick  │
                       │ └──────────────────────────────────────────────────────┘
  ─ after ⏎, the confirm ─────────────────────────────────────────────────────────
  Re-file alias ② into "Textile Jackets" (177104)?
   • 4 aspect columns appear:  Protection · Closure · Lining · CE Rating
   • 2 aspect columns go:      Neckline · Fit
   • 2 filled item specifics are orphaned: "Scollatura = Alta", "Vestibilità = Slim"
   • 1 newly required aspect is empty: Protection
   • eBay · IT readiness 71% → 58%                       [Cancel] [Re-file alias ②]
```

## 7. Contracts and data

**Reused unchanged:** `ebay-category.service.ts` (search, tree, breadcrumbs, rich aspects,
conditions, prewarm); `POST /api/pim/ebay-prewarm`; `PATCH /api/products/bulk`;
`getStudioColumns`/`loadEbaySpec`'s category keying; `ActionImpact.payload`.

**New / changed server:**
| piece | shape | lane |
|---|---|---|
| `GET /api/pim/ebay/categories/search?q&marketplace` | ranked `{id,path,name,matchPct}`; `throwOnError: **true**` — a token/eBay failure is a 502 with a reason, never `[]` | PES.5 |
| `POST /api/pim/ebay/categories/suggest` | title/description → same shape; read-shaped POST, must be mapped to `listings.view` in the manifest (add BEFORE the `/api/ebay` catch-all, or use a `/api/pim` prefix — the cheaper fix) | PES.5 |
| `GET /api/pim/ebay/categories/tree?parentId&marketplace` | one level of children from `loadTreeMap`, for the H7 browser | PES.5 |
| `GET /api/pim/ebay/categories/breadcrumbs?ids&marketplace` | thin re-expose of `getCategoryBreadcrumbs` outside the ⛔ flat-file prefix (that route also demands `listings.flatfile.edit`) — or compose it in-process in `studio-sheet.service.ts` and ship the path on the cell, which I prefer: one fetch fewer, and the value and its display cannot disagree | PES.5 |
| `POST /api/pim/ebay/categories/impact` | `{aliasKey, fromId, toId}` → `{columnsGained, columnsLost, orphanedSpecifics[], newlyRequired[], readinessBefore/After}`; warms the target leaf as a side effect | PES.5 |
| **phase-2 `platformAttributes` write** | the write route `studio-sheet.service.ts:1121` names; `attr_*` + `target:'channel'` must route to the store the **spec** declares (§A.4 of the AM.1 design), in ONE predicate shared with the readers | PES.5 |
| readiness gains eBay category rules | §6.5 | PES.5 |
| retire name-based `category-map` | replace with "does id X exist in tree Y" using `loadTreeMap` | PES.5 |

**Client:** the `Category` cell renderer (path + tooltip) and the `LookupPanelEditor` → **PES.2**
(grid substrate, `design-system/grid/{renderers,editors}`); `LookupCombobox` → **DS**; the H7
`CategoryPane` → **PES.4**; the `pick-category` / `apply-category` verbs and the alias-band pill →
**PES.3**; the H9 rows → PES.3's Errors & Sync console; H11 later → **PES.6**.

**Schema:** **none needed.** Everything lives in `platformAttributes` (ruling #282's own
conclusion) and in `CategorySchema`. If the Owner wants the category promoted to a real column
later that is a separate, additive migration — and #282 is the warning about naming a
`ChannelListing` column that does not exist. AM.1 §A.5's `EBAY_IT` → `IT` re-key in `CategorySchema`
(4 rows) is additive and belongs to that lane, not this one.

## 8. Risks and traps

- **Live listings.** Every eBay listing in the fixture family is LIVE. A category is the one field
  eBay validates hardest; re-filing a live item can invalidate aspects it currently accepts. Any
  rehearsal writes to a **draft** alias, restores **by value**, and re-reads after a delay.
- **Local dev writes PROD.** `reference_local_dev_hits_prod_api`, and worse:
  `reference_endpoint_safety_is_not_interaction_safety` — a lookup editor's **blur** has committed
  to prod before. The editor must not commit on blur while a preflight is unresolved.
- **The write route does not exist yet** (defect 5). Shipping the picker before the phase-2
  `platformAttributes` store lands produces a write to `overrideData` that nothing reads and a cell
  that repaints the old value — the exact "my edit did not save" defect
  `studio-sheet.service.ts:1100-1110` was written to prevent.
- **The silent fallback** (defect 10): a picked-but-uncached leaf shows the marketplace-wide aspect
  family. Prewarm inside RUN, and mark the cell until the schema is cached.
- **Three permissions for one control** (§3). A user with `listings.view` but not `channels.sync`
  can see the cell, get suggestions refused, and be unable to apply — and the manifest's
  first-match-wins order is part of its meaning (`permissions-manifest.ts:50-52`).
- **AI dark (#13) does not apply**, but must be said out loud: the "AI suggest" tab is eBay's own
  taxonomy ML, not our LLM. Do not label it ✦ AI draft — that glyph means an AI-drafted *value*.
- **⛔ Untouchable:** `ebay-flat-file.routes.ts` and `products/ebay-flat-file/**`. Read the
  breadcrumb/search/schema endpoints for reference; do not edit them, and do not make the studio a
  client of the `/api/ebay/flat-file` prefix (wrong permission, wrong owner).
- **Column-set churn is the performance risk.** Each build ~1.4 s (`studio-columns.ts:5-8`);
  a category change invalidates the key. The §4a budgets of the views design apply, and
  time-to-interactive must be measured **as a pair** before/after on eBay·IT.
- **Grid traps to gate:** the fill handle swallowing the open gesture; unregistered AG modules
  failing silently; `valueSetter` must mutate `params.data`; a doubled header set in a diagnostic is
  an HMR remount from a concurrent write, not a defect.
- Not implicated: per-channel oversell, Amazon EU shared quantity, images-global-per-ASIN.

## 9. Open questions for the Owner (3)

1. **Is the category cell editable, or read-only until the phase-2 write lands?**
   *Recommendation:* keep it **read-only** and ship the H7 pane + `pick-category` verb first, both
   writing through the phase-2 `platformAttributes` route — so producer and consumer land together
   and the cell becomes editable the day the store exists. Shipping the cell editor onto today's
   `overrideData` route would write where nothing reads.
2. **When a family spans two eBay leaves, does the sheet show the UNION of both aspect sets (today's
   behaviour), or per-alias column sets?**
   *Recommendation:* **union**, with each aspect column's tooltip naming the leaf(s) that declare it
   and the alias band showing its own leaf. Per-alias column sets mean two column models in one
   grid; the union plus honest labelling is the smaller, truer answer.
3. **Do the 11 category "soft gates" survive as a distinct recommended tier, or fold into
   readiness's required/optional?**
   *Recommendation:* survive as a **third `recommended` tier**, but **derived** from eBay's own
   `RECOMMENDED` guidance per leaf (already in the cache) rather than the hardcoded bilingual list —
   so DE/FR/ES get them too and an eBay label rename cannot silently drop one.

## 10. Effort and dependencies

| piece | lane | effort |
|---|---|---|
| `Category` cell renderer: breadcrumb path + tooltip + ⚠, breadcrumbs composed in-process | PES.5 + PES.2 | **S** |
| `Category state` H2 column (none / uncached / drift vs `EbayListingIndex`) | PES.5 + PES.3 | **S** |
| `LookupCombobox` DS component + `LookupPanelEditor` grid editor | DS + PES.2 | **M** |
| Read endpoints (search / suggest / tree / breadcrumbs) outside the ⛔ prefix, `throwOnError: true`, manifest entries | PES.5 | **S–M** |
| `/impact` preflight (column delta + orphaned specifics + readiness delta) + prewarm in RUN | PES.5 | **M** |
| **phase-2 `platformAttributes` write route, one predicate shared with the readers** | PES.5 | **M–L** ← blocks the editable cell |
| `pick-category` ROW / `apply-category` SELECTION + `CONTEXT(alias-group)` verbs | PES.3 | **M** |
| H7 `CategoryPane`: tree browser, sibling-market map (id-existence, not name search), `_categoryHistory`, schema age | PES.4 | **M–L** |
| Readiness: eBay category rules + derived recommended tier | PES.5 | **M** |
| Column-set refresh on category change (controlled column-model remount, scroll/selection preserved) | PES.2 | **M** |
| H9 Errors & Sync rows | PES.3 | **S** |
| Retire name-based `category-map`; client `SheetStorage` mirror gains `'listing'` | PES.5 / PES.3 | **S** |

**Dependencies.** Blocked on AM.1 phase 2 (the `platformAttributes` write) for anything editable.
Shares the aspect cache and the same store with **feature: eBay aspects/item specifics** — the two
must be designed as one column family, not two features. Shares the `LookupCombobox` with the
Amazon browse-node picker (parity 3.22 / 7.4, unowned), eBay business policies and description
themes; whoever builds it first owns it. Independent of PES.7 (images) and PES.8 (AI).
