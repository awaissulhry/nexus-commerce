# Channel attributes — the open items: research and plan (2026-09-27)

Research and plan written 2026-09-27 on `origin/main` c63da5363 (the Owner chose D1 = A and D2 = A the same day).
**Everything in §10 is built, merged and live** — the outcome is in §12. The sections before §9 are the research as
written, with corrections marked where production proved a first reading wrong (§7).

Code is read at c63da5363. Line numbers are under `apps/api/src/` unless a path says otherwise. Production numbers
come from read-only `GET` calls through the signed-in app (Xavia Racing), on 2026-09-27 after 15:00 UTC:
14 parent products × 18 channel scopes = 252 column reads, plus the listing lists of every channel.

Follows `RESEARCH-2026-09-27.md` (Amazon parity, §9 = what shipped) and
`../product-sheet-create-path/RESEARCH-2026-09-27.md` (the create path and its Corrections).

## Summary

**Amazon is complete.** Every product has its Amazon rules in all 11 markets. No field is unknown. The column
counts differ only where Amazon's own rules differ.

**The gaps are on the other channels, and in a few data rows.**

| # | Item | What I found | Fix | Your choice? |
|---|---|---|---|---|
| 1 | eBay DE, FR, ES, UK | 0 of 14 products have an eBay category there, so the sheet shows only the 29 general eBay fields. Also 3 products in eBay IT (the suit, 2 gloves). | Suggest a category per eBay site from the one we know, you confirm, save it as a category assignment per site. Then the item specifics download by themselves. | **D1** |
| 2 | Shopify | Connected, 0 listings. 101 columns on every product. The columns ignore the product's category: category fields show on every product and Shopify refuses them at publish. No nightly refresh of the store fields. | Filter category fields by the product's Shopify category; add the store fields to coverage and the nightly job. | no |
| 3 | Etsy | The Etsy account is **not connected**. There is no Etsy publish. The Studio already hides the Etsy scope (checked on screen); only the API still serves 58 Etsy columns. | Nothing now. Category fields, coverage and publish when Etsy is connected. | no |
| 4 | Fulfillment method label | The web has its own label table and it wins over ours (`referenceLabels.ts:53`). | Delete that one line. The cell then reads "FBA — Amazon stores and ships". | no (rec: fix) |
| 5 | Promoted Amazon row has no ASIN | Nothing on a schedule ever writes the ASIN into a listing row. Sheet, Variants, the delete warning and offer actions call such a row "draft" or "local". | Read the ASIN from Amazon right after the feed is accepted, and retry later. Until it arrives, show "Published · ASIN pending". | no |
| 6 | 25 Amazon rows DRAFT + no ASIN + published | Checked on Amazon: 22 are **live on Amazon** (20 IT sizes of AIREON and the overjacket, 2 parents) but Nexus has no ASIN for them. 1 (MISANO XS, DE) is not on Amazon. 2 DE parents need a closer look. Nothing is queued for them. | Fill ASIN + status for the 22 (S2 reader); MISANO XS → inert draft; look at the 2 parents. All on your word. | D2 = A (chosen) |
| 7 | Step 7 — the other listing creators | 40 sites. 20 leave `isPublished` TRUE on rows not on the channel. 9 live paths make drafts their own way; 5 record live listings with account faults; ~20 are dead (old editor, unmounted screens, or broken). Publishers other than Shopify never lift a draft's pause. | Drafts → `ensureDraftListings`. Live listings → one new "record live" rule that also lifts the pause. Delete the dead ones. Both rules in the same PR, or published listings would stay paused. | no |

Decisions are in §9. The build plan is in §10.

---

## 1. Coverage per channel and market (measured)

`GET /api/products/:id/studio/columns?scope=channel&channel=…&market=…`, all 14 parent products.

| Scope | Columns | Products with no rules | Why |
|---|---:|---:|---|
| Amazon BE, ES, FR, IT, NL, PL, SE | 167–254 | 0 | — |
| Amazon DE | 170–257 | 0 | Amazon DE adds 2 fields, drops 1 |
| Amazon IE | 179–266 | 0 | Amazon IE has other OUTERWEAR and GLOVES fields |
| Amazon UK | 161–248 | 0 | Amazon UK has no `image_locator_ps01…06` |
| Amazon TR | 155–243 | 0 | Amazon TR drops 13 fields |
| eBay IT | 32–52 | **3** (xracing suit, 2 gloves) | Their eBay IT row is a parent-only draft with no category |
| eBay DE, ES, FR, UK | **32** | **14** | No eBay listing, no category assignment |
| Shopify GLOBAL | 101 | 0 | Store fields loaded |
| Etsy GLOBAL | 58 | **14** | Etsy is not connected; no taxonomy |

The range inside Amazon is the product type (a knee slider has fewer fields than a coat). Every Amazon coverage entry
reads 0 unrecognised fields. `GET /api/categories/schema/coverage`: Amazon 66/66 cached; eBay 2 pairs (IT 177101,
IT 177104); Etsy 0; Shopify "unsupported channel".

Listings per channel: Amazon 746 rows (IT, DE, ES, FR, and the SE test draft); eBay 332 rows, **all in IT**;
Shopify 0; Etsy 0. Connections: Amazon, eBay, Shopify active; Etsy and WooCommerce not active.

## 2. eBay — no category on 4 of 5 sites

**How the category is chosen** (`services/pim/product-category-context.ts:7-27`,
`services/pim/mapping/category-mapping.service.ts:102-118`, `:262-343`): the listing's `platformAttributes.categoryId` on
that site, else a category assignment (mapping) for that site or for `'*'`. There is no product-level value.

**Why the Amazon trick does not apply.** For Amazon we borrow the product type from a sibling market, because a
product type is the same word in every market. eBay has one category tree per site. The trees are downloaded for all
5 sites (DE 17 051 nodes, ES 10 444, FR 12 036, IT 11 187, UK 15 993). I searched them:

| Site | 177104 | Motorcycle jackets are |
|---|---|---|
| IT | Abbigliamento per moto › Giacche e giubbotti | 177104 |
| FR | Vêtements moto › Blousons | 177104 |
| ES | Vestimenta motoristas › Chaquetas motoristas | 177104 |
| DE | (no such id) | 177117 Motorrad- & Motorsportausrüstung › Motorradjacken |
| UK | (no such id) | 177117 Motorcycle & Motorsports Gear › Motorcycle Jackets |

And **177117 in FR is "Vêtements de cross › Blousons" (motocross)**. So a copied id is sometimes right, sometimes
missing, and sometimes a different thing. A person must confirm each site.

**What exists today:**
- The sheet's eBay `categoryId` cell has a search editor over the downloaded site tree
  (web `_studio/sheet/ChannelCategoryEditor.tsx`, `categoryOptions.ts`; `GET /api/pim/taxonomies/EBAY/:market/nodes`).
  On a site with no listing, the first save starts a draft (create path). Then "Download rules" gets the item
  specifics. That works, but it is per product and per site, and the column is hidden in the eBay group.
- The Categories workspace (`/catalog/categories?view=assignments&channel=EBAY&market=DE`) assigns a Nexus category to
  an eBay leaf per site. It refuses until that leaf's rules are cached (`services/pim/mapping/impact.service.ts:371-373`).
- A cross-site finder exists but nothing reaches it: `GET /api/ebay/cockpit/category-map`
  (`routes/ebay-cockpit.routes.ts:194-238`), called only from the old cockpit modal, which the Studio redirect hides.
- eBay's own `get_category_suggestions` is wrapped and goes through the gateway (`services/ebay-category.service.ts:187-208`).

**Other eBay faults found:**
- An eBay assignment saved for `'*'` ("All-market default" in the workspace) gives one site's leaf id to every site
  (`services/pim/mapping/category-mapping.service.ts:263`). With separate trees that is wrong, and coverage skips `'*'`
  (`services/categories/schema-coverage.service.ts:169`), so its rules never download.
- `categoryId` is not marked required (`services/pim/channel-specs/ebay.ts:119`), but Publish refuses without it
  (`services/pim/studio-publication-ebay.ts:144-145`). Readiness can look complete while Publish refuses.
- The old eBay Inventory push falls back to the listing of any site (`services/ebay-variation-push.service.ts:2640-2645`),
  so it could send IT's leaf to DE. The Studio does not use that fallback.
- Dead or wrong code: the comment at `sheet-columns.service.ts:1203-1206` (aspect rows do not "stand in");
  `ebayCategoryIdsFor` (`studio-sheet.service.ts:936-953`) is never called; `suggestCategoryId` calls
  `suggest_category`, which is not an eBay endpoint (`ebay-category.service.ts:574`).

**Proposal — "eBay categories for other sites".** For one Nexus category (for example Jackets, 8 products) and every
eBay site with no assignment:
1. Nexus proposes up to 3 leaves per site: the leaf with the same path words as the known site's leaf in that site's
   downloaded tree, plus eBay's own suggestions for a product title (gateway). The known leaf's path is shown beside it.
2. You pick one per site (or none). Nothing is sent to eBay.
3. Nexus saves one assignment per site, downloads that leaf's item specifics for the site (the existing download
   action), and the sheet shows them for every product in the category.

The same screen then serves gloves, suits and knee sliders. Also: remove `'*'` for eBay assignments, mark `categoryId`
required, and delete the dead code above.

## 3. Shopify

- Columns = fixed Shopify fields (`packages/shared/shopify-information.ts:24-59`) + every store metafield definition
  (`services/pim/channel-specs/store.ts:21-96`). The store schema is cached in memory and in one `CategorySchema` row
  (`services/pim/channel-specs/shopify.ts:22-88`). All 14 products read 101 columns; the schema was warm.
- **The columns ignore the product's category.** Category metafields show on every product; Shopify refuses a value
  for the wrong category at publish (`services/shopify/linked-products.service.ts:126-139`). The constraints are
  already fetched (`services/shopify/linked-products-gateway.ts:62-80`) but the sheet does not use them.
- **No coverage and no nightly refresh.** Shopify is not a coverage channel; the stored row's expiry is ignored on read
  (`shopify.ts:63-66`). If the row is missing and Shopify fails, the sheet says "still loading" and never resolves.
- Shopify's standard taxonomy attributes are downloaded but used only in the Categories preview.

## 4. Etsy

- The Etsy connection is not active. There is no Etsy publish (`services/pim/studio-publication.service.ts:127`).
- The sheet still shows 58 Etsy columns (bundled Etsy fields, `services/pim/channel-specs/etsy.ts:20-132`); 26 are
  read-only "reported by Etsy" fields. With no taxonomy id there are no category fields (`ETSY:*` on all 14 products),
  and the Etsy taxonomy source reads `failed`.
- ~~Proposal: one banner on the Etsy scope.~~ Not needed: the Studio hides a channel with no connected account
  (web `_studio/scopes.ts`, `deriveScopeOptions`), checked on screen 2026-09-27. Category fields, coverage and publish
  wait until Etsy is connected.

## 5. Fulfillment method label

- Our labels are set on the server (`services/pim/channel-specs/amazon.ts:83-84`, `:143`): "FBA — Amazon stores and
  ships" / "FBM — you ship".
- The web merges labels as `{ ...column.optionLabels, ...labels[key], ...fixedLabels[key] }`
  (web `_studio/sheet/referenceLabels.ts:62`). `fixedLabels` wins. Line 53 maps this column to an older table
  (`:44-49`, from 2026-09-12): `AMAZON_EU` → "Fulfilled by Amazon (Europe)", `DEFAULT` → "Fulfilled by merchant (FBM)".
- The display and the editor agree (both read the merged labels). Only 6 columns have fixed labels; every other enum
  shows the server's labels.
- Fix: delete `referenceLabels.ts:53`. Keep lines 51-52 (a test pins the older labels for the flat-file columns).

## 6. A published Amazon row has no ASIN

- Studio Publish promotes each SKU Amazon accepts (`promoteAcceptedDrafts`), but the feed report has no ASIN.
- **No scheduled job writes `externalListingId` for Amazon.** The writers are the listing wizard, the manual flat-file
  pull, the flat-file save (only a typed ASIN) and the manual link actions. The daily quantity read-back
  (`jobs/amazon-qty-readback.job.ts`) reads the merchant listings report with ASINs but writes nothing to the row.
  The Amazon status notice (SQS) carries SKU and ASIN, but only emits a screen event (`jobs/amazon-sqs-poll.job.ts:293-316`).
- Views that need the ASIN and so call a promoted row a draft: the sheet row state (`services/pim/studio-sheet.service.ts:1624`,
  `services/pim/sheet-rows.service.ts:364`), Variants (`services/pim/family-projection.service.ts:581-588`, `:1479`,
  `:1661`), the delete warning (`packages/shared/listing-risk.ts:8-10` → under-warns), offer actions
  (web `_studio/sheet/channel/channelActions.ts:143-144`).
- `getListingsItem` (summaries → ASIN) is already wrapped and account-bound (`clients/amazon-sp-api.client.ts:1231-1345`,
  used by `services/pim/studio-publication-amazon.ts:210`). A 404 there means "not visible yet".
- Proposal:
  1. After a feed is accepted, read each accepted SKU with `getListingsItem` on the publishing account, after the
     database transaction, and write the ASIN only where the row has none. A 404 is retried at the next receipt check.
  2. Until the ASIN arrives, a row that is published and ACTIVE with no ASIN reads **"Published · ASIN pending"** —
     not "draft" and not "live".

## 7. The 25 Amazon rows (DRAFT, no ASIN, published)

| Rows | Market | What they are |
|---:|---|---|
| 16 | IT | AIREON jacket and pants, 2 colours, sizes XXS, XS, 4XL, 5XL. |
| 4 | IT | Waterproof overjacket, sizes XXS, XS, 4XL, 5XL. |
| 1 | DE | MISANO-JACKET-XS-BLACK (a standalone product in Nexus). |
| 4 | DE ×3, IT ×1 | Parent rows of VENTRA, REGAL, IT-MOSS (DE) and AIRMESH (IT). The product has an ASIN; the row has none. |

- Made 2026-05-19 to 2026-07-19, before `ensureDraftListings`. Their stored attributes carry flat-file keys
  (`skip_offer`, `parentage_level`, `child_parent_sku_relationship`), so the Amazon flat-file save is the likely
  creator (`services/amazon/flat-file.service.ts:3601`, which leaves `isPublished` at its default TRUE). Not proven.
- Nothing is queued for them: `GET /api/products/:id/sync-queue` returns 0 rows for all 25. Their `lastSyncStatus` is
  PENDING because cascades touched them earlier.

**Checked on Amazon (read-only, 2026-09-27 after the Owner chose D2 = A).** `GET /api/products/:id/live-read`
(one Listings Items read per seller SKU, on the row's own account; it stores nothing):

| Rows | Amazon says | Correction to the first reading | Repair (on the Owner's word) |
|---:|---|---|---|
| 20 IT children (AIREON 16, overjacket 4) | **Listed**, with an offer: overjacket 29.00 EUR, AIREON 129.00 EUR, quantity 0 | They are NOT "sizes Amazon never got". They are live listings that Nexus records as drafts with no ASIN. Nexus also shows another price (34.99, 159, 149). | Fill the ASIN and the status from Amazon (the S2 reader). Then compare the price. |
| REGAL (DE), AIRMESH (IT) parents | Parent SKU listed | — | Fill the parent ASIN (S2 reader). |
| MISANO XS (DE) | **Not listed** in DE | — | Make it an inert draft (`isPublished false`, `syncPaused true`). |
| VENTRA, IT-MOSS (DE) parents | "The parent seller SKU is not listed on Amazon in this marketplace." | Their DE children are live with ASINs (VENTRA 24, IT-MOSS 21; no parent ASIN stored), so Amazon DE groups them under another parent or none. | **No change.** Making the row a draft and publishing it would create our parent SKU on Amazon DE and could re-group a live family. Needs a read of one child's Amazon relationships first, then your decision. |

So the real fault is the same as §6: a live Amazon listing whose Nexus row has no ASIN. The S2 reader fills these rows
too (a read, then a write only where the row has no ASIN).

**Also found in the same read (not in the 25):**
- 21 Amazon rows are DRAFT **with** an ASIN (7 parent rows touched today, the IT AIRMESH sizes XXS/XS/4XL/5XL, the DE
  AIR-MESH sizes S–XXL).
- 15 rows are DISCOVERABLE with an ASIN but `isPublished false`, 12 of them GALE in FR. That may be a deliberate
  closed offer. The check in (a) should report both groups too.

## 8. Step 7 — the other listing creators

40 code sites create `ChannelListing` rows (grep `channelListing.(create|upsert|createMany)`, plus
`products.routes.ts:2122`, whose `.upsert(` sits on its own line). Every route file is registered in
`src/index.ts`. The dead code is on the web side: the old product editor (`ProductEditClient`) is mounted by no page
(`apps/web/src/app/products/[id]/edit/page.tsx:12` redirects to the Studio), and neither are
`BulkOperationsClient.tsx`, `UnifiedFlatFileClient.tsx`, `ImportCatalogButton.tsx` or `edit/tabs/PricingTab.tsx`.

Schema defaults: `listingStatus` DRAFT, **`isPublished` TRUE** (`packages/database/prisma/schema.prisma:1674`),
`syncPaused` false, `channelConnectionId` null. **20 sites leave `isPublished` TRUE on rows that are not on the
channel. Only `ensureDraftListings` sets `syncPaused`.**

**Group A — makes a Nexus draft, and the web still reaches it → move onto `ensureDraftListings`:**

| Site | Entry (web caller) | Today |
|---|---|---|
| `routes/catalog.routes.ts:1324` | add a child with "copy from" (Studio `familyActions.ts:412`) | copies the sibling's account (may be null) and its alias rows; not paused |
| `services/pim/catalog-transfer.service.ts:296` | PSIE / CFI / Shopify CSV apply (`TransferReview.tsx:116`) | explicit account; not paused; file patch spread last |
| `services/shopify/content-workspace.service.ts:149`, `linked-products.service.ts:61` | Shopify content and linked products (Studio) | parent-only draft; not paused |
| `services/amazon/flat-file.service.ts:3601` | Amazon flat-file save (`AmazonFlatFileClient.tsx:2517`) | no account; **published TRUE** on a save that sends nothing — the likely source of the 25 rows (§7) |
| `routes/ebay-flat-file.routes.ts:1091`, `:1204`, `:1444` | eBay flat-file save (`EbayFlatFileClient.tsx:1664`) | no account; published TRUE; `:1091` queues price/quantity pushes |
| `routes/listings-syndication.routes.ts:3717` | Cascade modal (flat files) | no account; published TRUE; **queues price/quantity pushes for the new draft** (`:3734`, `:3746`) |
| `routes/catalog.routes.ts:647` | Catalog "add products" (`catalog/add/page.tsx:360`, via a proxy to `localhost:3001`) | market hard-coded `US`; published TRUE |

`ensureDraftListings` refuses alias rows. The alias copies in `catalog.routes.ts:1324`, `catalog-transfer`, the two
Shopify sites and `createAlias` (`services/pim/listing-alias.service.ts:140`) need a shared alias-capable version of
`draftListingData`, so every draft gets the same fields.

**Group B — records a listing the channel already has → one new rule** (explicit account, the channel's status,
`isPublished` TRUE, external id, and the pause lifted on a still-draft). `services/shopify/content-sync.service.ts:190`
already does this and is the model.

| Site | Fault today |
|---|---|
| Listing wizard `services/listing-wizard/submission.service.ts:1431`, `:1474` | the upsert's `where` names the primary account, the `create` writes none → a second publish can hit the unique key |
| eBay flat-file push `services/ebay-variation-push.service.ts:2140` | drops the account in scope; writes market `GB` (the Marketplace code is `UK`) |
| Amazon flat-file pull `services/amazon/flat-file-pull.service.ts:299` | no account filter on the lookup |
| Reconciliation confirm `services/listing-reconciliation.service.ts:516` | allows a null account; no `aliasId` |
| Amazon flat-file resync after a feed (`flat-file.service.ts`, published branch); eBay flat-file rows with an item id | as above |

**Why group B must come with group A.** Today no publisher except Shopify lifts a draft's pause: the wizard never
writes `listingStatus`, `isPublished` or `syncPaused`; the eBay push sets ACTIVE only; the old marketplace publish sets
`isPublished` only. If group A made those drafts paused first, a listing published by the wizard or the eBay flat file
would stay paused and its stock would stop syncing.

**Group C — dead or broken → delete** (after a check that no script or test needs them):
- `routes/matrix.routes.ts:182`: fails on every call (the required `channelMarket` is missing); no web caller.
- `services/inbound-sync.service.ts:56`: upserts on three unique keys that do not exist (`:28`, `:58`, `:96`); its only
  button is imported nowhere.
- `routes/amazon.routes.ts:1257`, `:1443` (link Amazon): no web caller; `channelMarket` is a region and `marketplace`
  becomes `DEFAULT`; the second call hits the unique key.
- `routes/marketplaces.routes.ts:1063`, `:1080`: marks a listing ACTIVE and published **without calling the channel**;
  old editor only.
- `routes/flat-file-unified.routes.ts:630` + the `createIfMissing` branch of
  `services/flat-file/listing-content-write.service.ts:136` (writes eBay market `GB`): unmounted UI.
- `services/flat-file/import/apply.ts:456`: no web caller.
- Old-editor-only routes: `amazon-cockpit.routes.ts:178`; `ebay-cockpit.routes.ts:312`, `:658`, `:693`, `:1814`;
  `marketplaces.routes.ts:586` (the body can set `isPublished`, status, external id and account), `:710`, `:770`,
  `:919`; `product-channel-data.routes.ts:178`, `:401`. Unmounted-UI routes: `products.routes.ts:2122`, `:2384`.
- `services/market-offer-availability.service.ts:17`: neither web caller can reach its create branch.

Also: the eBay UK spelling differs between creators (`EBAY_GB` vs `EBAY_UK`, market `GB` vs `UK`).

## 9. Decisions

**2026-09-27 — the Owner chose D1 = A and D2 = A** ("I'll go with your recommendation"). Building S1–S8.

**2026-09-27 ~16:20 UTC — the Owner authorised merging #103–#109.** Merged in order: #103, #104, #105, #106, #108, #107 (#107 after a merge of main and one test fix). #109 merged (71bc30a8d) after its PostgreSQL suite was re-run (the first run stopped at the 10-minute limit). The deploy of da89ba7ce stopped at the pre-ship web build (a Google font download failed; the other shard passed), so nothing shipped until the #109 deploy (run 36335268071, success) carried all seven.

**Checked on production after that deploy (read-only):**
- Amazon · DE, GALE: the Fulfillment method cells read "FBA — Amazon stores and ships" / "FBM — you ship".
- eBay · DE, GALE: the Category column is required on every row; the Requirements chip says "No eBay category is chosen for eBay · DE. Choose one in Categories."
- Categories → eBay IT: "Fill other eBay sites" on Accessories, Rainwear and Jackets. The dialog opened and was cancelled; nothing assigned. **Its defaults were often wrong** (DE "Gitarren › E-Gitarren", UK "Casual Shoes") → fix **PR #113**: a site starts with a category only when two sources agree.
- ASIN fill **dry run** (`POST /api/amazon/listings/fill-asins`, `dryRun: true`): 21 would be filled (20 IT sizes + AIRMESH IT parent; 1 BUYABLE, 20 DISCOVERABLE), 4 not visible under our seller SKU (MISANO XS DE; VENTRA, IT-MOSS, REGAL DE parents). Nothing written; the write waits for the Owner.
- Open PRs after this: #110 (dead creators), #111 (drafts through one creator), #113 (suggestion defaults) — each needs the Owner's word.

**D1 — Where the eBay category for a new site is saved.**
- **A (recommended): one assignment per Nexus category per site** (Jackets → DE 177117). One choice covers all 8
  jackets. The nightly job keeps its item specifics fresh. New jackets get it at once.
- B: per product, in the sheet's Category cell (as today). Nothing new to build, but 14 products × 4 sites = 56 choices,
  and each one starts a draft.

**D2 — The 25 rows.**
- **A (recommended): check them on Amazon (read-only), then repair on your word** as in §7.
- B: leave them, and let step 7 stop new ones. They stay counted as published.

## 10. Build plan (small PRs, each merged on the Owner's word)

| Step | What | Size |
|---|---|---|
| S1 | Fulfillment label: delete `referenceLabels.ts:53`; test. **PR #103 — merged (230d6d5c7).** | tiny, web |
| S2 | ASIN after Publish + "Published · ASIN pending" state (§6), and a fill tool for existing live rows with no ASIN (§7: dry run first, write on your word). **PR #107 — merged (da89ba7ce)**; 21 rows filled on the Owner's word (§12) (route `POST /api/amazon/listings/fill-asins`; retry sweep every 30 min, `NEXUS_AMAZON_ASIN_FILL=0` turns it off). | API + web |
| S3 | eBay: `categoryId` required; no `'*'` for eBay; delete dead code; fix the any-site fallback. **PR #104 — merged (52400e3d4).** (`suggestCategoryId` left to S4, which works in the same file.) | small, API |
| S4 | eBay categories for other sites (§2, D1). **PR #106 — merged (eff46a63a).** Includes one guard change: for a category change, only products listed on that site block activation (else a new site's category could never be assigned — its item specifics only exist once the category does). | API + web |
| S5a | Step 7: the "record live" rule + group B (wizard, eBay push, flat-file pull, reconciliation), with the pause lift. **PR #108 — merged (ac356d4f9).** Then **PR #109** (stacked): a still-draft never blocks an eBay push of its family — live risk on main since #89 (eBay keeps one inventory item per SKU, so the flat-file push checks every site's row). | API |
| S5b | Step 7: group A onto `ensureDraftListings` (+ the alias-capable draft fields); the cascade stops queueing pushes for new drafts. **PR #111 — merged (087f036ed).** Left unchanged: the Amazon/eBay flat-file unpublished saves (their own publish locks refuse paused rows), Shopify linked products (its sync never lifts a pause), `catalog.routes.ts:647` (no market in the request). | API |
| S5c | Step 7: delete group C and the old-editor routes. **PR #110 — merged (b443dbc4a).** Kept: `unified-rows` + `import/apply.ts` (the flat-file regression probe calls them). | API + web |
| S6 | 25-row check (read-only), then the repair on your word (§7, D2). **Done:** 21 live rows filled (§12); 4 left for decisions. | data |
| S7 | Shopify: a category metafield says where it applies and is read-only outside those categories (same rule as the Shopify Information editor; nothing hidden). **PR #105 — merged (e9c89c724).** Coverage + nightly refresh **dropped**: the store fields refresh on every Studio visit (`readShopifyDisplaySchema`), and a failed read already shows a warning with "Retry attributes" (web `sheet/ProductSheetTab.tsx`). | API |
| ~~S8~~ | ~~Etsy banner (§4).~~ **Dropped 2026-09-27:** the Studio hides a channel with no connected account (web `_studio/scopes.ts`, `deriveScopeOptions`); checked on screen — GALE's channel menu lists Shared product, Amazon, eBay, Shopify, no Etsy. The 58 columns were read through the API only. | — |

## 12. Outcome (2026-09-27, evening)

**Merged, deployed and checked on production.**

| PR | What | Merge |
|---|---|---|
| #103 | Fulfillment method keeps Nexus's FBA / FBM labels | 230d6d5c7 |
| #104 | An eBay category always names its site; eBay `categoryId` required; old push never borrows another site's category, policies or item id | 52400e3d4 |
| #105 | A Shopify category metafield says where it applies; read-only outside those categories | e9c89c724 |
| #106 | "Fill other eBay sites" in Categories; only listed products block a category change | eff46a63a |
| #107 | Amazon ASIN fill (after Publish, a 30-minute retry sweep, `POST /api/amazon/listings/fill-asins`); "Published · ASIN pending" | da89ba7ce |
| #108 | `recordLiveListings` — one rule for a listing the channel already has; lifts a still-draft's pause | ac356d4f9 |
| #109 | A Nexus draft never blocks an eBay push of its family | 71bc30a8d |
| #110 | Dead listing creators deleted (−2,411 lines) | b443dbc4a |
| #111 | Drafts come from one creator | 087f036ed |
| #113 | "Fill other eBay sites" starts a site with a category only when two sources agree | 748256561 |
| #114 | The forced insert-race test suites always release their table lock (CI hung twice at the 10-minute limit) | ae6fc280b |

Deploys: run 36335268071 (up to #109) and run 36339229826 (up to #114), both successful.

Checked on production (read-only unless stated):
- Amazon · DE, GALE: Fulfillment method reads "FBA — Amazon stores and ships" / "FBM — you ship".
- eBay · DE, GALE: Category required on every row; "No eBay category is chosen for eBay · DE. Choose one in Categories."
- Categories → eBay IT: "Fill other eBay sites" on Accessories, Rainwear, Jackets (dialog opened and cancelled; nothing assigned).
- **ASIN write, on the Owner's word:** `POST /api/amazon/listings/fill-asins` with the 21 ids a fresh dry run reported as held by
  Amazon. Result: 21 filled, 0 errors. Read back: 20 DISCOVERABLE + 1 BUYABLE, all published, all with an ASIN. **No push was
  queued** (sync queue empty for all 21). The 4 others are unchanged: MISANO-JACKET-XS-BLACK (DE, not on Amazon DE) and the
  VENTRA, IT-MOSS and REGAL parent rows in DE (Amazon shows no listing under our parent seller SKU).

**The open items, settled later the same evening:**
1. Prices on the 20 filled IT rows — **the Owner handles it** by re-importing the native Amazon Excel files, so the data matches.
2. VENTRA, IT-MOSS, REGAL DE parent rows — **the Owner handles it** with the same re-import.
3. MISANO-JACKET-XS-BLACK DE — **the Owner handles it** with the same re-import.
4. eBay categories — **done** (on the Owner's word), through `POST /api/pim/category-workspace/EBAY/site-assignments`, one site per
   request, each through the existing review → activation path. Nothing was sent to eBay. Each leaf was checked in that site's
   own downloaded tree, with the same meaning as the IT choice:

   | Nexus category | IT | DE | UK | FR | ES |
   |---|---|---|---|---|---|
   | Jackets | 177104 (existing) | 177117 | 177117 | 177104 | 177104 |
   | Rainwear | 177104 (existing) | 177117 | 177117 | 177104 | 177104 |
   | Accessories | 177101 (existing) | 177101 | 177101 | 177101 | 177101 |
   | Gloves | **177103** (new) | 177116 | 177116 | 177103 | 177103 |
   | Suits | **177106** (new) | 177106 | 177106 | 177106 | 177106 |

   Notes: DE and UK have no 177103 or 177104 — their moto jackets and gloves are 177117 and 177116; in IT, FR and ES those
   numbers mean off-road items. Rainwear mirrors the IT choice (moto jackets); every site also has motorcycle rain wear, 177107.
   One save (Gloves · UK) was refused once because a product changed during its check; the retry saved it.
   Result: eBay rules cached for 20 of 20 category × site pairs, and **all 14 parent products show their eBay item specifics
   on all five sites** (46–63 columns; the 29-field generic set is gone).
5. Flat-file unpublished saves — **dropped** by the Owner (part of the native-file work).
6. Old product editor, old bulk-operations grid and the routes only they used — **deleted**, PR #118, merged 637bfd9a6 (−88,028 lines, 293 files;
   an import graph proves no mounted file lost an import).

## 11. How this was measured

- Live app, signed in, Xavia Racing (`/w/nexus_legacy_workspace`), `GET` only: `/api/products/:id/studio/columns`
  (252 reads), `/api/categories/schema/coverage`, `/api/listings` (all channels), `/api/listings/:id`,
  `/api/products/:id/sync-queue`, `/api/connections`, `/api/marketplaces`, `/api/pim/taxonomies` and
  `/api/pim/taxonomies/EBAY/:market/nodes`.
- Code at c63da5363.
