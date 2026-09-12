# 24 — Amazon PULL-FROM-CHANNEL (catalog/listings read by ASIN·SKU) + the non-AI "Pull from master"

Scope: the Amazon half of parity row 3.4, the `ImportFromAmazonModal` reverse-map, and the **non-AI**
"Pull from Master" half of `AutoFillCard`. AI generation is out (ruling #13, feature 09).
Twin: report `10-ebay-pull-live-preview.md` §6. **One verb design for both channels; the Amazon
differences are named in §6.4.**

## 1. What it is (operator terms)

A merchandiser opens a product on `Amazon · DE` and needs to answer two different questions that the
old page answered with the same button. **"What does Amazon actually hold for this listing right
now?"** — because someone edited it in Seller Central, or a feed half-landed, or we have never once
looked; and **"stop this coordinate being special — put the master value back."** The first is an
outward READ followed by an optional adopt-into-our-record; the second is purely local, an un-pin of
the override cascade. They are used at opposite moments (triage vs. cleanup), they cost completely
different things (an SP-API call vs. nothing), and collapsing them is how a "just have a look"
button becomes a write. There is a third thing wearing the same name — `ImportFromAmazonModal`
("Import attributes to master") — which fills an *empty master* from what we already store; it is a
bootstrap, not a refresh, and it never talks to Amazon at all (§2).

## 2. Old UI — inventory

**A. "Pull" on the channel listing tab** — `tabs/ChannelListingTab.tsx`
- Button: `:356-366` (`variant="secondary"`, `ArrowDownToLine`), beside `Translate`, in the listing
  header row. Handler `handlePullFromChannel` `:193-227` (Amazon branch).
- Calls `GET {API}/api/amazon/test-catalog-api?asin=${product.amazonAsin}` `:202`, through a
  429-aware retry helper `:166-190` (reads `Retry-After`, clamps 1–8s, retries **once**).
- **It writes nothing.** The whole success path is `setStatusMsg({kind:'success', text: 'Pulled
  latest title: "…"'})` `:216`. One field, echoed into a banner, discarded on close. CODE-READ.
- It is keyed on `product.amazonAsin`, which is the **parent, non-buyable** ASIN
  (`schema.prisma:92` — "parent-level: non-buyable parent ASIN"). The buyable child ASIN lives on
  `ProductVariation.amazonAsin` (`schema.prisma:1291`).
- It ignores the market switch: the route resolves `process.env.AMAZON_MARKETPLACE_ID ??
  'APJ6JRA9NG5V4'` (`amazon.routes.ts:553`), i.e. **Amazon IT**, whatever coordinate the tab shows.
- Round-trips: this one GET. Everything else here is browser-local state (`pulling`, `statusMsg`).

**B. `ImportFromAmazonModal`** — `_shared/cockpit-shell/ImportFromAmazonModal.tsx`, opened from
`tabs/MasterDataTab.tsx:492`
- Two modes (`:167-186`): `Flat file` → `POST /api/products/:id/master/import-from-flat-file`,
  `Amazon rules` → `POST …/import-from-channel` (`:61-66`). Source-market `Listbox` `:187-197`,
  defaulting to a hardcoded `EU_DEFAULTS` list `:37`.
- Proposal table with per-row checkboxes, **skip-by-default on conflict** `:76`, a `Skipped (n)`
  block with reasons `:247-258`. Apply → `PATCH /api/products/:id/global` with
  `{patch:{technical, <locale>:{…}}}` `:113-120`.
- 🔴 **Neither mode calls Amazon.** `proposeImportFromChannel` reads our own
  `ChannelListing.platformAttributes.attributes` (`reverse-mapping.service.ts:86-100`) and inverts
  the mapping rules. The label says "Import from Amazon parent"; the data source is our last push.
  CODE-READ.
- Not dead — it has an importer — but the diff/adopt shape here is the best existing spec for the
  confirm in §6.3.

**C. "Pull from Master"** — `tabs/amazon-cockpit/autofill/AutoFillCard.tsx`, mounted at
`tabs/amazon-cockpit/AmazonCockpit.tsx:637`
- Button `:425-437`, handler `handlePullMaster` `:193-215`, diff builder `diffFor` `:137-191`, diff
  modal + `handleApplyDiff` `:326-386`.
- Proposes `name`, `description`, `keywords` only. **Bullets are never proposed from master** —
  `proposed` `:196-205` has no `bullets` key — while the file header `:6-8` says "title /
  description / brand" and the card subtitle `:399` advertises "title + bullets + description from
  Master". The compositor explains why: "master doesn't have a bullet field today"
  (`useAmazonCompositor.ts:243-245`). Three descriptions, none matching the code. CODE-READ.
- Apply is browser-local: `setDraftField(productId, 'name'|'description'|…)` `:353-370` into the
  **master** draft bus — a module-scope `Map`, no `localStorage`, lost on reload
  (`_shared/draft-bus/useProductDraftBus.ts:36-58`). Persisting needs the header Save All.
- `keywords` is the exception and the worst of it: a fire-and-forget `PATCH /api/products/bulk`
  with `.catch(() => {})` and no `expectedVersion` `:341-352`.
- 🔴 **The verb is inverted.** It copies master into the *master* draft, and the Amazon cascade puts
  `listing.titleOverride` **above** the master overlay (`useAmazonCompositor.ts:213-222`). On a
  listing that is pinned — precisely when an operator reaches for "pull from master" — the button
  changes nothing on screen and never releases the pin. CODE-READ.

**D. Dead (no honest importer)** — `apps/web/src/app/api/sync/amazon/catalog/route.ts` proxies
`GET /api/amazon/products/list`, which is a pure Prisma read (`amazon.routes.ts:231-249`) and touches
no Amazon API, then reports `Fetched N products from Amazon`; `…/catalog/[syncId]/route.ts` returns
`status:'success', progress:100` for **any** id. Consumers are outside the studio
(`components/inventory/SyncTriggerButton.tsx:68,105`, `SyncStatusModal.tsx:41`). CODE-READ.

## 3. Backend that exists

**Reads against Amazon (all ungated by publish mode — the gate is on write paths only,
`amazon-sp-api.client.ts:568`, `:718`):**

| what | where | shape |
|---|---|---|
| `GET /api/amazon/test-catalog-api` | `amazon.routes.ts:542` | `getCatalogItem` v2022-04-01 **by ASIN**, `includedData:[relationships,summaries]`; default ASIN `'B0DYXSQP18'` when none given |
| `GET /api/amazon/products/test-catalog-api` | `amazon.routes.ts:468` | diagnostic twin: probes `summaries` and `relationships` separately and returns a `diagnosis` string |
| `POST /api/listings/:id/resync` | `listings-syndication.routes.ts:3068` | → `pullListingFromChannel` → `getListingState` (`amazon.service.ts:1249`) → `getListingsItem` `includedData:[summaries,attributes,offers]`, 10s timeout (`resync.service.ts:66-69`) |
| `POST /api/products/:id/live-channel-images/refresh` | `product-images-crud.routes.ts:1163` | → `refreshAmazonLiveImages` (`amazon-live-images.service.ts:64`) → `getListingsItem` **per (sku, marketplace)**, persists `ChannelLiveImage` |
| `POST /api/reconciliation/run` | `reconciliation.routes.ts:40` | catalog report → fallback `fetchCatalogViaListingsItems`, then `enrichProductFromAmazon` per matched SKU (`listing-reconciliation.service.ts:176`) |
| flat-file pull (UNTOUCHABLE) | `flat-file-pull-preview.service.ts:54` | `fetchListingForFlatFile` per SKU, **serial** `:157-177`; in-memory job + `FlatFilePullJob` recovery row |

Reader of record: **`fetchListingForFlatFile`** (`amazon.service.ts:1782-1836`) — keyed by
`(sellerId, sku, marketplaceIds:[explicit id])`, returns `{asin, attributes, title, listingStatus,
productType, relationships}`, and correctly reads the ASIN from `summaries[0].asin` `:1811-1815`.
`getCatalogItem` is the *catalog* record (contributed by any seller); `getListingsItem` is **our
offer on that market**. Only the second can answer "what does Amazon hold for our listing".

**What a pull writes today:**
- `resync` → `ChannelListing.price/quantity/title/listingStatus`, `syncStatus='IN_SYNC'`,
  `lastSyncedAt`, `version:{increment:1}` (`listings-syndication.routes.ts:3133-3155`) — **no diff,
  no confirm, no snapshot.** A `SyncAttempt` row and SSE `listing.syncing`/`listing.synced` are the
  only audit.
- reconciliation `enrichProductFromAmazon` → **master** `Product.name/description/bulletPoints/
  keywords/brand/manufacturer/ean/upc/weight*/dim*/categoryAttributes`, plus
  `ProductVariation.price/ean/upc/gtin`, plus `deleteMany` on `ProductImage` where
  `publicId:null, url contains 'amazon.com'` then `createMany`
  (`listing-reconciliation.service.ts:189-256`) — no diff, no confirm, no snapshot.
- `ChannelListingSnapshot` (`schema.prisma:1800-1841`) + `listing-snapshot.service.ts` is the
  correct undo store and already exists: `SNAPSHOT_FIELDS` `:69-82` covers `title, description,
  price, salePrice, quantity, platformAttributes, overrideData, flatFileSnapshot, *Override, all
  followMaster* flags, variationTheme` — i.e. everything a channel pull would write. Reasons
  `pre-publish | pre-restore | manual` `:28`. Routes: `GET/POST …/listings/:listingId/snapshots`
  and `…/snapshots/:snapshotId/restore` (`product-studio.routes.ts:705, 716, 741`), with a
  coordinate-mismatch 409 (`listing-snapshot.service.ts:50-58`).
- 🔴 `RESTORABLE_MASTER_FIELDS` (`restorable-fields.ts:15-22`) is **master scalars only** — the
  drawer's restore-points path cannot undo a channel pull. The snapshot path can.
- The one studio write path: `PATCH /api/products/bulk`, `target:'channel'` +
  `marketplaceContexts[{channel, marketplace, aliasKey}]` (`products.routes.ts:1010-1052`);
  `CHANNEL_FIELD_MAP` is **6 entries** (`channel-field-map.ts:23-36`); `attr_*` merges into
  `overrideData` and is refused without a marketplace context (`products.routes.ts:1490-1499`).

**Safety gates.** `amazonService.isConfigured()` = six env vars (`amazon.service.ts:339-348`), else
503. The SP-API client sets `auto_request_throttled:true` and `region:'eu'` hardcoded `:312-322`.
There is no dry-run flag on a read, and there should not be. **Jobs/crons:** none pull per product;
reconciliation is operator-triggered (`marketplace:'ALL'` fans out sequentially, ~25 min).

**Permissions (manifest, ordered prefixes).** `/api/amazon` → `listings.view` / `channels.sync`
`:353`. `/api/reconciliation` → `inventory.view` / `inventory.adjust` `:302`. `/api/products` →
`products.view` / `products.edit` `:412`. 🔴 **Three namespaces for one operator gesture** — the old
Pull reads under `listings.view` and would write under `products.edit`
(`reference_family_verbs_split_permissions`).

## 4. Studio today

- **Nothing on the sheet.** A grep of `_studio/**` for pull / catalog / drift returns only unrelated
  prose. `channelActions.ts` declares three verbs — `open-record`, `offer-toggle`,
  `broadcast-to-listings` (`:404`) — and no pull.
- **Parity:** 3.4 🕳 "*No pull-from-channel anywhere in the studio*" (`pes-parity-audit.md:122`);
  3.21 ⛔ (AI half is PES.8's, `:143`); 7.3 🔁 SUPERSEDED, with the sentence that hands me this
  feature: "*Non-AI 'Pull from Master' … flagging for PES.2/PES.3, who own master→channel copy*"
  (`:423`).
- **The vocabulary already exists, on the Amazon side, in the images lane.**
  `_studio/images/channel/amazon/channelTruth.ts:1-14` separates **STALE** (we published, master
  moved since) from **DRIFT** (Amazon's read-back vs our resolved cascade) and says why merging them
  loses the remedy. `ChannelTruthPanel.tsx:1-13`: "*'not checked' is not 'no drift'* … the live
  read-back cache is empty until someone refreshes it (measured on GALE-JACKET: 0 rows)"; the
  refresh is a READ, operator-triggered "because it spends an SP-API call and the answer keeps."
  Its button reads `Check Amazon` / `Check again` `:100`. **This is the pattern to extend, not to
  re-invent** — `feedback_shared_components_no_copy_props`.
- **The cascade is not "adopt master".** `CascadeCell.tsx:66-72` → `cascadeIntent`
  (`provenance.ts:187-206`): a pinned **aliasVariant** cell resets with `{action:'reset', target,
  value:null}` `:195`, and `describeCascade`'s own hint says "*Click to reset it to the alias
  value*" `:140-142`. Only on the band does a release reach master. So the prompt's premise needs
  correcting: **`intent:'reset'` releases ONE layer**; on a variant row an "Adopt master" needs both
  layers cleared. CODE-READ.
- Writes go through the one `SheetWriter` with `intent` first-class (`ChannelSheet.tsx:518-528`,
  `sheetWriter.ts:231-237`).
- **Registry is ready for this verb specifically.** `ActionImpact.payload` `:122` and
  `run(rows, impact?)` `:203` landed under ruling **#118**, whose text names pull-from-channel as
  the reason: without a payload channel "*pull-from-channel must fetch the channel TWICE — and the
  second call is the one that gets throttled … it opens a TOCTOU the confirmation cannot cover*"
  (`pes-claims.md:20203-20211`). `contextOf(axis)` `:42` gives CONTEXT scope.
- **Rulings that bind:** **#86** triage order `3.47 snapshot/restore → 3.4 pull-from-channel →
  3.13n broadcast → 3.38n lock` and "*a sheet is the wrong shape for per-listing operations*"
  (`pes-claims.md:21040-21063`). **#105 D3**: "*import-from-Amazon … consciously queued post-swap —
  decided, not lost*" (`:20549`), same ruling that signs off "*no direct Amazon submit*" and
  "*promote-to-master inversion*" (`:20555`). **#110** action registry / snapshot doctrine.
  **#114** a disabled verb with a reason teaches; the lane declares `invalidates` granularity.
  **#118** COLLECT → PREFLIGHT → CONFIRM → RUN. **#123** channel verbs need `products.edit`, and
  `PermissionState` has four members including `no-session` (`channelActions.ts:44-68`).
  **#58** the `affectsAllChannels` acknowledgement (`ChannelSheet.tsx:531-541`). **#127** the
  Errors & Sync console is sync-queue-first because the other panes measured zero.

## 5. Defects and slowness

1. 🔴 **The old Pull calls the wrong API and is a debug route.** `test-catalog-api` is
   `getCatalogItem` by ASIN — the shared catalog record, not our offer — reached through a route
   literally named `test-`, which defaults its ASIN to `'B0DYXSQP18'` when absent
   (`amazon.routes.ts:544`). CODE-READ.
2. 🔴 **It reads the wrong market.** `AMAZON_MARKETPLACE_ID ?? 'APJ6JRA9NG5V4'`
   (`amazon.routes.ts:553`) — Pull on Amazon·DE returns IT. CODE-READ.
3. 🔴 **It reads the wrong ASIN.** Keyed on the parent, non-buyable ASIN
   (`ChannelListingTab.tsx:202` + `schema.prisma:92`). CODE-READ.
4. 🔴 **`externalListingId` means two different things on Amazon.** `resync.service.ts:120-126`
   treats it as the **seller SKU**; `confirmReconRow` writes the **parent ASIN** into it
   (`listing-reconciliation.service.ts:487-524`). A resync on a recon-confirmed Amazon listing calls
   `getListingsItem(sellerId, <ASIN>)` and the row lands in `syncStatus:'FAILED'`. CODE-READ —
   never measured against prod, but the two writers cannot both be right.
5. 🔴 **`getListingState().asin` reads a path the codebase elsewhere documents as wrong**:
   `res.asin` (`amazon.service.ts:1310`) vs `summaries[0].asin` with the explanatory comment
   (`:1811-1815`). So `RemoteListingState.externalId` is always null and the "remote no longer
   recognises this listing" detection its own interface documents (`resync.service.ts:38-42`) can
   never fire. The route never reads it either — dead twice. CODE-READ.
6. 🔴 **A CONFIRMED reconciliation row's channel-side data freezes forever.** CONFIRMED SKUs are
   filtered out *before* the upsert (`listing-reconciliation.service.ts:334-342`), so
   `channelPrice / channelQuantity / channelStatus / title / updatedAt` never move again — while the
   service header claims only operator decisions are preserved `:16-17`. Any drift column built on
   `ListingReconciliation` would be most stale exactly on the listings an operator manages
   (`reference_stale_measurement_looks_like_a_missing_one`). CODE-READ.
7. 🔴 **Two existing pulls write with no diff, no confirm and no snapshot** — `resync`
   (`listings-syndication.routes.ts:3133`) onto the listing, `enrichProductFromAmazon` onto the
   master *plus a `deleteMany` on images* (`listing-reconciliation.service.ts:238-244`). The
   snapshot service that would make them undoable already exists and neither calls it. CODE-READ.
8. **"Pull from Master" is inverted and mislabelled** — items C in §2: writes the master draft, not
   the coordinate; never releases `titleOverride`; no bullets despite three claims that it copies
   them; `keywords` written fire-and-forget with a swallowed error and no `expectedVersion`.
   CODE-READ.
9. **"Import from Amazon" never touches Amazon** (`reverse-mapping.service.ts:86-100`), and its
   content half silently drops most of the EU: `localeForMarket` returns `null` for DE/ES/FR/NL/SE/
   PL/BE/AT (`:64-70`), so on those markets every content proposal is skipped with a reason while
   attributes still import. CODE-READ.
10. **N+1 by construction, and it cannot be avoided.** `getListingsItem` is keyed by seller SKU, so
    a 21-row family is 21 calls. Both existing implementations run them **serially**
    (`flat-file-pull-preview.service.ts:157-177`, `listing-reconciliation.service.ts:432-436`) — the
    right choice, and it means a family pull is seconds, not milliseconds. CODE-READ.
11. **Retry-once is not rate-limit handling.** `fetchWithRateLimitRetry`
    (`ChannelListingTab.tsx:166-190`) retries a single time and then tells the operator to come back
    in a minute. The library-level `auto_request_throttled` (`amazon.service.ts:321`) is the real
    mechanism and the browser path bypasses it. CODE-READ.
12. **No test covers a pull's diff or its adopt.** `grep` finds vitest files for
    `flat-file-pull` round-trips and `channelTruth`, none for `resync.service` or
    `enrichProductFromAmazon`. CODE-READ.
13. **`instrumentSellingPartner` logs every call under `process.env.AMAZON_MARKETPLACE_ID`**
    (`amazon.service.ts:326-329`), not the marketplace actually called — so `OutboundApiCallLog`
    attributes a DE pull to IT. CODE-READ.

## 6. Proposed home in the studio

### 6.1 Primary home + mirrors

**A — Pull from Amazon: primary `H4 SELECTION`, mirrored `H3 ROW` and `H5 CONTEXT(alias-group)`,
at rest `H2`, depth `H7`, backlog `H9` (later).**

Same verb id, same column, same confirm as report 10 — one design, two readers. What differs is
which scope is *primary*, and the reason is mechanical rather than stylistic. On eBay a
multi-variation listing is **one ItemID** and one `GetItem` returns the whole variation set, so the
alias band is one round-trip and H5 leads. On Amazon the buyable unit is the **child**: images are
stored per child ASIN and "the parent SKU often returns no images (parent is structural, not
buyable)" (`amazon-live-images.service.ts:93-96`), and the only reader that answers for our offer,
`getListingsItem`, is keyed by **seller SKU** (`amazon.service.ts:1798-1806`). A family pull is
therefore N calls whichever control starts it. So the honest primary is the **selection** — the
operator ticks the rows they mean and the confirm can say "21 SKUs = 21 Amazon calls, ~20s" — with
`H3 ROW` for triaging one line, and `H5 CONTEXT(alias-group)` kept as the convenience that expands
to the same fan-out **and names the cost in its own preflight**. Declared once in `channelActions.ts`
and rendered on the row menu, the `⋯` column, the selection bar and `RecordActions` with no second
declaration (ruling #110; a verb must never live only in the drawer).

**B — "Pull from master": the existing `H1` cascade mark stays primary; add ONE new `H4 SELECTION`
verb, "Adopt master for selected cells".** The per-cell affordance already exists and works
(`CascadeCell.tsx`); what does not exist is the bulk form, and the audit hands that to
PES.2/PES.3 (`pes-parity-audit.md:423`). It is not a channel operation at all — no marketplace call,
no preflight fetch — so it must **not** share the pull's surface, its confirm level or its column.
Its one subtlety is §4's correction: on a variant row, releasing the pin lands on the **alias**
value, so the verb clears *both* the aliasVariant and the alias layer in one batch and says so in
the confirm. Anything else is the same "looked like it worked" failure as defect 8.

**C — `ImportFromAmazonModal` → `H12 Drop`, with its capability re-homed.** Ruling #105 D3 already
parked it post-swap. Its actual function — fill an empty master by inverting the mapping rules — is
PES.6's (mapping) and belongs at `/channels/mapping` where the rules live, not in a per-product
modal that claims to talk to Amazon and does not. The *diff-with-checkboxes, skip-by-default*
interaction is the best thing in the old tree and is reused verbatim by A's confirm.

### 6.2 What the sheet shows at rest, per scope

| scope | at rest |
|---|---|
| **master** | Nothing. Master is not a channel; the pull returns `HIDDEN`. No column, no mark. |
| **Amazon · market, variant rows** | ONE `H2` column, **`Channel check`** — same id, same three states and same tooltip grammar as eBay's: `—` never checked · `✓ matches` · `⚠ N differ`, tooltip naming the drifted fields. Read-only and derived: no editor, never in the fill handle, no provenance mark. Sortable + filterable. |
| **Amazon · market, alias band** | Two facts, never merged into one number (`channelTruth.ts:1-14`): a `Pill` reading `checked 2h ago` / **`never checked`**, and — only after a check — `⚠ 3 fields differ`. `never checked` is first-class, not a clean bill of health. |
| **Amazon · market, globals** | Rows whose only differing fields are account-global (quantity, images) render `✓ matches` for the per-market fields and carry the global diff **once**, on the band, labelled "one value for all EU markets" (§6.4). |
| **eBay / Shopify** | Same column, same verb id. Shopify's verb is `DISABLED` with a reason, never hidden (ruling #114, `registry.ts:227-229`). |

Plus a view chip `Drift (N)` in the existing chip row (`channel/viewChips.ts`), obeying that
module's honest-count rule: `count: null` when nobody has checked, never `(0)`.

### 6.3 The interaction, step by step

**Pull.** Tick rows → selection bar → **Pull latest from Amazon** (or right-click one row, or the
band, or `RecordActions` in the drawer).

1. **COLLECT** — none. The rows *are* the parameter.
2. **PREFLIGHT** — ONE server call, `POST /api/products/:id/channel-pull/preview` (the same path
   report 10 proposes), which fetches Amazon once per SKU, persists the read-back, computes the diff
   and returns it. The verb builds `ActionImpact`: `title` = *"Pull Amazon · DE for 4 of 21 SKUs
   (4 Amazon calls)?"*; `findings[]` = one per differing field — ``Title — Amazon: "GALE Pro…" ·
   ours: "GALE Pro Racing…"`` — `severity:'warn'` when the target is **pinned**, `'info'` when it is
   inherited or empty; `consequences[]` names the fields that will be written; `sideEffects[]` names
   what the operator did not ask for (adopting bullets sets `followMasterBulletPoints = false`,
   `channel-field-map.ts:38-45`); `payload` = the read-back id + resolved per-field values, so
   **RUN applies exactly the snapshot that was approved** (#118). `level` is derived, never fixed:
   `'confirm'` when nothing pinned is touched, `'type-to-confirm'` with `confirmPhrase` = the
   **child ASIN** when it is (a real value, never "DELETE" — `registry.ts:126`). A failed fetch sets
   `unavailable` and the verb does not run. It also refuses with `unavailable` while the row has
   queued autosave cells — the in-flight-autosave-undoes-a-bulk-apply trap is banked.
3. **CONFIRM** — `ActionConfirm` from the sheet, `DrawerConfirm` from the drawer. The findings list
   is **checkable** (DS `Checkbox` per finding, skip-by-default on a pinned target, exactly
   `ImportFromAmazonModal.tsx:76`). Unchecking everything degrades the verb to "just record the
   check" — a legitimate outcome, already modelled by `FlatFilePullRecord.appliedAt = null`
   (`schema.prisma:13990`).
4. **RUN** — take a `ChannelListingSnapshot` with `reason:'manual'`, label "before pull from Amazon
   · DE" (`listing-snapshot.service.ts:109`), **then** write the adopted fields through the one
   write path: `PATCH /api/products/bulk`, `target:'channel'`, `marketplaceContexts` with the
   coordinate's `aliasKey`. No pull-specific write path — a second write path is a second
   provenance story (`ComparePane.tsx:39-42`). The snapshot id goes in the result so the toast can
   offer "Undo".
5. **REPAINT** — `invalidates:{kind:'page'}` (this scope has no row-level refetch and says so,
   `registry.ts:130-139`); adopted cells repaint with their new provenance and `Channel check`
   flips to `✓ matches` for rows that now agree.

DS components: `Menu`/`MenuItemDef`, `BulkActionBar`, `Modal` via `ActionConfirm`, `Checkbox`,
`Pill` + `Badge`, `Tooltip`, `Spinner`, `Banner` for a partial result ("Amazon answered for 3 of 4
SKUs — 1 was throttled"), `EmptyState` for never-checked. Keyboard: `useActionPress`; the confirm is
a focus-trapped DS `Modal` with Esc; **nothing bound to a bare key** — a marketplace round-trip must
never be one keystroke away. With the drawer open the sheet stays live behind it.

**Adopt master for selected cells.** Select a rectangle → selection bar → preflight is **local**
(no fetch, so `level:'confirm'` and instant): *"Release 12 pinned cells on Amazon · DE back to
master? 3 of them are pinned at the variant level and also at the alias level — both are cleared."*
RUN batches `intent:'reset'` writes through the same `SheetWriter`, two layers where needed. No
snapshot (nothing outward-facing happens; ⌘Z and the History pane are the undo).

### 6.4 Per-scope rules

- **Master:** pull `HIDDEN`, no column. "Adopt master" `HIDDEN` (there is nothing to adopt from).
- **Alias band vs variant row:** the *verb* is one id with one preflight; the **reader branches on
  the server**: a row with a child seller SKU is read with `getListingsItem`; a band with only a
  parent ASIN and no children is read with `getCatalogItem` and the confirm says so ("this is
  Amazon's catalog record, not your offer"). No client re-derives that branch.
- 🔴 **Pan-EU makes some fields NOT per-market, and the pull must classify every field it offers.**
  Amazon holds merchant quantity at `(sellerId, SKU)` for the whole EU region — proved 2026-07-26:
  zeroing DE zeroed IT (`reference_amazon_shared_eu_quantity`) — and maps images to the **ASIN
  globally, even when a `marketplace_id` selector is supplied** (`amazon-global-images-shared-asin`,
  SP-API Listings FAQ). Title / description / bullets / keywords *are* per-market: the attribute
  wrapper carries `marketplace_id` + `language_tag`, which both readers strip as infrastructure
  (`flat-file-pull-preview.service.ts:180`, `reverse-mapping.service.ts:47-61`). Consequence: a
  drift column that includes quantity or images would light up on all five EU coordinates for **one**
  underlying fact, and let an operator "adopt" it five times. So the spec must carry a per-field
  `scope: 'per-market' | 'account-global'`, the column counts only per-market diffs per row, and
  globals are shown once on the band and are **never adoptable per market**. This is the single most
  Amazon-specific rule in the design and it has no eBay counterpart.
- **A contract field can vary by market** (`reference_contract_field_varies_by_market`): the
  per-market/global classification must come from the channel adapter per coordinate, not a
  hardcoded list — a hardcoded set of field names is a set claim that goes stale in hours.
- **Shell aliases / never-published rows:** the pull is *most* valuable here, and the confirm must
  say "this will populate 0 rows — it records what Amazon holds" rather than looking like a failure.
- **Single-store channels (Shopify):** no market dimension; column reads `—` with a reason.

### 6.5 Provenance / autosave / readiness / publish

- **Provenance.** An adopted value is a normal channel write and takes the normal `✎ pinned` mark on
  the layer it landed on. It gets **no** new "from channel" glyph — the layer union is the server's
  (`drawer/types.ts:294-296`); *that it came from a pull* belongs to the snapshot and the History
  pane, not to the cell's identity. The `Channel check` column carries no provenance mark at all.
- 🔴 **Ruling #58 constrains what may be adopted.** `CHANNEL_FIELD_MAP` has six entries, so most
  columns on a channel scope route to **master** — 399 of 441 measured on eBay·IT
  (`ChannelSheet.tsx:531-541`). A pull that adopted a master-routed field would write Amazon's value
  into every channel. So the preflight **filters findings to fields with a channel write route**
  (`isChannelWritable`, `channel-field-map.ts:58-60`) and lists the rest as *"Amazon differs here,
  but this field is stored once for all channels — adopt it from the master scope"*. A disabled
  finding with a reason teaches; a silently-dropped one does not.
- **Autosave.** RUN writes through `SheetWriter` with `expectedVersion`; a 409 repaints and refetches
  as any cell edit does. The verb refuses while the row has queued cells (§6.3.2).
- **Readiness.** Untouched. ONE server definition (`services/pim/readiness.service.ts`); drift is not
  an issue class in it. A drifted listing can be perfectly ready and a ready one can have drifted —
  merging them repeats the STALE/DRIFT collapse `channelTruth.ts:9-13` warns against.
- **Publish.** A pull is a READ and is available in **every** publish mode including `gated` — the
  gate sits on `submitListingPayload`/`patchListingPrice` only (`amazon-sp-api.client.ts:568,718`).
  Nothing on either surface publishes; `AliasPublishControl` stays the only publish entry, and the
  mode still comes from `getAmazonPublishMode()`, never env.

### 6.6 ASCII mockup

```
┌ Amazon · DE ────────────────────────────────────────────────────────────────────────────┐
│ 21 rows · 4 selected  [View ▾][Missing required (7)][Drift (3)]  Find…  [Customise] […] │
├──────────────────────┬──────────┬─────────────┬──────────┬─────────┬───────────────────┤
│ ▾ ① GALE-KAN-PRO     │ ● Active │ ✎ item_name │ 🔗 price │ Ready   │ Channel check     │
│   ASIN B0C… (parent) │          │             │          │  84%    │ ⚠ 3 differ · 2h   │
│   ├ …-PRO-N-S  B0D1… │ ● Active │ GALE Pro R… │ € 249.00 │ ⚠       │ ⚠ 2 differ        │
│   ├ …-PRO-N-M  B0D2… │ ● Active │ GALE Pro R… │ € 249.00 │ ✓       │ ✓ matches         │
│   └ …-PRO-N-L  B0D3… │ ● Draft  │ GALE Pro R… │ € 249.00 │ ⚠       │ — never checked   │
│ ▸ ② GALE-KAN-ALT     │ ○ Draft  │  no children — Amazon holds a catalog record only    │
└──────────────────────┴──────────┴─────────────┴──────────┴─────────┴───────────────────┘
 selection bar ▸ [Pull latest from Amazon]  [Adopt master for selected cells]  [Broadcast…]

┌ CONFIRM ─────────────────────────────────────────────────────────────────────┐
│ Pull Amazon · DE for 4 of 21 SKUs?   4 Amazon calls, about 8s                │
│ 3 fields differ — tick what to adopt:                                        │
│  ☑ item_name           Amazon "GALE Pro Racing…"  ·  ours "GALE Pro Suit" ✎  │
│  ☐ product_description Amazon 4,102 chars         ·  ours 3,880 chars     🔗 │
│  ☑ bullet_point        Amazon 5 bullets           ·  ours 4                ✎ │
│  ⃝ quantity  Amazon 4 · ours 6 — ONE value for all EU markets; not adoptable │
│    here (adopting would change IT/FR/ES/UK too).                             │
│  ⃝ color    stored once for all channels — adopt it from the Master scope.    │
│ Also happens: adopting bullets turns off "follows master" on this listing.    │
│ A restore point is taken first.   Type the ASIN ▸ [ B0D1…  ]  [Cancel][Pull] │
└──────────────────────────────────────────────────────────────────────────────┘
```

## 7. Contracts and data

**Reused as-is.** `fetchListingForFlatFile` (`amazon.service.ts:1782`) as the per-SKU reader.
`getCatalogItem` for the childless/parent-only band case. `captureSnapshot` / `listSnapshots` /
`restoreToDraft` + `SNAPSHOT_FIELDS` for the restore point. `PATCH /api/products/bulk` with
`target:'channel'` + `marketplaceContexts` as the only write. `isChannelWritable` as the
adopt filter. `ActionImpact.payload` + `run(rows, impact?)`. `ChannelTruthPanel`'s
never-checked/stale/drift grammar.

**New, server (PES.5).**
1. `POST /api/products/:id/channel-pull/preview` `{channel, marketplace, aliasKey, rowIds[]}` →
   `{readBackId, checkedAt, perRow:[{rowId, sku, asin, reachable, fields:[{key, label, channelValue,
   ourValue, differs, writable, scope:'per-market'|'account-global', pinnedHere}]}], errors[]}`.
   Under `/api/products` so **one** permission (`products.edit`) covers read and write — the fix for
   §3's three-namespace split. Serial per SKU, capped, partial results returned.
2. `POST /api/products/:id/channel-pull/apply` `{readBackId, accept:[{rowId, fieldKey}]}` — snapshots
   then delegates to the same bulk-write code path; returns `{snapshotId, written, refused[]}`.
3. `GET /api/products/:id/channel-check?channel&marketplace` — the at-rest feed for the H2 column
   from the stored read-back. **Never** from `ListingReconciliation` (defect 6).
4. **Additive schema** — one model, `ChannelLiveField`, deliberately shaped on the existing
   `ChannelLiveImage` (`schema.prisma:4876-4916`): `productId, channel, marketplace?, externalSku?,
   asin?, fieldKey, value Json, etag?, fetchedAt`, `@@unique([productId, channel, marketplace,
   externalSku, fieldKey])`. Additive only, so pre-approved.
5. Per-field `scope` on the channel adapter's `ChannelFieldSpec`
   (`docs/2026-09-04-channel-attribute-model-design.md`) — the per-market/global classification,
   derived per coordinate, never a hardcoded name list.

**Lane split.** PES.5 — the four endpoints, the model, the reader branch, the field classification.
PES.3 — `channel-pull` and `adopt-master-cells` in `channelActions.ts`, the `Channel check` column,
the `Drift (N)` chip, the two-layer reset. PES.2 — nothing new required (registry, `ActionConfirm`,
`BulkActionBar` and `ProvenanceMark` all exist); a checkable `findings` list in `ActionConfirm` is
the one substrate ask. PES.4 — the `Channel truth` drawer pane and the snapshot-undo row. PES.7 —
owns the images half already and should be consulted so the two `channelTruth` modules become one.
PES.6 — inherits `ImportFromAmazonModal`'s reverse-map at `/channels/mapping`. PES.1 — nothing.

## 8. Risks and traps

1. **A pull is a read, but the surface around it is one click from a write.** Endpoint safety is not
   interaction safety (`reference_endpoint_safety_is_not_interaction_safety`): a blur on a field
   inside a "preview" panel has already committed to prod in this programme. The diff must be
   rendered with non-editable controls only.
2. **Local dev writes the production database and calls the real Amazon account.** Any exercise of
   `apply` from a dev browser is a real write to real listings; SP-API reads are real calls against
   the real rate budget. Verify on prod, deliberately, per `feedback_verify_on_prod_not_docker`.
3. **EU shared quantity and global images** — §6.4. Getting this wrong lets an operator zero five
   marketplaces from a DE screen, which is the exact incident already proved once.
4. **Ruling #58** — an adopt on a master-routed field rewrites every channel. §6.5.
5. **Defect 4's identity conflict** must be settled *before* a new reader lands, or the new pull
   inherits it. Whatever `ChannelListing.externalListingId` holds on Amazon, the pull must take the
   SKU from the row, not from that column.
6. **TOCTOU** — without `payload`, preflight and run fetch twice and the operator approves a
   snapshot that is not what lands (#118). The type supports it now; the verb must use it.
7. **Untouchables** — the flat-file editors keep their own pull; reuse their *service*, never edit
   their routes, pages or UI. FBA quantity logic and the existing import flows are off-limits.
8. **AI stays dark** — nothing here generates; the `✦ AI draft` provenance and a pull's `✎ pinned`
   must not be conflated.
9. **Throttling** — a family pull is N serial calls; `auto_request_throttled` handles the retry but
   the operator sees seconds. Say the cost in the confirm; never fire on load.
10. **A cold API reads as DOWN** and a quiet measurement is not a negative result — an empty
    `Channel check` must render `— never checked`, never `✓ matches`.

## 9. Open questions for the Owner (max 3)

1. **Does the studio pull adopt onto the CHANNEL only, or may it also propose to master?**
   Recommendation: **channel only**, wave 1. Master-routed differences are *listed and refused with
   a reason* (§6.5). Adopting to master is `enrichProductFromAmazon`'s unreviewed behaviour with a
   dialog in front of it, and the swap already removed one such path as an improvement (7.3).
2. **Does the pull get its own restore point, given ruling #105 D3 put snapshot/restore first?**
   Recommendation: **yes, reuse `ChannelListingSnapshot` with `reason:'manual'`** — the store, the
   coordinate guard and the routes already exist, and a pull is the second outward-facing-consequence
   verb after publish. The drawer's restore-*points* path cannot help (master scalars only).
3. **Do the two existing silent pulls get fixed now or flagged at swap?** `resync` and
   `enrichProductFromAmazon` both write channel/master data from Amazon with no diff, no confirm and
   no snapshot, and both remain reachable after the swap. Recommendation: **flag now, fix in PES.5's
   pass** — add a `captureSnapshot` call to `resync` (one line, same store) and leave reconciliation
   alone until its own surface is rebuilt; do not let the studio's honest pull ship beside two
   dishonest ones without the Owner knowing.

## 10. Effort and dependencies

| piece | lane | size |
|---|---|---|
| `POST channel-pull/preview` + per-SKU reader branch (reuses `fetchListingForFlatFile`) | PES.5 | **M** |
| Per-field `scope` classification (per-market vs account-global) on the adapter | PES.5 | **M** — the Amazon-specific risk lives here |
| `ChannelLiveField` model + `GET channel-check` | PES.5 | **S** |
| `POST channel-pull/apply` (snapshot → bulk write → refused list) | PES.5 | **S** |
| `channel-pull` verb (ROW/SELECTION/CONTEXT, one declaration) | PES.3 | **S** |
| `Channel check` column + `Drift (N)` chip | PES.3 | **S** |
| `adopt-master-cells` selection verb, two-layer reset | PES.3 | **S** |
| Checkable `findings` in `ActionConfirm` | PES.2 | **S** |
| `Channel truth` drawer pane (extends PES.7's, does not fork it) | PES.4 + PES.7 | **M** |
| Retire `ImportFromAmazonModal`, re-home the reverse-map | PES.6 | **M**, post-swap (#105 D3) |

**Dependencies.** Feature 10 (eBay pull) — same verb, same column, same endpoints; they must land as
one design or the column becomes eBay-shaped. Feature 06 (publish snapshot/restore) — the restore
point; ruling #86 puts 3.47 ahead of 3.4 for exactly this reason. Feature 09 (AI) — must not share
this surface. PES.7's images `channelTruth` — one module, not two. The
channel-attribute-model design (approved 2026-09-05) — the `ChannelFieldSpec` that carries `scope`.
Blocking prerequisite: defect 4's `externalListingId` ruling.
