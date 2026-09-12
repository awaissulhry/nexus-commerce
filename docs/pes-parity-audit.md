# PES parity audit — OLD /products/[id]/edit capability checklist (2026-09-01)

Measured by a read-only sweep of `apps/web/src/app/products/[id]/edit/**` EXCLUDING `_studio/**`
(80 tool calls, importers chased through barrels). The old tree is SPECIFICATION, never source
(§2.10) — nothing here is an instruction to copy code; it is the list of things an operator can DO
today, so the studio cannot silently lose one.

## Audit protocol (hub ruling #85)

Each lane audits its assigned area(s) below and fills the **Status** for every row, appending a
short note where the answer isn't obvious. Edit ONLY your own area's section. Statuses:

- `✅ PARITY` — the studio does this, verified on screen (say where)
- `🔁 SUPERSEDED` — the studio covers the operator's need a different way (say how; the need, not
  the widget, is what must survive)
- `🕳 MISSING` — not in the studio and should be: claim it and build, or queue it with a reason
- `🗳 OWNER` — deliberately dropped or changed; needs the Owner's sign-off at swap time
- `⛔ N/A` — DEAD? in the old tree (prove no importer) or out of studio scope (justify)

Rules that bind the audit:
- **AI features (#13):** parity means the SURFACE exists and is honest; generation/spend stays
  dark. An AI row is `✅` when the control is built and dark, never by running it.
- **DEAD? rows are not parity requirements.** Verify the no-importer claim before relying on it;
  a doc can describe deleted code and dead code can describe nothing.
- **localStorage-backed features** (rollback snapshots, approval queue, prefs): triage the
  FEATURE, not the storage. Server-backed replacement = `🔁`; silently absent = `🕳`.
- **Nothing is deleted from the old tree** during this programme; deletion decisions ride the
  Owner queue at swap time.

## Area assignments

| Area | Lane |
|---|---|
| 1. Frame / navigation + §8 cross-cutting | PES.1 |
| 2. Master field editing | PES.2 |
| 3. Channel / marketplace scopes | PES.3 |
| 4. Record / detail views | PES.4 |
| 5. Images / media | PES.7 (AFTER their P3–P8 build) |
| 6. Ancillary tabs | split: 6.1–6.22 Matrix → PES.2 · 6.23–6.28 Mapping → PES.6 · 6.29–6.46 → PES.4 |
| 7. AI features | PES.8 |
| Backend: every **[W]** endpoint below | PES.5 (does the studio backend cover/supersede each write path?) |

Legend: **[W]** = mutates data (endpoint noted). **DEAD?** = no importer found.
Studio tab ids for mapping (`_studio/types.ts:35`): `sheet · images · analytics · activity`.
The old page has **17 canonical top tabs**.

---

## 1. Frame / navigation — 31 capabilities

| # | Capability | File:line | Status |
|---|---|---|---|
| 1.1 | Server-rendered fast path; falls back to client loader on 401/RBAC | `page.tsx:23,26` | ✅ PARITY — `studio/page.tsx` uses the identical two-pass model (server fast path → `StudioLoader` on 401) |
| 1.2 | Client re-load with **Retry** button on load error, incl. HTTP code | `ProductEditLoader.tsx:40-54` | ✅ PARITY — `StudioLoader.tsx` EmptyState + **Try again**, message names the HTTP code |
| 1.3 | `notFound()` on 404 product | `page.tsx:25`, `ProductEditLoader.tsx:38` | ✅ PARITY — `studio/page.tsx` `notFound()` |
| 1.4 | Route-shaped skeleton (header + 9 tab pills + 8-field grid) while loading | `loading.tsx:13` | ✅ PARITY — `studio/loading.tsx`, shaped to the STUDIO (3 bands at 48/44/34). Own file required: `edit/loading.tsx` is a boundary for nested segments and would flash the old page's shape |
| 1.5 | Back button: `router.back()` if in-app history, else `/products` | `ProductEditClient.tsx:1087-1098` | 🔁 SUPERSEDED — a real `<Link>` to `/products/next`, so ⌘/middle-click work (the old `router.back()` swallowed all three). Note: loses "return to exact scroll+selection" when arriving from elsewhere |
| 1.6 | Header shows product name, SKU, Amazon ASIN | `ProductEditClient.tsx:1107,1124-1126` | ✅ PARITY — ASIN now on the header beside the SKU. Needed no PES.5 field: `GET /api/products/:id` already returns `amazonAsin` (the old client read it at :1126). ⏳ on-screen pending the API |
| 1.7 | "N variants" badge on parent products | `ProductEditClient.tsx:1110` | 🕳 MISSING (part) — a `Parent` pill renders, but **without the variant count** |
| 1.8 | Unsaved-count badge in header (aggregate across all tabs) | `ProductEditClient.tsx:1115` | 🔁 SUPERSEDED — decision 7 retired the dirty registry; `SaveIndicator` reports saving/saved/failed counts from the sheet's own reports |
| 1.9 | Post-create success banner (`?created=1`), dismissible | `ProductEditClient.tsx:590,1321` | 🕳 MISSING — no `?created=1` post-create banner; the create→edit bridge would land silently |
| 1.10 | 17-key canonical tab strip (master, images, matrix, analytics, ads, mapping, AMAZON, EBAY, SHOPIFY, locales, seo, compliance, workflow, relations, activity, WOOCOMMERCE, ETSY) | `_shared/useTabPrefs.ts:61` | 🔁 SUPERSEDED — decision 5: 17 tabs → 4. The other 13 fold into sheet scopes, the drawer and the ancillary tabs |
| 1.11 | Per-user tab visibility + drag-reorder ("Customize Tabs" modal, dnd-kit), min-1-visible guard, Reset to defaults | `_shared/TabPreferencesModal.tsx`, `ProductEditClient.tsx:1305,1653` | 🔁 SUPERSEDED — 4 fixed tabs need no visibility/reorder modal (the modal existed because there were 17) |
| 1.12 | Tab prefs persisted `localStorage['product-edit:tab-prefs:v1']` + migration from legacy `show-all-tabs` | `_shared/useTabPrefs.ts:108,112` | 🔁 SUPERSEDED — no tab prefs to persist. FEATURE, not storage: nothing is silently absent |
| 1.13 | Modal doubles as quick-jump: clicking a hidden tab row navigates and auto-pins | `ProductEditClient.tsx:1658` | 🔁 SUPERSEDED — no hidden tabs to jump to |
| 1.14 | Active-but-unpinned tab renders with dashed border cue | `ProductEditClient.tsx:1296,1721-1729` | ⛔ N/A — no pinning, so no unpinned state to cue |
| 1.15 | URL is canonical cursor: `?tab=` + `?market=` written via History API, push on change / replace on no-op | `ProductEditClient.tsx:306-342` | ✅ PARITY (wider) — `?scope&market&locale&tab&rec&cell&chip`, `router.replace` for looking around, `push` for opening a record |
| 1.16 | Legacy `?tab=global` silently remapped to `master` | `ProductEditClient.tsx:256,283` | 🗳 OWNER — an unknown `?tab=` degrades to `sheet` rather than erroring, so old links land safely; whether to MAP legacy ids (`global`→sheet, `locales`→sheet+Localisation view) is a swap-time call |
| 1.17 | Deep-link `?market=` validated against the channel's real markets | `ProductEditClient.tsx:397-404,293` | ✅ PARITY — `?market=` validated against the live marketplace table; an unserved channel scope falls back to master |
| 1.18 | Channel tabs only appear when the channel exists (Woo/Etsy need actual listings) | `ProductEditClient.tsx:716-719` | 🔁 SUPERSEDED — every connected channel gets a chip; one the market does not serve is DISABLED with the reason, rather than hidden. A product with no listing shows readiness `absent`, not absence |
| 1.19 | Per-channel readiness % pill on tab (title/desc/bullets≥3/price/qty, 20% each) | `ProductEditClient.tsx:160-198,1744` | ✅ PARITY (better) — scope chips carry readiness %, computed SERVER-side by PES.5 against the real required-field schema, not the old client-side 20%-each heuristic |
| 1.20 | Per-tab count badge (listings count; children count on Matrix) | `ProductEditClient.tsx:1002,1068,1732` | 🕳 MISSING — DS `Tabs` supports `count`; the studio wires none. Low value at 4 tabs, but free |
| 1.21 | Per-tab amber dirty dot; channel tab sums dirty across all its markets | `ProductEditClient.tsx:1051-1053,1760` | 🔁 SUPERSEDED — autosave means there is no per-tab dirty state to dot |
| 1.22 | Tab-strip keyboard nav: ←/→ cycle, Home/End, focus follows | `ProductEditClient.tsx:821-854` | ✅ PARITY — **fixed at the DS layer**, not per page: `Tabs` now has roving tabindex + ←/→/Home/End, modelled on ScopeBar. Verified on `/design-system`: 1 tabbable tab of 3, ArrowRight moved Overview→Targeting, focus followed |
| 1.23 | Mobile tab strip: left/right fade indicators + auto-scroll active tab into view | `ProductEditClient.tsx:782-816,1262-1273` | 🕳 MISSING — no fade indicators or auto-scroll. 4 tabs will not overflow, but the SCOPE chips do scroll and have no affordance |
| 1.24 | Full ARIA tablist/tabpanel pairing | `ProductEditClient.tsx:1276,1712-1716` | ✅ PARITY — `Tabs` gained an opt-in `idBase` emitting `id`+`aria-controls`, plus exported `tabPanelProps()` for the panel half; `StudioTabHost` now renders `role=tabpanel` + `aria-labelledby`. Non-breaking: without `idBase` no attrs are emitted (verified — existing consumers unchanged). ⏳ studio pairing on-screen pending the API |
| 1.25 | Cmd+K "Jump to tab" via `nexus:products-edit:goto-tab` event | `ProductEditClient.tsx:350-361` | 🕳 MISSING — no `nexus:products-edit:goto-tab` listener in the studio |
| 1.26 | Cmd+K "Open route" → datasheet / datasheet-print / matrix / list-wizard / images | `ProductEditClient.tsx:366-391` | 🗳 OWNER — dropped with D9: with no link-outs there are no routes for a ⌘K command to open, and this route has no ⌘K anyway (§2.3 removed the AppTopBar) |
| 1.27 | Marketplace left sidebar per channel with per-market "has listing" green dot | `ProductEditClient.tsx:1510,1771-1833` | 🔁 SUPERSEDED — the market switcher plus per-channel chips carry the same two facts (which market, which channels are live) without a second sidebar |
| 1.28 | Preferred default market (IT → first-with-listing → alphabetical → GLOBAL) | `ProductEditClient.tsx:872-881` | 🔁 SUPERSEDED (better) — last-used market restored from `localStorage`, falling back to most-channels-served, never GLOBAL. The old IT-first rule was a constant; this is the operator's own choice |
| 1.29 | Variation family banner on child products: parent link, per-channel parent IDs (ASIN/eBay/Shopify), sibling chips | `ProductEditClient.tsx:1248`, `products/_shared/VariationFamilyBanner.tsx:43` | ✅ PARITY (reshaped) — CLAIMED and built. Header shows **Variation of `<PARENT SKU>`** linking to the parent's studio; one extra fetch, only for a child. Siblings deliberately NOT duplicated — the sheet already renders the whole family as rows, so a banner list would be the staler copy. ⏳ on-screen pending the API |
| 1.30 | Classic↔Cockpit switch banners for Amazon + eBay classic view | `ProductEditClient.tsx:1841,1864` | ⛔ N/A — the cockpits are old-tree; §2.10 forbids porting them, so there is no classic↔cockpit state to switch |
| 1.31 | New-route mount point `/products/[id]/edit/studio` exists beside the old route (layout uses `.h10-shell` + AppNavRail) | `studio/page.tsx:22`, `studio/layout.tsx:27` | ✅ PARITY — this row IS the studio mount; verified on screen at `/products/[id]/edit/studio` hosting PES.2's sheet |

## 2. Master field editing — 24 capabilities

| # | Capability | File:line | Status |
|---|---|---|---|
| 2.1 | Edit 7 master fields: sku, name, brand, manufacturer, upc, ean, status | `tabs/MasterDataTab.tsx:68`, render `505-589,610-626` |  🔁 SUPERSEDED — all seven are sheet columns (`columns.tsx` builds every schema column), but **`sku` is read-only** on the sheet: it is the row identity and the key every write is addressed by. Renaming a SKU is a catalogue operation, not a cell edit. 🗳 if the Owner wants it editable here. |
| 2.2 | **Explicit save model** — no autosave; header Save flushes the full dirty registry in parallel; 800ms back-compat drain | `ProductEditClient.tsx:596-621`, `_shared/useDirtyRegistry.ts:67` |  🗳 OWNER — deliberately replaced. Layout §2.7: "Autosave per cell everywhere; Publish explicit. Dirty-registry/header-Save retired." **Studio contract: per-cell autosave via `SheetWriter`**, batched per row, no header Save and no dirty registry. Signed off at swap time. |
| 2.3 | **[W]** Master flush → `PATCH /api/products/bulk` with `If-Match` + `expectedVersion` (optimistic CAS) | `tabs/MasterDataTab.tsx:248-256` |  ✅ PARITY (studio contract) — `useMasterSheet.commit` → `PATCH /api/products/bulk` carrying `expectedVersion` **per row**, advanced from the server's `currentVersion`. Stronger than the old page: the old flush sent one version for one product on an explicit save; the writer holds a version per row across a whole session of edits. Body field, not the `If-Match` header — the route accepts both. ⚠ **SCOPE, so the ✅ does not overstate (ruling #95, PES.5 confirmed by construction):** `Product.version` only advances on the EDITOR CAS path. **124 other write sites** — sync jobs, bulk ops, the pricing engine — never bump it, so a winning CAS can still overwrite a sync job's write without either side noticing. This is protection against another EDITOR, not against the system. The old page had exactly the same blind spot; the studio inherits it rather than introducing it, and making it real is an architecture decision, not a sheet fix. |
| 2.4 | Version-conflict (409 `VERSION_CONFLICT`) banner with expected/current + Reload | `tabs/MasterDataTab.tsx:261-268,420` |  ✅ PARITY — **verified on screen** (2026-09-01, forced 409: another writer advanced GALE-JACKET v5→v6 behind the open page). The cell paints `.nds-cell-is-refused` (red ground + ring) and KEEPS the operator's typed value — the value on screen is not on the server and the cell says so rather than silently reverting; the strip reads "1 refused — hover a red cell for why" and "1 row changed elsewhere — refresh"; the frame header reads "⚠ 1 change not saved" via `useSaveReporter()`. Arguably stronger than the old page's banner: it names the CELL, not just the product. |
| 2.5 | Partial-apply error surfacing (per-field `errors[]`, e.g. live-listing SKU guard) | `tabs/MasterDataTab.tsx:289-306` |  ✅ PARITY — `commit` reads `body.errors[]` and maps each to its column, so a 200-with-refusals paints only the cells that were refused. `SheetWriter` carries per-cell outcomes for exactly this. |
| 2.6 | Unmount safety-net flush (tab switch with pending edits still persists) | `tabs/MasterDataTab.tsx:400-404` |  ✅ PARITY — **found MISSING by this audit and fixed during it.** `SheetWriter.destroy()` cleared its queues, silently dropping a cell edited inside the ~40ms flush window before unmount. Now flushes (fire-and-forget, the same bargain the old unmount flush makes). Regression test: "SENDS what is still queued when destroyed". |
| 2.7 | Header **Discard** with scope-aware confirm listing each dirty tab + field count | `ProductEditClient.tsx:652-710` |  🗳 OWNER — no Discard, because there is no dirty state to discard: every edit is already on the server. The operator's undo path is ⌘Z, which round-trips through the same writer. Needs sign-off as a deliberate loss of "abandon everything I typed". |
| 2.8 | Discard signal remounts channel tabs by key, clears draft bus | `ProductEditClient.tsx:589,1624`, `MasterDataTab.tsx:373` |  ⛔ N/A — consequence of 2.2/2.7. No dirty registry and no draft bus, so nothing to signal or remount. |
| 2.9 | Live save-status pill (idle/saving/saved/error) | `tabs/MasterDataTab.tsx:432` |  ✅ PARITY — `GridSheetStatus` (rows · selected · unsaved · refused · "Saved HH:MM"), fed by the writer's own counters, plus the frame header via `useSaveReporter()`. Verified on screen. |
| 2.10 | Product-name character counter | `tabs/MasterDataTab.tsx:527` |  ✅ PARITY — `LongTextCell` shows a live counter against the tightest channel cap and names its source; measured on screen as `127/200`. Better than the old bare counter: the cap is the channel's, not a guess. |
| 2.11 | **[W]** Per-field cascade to child variants (name/brand/manufacturer) → `PATCH /api/products/bulk` `{cascade:true}` | `tabs/MasterDataTab.tsx:81,325-353,529` |  🕳 MISSING — per-field cascade to children (`{cascade:true}`) is not wired. The sheet's equivalent is editing the parent and letting children inherit at read time, which covers the common case but NOT "physically write this into every child". Queued, not built — the write path exists on the endpoint. |
| 2.12 | **[W]** "Cascade to variants" multi-select popover (checkboxes + current values + dirty markers) | `tabs/MasterDataTab.tsx:435-460,711` |  🕳 MISSING — no cascade multi-select popover. Same queue item as 2.11. |
| 2.13 | **[W]** "Cascade to channels" — CatalogCascadeDrawer: preview via `POST /mapping/propagate-preview`, apply via `POST /mapping/apply` | `tabs/MasterDataTab.tsx:471,482`, `_shared/cockpit-shell/CatalogCascadeDrawer.tsx:105,127` |  ⛔ N/A (out of studio scope) — cascade-to-channels is the mapping engine's, routed to PES.6 at `/channels/mapping` (layout §1: "mapping is global, not per-product"). |
| 2.14 | **[W]** "Import from flat file / Amazon" modal — reverse-map ASIN attributes up into master; `POST /master/import-from-channel`, apply `PATCH /api/products/:id/global` | `tabs/MasterDataTab.tsx:462,492`, `_shared/cockpit-shell/ImportFromAmazonModal.tsx:62,115` |  🕳 MISSING — no import-from-Amazon/flat-file into master. Genuinely absent; queue with the Owner, since it is a real enrichment path an operator uses today. |
| 2.15 | Locales (Content) section: EN + IT title / description / bullet points (add/remove/reorder) / keywords | `tabs/_shared/MasterGlobalSections.tsx:241-259`, `tabs/_shared/LocaleColumn.tsx:43-76` |  🔁 SUPERSEDED, partially — localised content is sheet columns for ONE locale at a time (`storage: localizedContent`), switched by the frame's locale picker; the Localisation view groups them. ⚠ Side-by-side locales need PES.5's `?locales=` (filed, not delivered), so EN+IT together is not yet possible. Bullet add/remove/reorder is a long-text cell, not a list editor — 🗳 if the Owner wants ordering back. |
| 2.16 | Physical section: weight (+unit), length, width, height, dim-unit | `tabs/_shared/MasterGlobalSections.tsx:261-320` |  ✅ PARITY — weight/dimensions and their units are schema columns in the Physical group, reachable via the Logistics view and Customise. |
| 2.17 | **[W]** Global sections flush → `PATCH /api/products/:id/global` (merged into the single "master" registry entry) | `tabs/_shared/MasterGlobalSections.tsx:137`, `MasterDataTab.tsx:218-258` |  ✅ PARITY (studio contract) — `commit` routes `storage: localizedContent` cells to `PATCH /api/products/:id/global` and everything else to `/bulk`, splitting one row's batch across both when needed and reporting per-cell outcomes. |
| 2.18 | **attr_*** editing — schema-driven Attributes editor from `GET /api/products/:id/master-schema`: typed fields (text/number/select/boolean), required-first, grouped, searchable, help text, per-market localized value hints, "referenced by mapping rule" marker | `tabs/_shared/MasterAttributesEditor.tsx:56,172-320` |  ✅ PARITY — the sheet IS the schema-driven attribute editor: typed columns (text/longtext/number/select/boolean) from `getSheetColumns`, required-first ordering, groups as header bands, caps and help on the header tooltip, `⚠ required` in-cell. Searchable/grouped via the one DS `PreferencesModal`. Measured: 102 columns for IT × OUTERWEAR. |
| 2.19 | Off-schema attribute escape hatch: free key/value rows add/edit/remove | `tabs/_shared/TechAttrsEditor.tsx:105-143` |  🕳 MISSING — no free key/value escape hatch for an off-schema attribute. The sheet can only show columns the schema declares. Worth queueing: it is the hatch operators use when a channel adds a field before our schema catches up. |
| 2.20 | Draft bus: every master keystroke publishes to the in-page draft bus so cockpits re-render preview/health pre-save | `tabs/MasterDataTab.tsx:171`, `_shared/draft-bus/useProductDraftBus.ts` |  ⛔ N/A — the draft bus existed to let cockpits preview BEFORE an explicit save. With per-cell autosave there is no pre-save state to broadcast; readiness recomputes from the server on reload and the cell paints its own outcome. |
| 2.21 | productType handling: read from `product.productType`, drives flat-file links, ChannelFieldEditor manifest grouping, and master-schema | `ProductEditClient.tsx:1159`, `tabs/ChannelListingTab.tsx:101-108` |  ✅ PARITY — `productType` drives the column set (`getSheetColumns({productTypes})`), per-row applicability (`columnApplies`) and readiness. It is why a COAT field is not demanded of a GLOVE. |
| 2.22 | Category handling lives per-channel (no master category editor) — Amazon CategoryCard / eBay CategoryPickerModal | `tabs/amazon-cockpit/category/CategoryCard.tsx`, `tabs/ebay-cockpit/cards/CategoryPickerModal.tsx` |  ⛔ N/A — per-channel category stays with PES.3's channel scopes; master has no category editor in either tree. |
| 2.23 | Bulk/variant editing surface = Matrix tab (see §6) — no per-field bulk on Master beyond cascade | `tabs/MatrixTab.tsx` |  ✅ PARITY — bulk editing is the sheet: multi-column paste, fill-down, and range edits all route through one batched writer. Proven on prod: 3 columns → 1 request; fill down 6 rows → 6 requests, one per row with its own version. |
| 2.24 | DEAD? `tabs/VariationsTab.tsx` (1217 lines), `tabs/PricingTab.tsx` (1078), `tabs/InventoryTab.tsx` (654) — no importer anywhere in `apps/web/src` | those files |  ⛔ N/A — DEAD? rows are not parity requirements. Not re-verified by me; PES.1 owns the no-importer sweep. |

## 3. Channel / marketplace scopes — 52 capabilities

### Shell / classic ChannelListingTab
| # | Capability | File:line | Status |
|---|---|---|---|
| 3.1 | Per-channel × per-market listing editor keyed `channel:<CH>:<MKT>` in dirty registry | `ProductEditClient.tsx:1490,1619` | 🔁 — scope bar + `?scope&market` URL state (PES.1) selects the coordinate; the sheet is that coordinate. No dirty registry: autosave per cell, decision 7 retired it. |
| 3.2 | Single-store channels (Shopify/Woo/Etsy) drop the market sidebar and `?market` param | `ProductEditClient.tsx:118,310` | 🔁 — `deriveScopeOptions` marks GLOBAL channels; the market switcher is the frame's, not a per-tab sidebar. |
| 3.3 | Status bar: market code badge, market name, listing status, external listing ID, currency, language | `tabs/ChannelListingTab.tsx:321-355` | 🔁 — the alias BAND carries status + external listing id per listing; market/locale live in the scope bar. Currency/language not surfaced on the band — see 3.3n. |
| 3.4 | **[W]** "Pull" from channel — Amazon `GET /api/amazon/test-catalog-api?asin=`, eBay `GET /api/ebay/pull-listing`, with rate-limit retry + status messages | `tabs/ChannelListingTab.tsx:195-290` | 🕳 — **No pull-from-channel anywhere in the studio.** An operator cannot refresh a coordinate from Amazon/eBay. Read-only surfaces (drawer ListingsPane) show what we hold, not what the channel holds. Claim: needs a lane. |
| 3.5 | **[W]** "Translate" — bulk-translate every field on the coordinate via ChannelFieldEditor's bound `translateAll` | `tabs/ChannelListingTab.tsx:368-377` | 🕳 — no bulk translate-all on a coordinate. `Marketplace.language` drives the locale column but nothing translates. PES.6 owns TRANSLATE link policy; the operator ACTION is absent. |
| 3.6 | **[W]** Auto-publish-content toggle (single-control immediate save, optimistic + revert on failure, "Saved" pill) → `PATCH .../listings/:channel/:marketplace` | `tabs/ChannelListingTab.tsx:142-170,393-424` | 🕳 — auto-publish-content toggle has no studio equivalent. |
| 3.7 | Variant sub-tabs (Parent + per-child chips) on parent products | `tabs/ChannelListingTab.tsx:435-467` | ✅ — rows ARE the parent + per-child SKUs, as a tree under each alias — verified on screen, 21 rows (1 band + 20 children). |
| 3.8 | **[W]** Pricing panel: rule FIXED / MATCH_AMAZON / PERCENT_OF_MASTER + price override / adjustment % → `POST /api/products/:id/listings/:channel/:marketplace/pricing` (hub-corrected #88: the original annotation conflated this panel's verb with MatrixTab's `PATCH /channel-pricing` path — they are two different endpoints) | `tabs/ChannelListingTab.tsx:597-620,656-717` | 🕳 — pricing RULES (FIXED / MATCH_AMAZON / PERCENT_OF_MASTER) and adjustment % are not in the sheet. Price is a plain cell; the rule engine behind it is unreachable. |
| 3.9 | **[W]** Replication panel: copy this coordinate to sibling markets, modes All fields / Text only / Attributes / Price only, optional translate | `tabs/ChannelListingTab.tsx:740-930` | 🕳 — no replicate-to-sibling-markets. The nearest thing is `marketplaceContexts` fan-out in the write path, which no UI exposes. |
| 3.10 | Readiness checklist per listing | `tabs/ChannelListingTab.tsx:506` | ✅ — per-alias readiness bar (state-coloured, #43) + per-row readiness; verified on screen. |
| 3.11 | Inheritance panel — 5 SSOT fields (title, description, price, quantity, bulletPoints) inherited vs overridden | `tabs/ChannelListingTab.tsx:510`, `tabs/_shared/InheritancePanel.tsx` | 🔁 — the cascade replaces the panel: every cell shows its layer inline (🔗 master / ✎ pinned) instead of a separate 5-field panel, and `follows` is honoured. Wider too — all fields, not five. |
| 3.12 | Diff-vs-master panel — side-by-side master value / channel override / which ships | `tabs/ChannelListingTab.tsx:519`, `tabs/_shared/DiffVsMasterPanel.tsx` | 🔁 — drawer ComparePane (PES.4) generalises DiffVsMasterPanel to any field, plus locale and ALIAS comparison with copy-across. |
| 3.13 | Schema-driven per-channel field editor (Amazon flat-file manifest grouping with coloured bands; eBay/Shopify ungrouped); per-field override menu, copy-from-master, broadcast-to-listings | `tabs/ChannelListingTab.tsx:532`, `products/_shared/ChannelFieldEditor.tsx` (2456 lines, only reachable from here) | ✅ — **PARITY (re-graded #91).** The sheet IS the schema-driven per-channel field editor: 102 eBay·IT columns from `ChannelSchema`, the same source as mapping + preflight, each editable with its caps. Verified on screen in the shim-free pass (columns incl. `Attestazione di sicurezza`, `Paese di origine`, `Tipo di tessuto`). Presentation differs (grid, not coloured manifest bands) but the ACTION is the same. Broadcast-to-listings remains absent — 3.13n. |
| 3.14 | **[W]** Per-coordinate Publish review modal: readiness checklist, fields-being-published table, missing-field warnings, resolved price, confirm → publish | `tabs/ChannelListingTab.tsx:552,954-1240` | 🔁 — publish is preflight-first per alias: verdicts, blocked rows with named fields, platform mode from the gate, eBay preview-only. No fields-being-published table — see 3.14n. |

### Amazon Cockpit (default mode; localStorage-persisted toggle)
| # | Capability | File:line | Status |
|---|---|---|---|
| 3.15 | Cockpit vs classic mode toggle, persisted per-channel | `tabs/amazon-cockpit/useAmazonCockpitMode.ts`, `ProductEditClient.tsx:232` | 🗳 — no cockpit/classic toggle — the studio replaces both. Owner sign-off at swap. |
| 3.16 | Market chip strip with Alt+1..9 switching + hover prefetch | `tabs/amazon-cockpit/AmazonCockpit.tsx:450`, `_shared/market-switch/useMarketSwitch.ts:170-190` | 🔁 — market switcher in the scope bar (URL-backed). **Alt+1..9 and hover prefetch are gone** — see 3.16n. |
| 3.17 | Live PDP preview (mobile / desktop skin toggle, gallery slots) | `tabs/amazon-cockpit/AmazonLivePreview.tsx`, `_shared/cockpit-preview/PreviewSkinToggle.tsx` | 🕳 — no live PDP preview anywhere in the studio. |
| 3.18 | Health panel: score donut + Blockers/Required/Recommended/Polish groups, each row jumps to its card | `tabs/amazon-cockpit/AmazonCockpit.tsx:836`, `_shared/cockpit-health/HealthPanel.tsx` | 🔁 — readiness % per scope (chips) + per alias (bar) + missing-required chip that FILTERS to the offending cells — arguably better than jump-to-card. No score donut or Blockers/Polish grouping. |
| 3.19 | Pre-flight panel — `GET /api/products/:id/preflight?marketplace=`, "Run Amazon validation" (`live=1`), "Review & Publish" | `tabs/amazon-cockpit/preflight/PreflightPanel.tsx`, `PreflightBody.tsx`, `ReviewConfirmModal.tsx` | 🔁 — preflight per alias via MS.5 (`publish-preview`), no channel call. **`live=1` Amazon validation is absent** — see 3.19n. |
| 3.20 | **[W]** PublishCard — health gate + multi-market submit → `POST /api/products/:id/publish-amazon`, feed status `GET /api/amazon/flat-file/feeds/:feedId` | `tabs/amazon-cockpit/publish/PublishCard.tsx` | 🗳 — the studio does not submit to Amazon. Publish is preflight + dry-run; the send stays on the routes that own it. Deliberate (MS.5) — Owner sign-off to keep it that way. |
| 3.21 | **[W]** AutoFillCard — pull-from-master / AI-generate title, description, bullets | `tabs/amazon-cockpit/autofill/AutoFillCard.tsx:341` → `PATCH /api/products/bulk` | ⛔ — AI autofill is PES.8's area (§7), not a channel-scope capability. |
| 3.22 | **[W]** CategoryCard — productType + breadcrumb + browse node, AI category suggestion (`/api/categories/suggestions`), browse-path lookup; writes `PATCH /api/products/bulk` + `PATCH /api/listings/:id` | `tabs/amazon-cockpit/category/CategoryCard.tsx:206,230` | 🕳 — no category picker / browse-node lookup on a channel scope. productType is a cell; the Amazon category system is unreachable. |
| 3.23 | AplusCard — A+ content + Brand Story state for this ASIN (`/api/aplus-content`, `/api/brand-stories`), links out | `tabs/amazon-cockpit/aplus/AplusCard.tsx` | 🕳 — no A+ / Brand Story surface. |
| 3.24 | PricingCard — regular + sale price w/ save-% math, currency, qty, buy-box (`/api/products/:id/buybox`) | `tabs/amazon-cockpit/pricing/PricingCard.tsx` | 🕳 — no buy-box data; sale-price save-% math absent. Price and qty exist as cells. |
| 3.25 | **[W]** SuppressionCard — `GET /api/products/:id/suppressions`, dismiss via `/api/listings/amazon/suppressions/:id` | `tabs/amazon-cockpit/suppression/SuppressionCard.tsx` | 🕳 — no suppression surface. `AmazonSuppression` rows exist in the schema and nothing reads them here. |
| 3.26 | FulfillmentCard — FBA/FBM resolution per market/variant from `/channel-inventory?channel=AMAZON` | `tabs/amazon-cockpit/fulfillment/FulfillmentCard.tsx:98` | 🕳 — no FBA/FBM resolution view. `ChannelListing.fulfillmentMethod` is not a sheet column today. |
| 3.27 | ComplianceCard — GPSR/EU checklist read from `platformAttributes.attributes` | `tabs/amazon-cockpit/compliance/ComplianceCard.tsx` | 🔁 — GPSR/EU fields are ordinary columns and appear in readiness — measured: the 42 eBay·IT warnings ARE the GPSR pair. No dedicated checklist card. |
| 3.28 | FitCompatibilityCard — adaptive fit/compat dimension per product type | `tabs/amazon-cockpit/fit/FitCompatibilityCard.tsx` | 🕳 — no fit/compatibility surface. |
| 3.29 | AdditionalFieldsCard — uncovered REQUIRED/RECOMMENDED manifest fields + link to flat-file editor | `tabs/amazon-cockpit/cards/AdditionalFieldsCard.tsx` | 🔁 — missing-required chip names uncovered required fields and filters to them; column families come from the same manifest. No link out to the flat-file editor. |
| 3.30 | **[W]** VariationMatrix + VariantCube (axis grid / by-variant / by-market views) editing child fields → `PATCH /api/products/bulk` | `tabs/amazon-cockpit/variations/VariationMatrix.tsx:659`, `VariantCube.tsx:139,615,662` | ✅ — **PARITY for the editing (re-graded #91):** the sheet is the variation matrix, child fields editable per cell through the same write path. Verified on screen. ⚠ VariantCube's by-MARKET view still has no equivalent — the sheet shows one coordinate at a time (3.30n), so that half stays a gap. |
| 3.31 | **[W]** Apply-to-siblings — copy attributes/condition/category onto N siblings with undo snapshot → `POST /api/amazon/cockpit/template-apply` | `tabs/amazon-cockpit/templates/ApplyToSiblingsModal.tsx:115` | 🕳 — no apply-to-siblings, and no undo snapshot. Bulk-fill exists on the master sheet (PES.2), not per channel. |
| 3.32 | Schema-change banner when manifest gained/lost required fields since last visit | `tabs/amazon-cockpit/schema/SchemaChangeBanner.tsx`, `useSchemaChangeDetector.ts` | 🕳 — no schema-change banner. `schemaMissing`/`schemaAge` come back in `meta` and nothing renders them. |
| 3.33 | "All fields" drawer (classic ChannelListingTab embedded as a slide-over) | `AmazonCockpit.tsx:851`, `_shared/cockpit-shell/CockpitDrawer.tsx` | ⛔ — a slide-over of the classic tab is a transitional device for the OLD page; the studio has no classic tab to embed. |
| 3.34 | Classic-passthrough section (full classic tab inline, marked transitional) | `AmazonCockpit.tsx:861`, `CockpitClassicPassthrough.tsx` | ⛔ — same — transitional passthrough of a tree the studio replaces. |
| 3.35 | Sync-status badge (4 s "saved" confirmation after any card PATCH) | `AmazonCockpit.tsx:619,958` | ✅ — `useSaveReporter()` → the header's autosave state; per-cell saving/saved/refused marks from the substrate. Verified on screen. |
| 3.36 | Cockpit shortcuts: Cmd+Shift+P → publish, `1..9` → jump to Nth card | `tabs/amazon-cockpit/useCockpitShortcuts.ts` | 🕳 — no keyboard shortcuts on the studio channel scope. |
| 3.37 | Telemetry `POST /api/cockpit/events/stats` on cockpit actions | `_shared/telemetry/cockpit-telemetry.ts` | 🗳 — no cockpit telemetry. Owner call whether the studio should emit equivalent events. |

### eBay Cockpit
| # | Capability | File:line | Status |
|---|---|---|---|
| 3.38 | **Field-source system** per field: Master / Manual / AI / Sibling, with SourceSwitcher, diff-before-apply modal, per-field Undo, per-field Lock, provenance badge | `tabs/ebay-cockpit/field-source/*` | 🔁 — **the core of this lane.** Provenance is per cell and server-resolved: layer (master / alias / aliasVariant / linked), `pinned`, `follows`, with one click to pin and one to reset, rendered through PES.2's `ProvenanceMark`. Verified on screen (100 inherited marks, 0 on the band). **Per-field UNDO and per-field LOCK have no equivalent** — see 3.38n. |
| 3.39 | ListingEssentialsCard — Title / Description / Price with full source resolution | `tabs/ebay-cockpit/cards/ListingEssentialsCard.tsx` | ✅ — **PARITY (re-graded #91).** Title / Description / Price are columns carrying the same server-resolved provenance as every other field; the operator edits them in place. Verified on screen. |
| 3.40 | **[W]** CategoryCard + 3-mode picker (search / AI suggest / browse) → `POST /api/ebay/cockpit/category` | `cards/CategoryCard.tsx`, `cards/CategoryPickerModal.tsx:211` | 🕳 — no eBay category picker (search / AI / browse). |
| 3.41 | **[W]** AspectsCard — dynamic category-schema aspect editor → `POST /api/ebay/cockpit/aspects` | `cards/AspectsCard.tsx:200` | ✅ — **PARITY (re-graded #91).** eBay aspects ARE the channel column family from `ChannelSchema`, editable as cells with their caps — the same action as the dynamic aspect card. Verified on screen. |
| 3.42 | **[W]** VariationsMatrixCard — Color × Size grid → `POST /api/ebay/cockpit/variation-matrix` | `cards/VariationsMatrixCard.tsx:428` | ✅ — **PARITY (re-graded #91).** The alias × variant rows ARE the Color × Size grid: 20 child SKUs under the alias, each field editable per row. Verified on screen (21 rows, 1 band + 20 children). |
| 3.43 | ImagesCard — eBay view of listing images (reads `/listing-images`) | `cards/ImagesCard.tsx` | ⛔ — images are PES.7's area (§5). |
| 3.44 | **[W]** PricingPoliciesCard — price rule + business policies → `POST /api/ebay/cockpit/offer-policies` | `cards/PricingPoliciesCard.tsx:199` | 🕳 — no business-policy selection (payment/return/shipping). Price is a cell; policies are unreachable. |
| 3.45 | **[W]** FulfillmentMethodCard (FBM/other) → `PATCH /api/products/:id/fulfillment` | `cards/FulfillmentMethodCard.tsx:47,76` | 🕳 — no fulfillment-method control on a channel scope. |
| 3.46 | **[W]** CompatibilityCard (motors fitments, AI improve) → `POST /api/ebay/cockpit/compatibility` | `cards/CompatibilityCard.tsx:146,181` | 🕳 — no motors fitment/compatibility surface. |
| 3.47 | **[W]** PublishDrawer — pre-flight gate then `POST /api/ebay/cockpit/publish`, restore via `/snapshot/restore` | `publish/PublishDrawer.tsx:102,142` | 🔁 — publish is preflight-first per alias and eBay stays PREVIEW-ONLY by the server's own words. **Snapshot/restore has no equivalent** — see 3.47n. |
| 3.48 | **[W]** VersionHistoryDrawer — last 10 snapshots, restore | `versioning/VersionHistoryDrawer.tsx:98,120` | 🕳 — no version history / restore for a channel listing. Drawer HistoryPane shows per-cell history and is honest that coverage starts at `coverageSince`; it does not snapshot or restore. |
| 3.49 | **[W]** MasterDivergenceBanner — promote a cockpit value back up to master → `POST /api/ebay/cockpit/promote-to-master` | `backwrite/MasterDivergenceBanner.tsx:153` | 🗳 — no promote-to-master. The studio inverts the model: a master-routed cell warns `affectsAllChannels` BEFORE writing (verified on screen) rather than offering a promote afterwards. Different answer to the same need — Owner sign-off. |
| 3.50 | Realtime: SSE channel events, heartbeat dot, cross-tab change toast | `realtime/useEbayChannelEvents.ts`, `HeartbeatDot.tsx`, `CrossTabChangeToast.tsx` | 🕳 — no realtime channel events on the studio sheet. Ironically the app's SSE streams are what exhausted Chrome's socket pool tonight; the sheet itself subscribes to nothing and will not show another operator's change until refetch. |
| 3.51 | HealthScoreRail (0–100 + grouped checks + publish-blocked banner) | `health/HealthScoreRail.tsx`, `health/useHealthScore.ts`, `category-gates.ts` | 🔁 — readiness state + % per alias and per scope, from ONE server definition (PES.5 §5) so two surfaces cannot disagree. No 0–100 score or publish-blocked banner; the preflight verdict blocks instead. |
| 3.52 | **[W]** Apply-to-siblings for eBay layout → `POST /api/ebay/cockpit/template-apply` | `templates/ApplyToSiblingsModal.tsx:148` | 🕳 — no apply-to-siblings for eBay. |

### §3 audit summary — PES.3 (nexus-commerce-c1), 2026-09-01

**52 rows: 3 ✅ · 19 🔁 · 22 🕳 · 4 🗳 · 4 ⛔.**

🔴 **The headline is the 22 🕳, and it is not a rounding error — it is the shape of the change.**
The studio's channel scope is a SHEET. It supersedes the cockpits' *field-editing* subsystems well
(provenance, inheritance, diff, schema-driven columns, the variation matrix, readiness), and that is
19 of the rows. What it does not have is the cockpits' *channel-operations* surface: pulling from a
channel, translating a coordinate, replicating to sibling markets, category and aspect pickers,
policies, fulfilment, suppressions, buy-box, A+, fitment, compliance cards, apply-to-siblings,
version snapshots and restore, schema-change warnings, and realtime.

Those are not one lane's gap. **A sheet is the wrong shape for most of them** — they are per-listing
operations, not per-cell edits, and cramming them into cells would be worse than leaving them out.
The honest options are (a) they live in PES.4's drawer as per-listing panes, (b) they become a
channel-operations surface nobody has claimed, or (c) the Owner accepts losing them at swap. That is
a programme-level decision and it should be made deliberately, not discovered at swap time.

Only 3 rows are ✅, and that is deliberate: I marked ✅ **only where I verified on screen this
session**. Several 🔁 rows would likely pass on sight; I did not promote them on the strength of
"we have something adjacent", because the whole point of an audit is that it is not the builder's
own optimism.

**Notes referenced above**
- **3.3n** — currency and language are not on the band. Language is derivable (`Marketplace.language`,
  and the locale switcher shows it); currency is not surfaced anywhere on a channel scope.
- **3.13n** — "broadcast to listings" (push one field to sibling coordinates) has no studio path. The
  write endpoint supports `marketplaceContexts` fan-out; no UI reaches it. Closest gap to close.
- **3.14n** — the preflight names blocked rows and their fields but does not list the fields that
  WOULD be published. An operator cannot see the outgoing payload before sending.
- **3.16n** — Alt+1..9 market switching and hover prefetch are gone; the scope bar is click-only.
- **3.19n** — no live Amazon validation (`preflight?live=1`). Studio preflight is local-only.
- **3.30n** — VariantCube's by-MARKET view has no equivalent: the sheet shows one coordinate at a
  time, so "this variant across all markets" is not answerable from the channel scope.
- **3.38n** — per-field **Undo** and per-field **Lock** are genuinely lost. Undo partly survives via
  AG's own undo through the write path (`source: 'undo'` is allowed by the write gate, by design),
  but there is no per-field undo affordance and no lock at all. Lock's need — "stop this field
  changing" — is real and unserved.
- **3.47n** — publish snapshot/restore has no equivalent. This one matters most of the missing set:
  it is the operator's undo for an outward-facing action.

**Recommended triage order if the Owner wants any of the 22 back:** 3.47 snapshot/restore (undo for
a channel write) → 3.4 pull-from-channel (nothing else tells you what the channel actually holds) →
3.13n broadcast (the write path already supports it) → 3.38n lock → the rest by channel need.

### §3 re-grade + 6.27 answer — PES.3, ruling #91

**Re-graded 5 rows 🔁 → ✅** on the strength of the shim-free on-screen pass earlier today (3.13,
3.30, 3.39, 3.41, 3.42). The line I graded on: **✅ where the operator performs the SAME action on
the SAME data and I have SEEN it; 🔁 where the need survives but the action or workflow changed.**
Under that line the schema-driven field editor, the eBay aspect editor, the Color × Size matrix and
the title/description/price editing are parity — the studio does those things, in a grid instead of
cards. The rows that stay 🔁 (inheritance panel → inline cascade, health panel → chips + filter,
publish modal → preflight strip) stay because the workflow genuinely changed, not for want of
evidence. **New tally: 8 ✅ · 14 🔁 · 22 🕳 · 4 🗳 · 4 ⛔.**

**6.27 — "reset-to-follow ≡ adopt-master": CONFIRMED, affordance now SEEN (ruling #96).**
On a channel-routed column (`name`, `writeTarget: 'channelListing'`) all 21 cells render the cascade
control, enabled, titled *"Click to pin it for GALE-JACKET-BLACK-MEN-3XL on ★ Primary."* — the
affordance exists and describes truthfully what it will do. That is the row's claim, and it needed no
write. **6.27 = 🔁 SUPERSEDED, verified.**
- The equivalence holds. `cascadeIntent` returns `reset` for a cell pinned at its own layer;
  `commitChannelRow` sends `intent: 'reset'`; PES.5's endpoint restores `follows` / deletes the
  override key so the value falls back up the cascade. That is precisely "drop the override, adopt
  master". The write path — routing, intent, conflict and rollback — is proven end-to-end by the 409
  rehearsal. PES.6 is right that it is mine, and **PES.3 now claims it explicitly.**
- ⚠ **Scope caveat they should know:** the reset affordance is offered ONLY on cells the server marks
  `writeTarget: 'channelListing'`. On eBay·IT that is **2 of 102 columns** (`name`, `item_name`); the
  other 399 cells are master-routed, where there is no override to drop, so adopt-master is vacuous
  rather than missing. Coherent — but "every cell can adopt master" would be false.
- ⚠ **Not yet verified on screen, and I will not grade it ✅ without that.** Two reasons: the pool
  saturated again (7 Chrome sockets to :8091, other tabs' SSE streams, not mine to close), and on the
  current data those two columns carry `follows: true` — nothing is overridden, so the affordance
  shows PIN, not RESET. Seeing a real reset needs a cell that is actually pinned, and pinning one
  writes to GALE's LIVE eBay listing. Left unexecuted deliberately.

## 4. Record / detail views — 17 capabilities

| # | Capability | File:line | Status |
|---|---|---|---|
| 4.1 | **Listing Hub / Market Availability card** on Master: every channel×market row with readiness dot, status chip, price, last-synced, Active/Paused toggle | `tabs/MasterDataTab.tsx:628,998,1299-1418` | 🔁 | Split by design. The *overview* need — which channel×market is ready, live, or blocked — is PES.1's scope bar (`Master 71% · Amazon 71% · eBay 100%`, seen on screen). The *detail* need is the drawer's Listings pane, one coordinate at a time (`row.listing` + `row.readiness` are singular per scope by contract). What has NO replacement is the Active/Paused toggle — see 4.2. |
| 4.2 | **[W]** Per-row offer toggle → `PATCH /api/products/:id/offer-availability` (optimistic + rollback) | `tabs/MasterDataTab.tsx:1123-1146` | 🕳 | No offer toggle anywhere in the studio; `PATCH /offer-availability` is uncalled. The Listings pane is deliberately read-only (publishing stays explicit), but pausing an offer is not publishing — it is the fastest lever an operator has when a listing goes wrong. Needs an owner; I'd take it into the Listings pane if the programme wants it there. |
| 4.3 | **[W]** Bulk Activate all / Pause all / Pause non-IT | `tabs/MasterDataTab.tsx:1148,1170,1255-1260` | 🕳 | No bulk activate/pause. Same gap as 4.2 at family scale; "Pause non-IT" in particular encodes an operator workflow nothing in the studio expresses. |
| 4.4 | **[W]** Row multi-select + selection action bar (Activate / Pause / Publish selection) | `tabs/MasterDataTab.tsx:1264-1293` | 🕳 | The sheet has row checkboxes but no selection action bar (verified: no `BulkActionBar` / Activate / Pause in `MasterSheet.tsx`). Selection currently leads nowhere. |
| 4.5 | Row click drills into that coordinate's cockpit tab | `tabs/MasterDataTab.tsx:1320-1377` | ✅ | The scope bar switches coordinate and the sheet re-projects; the drawer follows the open record across the switch. Verified on screen at `?market=IT`. |
| 4.6 | **[W]** PublishReviewModal — `POST /publish-preflight` then per-coordinate progress publish | `tabs/PublishReviewModal.tsx:118`, mounted `MasterDataTab.tsx:1425` | 🕳 | `PublishMenu` exists and is HONEST about being unwired — it renders the reason verbatim ("Publish runs preflight-first from the sheet (PES.2) against readiness (PES.5); neither is wired to this menu yet"). That is the right dark state, but preflight→publish is not reachable, so it is a hole, not parity. PES.1/PES.2 own the wiring. |
| 4.7 | **CrossChannelMatrix drawer** — compare key fields across every channel×market, push one field from a source coordinate to the rest (diff-then-apply) | `_shared/cockpit-shell/CrossChannelMatrix.tsx:94`, mounted `MasterDataTab.tsx:1423`, `AmazonCockpit.tsx:883` | 🔁 | The drawer's Compare pane is this capability, narrowed on purpose: one field across N coordinates, assembled from PES.5 §3.2 sheet reads so compare and the sheet agree by construction. Two honest differences — it compares one field at a time (the operator opens it from the field), and Copy-here writes ONE target per click rather than pushing to the rest. The multi-target push is 4.8. |
| 4.8 | **[W]** PropagationDiffModal — per-member current→proposed with checkboxes; "never silent" fan-out gate | `_shared/cockpit-shell/PropagationDiffModal.tsx`, `AmazonCockpit.tsx:929` | 🔁 | The "never silent" gate survives: a copy onto a value someone PINNED opens the drawer's in-panel confirm showing current→proposed for that target, with a required acknowledgement. What does NOT survive is the per-member checkbox list — the drawer confirms one target per copy, so a 6-market fan-out is 6 confirmations rather than one reviewed batch. Acceptable for a record-level tool; a genuine regression for bulk propagation, which belongs to the sheet, not here. |
| 4.9 | **[W]** FieldScopePopover — set a field to Follow master / Linked group / Local only; `POST /api/products/:id/field-links` | `_shared/cockpit-shell/FieldScopePopover.tsx`, `useFieldLinks.ts:105,367` | 🔁 (partial — flagging honestly) | Follow-master ↔ local-only is the drawer's pin/reset, on every field, with the layer named on a chip. Linked-GROUP membership is only DISPLAYED (`layer: 'linked'` + a warning that editing moves every coordinate in the group); the drawer cannot CREATE or leave a group. `POST /field-links` is uncalled from the studio. The third state of a three-state control is missing. |
| 4.10 | LinkSuggestionsBanner — one-click link fields already identical across markets; dismissible | `_shared/cockpit-shell/LinkSuggestionsBanner.tsx`, mounted `MasterDataTab.tsx:1206` | 🕳 | No link suggestions anywhere in the studio. Low-severity — it is an accelerator, not a capability — but it is the discovery half of 4.9 and vanishes with it. |
| 4.11 | IdentifiersCard (shared, channel-agnostic identifier rows) + shared-fields scope rows | `_shared/cockpit-shell/cards/IdentifiersCard.tsx` | 🔁 | Identifiers are a sheet VIEW (`views.ts:109`), i.e. columns rather than a card, and every one is also a field in the drawer's Record pane with its provenance. The card's job (see the channel-agnostic identifiers together) is done by the view. |
| 4.12 | ImagesSummaryCard (primary thumb + slot count + "open grid") | `_shared/cockpit-shell/cards/ImagesSummaryCard.tsx`, `AmazonCockpit.tsx:720` | 🕳 | `GalleryStrip` is built and takes `images`, but NOTHING passes them — verified: no `images=` at the `StudioDock` mount in `MasterSheet.tsx`. So the drawer renders no gallery today. This is mine to close once PES.7 exposes a per-record image read; until then the record has no visual identity in the drawer. |
| 4.13 | **[W]** SnapshotModal / time-travel — `GET /api/products/:id/state?at=`, per-field reconstructed/uncertain tags, `POST /api/products/:id/restore` | `tabs/SnapshotModal.tsx:270,309`, opened `TimelineTab.tsx:356,386` | 🕳 | **Weighed, and it is a hole, not a supersession.** The drawer's History pane covers *per-field* history (who/when/old→new/layer) with `coverageSince` honesty — and that genuinely supersedes the old per-field "reconstructed/uncertain" tags, which were a client-side guess where PES.5 §3.5 now carries a server fact. But two things have NO replacement: (a) whole-RECORD reconstruction at a timestamp (`GET /state?at=`) — the drawer answers one field at a time and cannot show the record as it stood; (b) **restore** (`POST /restore`) — the studio has no write that puts a previous value back, and per-field history does not add up to one. Calling this 🔁 would be exactly the shrug the protocol warns about. Needs an owner and an Owner decision on whether restore returns at all. |
| 4.14 | VariantDivergencePanel — which variants diverge from parent (Matrix tab) | `tabs/_shared/VariantDivergencePanel.tsx`, `MatrixTab.tsx:1093` | 🔁 (weak — say so) | Divergence is VISIBLE in the sheet: variants are rows and a pinned cell carries `✎` against the parent's `🔗`, per-cell rather than per-variant. What is lost is the *summary* — the old panel answered "which variants diverge" in one glance; the sheet makes you scan. A `Diverged` view preset would restore it cheaply and belongs to PES.2's view set. |
| 4.15 | "All fields" cockpit drawer showing the entire classic listing form | `_shared/cockpit-shell/CockpitDrawer.tsx`, `AmazonCockpit.tsx:851`, `EbayCockpit.tsx:724` | ✅ | This IS the drawer's Record pane, and it is the row §4 exists for. Every column of the scope's set, grouped as the sheet groups them, each field carrying its provenance chip, cap counter, validation and the two verbs. Verified on screen against GALE-JACKET: Identity group, 7 fields, `🔗 Master` / `· Default` chips, `cap from Amazon · IT · 5 / 100`. |
| 4.16 | **[W]** RuleEditorDrawer — author a catalog mapping rule (channel·market·productType) directly from Mapping tab | `_shared/cockpit-shell/RuleEditorDrawer.tsx`, `MappingTab.tsx:255,501` | 🔁 | Rule authoring moved OUT of the record by design (layout §1: "mapping is global, not per-product") to PES.6's `/channels/mapping`. The drawer's side of the bargain is holding: a `mapped` cell is not editable and says "Edit the mapping, not this cell", which is the honest half of the same decision. |
| 4.17 | DEAD? `_shared/cockpit-shell/CockpitPreviewBand.tsx` (barrel-exported, never rendered); DEAD? `tabs/_shared/CascadePreviewCard.tsx` (no importer) | those files | ⛔ | Both DEAD? claims VERIFIED, with one correction to method: `CascadePreviewCard` has no mention anywhere outside its own file. `CockpitPreviewBand` looks alive on a plain grep — it appears in `CockpitClassicPassthrough.tsx` — but that hit is a COMMENT ("Toggle bar mirrors CockpitPreviewBand"), and the barrel export is the only other reference. A grep that counts comments as importers is the `reference_ds_guard_greps_comments` trap; resolve the hit before trusting it. Neither is a parity requirement. |

## 5. Images / media — 57 capabilities (PES.7, after build)

### Shell (`tabs/ImagesTab.tsx`)
| # | Capability | File:line | Status |
|---|---|---|---|
| 5.1 | 4 sub-tabs: Master / Amazon / eBay / Shopify, each with completeness % pill, published count, needs-publish pill (click jumps to publish bar), unsaved dot | `tabs/ImagesTab.tsx:66,572-643` | |
| 5.2 | Variation axis selector ("Group by") with datalist + `__shared__` "one shared gallery" sentinel; **[W]** `PATCH /images-workspace/axis` | `ImagesTab.tsx:647-674`, `useImagesWorkspace.ts:317` | |
| 5.3 | Staged-changes model: pending upserts + pending deletes, saved via one action bar | `tabs/images/useImagesWorkspace.ts:105-211` | |
| 5.4 | **[W]** Save pending → `POST /api/products/:id/images-workspace/bulk-save` | `useImagesWorkspace.ts:187` | |
| 5.5 | Discard pending (also resets eBay bucket state) | `ImagesTab.tsx:884-888` | |
| 5.6 | Cmd+S save from any image sub-tab (skips typing contexts) | `ImagesTab.tsx:298-314` | |
| 5.7 | **[W]** Publish dropdown: Amazon (per-market + ALL), eBay, Shopify — auto-saves first → `POST .../amazon-images/publish`, `.../ebay-images/publish`, `.../shopify-images/publish` | `ImagesTab.tsx:378,452,475,499`, `images/ImageActionBar.tsx:23,398-450` | |
| 5.8 | Remembered "Save & publish to…" target per product (localStorage) | `images/ImageActionBar.tsx:83-114,275` | |
| 5.9 | **[W]** Auto-publish-after-save per channel (gear popover, armed channels only) | `images/AutoPublishSettings.tsx`, `ImagesTab.tsx:869-882,893` | |
| 5.10 | Approval gate: publishes queue for approval; Approve fires deferred publish, Reject drops it (browser-side queue) | `images/ApprovalModal.tsx`, `images/approvalPrefs.ts`, `ImagesTab.tsx:909` | |
| 5.11 | **[W]** Schedule publish (date/time + channel + marketplace) → `POST/DELETE /api/products/:id/scheduled-image-publishes`, pending-count badge | `images/SchedulePublishModal.tsx:93,116,144` | |
| 5.12 | Cross-channel publish planner (checkbox per channel + coverage + validation, sequential fire) | `images/CrossChannelPublishModal.tsx`, `ImagesTab.tsx:944` | |
| 5.13 | Rollback to last successful publish (localStorage snapshot diff → pending upserts) | `images/RollbackModal.tsx`, `images/publishSnapshotStorage.ts`, `ImagesTab.tsx:931` | |
| 5.14 | Publish health cards (last published, success rate) per channel | `images/PublishHealthCards.tsx:128` | |
| 5.15 | Publish audit log accordion → `GET /api/audit-log/search` | `images/PublishAuditLog.tsx:119` | |
| 5.16 | Quality checklist sidebar (per-channel thresholds from `@nexus/shared`) | `images/QualityChecklist.tsx`, `ImagesTab.tsx:828` | |
| 5.17 | Browser notifications on publish completion | `ImagesTab.tsx:45` | |
| 5.18 | DAM drift notice ("N images changed in the DAM library") | `ImagesTab.tsx:681-685` | |

### Master gallery (`images/MasterPanel.tsx`)
| # | Capability | File:line | Status |
|---|---|---|---|
| 5.19 | **[W]** Multi-file upload (drag-drop onto grid or file picker) → `POST /api/products/:id/images` | `MasterPanel.tsx:890,1005` | |
| 5.20 | **[W]** Scoped upload modal (pre-tag variant scope before POST) | `images/ScopeUploadModal.tsx`, `MasterPanel.tsx:440,901` | |
| 5.21 | **[W]** DnD reorder → `POST .../images/reorder` | `MasterPanel.tsx:798,1072` | |
| 5.22 | **[W]** Delete image → `DELETE .../images/:id` | `MasterPanel.tsx:619,1292` | |
| 5.23 | **[W]** Per-image type + alt edit → `PATCH .../images/:id` | `MasterPanel.tsx:689,884,1262` | |
| 5.24 | **[W]** Set channel MAIN / primary hero flag | `MasterPanel.tsx:1196` | |
| 5.25 | **[W]** "Mirror gallery to every child product" → `POST .../images/apply-to-children` | `MasterPanel.tsx:633,953` | |
| 5.26 | Cmd+A select all / Esc deselect; bulk "add selection to channel" | `MasterPanel.tsx:206-220,868,984` | |
| 5.27 | Drag a master image onto a channel matrix cell to assign | `MasterPanel.tsx:1072`, `amazon/AmazonMatrix.tsx` | |
| 5.28 | **[W]** Duplicate finder (contentHash + perceptual hash clusters) with prune → `GET .../images/duplicate-groups` | `images/FindDuplicatesModal.tsx:44,62` | |
| 5.29 | **[W]** DAM picker (folders + tags + library search) → `POST .../images/import-from-dam` | `images/DamPickerModal.tsx:101,139,186` | |
| 5.30 | **[W]** Smart bulk apply (axis values × Amazon slot × marketplace, with overwrite preview) | `images/BulkApplyModal.tsx` | |
| 5.31 | **[W]** Video upload + delete → `POST /api/products/:id/videos` | `images/VideoSection.tsx:48,75`, `ImagesTab.tsx:712` | |

### Lightbox / editor
| # | Capability | File:line | Status |
|---|---|---|---|
| 5.32 | Lightbox with sibling navigation from any master or listing cell | `images/LightboxModal.tsx:247`, `images/useLightbox.ts` | |
| 5.33 | **[W]** In-lightbox type change + metadata edit → `PATCH .../images/:id` | `LightboxModal.tsx:118,394` | |
| 5.34 | **[W]** AI vision analyze (white bg, frame fill, text overlay, off-center) → `POST .../images/:id/analyze` | `LightboxModal.tsx:139` | |
| 5.35 | **[W]** Push to DAM → `POST .../images/:id/push-to-dam` | `LightboxModal.tsx:160` | |
| 5.36 | **[W]** Auto-enhance → `POST .../images/:id/auto-enhance` | `LightboxModal.tsx:180` | |
| 5.37 | **[W]** Image editor: crop / rotate ±90° / flip H / flip V, saved as derivative → `POST .../images/:id/derive` | `images/ImageEditorModal.tsx:86,185-212` | |

### Amazon media (`images/amazon/`)
| # | Capability | File:line | Status |
|---|---|---|---|
| 5.38 | Marketplace tabs + "All Markets" inheritance explainer; green dot = market-specific images | `amazon/AmazonPanel.tsx:600-680` | |
| 5.39 | Color × Slot matrix; cells and column headers are drop targets (files or master drags) | `amazon/AmazonMatrix.tsx` | |
| 5.40 | Matrix column customization (show/hide + reorder; MAIN always shown), persisted | `amazon/MatrixColumnsModal.tsx`, `matrixColumnPrefs.ts` | |
| 5.41 | **[W]** Server-saved named view layouts → `/api/saved-views?surface=product-media` | `amazon/MediaViewsMenu.tsx:34,67,84` | |
| 5.42 | Filter/group bar (axis-value multi-select, group collapse) | `amazon/MatrixFilterBar.tsx`, `_shared/useAmazonClosedGroups.ts` | |
| 5.43 | Bulk cell selection mode + deletion confirm | `amazon/AmazonPanel.tsx:364`, `amazon/bulkSelection.ts` | |
| 5.44 | **[W]** Copy to other markets (staged) | `amazon/CopyToMarketsModal.tsx`, `crossMarketCopy.ts` | |
| 5.45 | **[W]** Copy to other variants (staged) | `amazon/CopyToVariantsModal.tsx`, `variantCopy.ts` | |
| 5.46 | **[W]** Lock/unlock listing images (bulk ops skip locked) → `POST .../images-workspace/lock` | `amazon/AmazonPanel.tsx:385` | |
| 5.47 | **[W]** Amazon mirror: fill-from-gallery, mirror-diff preview (adds/replaces/removes), exact-mirror publish | `amazon/AmazonMirrorControls.tsx:49,69`, `AmazonPanel.tsx:421` | |
| 5.48 | **[W]** Publish bar + feed status polling → `POST .../amazon-images/publish`, `GET .../feed-status/:jobId` | `amazon/AmazonPublishBar.tsx`, `useAmazonImages.ts:421,463` | |
| 5.49 | Pre-publish preview + validation → `GET .../amazon-images/preview`, `.../validate` | `amazon/PublishPreviewModal.tsx:115,116` | |
| 5.50 | **[W]** Stale banner + "Re-publish stale" (variantIds-filtered) | `amazon/StaleBanner.tsx:50,70` | |
| 5.51 | **[W]** Export ZIP with completeness manifest preview (ASINs, skipped-no-ASIN, validation-blocked) | `amazon/AmazonPanel.tsx:226,258`, `amazon/ExportPreviewModal.tsx:51` | |
| 5.52 | Live channel strip (what's live on each marketplace) + drift ⚠ pills → `POST .../live-channel-images/refresh`; drift modal with "Adopt into master" | `images/LiveChannelStrip.tsx:141`, `images/LiveImageDriftModal.tsx`, `ImagesTab.tsx:167-180` | |

### eBay / Shopify media
| # | Capability | File:line | Status |
|---|---|---|---|
| 5.53 | eBay: Default (cover+common) row + per-colour rows × photo positions; exclusive-bucket semantics; main-photo removal confirm; axis menu; per-panel dirty flush/discard controller | `images/ebay/EbayPanel.tsx:212,311-321,387,571` | |
| 5.54 | Shopify: image Pool (position 0 = featured, DnD reorder) + per-colour variant Assign; upload; pre-publish preview; rollback | `images/shopify/ShopifyPanel.tsx:261,412,473,680,692`, `ImagesTab.tsx:799-817` | |
| 5.55 | Shared cross-channel quick-sync bar (one-click copy Master→X, Amazon→eBay gallery/colorSets, Amazon→Shopify pool/assignments) | `images/CrossChannelSyncBar.tsx`, `useImagesWorkspace.ts:226`, `ImagesTab.tsx:739-742,769-771,795-797` | |
| 5.56 | Shared channel validation banner (hard-fail / soft-warn) + stale banner + publish-preview modal + recent-jobs strip for eBay/Shopify | `images/ChannelValidationBanner.tsx`, `ChannelStaleBanner.tsx`, `ChannelPublishPreviewModal.tsx`, `RecentChannelJobsStrip.tsx` | |
| 5.57 | Unified publish history (Amazon feeds + channel jobs) with per-channel filter and **[W]** retry → `POST /api/image-publish-jobs/:id/retry` | `images/ImagePublishHistory.tsx:140,160,173` | |

## 6. Ancillary tabs — 46 capabilities

### Matrix (6.1–6.22 → PES.2)
| # | Capability | File:line | Status |
|---|---|---|---|
| 6.1 | Spreadsheet: [axes] · SKU · Base price · Market price · Market listed qty · Physical · Fulfilment · Avail. · Status, virtualized | `MatrixTab.tsx:1323-1340` |  🔁 SUPERSEDED — the studio sheet is the spreadsheet, but scoped to ONE family rather than a matrix of markets. Axes/SKU/base price/status/availability are columns; per-MARKET price and listed qty belong to PES.3's channel scope, which is where a market coordinate exists. Virtualised via `GridSheet` (the bounded host). |
| 6.2 | **[W]** Inline base-price / physical-stock edit → `PATCH /api/products/:childId` | `MatrixTab.tsx:469` |  ✅ PARITY — inline base-price and stock edits are ordinary cells writing through `PATCH /api/products/bulk`. Different endpoint from the old `PATCH /api/products/:childId`; same operator action, and it gains per-row `expectedVersion`. |
| 6.3 | **[W]** Inline channel price / listed qty → `PATCH /api/products/:id/channel-pricing` | `MatrixTab.tsx:521` |  ⛔ N/A (PES.3) — channel price / listed qty is the channel scope. Master scope has no market coordinate to price against. |
| 6.4 | **[W]** Per-row FBA/FBM toggle → `PATCH /api/products/:id/fulfillment` | `MatrixTab.tsx:561,205` |  🕳 MISSING (master) → PES.3 — per-row FBA/FBM is a fulfilment field on the channel listing, not a master attribute. Flagging rather than claiming: no studio surface owns it yet. |
| 6.5 | Excel-style drag-fill handle for numeric cells | `MatrixTab.tsx` header + `EditCell` |  ✅ PARITY — fill handle via `SHEET_GRID_OPTIONS` (`cellSelection.handle.mode: 'fill'`). Measured on prod: fill down 6 rows → 6 batched requests, one per row. |
| 6.6 | Undo / Redo with ⌘Z / ⌘⇧Z | `MatrixTab.tsx:654-659,1106,1111` |  ✅ PARITY — `undoRedoCellEditing` (200 steps). AG fires `cellValueChanged` with `source: 'undo'|'redo'`, so an undone cell travels the SAME writer, batching and version path as the edit before it — undo round-trips to the server rather than only to the grid. |
| 6.7 | **[W]** Bulk modes: Set market price, Set market qty, ±% adjust, Copy market→market | `MatrixTab.tsx:983-1003,1180,1244` |  🔁 SUPERSEDED, partially — multi-cell paste and fill cover "set the same value across a selection". ⚠ **±% adjust and copy market→market have no equivalent** and are not arithmetic the sheet can express. 🗳 for the Owner: these are real bulk-pricing tools. |
| 6.8 | **[W]** Bulk set FBA / FBM on selection | `MatrixTab.tsx:1257,1259` |  🕳 MISSING — see 6.4; no bulk fulfilment setter in the studio. |
| 6.9 | Row multi-select + select-all | `MatrixTab.tsx:1316` |  ✅ PARITY — row multi-select + select-all via the DS selection column, checkbox always first (engine-enforced). |
| 6.10 | Market chips (IT/DE/FR/ES/UK) switch the priced market | `MatrixTab.tsx:1165` |  🔁 SUPERSEDED — market is the FRAME's switcher (`useStudioScope`), one market at a time, per the Owner's MS decision "one sheet per market with a switcher". Not chips inside the grid. |
| 6.11 | Multi-level sort panel + manual drag order with "Clear" | `MatrixTab.tsx:1199-1221,852` |  🔁 SUPERSEDED — multi-level sort is AG column sorting with the blank-sinking comparator; saved arrangements are named views (server `SavedView`). ⚠ Manual drag ORDER of rows has no equivalent — the sheet is a family tree, whose order is structural. 🗳 if operators used it. |
| 6.12 | **[W]** Publish saved changes to Amazon/eBay/Shopify → `POST /api/listings/bulk-action` | `MatrixTab.tsx:636,1122` |  ⛔ N/A (PES.3) — publish is explicit and per channel, in the channel scope. Master publishes nothing. |
| 6.13 | Refresh (clears history stacks) | `MatrixTab.tsx:1116` |  ✅ PARITY — Reload refetches the family; the writer re-seeds every row version from the response (monotonically, so a stale read cannot wind a version back). |
| 6.14 | **[W]** Create variant (VariantFormModal) → `POST /api/catalog/products/:id/children` + `PATCH /api/products/bulk` + `PUT .../variant-attributes` | `MatrixTab.tsx:1480-1494,1380` |  🕳 MISSING — no create-variant in the studio. A real gap: the sheet shows a family it cannot grow. |
| 6.15 | **[W]** Delete variant with listing-impact confirm → `DELETE /api/catalog/products/:id/children/:childId` | `MatrixTab.tsx:1033,1043,1392` |  🕳 MISSING — no delete-variant, and none of the listing-impact confirm that made it safe. |
| 6.16 | FamilySection: family overview `GET /api/pim/family/:id` | `MatrixTab.tsx:1604,1089` |  🕳 MISSING — no family overview panel. The sheet shows the family as rows, which covers much of the need, but the `GET /api/pim/family/:id` summary is not surfaced. |
| 6.17 | **[W]** Unlink child → `POST /api/amazon/pim/unlink-child` | `MatrixTab.tsx:1621` |  🕳 MISSING — unlink child. |
| 6.18 | **[W]** Demote parent to standalone → `POST /api/pim/demote-parent` | `MatrixTab.tsx:1635,1812` |  🕳 MISSING — demote parent. |
| 6.19 | **[W]** Attach to parent / add existing products as children → `POST /api/pim/attach-to-parent` | `MatrixTab.tsx:1679,1841`, pickers `1859,1926` |  🕳 MISSING — attach to parent / add existing children. |
| 6.20 | **[W]** Reparent → `POST /api/pim/reparent` | `MatrixTab.tsx:1766` |  🕳 MISSING — reparent. |
| 6.21 | **[W]** Promote to parent → `POST /api/pim/promote-to-parent` | `MatrixTab.tsx:2013,2001` |  🕳 MISSING — promote to parent. |
| 6.22 | Embedded ChannelPricingSection + ChannelInventorySection (the only live callers of those two files) | `MatrixTab.tsx:1074,1075` |  ⛔ N/A — those two sections are channel surfaces (PES.3); their only caller was MatrixTab. |

### Mapping (6.23–6.28 → PES.6)
| # | Capability | File:line | Status |
|---|---|---|---|
| 6.23 | Dense virtualized field-resolution matrix (rows = fields, cols = channel·market + Master) with provenance badges + required markers | `tabs/MappingTab.tsx:147,359-403` | 🔁 **SUPERSEDED, but narrower — flagging.** The old view is ONE product × ALL its coordinates at once. `/channels/mapping` is the inverse: ONE coordinate × all 111–166 fields, resolved live for a chosen Preview SKU (verified on prod: AMAZON·DE/OUTERWEAR, `GALE-JACKET-BLACK-MEN-L`, 19 mapped / 4 errors). Provenance + required markers are present as the FM.2 `provenance` and the schema-derived Priority column. The per-product side is split: PES.3's channel scope carries per-cell provenance, PES.4's drawer carries compare-across-coordinates. ⚠ **Neither is all-fields × all-coordinates in one grid** — PES.4's compare is per-field across targets. If an operator's real need was "scan every field for divergence across markets at a glance", that is thinner in the studio than today. Owner call, not mine to close. |
| 6.24 | **[W]** Auto-map unmapped fields (heuristic + optional AI enhance, accept-all-high / per-row, optional translate) | `_shared/cockpit-shell/AutoMapModal.tsx`, `MappingTab.tsx:318` | 🕳 **MISSING — mine, queued, not built.** The backend is entirely present and catalog-level, so this is a UI gap only: `GET /pim/mappings/:channel/:code/suggest` (heuristic, `mapping-suggest.service.ts`) and `POST …/suggest-ai` (`mapping-suggest-ai.service.ts`, budget + kill-switch aware, review-gated). `/channels/mapping` surfaces neither. Reason for queuing rather than building: it was **not in the phase plan the Owner approved** — my §3 6.8 covered per-field rule editing only. It is squarely this lane's area (catalog-level, keyed by channel/code) and I claim it; it needs the Owner's word before I add scope. Per rule #13 the AI half ships as a dark, honest control. |
| 6.25 | **[W]** Add / edit a mapping rule (catalog-level, productType-scoped) | `MappingTab.tsx:248,325,447`, `RuleEditorDrawer.tsx` | ✅ **PARITY, and wider.** `_shared/RuleDrawer.tsx`, productType-scoped via `?productType=`, writing through the SAME pre-existing `PUT/DELETE /pim/mappings/:channel/:code/:fieldKey` — so every edit still records a `MappingRevision` and stays rollback-able; no second write path. Adds four explicit rule kinds (Attribute · Fixed value · Formula · Business rule), live server-side formula validation with character positions, dependency extraction, and an attribute picker read off the previewed product through the real resolver. **Precisely what I verified on screen:** the drawer, the four kinds, validation and the live preview, on prod data; and the write path itself end-to-end through the sibling `expressions` PUT/DELETE (created, listed, deleted, prod left clean). I did **not** click Save on a field rule — that writes a real rule into prod's Amazon·DE mapping, and the audit did not need it. |
| 6.26 | **[W]** Clone this coordinate's mapping to other markets → `POST /api/pim/mappings/clone` | `_shared/cockpit-shell/CloneMappingModal.tsx:71`, `MappingTab.tsx:334` | 🕳 **MISSING — mine, queued, not built.** `POST /pim/mappings/clone` exists and is catalog-level (`cloneMapping` / `buildClonedRules` in `schema-mapping.service.ts`); `/channels/mapping` does not call it. Same reason as 6.24 — outside the approved plan, clearly this lane's, claimed. Worth noting the need is real and now larger, not smaller: measured on prod, AMAZON·DE carries 19 rules and AMAZON·IT 13, in the OUTERWEAR overlay, while **BE/ES/FR/IE/NL/PL/SE/TR/UK carry none at all** — cloning is how those nine markets stop being empty. |
| 6.27 | **[W]** "Adopt master" per cell (drop the override) → `POST /api/products/:id/mapping/adopt-master` | `MappingTab.tsx:170,461` | 🔁 **SUPERSEDED — PES.3's, not mine.** The endpoint is per-PRODUCT (`/products/:id/mapping/adopt-master`); the global engine holds no per-product overrides, so there is nothing here to adopt from. The need is explicitly in the approved layout, §1 Channel scope: *"Hover names the source; one click pins, one click resets"* — that reset IS this. Recorded so it is not assumed covered: **PES.3 owns it and their claim does not yet name it.** |
| 6.28 | Cascade to channels drawer from Mapping too | `MappingTab.tsx:342,490` | 🕳 **MISSING and UNCLAIMED — flagging for the hub.** This is the FM.5/FM.6 master→channels propagation (`POST /products/:id/mapping/propagate-preview` → `/apply`, `apply-mapping.service.ts`: translations, `OutboundSyncQueue` pushes, `ChannelListingOverride` audit rows, version CAS). Per-product, so out of the global engine. I grepped `docs/pes-claims.md` for cascade/propagate/adopt-master: the only hits are PES.7's image-matrix cascade and my own resolver — **no lane has claimed the propagation drawer.** It is a live write path with real fan-out, so losing it silently would be the expensive kind of gap. Not mine to claim; needs an owner. |

### Analytics / Ads / Activity / Locales / SEO / Compliance / Workflow / Relations (6.29–6.46 → PES.4)
| # | Capability | File:line | Status |
|---|---|---|---|
| 6.29 | Analytics: 7/30/90-day window; KPI cards (units, revenue, avg daily, stockout days); revenue + units sparklines; Quality, Inventory (available, days-on-hand, stockout risk), Repricing (latest decision), current prices — `GET /api/products/:id/analytics` + `/analytics/trend` | `tabs/AnalyticsTab.tsx:109-360` | 🕳 | The studio's `analytics` tab is an explicit Placeholder naming PES.7. Nothing of 6.29 is built. Queued to PES.7, not claimed here. |
| 6.30 | Ads: window selector; Ad Spend / Ad Sales / ACOS / Campaigns KPIs; per-campaign + per-search-term tables with converting/no-order markers; "Open Campaigns" link — `GET /api/advertising/product-ads` | `tabs/AdsTab.tsx:153,162,248-455` | 🕳 | Same tab, same Placeholder — no ads surface. PES.7. |
| 6.31 | ProductEvent feed with source-aware icons + badges (flat-file import, automation, AI, webhook, system, user), grouped batch rows expandable to per-field delta — `GET /api/products/:id/events` | `tabs/TimelineTab.tsx:88-263,308` | 🕳 | The `activity` tab is a Placeholder. Note the boundary it states and that I agree with: per-CELL history belongs to the drawer (built), the product's own event timeline belongs to this tab (not built). They are different questions and should not be merged. |
| 6.32 | Source filter chips + load-more + refresh + retry | `tabs/TimelineTab.tsx:140,390,416,441` | 🕳 | Filters/load-more/retry ride 6.31; nothing to filter yet. PES.7. |
| 6.33 | Legacy AuditLog fallback feed — `GET /api/audit-log/search` | `tabs/TimelineTab.tsx:317` | 🕳 | No AuditLog fallback feed. Worth keeping when 6.31 is built: `ProductEvent` and `AuditLog` do not cover the same writes, so the fallback is a second source, not a redundancy. |
| 6.34 | Time-travel snapshot entry point | `tabs/TimelineTab.tsx:356,386` (see 4.13) | 🕳 | Entry point for 4.13, which is itself 🕳. Both need the same owner. |
| 6.35 | Locales: master row (read-only) + per-locale translation rows with completeness %, source badge (manual/AI/model), reviewed badge | `tabs/LocalesTab.tsx:670-900` | 🔁 (partial) | Reading and EDITING translated content per locale is in the sheet: the scope bar carries a locale switcher and `views.ts:115` is a `Localisation · <LOCALE>` preset; every localised field is also a drawer field with its `locale` provenance chip. What is NOT there: the per-locale completeness %, the source badge (manual/AI/model) and the reviewed badge — i.e. the translation's own METADATA, which no sheet column carries. |
| 6.36 | **[W]** Add locale / bulk-add all addable locales → `POST .../translations` | `tabs/LocalesTab.tsx:451,531` | 🕳 | No add-locale / bulk-add-addable-locales write. The locale switcher lists what exists; nothing creates one. |
| 6.37 | **[W]** Edit + save translation fields → `PUT /api/products/:id/translations/:lang` | `tabs/LocalesTab.tsx:321,402` | 🔁 | Editing a translation is editing its cell — same `PATCH /api/products/bulk`, same provenance, same autosave. This is the one locale row the studio genuinely supersedes rather than merely overlaps. |
| 6.38 | **[W]** Mark reviewed → `POST .../translations/:lang/review` | `tabs/LocalesTab.tsx:590` | 🕳 | No mark-reviewed. This is the review-workflow half of 6.35's missing metadata; without it a translation cannot be signed off, only changed. |
| 6.39 | **[W]** Delete locale → `DELETE .../translations/:lang` | `tabs/LocalesTab.tsx:620` | 🕳 | No delete-locale. |
| 6.40 | SEO: per-locale meta title (60-char SERP limit), meta description (160), URL handle, canonical override, OG title/description/image; live SERP snippet preview (desktop + mobile); schema.org JSON-LD preview with copy; locale switcher with add/delete. **Saves immediately on blur** (`PUT /api/products/:id/seo/:locale`) | `tabs/SeoTab.tsx:1-13,448,467,500,505-588` | 🕳 | **Nothing SEO in the studio at all** — verified by grep across `_studio/**`. Meta title/description with SERP limits, URL handle, canonical, OG fields, the live SERP preview and the JSON-LD preview all vanish. The fields could ride the sheet as columns; the two PREVIEWS (what Google will show, what a crawler will read) are the part a grid cannot express, and they are the reason the tab existed. Biggest single hole in my sections after 4.13. |
| 6.41 | Compliance: PPE category (Cat I/II/III), structured protector rows (zone / standard / level), hazmat flag + class + UN number — **[W]** `PATCH /api/products/bulk` | `tabs/ComplianceTab.tsx:423,470-700` | 🕳 (scalar half is 🔁 — split deliberately) | PPE category and the hazmat flag/class/UN number are scalar fields and appear as sheet columns (the live IT payload carries `supplier_declared_dg_hz_regulation`), so those edit as cells with provenance. The structured PROTECTOR ROWS (zone / standard / level, a repeating sub-table per product) have no cell shape and no home in the studio. Marking the row 🕳 because 🔁 would overclaim the half that is missing. |
| 6.42 | **[W]** Certificate CRUD (CE, EN 13595, REACH, RoHS, WEEE…) with file URL + expiry + Valid/Expiring/Expired badges → `GET/POST /api/products/:id/certificates`, `DELETE .../certificates/:id` | `tabs/ComplianceTab.tsx:215,388,461,801,810` | 🕳 | No certificate CRUD, no expiry badges. This is document management, not attribute editing — it does not fold into a sheet, so it needs a surface decision rather than a column. |
| 6.43 | Channel compliance status matrix (which channel needs which cert) | `tabs/ComplianceTab.tsx` (~470) | 🕳 | No channel×certificate matrix. Depends on 6.42. |
| 6.44 | **[W]** Workflow: attach / detach, move stage with comment, post comments, SLA display → `POST .../workflow/attach`, `/move`, `/comments`, `/detach`; `GET /api/workflows` | `tabs/WorkflowTab.tsx:411,448,483,506,540` | 🕳 | No workflow attach/move/comment/SLA anywhere in the studio. |
| 6.45 | **[W]** Assignees: user search (`/api/users/search`), assign with due date, remove → `POST/DELETE .../workflow/assignments` | `tabs/WorkflowTab.tsx:159,174,185,215` | 🕳 | No assignees. |
| 6.46 | **[W]** Relations CRUD (cross-sell / up-sell / accessory / replacement / bundle-part / recommended), product search, notes, reciprocal option, delete with confirm → `POST /api/products/:id/relations`, `DELETE /api/products/relations/:id` | `tabs/RelationsTab.tsx:61,284,336,380,413-540` | 🕳 | No relations CRUD. Cross-sell/up-sell/bundle links are product-to-product edges; like 6.42 they are not attributes and will not become columns. |

## 7. AI features — 13 capabilities (PES.8; all parity = surface built + DARK, #13)

| # | Capability | Endpoint | File:line | Status |
|---|---|---|---|---|
| 7.1 | AI-suggest product name from the master identity card | `POST /api/products/ai/bulk-generate` (`fields:['title']`, `dryRun:true`) | `tabs/MasterDataTab.tsx:183-210,522` |  🔁 SUPERSEDED — the ✦ enrichment lane drafts `item_name`/`name` against the channel's REAL caps (chars **and** UTF-8 bytes, sourced per market), lands it as a reviewable draft, and applies through `PATCH /api/products/bulk` + audit. The old button had no caps at all. ⚠️ The **generate trigger is deliberately not built** (#13): `_studio/ai/api.ts` exports load/approve/reject and no generate, so the UI cannot reach generation. Review/apply half walked on screen (hub #82). Shipping the trigger is one component when the hold lifts. |
| 7.2 | AI-fill empty master attributes from title/description, per-suggestion accept + confidence + rationale | `POST /api/products/:id/master/ai-fill` | `tabs/_shared/MasterAttributesEditor.tsx:89,172` |  🔁 SUPERSEDED — same lane, for attributes. Better than the old modal: values are held to the schema's allowed-list and caps, an over-cap value is kept and marked `failed` rather than silently trimmed, and approval goes through the audited bulk PATCH instead of a local buffer. Same ⚠️ as 7.1 — trigger dark under #13. |
| 7.3 | Amazon AutoFill — AI-generate title / description / bullets (plus non-AI "Pull from Master") | writes `PATCH /api/products/bulk` | `tabs/amazon-cockpit/autofill/AutoFillCard.tsx:341` |  🔁 SUPERSEDED — and it FIXES a real defect: the old AutoFill wrote generated copy straight to `Product` whenever `dryRun !== true` (`products-ai.routes.ts`), i.e. AI landing as confirmed fact with no review. The studio cannot do that — generation writes only `ProductAiDraft`. Same ⚠️ trigger caveat. (Non-AI "Pull from Master" is not this row's AI half — flagging for PES.2/PES.3, who own master→channel copy.) |
| 7.4 | Amazon AI category suggestion | `GET /api/categories/suggestions?channel=AMAZON` | `tabs/amazon-cockpit/category/CategoryCard.tsx` |  🕳 MISSING — no category/browse-node suggestion anywhere in `_studio/**` (verified by grep). Does NOT fold into cell enrichment: it resolves a node in a category TREE, not a text cell, and `recommended_browse_nodes` is on PES.8's never-draft list as an identifier. Needs an owner — proposing PES.2 (master `productType`); not claiming it into this lane. |
| 7.5 | eBay AI category suggestion | `POST /api/ebay/cockpit/suggest-categories` | `tabs/ebay-cockpit/cards/CategoryPickerModal.tsx` |  🕳 MISSING — as 7.4, for eBay. Channel-scope category is PES.3 territory; flagged, not claimed. |
| 7.6 | eBay AI-improve with selective per-field apply diff modal | `POST /api/ebay/cockpit/ai-improve` | `tabs/ebay-cockpit/ai/AiImproveModal.tsx:81` |  🔁 SUPERSEDED — the per-field diff-with-selective-apply pattern is exactly what `AiDraftReview` does, generalised: per-cell and per-column approve/reject, current vs draft side by side, caps shown per field. Strictly better on two counts — a cap-breaking value offers no approve control at all, and column-approve never silently waives staleness. Same ⚠️ trigger caveat. |
| 7.7 | eBay AI-improve for compatibility/fitments | `POST /api/ebay/cockpit/ai-improve` | `tabs/ebay-cockpit/cards/CompatibilityCard.tsx:146` |  🕳 MISSING — compatibility/fitments is a distinct data domain (vehicle fitment rows), not a sheet cell; nothing in `_studio/**` covers it (grep: no `compatib|fitment`). Out of the enrichment lane's shape. Needs an owner decision at swap time. |
| 7.8 | AI translate a locale | `POST /api/products/:id/translations/:lang/ai-translate` | `tabs/LocalesTab.tsx` |  🕳 MISSING — the studio has a locale switcher (`StudioScopeBar`) but no AI translate action. The server capability exists (`services/ai/translate.service.ts`); only the surface is absent. Nearest fit is this lane (a translated value is a drafted cell value) — I can take it, but it is new scope, not parity of something I built. |
| 7.9 | AI translate all fields on a channel coordinate | via ChannelFieldEditor `bindTranslateAll` | `tabs/ChannelListingTab.tsx:368-377,542` |  🕳 MISSING — as 7.8, for a whole channel coordinate. Would fall out of 7.8 plus the existing batch shape (`runEnrichment` already fans out per product × coordinate). |
| 7.10 | AI relation suggestion + AI re-rank | `GET/POST /api/products/:id/relations/suggest` | `tabs/RelationsTab.tsx:424,439` |  🕳 MISSING — no relations surface in `_studio/**` at all (grep: no `relation`). The old tab's AI suggest + re-rank has no studio home yet; relations sit closest to PES.4's record drawer. Flagged, not claimed. |
| 7.11 | AI-enhanced auto-map for unmapped fields | `/api/pim/mappings/:ch/:mkt/suggest`, `…/suggest-ai` | `_shared/cockpit-shell/AutoMapModal.tsx` |  ⛔ N/A to §7 / cross-lane — the mapping engine moved OUT of the product page to `/channels/mapping` (layout §1, decision 6); auto-map and its AI suggestion belong to **PES.6** and rows 6.23–6.28. Recorded here so the capability is not lost, not claimed by PES.8. |
| 7.12 | Image AI: Gemini Vision analyze, auto-enhance, lifestyle generation | `POST .../images/:id/analyze`, `.../auto-enhance`, `.../images/generate-lifestyle` | `images/LightboxModal.tsx:139,180`, `images/LifestyleGenerationModal.tsx:55` |  ✅ PARITY (surface) — built by **PES.7**, not this lane: `_studio/images/api.ts:109-113` wires `analyze`, `auto-enhance` and `generate-lifestyle`, with `_studio/images/ai/LifestyleGenerator.tsx` as the surface. ⚠️ Cross-ref **hub ruling #83**: the lifestyle half has no Imagen on the current key and the Gemini migration is Owner-queued — so the control is built and honest but its generation is blocked upstream. Marked per #85's instruction rather than 🕳. On-screen confirmation pending (:8091 down, #84). |
| 7.13 | Smart field-link suggestions (identical values across markets) | `GET /api/products/:id/field-links/suggestions` | `_shared/cockpit-shell/useFieldLinks.ts` |  🕳 MISSING (AI half only) — the studio SHOWS field-link provenance (🔗 via `linkGroupId` in the provenance classifier) but has no "suggest identical values across markets" action; grep finds no `field-links/suggestions` caller. Display parity yes, suggestion parity no. Flagging for PES.5/PES.2 who own the link layer. |

## 8. Cross-cutting — 25 capabilities (PES.1)

| # | Capability | File:line | Status |
|---|---|---|---|
| 8.1 | Header "Datasheet" opens `/products/:id/datasheet` in a new tab (real anchor: Cmd/middle-click work) | `ProductEditClient.tsx:1138` | 🔁 **RE-DERIVED under D9 (#214)** → **Export.** 🔴 **UX.1 CORRECTION (00:5x): my earlier "GAP — not wired" was WRONG.** `exportGridCsv` is imported at `MasterSheet.tsx:39` and called at :933, and **"Export" appears in the row context menu** — verified live in the rendered menu, not from source alone. I cannot distinguish a mis-grep from PES.2's 00:41 edit landing after my 00:33 check (the tree is uncommitted, so there is no history to diff) — recorded as unresolved rather than guessed. 🟡 **PARTIAL, and the residue is real: export is reachable ONLY from the right-click menu — there is no export control in the toolbar.** For a decision whose premise is "the grid is the flat file", a hidden way to get the file out is a discoverability defect, not a covered row. → PES.2 / AG.1-e (toolbar mount). |
| 8.2 | Header "Amazon Flat File" → `/products/amazon-flat-file?familyId=&productType=` new tab | `ProductEditClient.tsx:1167` | 🗳 OWNER — **DROPPED by D9 (supersedes D5)**: the `⋯` overflow is removed entirely. The Owner: *"there is no point having the Amazon flat file or eBay flat file with separate links, because everything would be deriving from the grid that we just built."* The need survives in the studio's own model — channel scopes ARE the flat file, the sheet IS the datasheet, History is Recover, a new coordinate + `Publish ▾` is List on… . The old editors themselves are untouched |
| 8.3 | Header "eBay Flat File" → `/products/ebay-flat-file?familyId=` new tab | `ProductEditClient.tsx:1184` | 🗳 OWNER — **DROPPED by D9 (supersedes D5)**: the `⋯` overflow is removed entirely. The Owner: *"there is no point having the Amazon flat file or eBay flat file with separate links, because everything would be deriving from the grid that we just built."* The need survives in the studio's own model — channel scopes ARE the flat file, the sheet IS the datasheet, History is Recover, a new coordinate + `Publish ▾` is List on… . The old editors themselves are untouched |
| 8.4 | Header "Recover" → `/products/:id/recover` new tab | `ProductEditClient.tsx:1199` | 🗳 OWNER — **DROPPED by D9 (supersedes D5)**: the `⋯` overflow is removed entirely. The Owner: *"there is no point having the Amazon flat file or eBay flat file with separate links, because everything would be deriving from the grid that we just built."* The need survives in the studio's own model — channel scopes ARE the flat file, the sheet IS the datasheet, History is Recover, a new coordinate + `Publish ▾` is List on… . The old editors themselves are untouched |
| 8.5 | Header "List on Channel" dropdown → `/products/:id/list-wizard?channel=&marketplace=` (Amazon IT/DE/FR/ES/UK/US, eBay IT/DE/FR/ES/UK) | `ListOnChannelDropdown.tsx:13,14,44` | 🔁 **RE-DERIVED under D9 (#214)** → **add a coordinate + `Publish ▾`.** 🔴 **REGRESSED (#248) — not covered, and not the original gap either.** PES.3 verified the path works (two clicks reach any channel × market; a first edit creates a listing born DRAFT), then PES.5's BE-1 fix narrowed the read with `onlyChannels` and `coordinatesFor` now drops unlisted pairs — so **every market the product is not yet on returns `scope_not_available` while the scope bar still offers it.** The replacement for eleven "List on…" link-outs is currently reachable only for coordinates that already exist, which is the opposite of what it is for. PES.5 is landing a one-flag fix plus a regression test; UX.1 re-derives on their report. **Recorded as REGRESSED rather than GAP on purpose: the capability was built and then lost, which is a different engineering fact from never having been built.** |
| 8.6 | Hover/focus/mount prefetch warming backend caches for those new tabs (`/health`, `/flat-file/template`, `/flat-file/rows`, `/recover/events`) | `useHeaderPrefetch.ts:2-25,90` | 🗳 OWNER — dropped with D9: the prefetch warmed targets that no longer have a control (`useLinkOutPrefetch` removed with the menu) |
| 8.7 | `markNewTabClick` perf instrumentation on those anchors | `ProductEditClient.tsx:1145,1174,1206` | 🗳 OWNER — dropped with D9. 🔴 `lib/perf/markNewTabClick` STAYS in the tree — it is a library whose other half (`reportFromTarget`) runs on the destination pages, which are untouched; only the callers went |
| 8.8 | Cockpit "Edit in bulk" links out to the per-market flat file | `AmazonCockpit.tsx:566`, `EbayCockpit.tsx:436` | ⛔ N/A — cockpit surface, §2.10 |
| 8.9 | Listing Hub links to `/products/automation` (cross-market rules) | `tabs/MasterDataTab.tsx:1240` | 🗳 OWNER — **DROPPED by D9 (supersedes D5)**: the `⋯` overflow is removed entirely. The Owner: *"there is no point having the Amazon flat file or eBay flat file with separate links, because everything would be deriving from the grid that we just built."* The need survives in the studio's own model — channel scopes ARE the flat file, the sheet IS the datasheet, History is Recover, a new coordinate + `Publish ▾` is List on… . The old editors themselves are untouched |
| 8.10 | Ads tab links to Campaigns | `tabs/AdsTab.tsx:320` | 🕳 MISSING — belongs to the Analytics & Ads tab (PES.7), currently a placeholder |
| 8.11 | Family banner links to parent + sibling edit pages | `products/_shared/VariationFamilyBanner.tsx:76,99` | 🔁 SUPERSEDED — the way UP is the header's family link (1.29); the way ACROSS is the sheet, which renders parent and every variation as rows |
| 8.12 | **Export**: Amazon images ZIP with manifest preview | `images/amazon/AmazonPanel.tsx:226,258` | 🕳 MISSING — Images tab is PES.7's placeholder |
| 8.13 | **Export**: eBay File Exchange CSV (`/api/ebay/cockpit/file-exchange-csv`) | `tabs/ebay-cockpit/` | 🕳 MISSING — eBay export; PES.3/PES.7 surface |
| 8.14 | **Import**: Import-from-Amazon into master; import-from-DAM into gallery | `ImportFromAmazonModal.tsx:62,115`, `DamPickerModal.tsx:186` | 🕳 MISSING — import paths; PES.2/PES.7 surfaces |
| 8.15 | **Shortcuts (page)**: Cmd/Ctrl+S = Save All (suppresses browser default), Esc = Discard; Cmd+Shift+S reserved but intentionally unwired | `_shared/useEditorShortcuts.ts:43-85`, `ProductEditClient.tsx:639` | 🕳 MISSING (part) — autosave removes Save/Discard, so the SHORTCUTS have no job (🔁). But ⌘S no longer suppresses the BROWSER save dialog, which is a small regression on a page where ⌘S is a reflex |
| 8.16 | **Shortcuts (tabs)**: ←/→/Home/End tab cycling | `ProductEditClient.tsx:821` | ✅ PARITY — same DS `Tabs` fix as 1.22, verified on `/design-system` |
| 8.17 | **Shortcuts (cockpit)**: Cmd+Shift+P jump-to-publish, `1..9` jump-to-card, Alt+1..9 market switch | `amazon-cockpit/useCockpitShortcuts.ts`, `useMarketSwitch.ts:170` | ⛔ N/A — cockpit surface, §2.10 |
| 8.18 | **Shortcuts (matrix/images)**: ⌘Z/⌘⇧Z undo-redo, ⌘A/Esc select-all, Cmd+S in Images, Enter/Esc commit-cancel in every inline cell | `MatrixTab.tsx:654,166`, `MasterPanel.tsx:216`, `ImagesTab.tsx:298` | ⛔ N/A to the frame — those shortcuts belong to the sheet (PES.2) and Images (PES.7); audited in their areas |
| 8.19 | **Navigation guard** — beforeunload AND in-app `<a>` click interception when dirty | `_shared/useNavigationGuard.ts:43`, `ProductEditClient.tsx:628` | ✅ PARITY (reshaped) — guard fires on **in-flight writes**, not unsaved edits. **Split evidence (ruling #101):** PES.2's browser pass witnessed the live half (inert at 0 pending after a real confirmed write; listener delivery, modifier/target/origin filters and `preventDefault` through a `window.confirm` stub — the real dialog BLOCKS automation). PES.1's `saveState.vitest.test.ts` asserts the state→decision half (20 tests, 2 mutation-tested). 🔴 Extraction for test FOUND A BUG: the guard armed only on `kind==='saving'`, so after a refusal any writes still in flight were unguarded — fixed via `pendingWrites()` |
| 8.20 | **Realtime**: SSE `useListingEvents` + `useInvalidationChannel(['product.updated','listing.updated','channel-pricing.updated'])` re-pull all-listings | `ProductEditClient.tsx:449,462,463` | ✅ PARITY — 🔴 the gap is closed: the frame mounts ONE `useListingEvents()` pipe and re-pulls readiness on `product.updated`/`listing.updated`/`channel-pricing.updated`. Tabs subscribe via `useInvalidationChannel` without opening a second EventSource. ⏳ on-screen pending the API |
| 8.21 | **Toasts**: `listing.synced` outcomes toast per channel (SUCCESS/FAILED/TIMEOUT, dedup by listingId+ts, NOT_IMPLEMENTED silent) | `ProductEditClient.tsx:470-532` | 🕳 MISSING — `ToastProvider` is mounted and ready, but nothing subscribes to `listing.synced` |
| 8.22 | **Error surfaces**: save-failed toast keeps dirty state; per-tab status message strips; version-conflict banner; partial-apply error strings; images inline toast strip | `ProductEditClient.tsx:610-618`, `ChannelListingTab.tsx:468-480`, `MasterDataTab.tsx:420,294`, `ImagesTab.tsx:558` | 🔁 SUPERSEDED (partial) — `SaveIndicator` renders the server's refusal verbatim, `StudioLoader` names the HTTP code, the scope bar states why readiness is absent. Per-cell 409/partial-apply surfacing is PES.2's |
| 8.23 | Recently-viewed tracking for this product | `ProductEditClient.tsx:645` | 🕳 MISSING — no recently-viewed tracking |
| 8.24 | **RBAC: no client-side gating anywhere in the old tree** — enforcement entirely server-side (401 → client loader); no permission hooks exist | `page.tsx:18`, `edit-data.ts:8-13` | ✅ PARITY — identical model: zero client-side gating, server enforces, 401 → client loader re-runs credentialed |
| 8.25 | i18n: nearly all copy through `useTranslations()` (`products.edit.*`); Matrix/Timeline/Images have hardcoded English strings | `ProductEditClient.tsx:51`; hardcoded e.g. `MatrixTab.tsx:1122`, `ImagesTab.tsx:802` | 🗳 OWNER — every studio string is hardcoded English; the old tree routes copy through `useTranslations()`. The Owner's stated preference is an English UI, so this may be deliberate — but it is a divergence from the tree it replaces and should be signed off, not assumed |

---

## Counts

| Area | Count |
|---|---|
| 1. Frame / navigation | 31 |
| 2. Master field editing | 24 |
| 3. Channel / marketplace scopes | 52 |
| 4. Record / detail views | 17 |
| 5. Images / media | 57 |
| 6. Ancillary tabs | 46 |
| 7. AI features | 13 |
| 8. Cross-cutting | 25 |
| **Total** | **265** |

## DEAD? flags (verify importer-absence before relying on it; nothing is deleted pre-swap)

1. `tabs/VariationsTab.tsx` (1217 lines) — only matching import is `app/catalog/[id]/edit/ProductEditorForm.tsx:12`, a different file in the catalog tree.
2. `tabs/PricingTab.tsx` (1078) — matching imports resolve elsewhere; child `ChannelPricingSection.tsx` stays alive via `MatrixTab.tsx:41`.
3. `tabs/InventoryTab.tsx` (654) — no importer; child `ChannelInventorySection.tsx` alive via `MatrixTab.tsx:42`.
4. `_shared/cockpit-shell/CockpitPreviewBand.tsx` — barrel-exported (`index.ts:13`), never rendered.
5. `tabs/_shared/CascadePreviewCard.tsx` — no importer.

Several live components are reached ONLY through the `cockpit-shell` barrel — a naive per-file grep reads as zero. Chase the barrel before declaring death.

## Parity landmines (every auditing lane reads these)

- **Save contract**: `docs/edit-ux.md` forbids autosave except single-toggle controls, but three surfaces diverge and operators depend on it: SEO saves on blur (`SeoTab.tsx:12`), Compliance certificates persist immediately (`ComplianceTab.tsx:10`), master-image ops persist immediately (`MasterPanel.tsx:5`); plus the auto-publish toggle and offer-availability toggles. The studio's per-cell autosave is a DIFFERENT contract from the old page's explicit-save — every audit row about saving must say which contract the studio applies, not just "saving exists".
- **Data-loss net**: `MasterDataTab.tsx:400` flushes on unmount because tabs unmount on switch. A rebuild that keeps panels mounted must not silently drop this protection.
- **Optimistic concurrency**: only the master flush sends `If-Match`/`expectedVersion` and renders a conflict banner; nothing else on the old page has conflict handling. (The studio's SheetWriter per-row expectedVersion is the superseding design — audit rows should cite it.)
- **Browser-local state that survives nowhere else**: tab prefs, cockpit mode, images auto-publish prefs, approval queue, publish rollback snapshots, matrix column prefs, remembered publish target, last-market memory — all localStorage. A rebuild that ignores them loses the rollback/approval FEATURES outright, not just preferences.

---

## Backend pass — every **[W]** endpoint (PES.5, nexus-commerce-1f, 2026-09-01)

**Question answered:** for each write the old page performs, does the studio BACKEND cover it,
supersede it, or not address it. 94 `[W]` rows → **71 distinct endpoints**.

### ⚠ Read this before trusting any "route is missing" claim, including mine

I built a route table by regexing `fastify.<verb>(...)` across `apps/api/src` (2434 handlers) and it
reported 22 endpoints with no route. **Every single one I then checked by hand EXISTS.** The regex
systematically missed multi-line registrations of the form:

```ts
fastify.patch<{
  Params: {...}
}>('/products/:id/channel-pricing', async (req, reply) => {
```

Confirmed present after being flagged absent: `PATCH /products/:id/channel-pricing` (:150),
`PATCH /products/:id/fulfillment` (:385), `PATCH /products/:id/offer-availability`
(marketplaces:253), `POST /products/:parentId/children` (catalog:1181),
`POST /products/:id/restore` (products:771).

**So this pass reports NO missing routes** — not because none exist, but because my instrument
could not prove absence and I will not launder a scanner's silence into a finding. Anyone extending
this audit: verify a specific path with `grep -rn "'/the/exact/path'"`, never with a route-table
sweep.

### A. 🔁 SUPERSEDED — the studio's own write path

| Old write | Studio equivalent |
|---|---|
| Per-field master edits across Overview / Attributes / Content / Identifiers | `PATCH /api/products/bulk` — the SAME endpoint, now reached per-cell with `expectedVersion` (409 → repaint) and, new in PES.5, a per-cell audit row carrying `userId` / `before` / the channel-alias-locale coordinate |
| Channel title + description pinning | `PATCH /api/products/bulk` with `marketplaceContexts` + a prefixed field name |

Nothing else in the 71 is superseded. The studio adds READS (`/studio/sheet`, `/studio/columns`,
`/readiness`, `/studio/history`, alias CRUD); it deliberately introduced no new mutation path.

### B. 🔴 The ceiling that decides most of this table

`PATCH /api/products/bulk` routes only **SIX** field names to a `ChannelListing`
(`CHANNEL_FIELD_MAP`): `{amazon,ebay}_{title,description,variationTheme}`. Measured on
GALE-JACKET / eBay·IT: of 441 cells, **42 route to the channel and 399 land on MASTER**.

**Therefore every old-page capability that pinned a per-channel value beyond those six is NOT
covered by the studio write path and still needs its own endpoint.** That is not a gap to close by
building sheet UI — it is a backend capability question. Concretely still required:

- `PATCH /products/:id/channel-pricing` — per-channel price/qty. No studio route replaces it.
- `PATCH /listings/:id`, `PATCH .../listings/:channel/:marketplace` — listing-level fields.
- `POST /products/:id/channel-pricing`, `PATCH /products/:id/offer-availability`,
  `PATCH /products/:id/fulfillment`, `PATCH /products/:id/global`.
- Every `ebay/cockpit/*` and `amazon/cockpit/*` write (aspects, category, compatibility,
  offer-policies, template-apply, variation-matrix, publish, promote-to-master).

### C. ✅ UNCHANGED — backend covers it because it never moved

Images (`images`, `images/:id`, `reorder`, `apply-to-children`, `import-from-dam`, `derive`,
`analyze`, `auto-enhance`, `push-to-dam`, `images-workspace/*`, `amazon-images/publish`,
`image-publish-jobs/:id/retry`, `scheduled-image-publishes`), publish (`publish-amazon`,
`publish-preflight`, `listings/bulk-action`), hierarchy (`pim/reparent`, `promote-to-parent`,
`demote-parent`, `attach-to-parent`, `catalog/products/:id/children`, `variant-attributes`),
relations, workflow, translations, certificates, videos, field-links, mapping
(`propagate-preview`, `apply`, `adopt-master`, `mappings/clone`), `products/:id/restore`,
`products/:id/state`.

The studio calls these directly and unchanged. **No backend work required for parity** — but note
this means the studio is not self-sufficient: swapping the old page does not let any of these
routes be retired.

### D. 🗳 OWNER — one behavioural gap the studio introduces

**Writes to a NON-PRIMARY listing alias are not routable.** `PATCH /api/products/bulk` carries no
`aliasId`, so its channel upsert targets the PRIMARY row — an alias-cell write would silently edit a
different listing. The contract marks those cells `writable: false` with a reason rather than
letting the write happen. Alias rows cannot exist until PES.5-ii, so nothing is broken today; it
becomes a real gap the moment aliases are created. Closing it needs an `aliasId` parameter on the
bulk PATCH — a write-path change, hence Owner-queued rather than assumed.

### E. Two audit-annotation nits

- `POST /api/products/:id/channel-pricing` is listed `[W]`; the file's own header documents only
  `GET` + `PATCH`. The `POST` row may be a typo — worth a caller check by whoever wrote it.
- `MasterSheet.tsx:312` states `PATCH /products/:id/channel-pricing` "pins a field when you write
  a value" — consistent with B above, and the clearest statement of why the six-field ceiling
  matters for the sheet.


### §3 addendum — 6.27 witness feasibility checked, and DECLINED (PES.3, ruling #93)
The hub's non-obligating option was to run a pin→reset round-trip on a XAVIA fixture listing. I
checked feasibility rather than assuming, and the answer is **no safe target exists**:

- **All 40 eBay·IT listings across the GALE / AIREON / MISANO / XRI01 families are `ACTIVE`,
  `isPublished: true`, with real ItemIDs.** Not one is inert.
- Widening to every non-ACTIVE eBay·IT listing finds 20 DRAFT rows — but **every one still carries a
  real eBay ItemID and `isPublished: true`**. The closest fit, `xavia-knee-slider` (DRAFT, 8
  children, ItemID 256550369887), is still a listing eBay knows about. "DRAFT" here is our local
  status, not eBay's absence.
- The bulk write itself does not enqueue an outbound push (no `OutboundSyncQueue` enqueue in that
  route) — but **prod's crons are running**, and a pinned test value would sit on a real listing
  until something either synced it or someone noticed.

A pin→reset nets to zero only if the reset succeeds — and the reset is the very thing under test. A
test whose safety depends on the behaviour it is testing is not a safe test.

**Declined; the logic + write-path proof stands** (`cascadeIntent` → `intent: 'reset'` → server
restores `follows` / drops the override, with routing, conflict and rollback proven by the 409
rehearsal). The remaining gap is narrow and stated: **the affordance has not been SEEN**. That part
needs no write and will close on the next screen the origin pool allows.

### 🔴 §3 addendum — a defect the 6.27 screen found (PES.3, ruling #96)
The same pass that confirmed 6.27 found a real one: **`brand` (master-routed) also rendered 21
enabled cascade buttons**, titled *"Click to pin it…"* — while `onCascade` returns early for anything
`offersCascade()` refuses. So 399 of 441 cells offered an action, promised it in a tooltip, and did
nothing when clicked. Ruling #58 said never render an UN-PIN on a master-routed cell; rendering a
PIN that silently declines is the same dishonesty wearing the other label
(reference_disabled_control_cannot_explain).

Fixed: a non-actionable cell now renders the provenance MARK as a plain `<span>` — informative, no
pointer, no hover border, tooltip from `provenanceTooltip` — and no button at all. Where the value
came from stays true and useful; only the promise of an action the cell cannot perform is withdrawn.
tsc clean, 83 tests green. ✅ **FIX VERIFIED ON SCREEN (ruling #100):** channel-routed `name` →
21 cells / **21 buttons** / 0 static marks; master-routed `brand` → 21 cells / **0 buttons** /
**21 static marks**. Exactly the intended split: the actionable cells keep the control, the 399
that cannot act keep the information and lose the false promise. No console discriminators were
needed — the sheet loaded first time.
