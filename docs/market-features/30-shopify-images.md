# 30 — SHOPIFY IMAGES (and the Shopify channel scope generally)

## 1. What it is (operator terms)

A Shopify product has ONE ordered picture list — the **pool** — shared by the whole storefront, and
position 1 of it is the featured image (search, collection tiles, social cards). Separately, each
**variant** may point at exactly one picture from that pool, which is what swaps in when a buyer picks
a colour. So the operator's two decisions are *"what order is the pool in, and which pool picture does
each colour point at"*. There is **no market dimension** — one shop is one channel connection
(`ShopifyListingsClient.tsx:4-8`) — and no per-variant gallery: eBay's twelve positions per colour have
no Shopify equivalent, one image per variant is the whole model. The cap is 250 pool images
(`packages/shared/image-validation.ts:73-82`). Shopify's *second* dimension is not markets but
**locations** (stock), which is a fulfilment surface, not a content one (§6.4).

## 2. Old UI — inventory

**Entry point:** old edit page → Images tab → Shopify channel tab. `tabs/ImagesTab.tsx:781` mounts
`tabs/images/shopify/ShopifyPanel.tsx` (774 L; the file's own header at `:1-13` is the clearest spec of
the model in the repo).

| Interaction | file:line | Round-trips? |
|---|---|---|
| Pool tiles, `★1` badge on position 1, ×10-spaced positions | `:227-247`, `:449-475` | no — client staging |
| Pool DnD reorder (whole pool renumbered dense 0..N) | `:206-249` | no |
| Upload → master row then staged into the pool | `:250-266` | `POST /products/:id/images?type=ALT` |
| Add from master / DAM (`ImagePickerModal`) | `:722-738` | no |
| Remove from pool | `:497-505` | no |
| Per-colour **Assign / Change / Clear**, one image per colour | `:279-311`, `:563-586` | no |
| Empty-pool **master preview** rows (dashed + chain glyph, IE.3) | `:158-170`, `:481-492` | no |
| 250-usage bar | `:336-346` | no |
| Validation banner (hard-fail/soft-warn) | `:376-382` (`ChannelValidationBanner`) | client, `@nexus/shared` |
| Stale banner (`master.updatedAt > publishedAt`) | `:385-392` | client, from workspace |
| **Pre-publish preview modal** | `:741-763` (`ChannelPublishPreviewModal`) | client-side resolution |
| **Rollback ("Revert")** | `:680-690` → `ImagesTab.tsx:817` `setRollbackTarget` | **localStorage snapshot** |
| Live-on-Shopify strip + Refresh | `:359-373` (`LiveChannelStrip`, `marketplaces={['GLOBAL']}`) | `POST /live-channel-images/refresh` |
| Buyer preview (stylised storefront) | `:626-635` (`ChannelPreview`) | client |
| Publish history + recent-jobs strip | `:652`, `:658` | `GET /image-publish-jobs` |
| Cross-channel copy (Master→Shopify, Amazon pool/assignments→Shopify) | `:600-611`, `ImagesTab.tsx:795-797` | `POST /images-workspace/copy-scope` |
| Publish | `:692-712` → `ImagesTab.tsx:803-808` | `POST /shopify-images/publish` |

**Browser-local only:** the staged `pendingUpserts`/`pendingDeletes` working copy, the rollback
snapshots, auto-publish and approval prefs.

**Not dead here.** Report 02 found the four shared channel surfaces are *declared* for eBay+Shopify and
mounted on **neither** for eBay. For Shopify they ARE mounted — `ShopifyPanel.tsx:27,28,29,658` is the
sole importer of `ChannelValidationBanner`, `ChannelPublishPreviewModal`, `ChannelStaleBanner` and
`RecentChannelJobsStrip`. So Shopify is the only channel where inventory §2.5's "REAL" grade is true —
and it is the reason those components cannot be deleted at swap.

## 3. Backend that exists

**Routes** (prefix `/api`)
- `POST /products/:productId/shopify-images/publish` — `routes/images/channel-image-publish.routes.ts:97-137`.
  Body `{ activeAxis? }`. **No `marketplace` query, correctly** — no market dimension. 200/422/500.
- `GET /products/:productId/images-workspace` — carries `shopifyProductId` (`images-workspace.routes.ts:105`)
  and `shopifyVariantId` per variant (`:152`). `bulk-save` / `copy-scope` are channel-generic.
- `GET|POST /products/:id/live-channel-images[/refresh]` — `product-images-crud.routes.ts:1199-1207`
  dispatches `SHOPIFY` to `refreshShopifyLiveImages`. **Wired** (see §5.7).
- `GET /products/:id/image-publish-jobs` + `POST /image-publish-jobs/:jobId/retry` — unified, includes SHOPIFY.
- `GET /api/stock/shopify-locations` · `POST …/discover` · `PATCH …/:id` — `stock.routes.ts:2685,2699,2723`.
- `GET /api/listings/publish-readiness` — `listings-syndication.routes.ts:2668` returns
  `shopify: { enabled, mode: getShopifyPublishMode(), configured }`.
- **No** `shopify-images/validate`, `/preview` or `/stale` route. Amazon has all three
  (`routes/images/amazon-images.routes.ts:320,371,406`).

**Services**
- `services/images/shopify-image-publish.service.ts` (238 L) — the real path. Two sequential live REST
  writes with **raw `fetch`**: `PUT /admin/api/2024-01/products/{id}.json` with `{ images: [{src}] }`
  (`:117-133`) which **REPLACES the product's entire image set**, then per assignment
  `PUT /variants/{id}.json` with `image_id` (`:194-206`). Matches pool→Shopify ids **by array index**
  (`:161-171`).
- `services/images/shopify-live-images.service.ts` (236 L) — `GET /products/{id}.json` → `ChannelLiveImage`;
  pool rows `slot = position` (1-based), variant rows `externalSku = variant.sku, slot = variant.id`;
  honest `skipped: 'NO_CREDS' | 'NO_PRODUCT_ID'` (`:16-20`).
- `services/shopify-publish-gate.service.ts` — **`getShopifyPublishMode()` EXISTS** (`:31-37`,
  default-safe `gated` → `dry-run` → `live`), plus a token-bucket limiter (`:66`) and a circuit breaker
  (`:137`). Landed 2026-06-16 (`bc330228c`, "PD.4 — Shopify publish-mode gate").
- `services/outbound-sync.service.ts:1826-1960` — the **safe sibling**: the same
  `PUT /products/{id}.json`, but mode-gated (`:1833-1838`, returns `SKIPPED`/`dryRun`), circuit-checked
  (`:1856`), rate-limited (`:1863`), and `writeAttemptLog`-audited with mode + payload digest (`:1946`).
- `services/shopify-locations.service.ts` — `discoverShopifyLocations`, `resolveByShopifyId`; webhook
  consumer `routes/shopify-webhooks.ts:172-198`.

**Prisma.** `Product.shopifyProductId` (`schema.prisma:95`), `ProductVariation.shopifyVariantId` (`:1293`).
Shopify images are `ListingImage` rows `scope: PLATFORM, platform: 'SHOPIFY', marketplace: null`; pool =
`variantGroupKey: null, variationId: null` ordered by `position`; assignment = `variantGroupKey: <axis>,
variantGroupValue: <colour>, position: 0`. `ChannelImagePublishJob{ channel: 'SHOPIFY',
vendorEntityId: shopifyProductId }`. `ChannelLiveImage` (`:4876`) — `marketplace` "Null for eBay +
Shopify"; `StockLocation` (`:8431`) `type: 'SHOPIFY_LOCATION'`, `externalLocationId`, `externalChannel`.
**No schema change is needed for anything in §6.**

**Jobs/crons.** `jobs/scheduled-image-publish.job.ts:93-94` fires `publishShopifyImages`, **default-OFF**
behind `NEXUS_ENABLE_SCHEDULED_IMAGE_PUBLISH=1` (`:144`).

**Permissions** (`lib/auth/permissions-manifest.ts`, first-match-wins, `has = includes`, `:34`).
`/api/products/:id/shopify-images/publish` contains `-images/`, **not** `/images`, so it misses
`P(F.productsImagesEdit, has('/images'))` at `:380` and falls through to
`RW(F.productsView, F.productsEdit, pfx('/api/products'))` at `:412`. **A live Shopify image publish
that replaces the storefront's picture set needs only `products:edit`** — while the job LIST needs
`marketingPublish` (`:164`). Identical to report 02's eBay finding. (CODE-READ.)

## 4. Studio today

- **Images tab, Shopify scope: an honest statement, not a grid.** `_studio/images/ImagesTab.tsx:158-165`
  renders "The Shopify image scope is the remaining P4 surface — a product-level pool plus per-colour
  variant assignment… This product has no Shopify image rows yet."
- **But the Shopify scope is barely reachable.** `StudioBar.tsx:74-80` disables a channel chip when
  `!c.markets.includes(market)`. Shopify's only `Marketplace` row is the seeded `GLOBAL` pseudo-market,
  and `defaultMarket` **never lands on GLOBAL** by design (`scopes.ts:171-176`). Worse:
  `contracts.tsx:626` falls a `?scope=SHOPIFY&market=IT` deep link **silently back to Master**, and
  `setMarket`'s `strands` branch (`:863-867`) DROPS the Shopify scope the moment the market moves off
  GLOBAL. So the only reachable Shopify coordinate is `market=GLOBAL`, where Amazon and eBay both go
  disabled — the market switcher works as a channel-family toggle. (CODE-READ.)
- **The disabled chip's reason is a market statement and it is only in a tooltip.**
  `ScopeBar.tsx:97` puts `disabledReason` in `title` alone; the chip is `opacity: .5`
  (layout review §2.3, §4.5 — deliberately left). The sentence it shows is *"Shopify is not configured
  for IT. It sells in GLOBAL."* — a coordinate fact standing in for the real one (`configured: false`,
  zero rows anywhere). The approved layout's own mockup shows `[Shopify ○—]` as a live chip with a null
  readiness dash (`docs/2026-09-01-product-edit-studio-layout.md:51`), so implementation and design
  already disagree.
- **Channel sheet on a Shopify scope:** 30 columns, **not one per-channel write field** — all master's.
  `studio-sheet.service.ts:512-524`: `marketplaceContexts[].channel` is typed `'AMAZON' | 'EBAY'` on the
  bulk PATCH (`products.routes.ts:1034,1043,1163`), "so a Shopify/Etsy/Woo context **cannot be expressed
  at all**". #522 confirms: "Shopify's 30 columns write MASTER with `affectsAllChannels: true`", and 7
  cells are `editable: false`.
- **Publish preview refuses it, using the wrong reason.** `sheet-publish.service.ts:121-123`
  `publishModeFor` returns `'unknown'` for SHOPIFY **though `getShopifyPublishMode()` exists**; `:138`
  answers *"SHOPIFY has no publish route wired to the sheet"* — true of the listing route, **false of
  images**.
- **Readiness** reports `pct: null` + a note (`readiness.vitest.test.ts:87`: "Shopify · GLOBAL declares
  no required fields for this product type").
- `plan/CrossChannelPlanner.tsx:100` already posts `routes.shopifyPublish(productId)`;
  `publish/ScheduleSurface.tsx:118` already offers `SHOPIFY` to a default-OFF cron.

**Parity rows.** **5.54** (pool/featured/DnD/Assign/upload/preview/rollback) — **status cell EMPTY**
(`docs/pes-parity-audit.md:352`); against the code it is **absent** in the studio. **3.2** (single-store
channels drop the market sidebar and `?market`) — graded `🔁` "`deriveScopeOptions` marks GLOBAL
channels" (`:120`); **nothing in `scopes.ts` marks anything** — there is no single-store concept in the
studio, and the old page HAD one (`ProductEditClient.tsx:118` `SINGLE_STORE_CHANNELS`, `:310` drops
`?market`). 3.2 should read 🕳/partial. 5.55–5.57 are shared with eBay (report 02).

**Rulings.** **#125** — "Shopify NOT built, and the refusal is right… HUB RULING (conditional): PES.7
first MEASURES whether any Shopify listing rows exist anywhere… None anywhere → Shopify media is an
OWNER decision (deliberate XAVIA fixture vs defer post-swap), not a lane guess." **#127** — the
measurement, whole catalogue **scanned not sampled**: 37 products, **0** with SHOPIFY in `syncChannels`
(AMAZON 10, EBAY 22), **0** with a `shopifyProductId`, **0 `ListingImage` rows on SHOPIFY anywhere**,
readiness `{enabled:false, mode:'gated', configured:false}`. **#247** — recommends closing the eBay and
Shopify batch gates ("a Shopify equivalent"); it exists. **#315** — a `SHOPIFY·GLOBAL` chip's zero is
correct and its MESSAGE was the defect; amended criterion: *an unexplained zero is a failure, an
explained zero is an answer*. **#171** — the channel-write design; identity fields stay master.

## 5. Defects and slowness

1. 🔴 **The Shopify image publish bypasses a gate that exists, is default-safe, and is called by its
   own sibling.** CODE-READ. `shopify-image-publish.service.ts` makes raw `fetch` PUTs (`:126`, `:196`)
   with **no** `getShopifyPublishMode()`, **no** `checkShopifyCircuit`, **no**
   `acquireShopifyPublishToken`, **no** `writeAttemptLog` — while `outbound-sync.service.ts:1833-1863`
   applies all four to the *same endpoint* and its comment names the risk: *"Shopify used to write live
   the instant creds existed (no mode switch — accidental-live risk)"*. The gate landed 2026-06-16
   (`bc330228c`); the image service's last touch is 2026-06-07 — it was never brought onto it. This is
   #247's shape with the safe sibling in the same repo. Today it only fails because
   `new ShopifyService()` throws on missing creds (`:88-104`); **the day creds are set for the
   locations/stock features it becomes a live, ungated storefront write.**
2. 🔴 **The publish REPLACES the storefront's whole image set, and nothing says so.** CODE-READ,
   `:117-133`: `{ product: { id, images: poolImages.map(src) } }`. Any picture added in Shopify admin,
   or by an app, and absent from our pool is **deleted**. No screen, tooltip or modal in the old panel
   or the studio states this.
3. 🔴 **An assignment that is not in the pool is silently skipped.** CODE-READ, `:181`
   `if (!shopifyImageId) continue` — the URL→id map is built from the pool only (`:167-171`). Yet
   `ShopifyPanel.tsx:279-300` accepts ANY master/DAM url for a colour, so the operator's Assign can be
   a guaranteed no-op that reports success. This is a **model rule** (§6.3), not a bug to patch in the UI.
4. 🔴 **Index-matching pool URLs to Shopify image ids.** CODE-READ, `:161-171` assumes
   `response.images[i]` corresponds to `poolImages[i]`. Shopify de-duplicates identical `src` and
   re-hosts uploads; one collapsed entry shifts every subsequent id and assigns **the wrong picture** to
   every colour after it. HYPOTHESIS on Shopify's exact de-dupe behaviour; the *unchecked assumption* is
   CODE-READ (the code never matches on `src`, which the response carries).
5. 🔴 **Dishonest publish stamping, both directions.** CODE-READ. Success stamps **every** pool row
   `PUBLISHED` by `updateMany({ productId, platform:'SHOPIFY', variantGroupKey: null })` (`:155-159`),
   and `assignedIds.push` (`:211`) runs even when a colour matched **zero** variants or every variant
   PUT failed (failures are `logger.warn`-swallowed, `:207`). On the error path `updateMany({ productId,
   platform:'SHOPIFY' })` (`:144-147`) stamps **assignment rows ERROR that were never attempted**.
6. 🔴 **`activeAxis ?? imageAxisPreference ?? 'Color'`** (`:44`). The fallback is the English `'Color'`
   while this catalogue's axis values are Italian (`Colore`, report 02 §1), and the axis is used **twice**
   as an exact key: `variantGroupKey: axis` when loading assignments (`:70`) and
   `attrs[axis] === colorValue` when matching variants (`:186-188`). A wrong axis returns zero
   assignments and zero variants — a silent "published 0 assignments, success".
7. ⚠ **Inventory §2.2 grades the Shopify read-back "not wired" → KEEP (roadmap)**
   (`docs/2026-09-01-pes7-images-inventory.md:70`). It IS wired —
   `product-images-crud.routes.ts:1199-1207` → `refreshShopifyLiveImages`. Doc drift; the parity grade
   depends on it.
8. ⚠ **`ChannelLiveImage`'s Shopify `slot` comment is wrong.** `schema.prisma:4899` says "Shopify: media
   node id"; the service writes `String(img.position)` for pool rows and `String(v.id)` for variant rows
   (`shopify-live-images.service.ts:131,167`).
9. ⚠ **The Shopify read-back may duplicate rows on every refresh.** `@@unique([productId, channel,
   marketplace, externalSku, slot])` is a plain unique index (migration
   `20260523_ie4_channel_live_image/migration.sql:34`, **no `NULLS NOT DISTINCT`**) and pool rows carry
   `marketplace: null, externalSku: null`, passed through `as any` (`:137-144`). Per
   `reference_prisma_upsert_on_conflict`, Prisma emits `ON CONFLICT (those columns)` and NULL never
   collides with NULL, so each refresh inserts a fresh row and the stale-delete (`:212-225`) keys on
   `externalSku|slot`, which the duplicates satisfy. **HYPOTHESIS** — discriminator: count
   `ChannelLiveImage` rows for one product across two refreshes. eBay has the same shape.
10. 🔴 **The studio's rollback surface says the wrong thing on every non-Amazon scope.** CODE-READ.
    `local/LocalPublishSettings.tsx` mounts for `scope !== MASTER_SCOPE` (`_studio/images/ImagesTab.tsx`)
    and `local/publishPrefs.ts:235` filters snapshot candidates on `r.amazonSlot` being truthy — so on
    eBay (16 photos) and on any future Shopify pool it returns `[]` and the button reports **"Nothing to
    snapshot — this channel has no pictures placed."** (`LocalPublishSettings.tsx:75`).
    `local/restorePlan.ts:68` filters the same way and `:103` hardcodes `platform: 'AMAZON'`. The restore
    is unreachable only *because* the snapshot is — a latent write of AMAZON rows from a non-Amazon
    snapshot. Parity 5.54's "rollback" and 5.53's eBay equivalent are both blocked on this.
11. **Old-panel staging defects** (spec value only, but they name the rules a rebuild must get right).
    CODE-READ: `atMax` and `role: length===0 ? 'MAIN'` both count the **master-preview** rows
    (`:158-170`, `:274-277`, `:313`) — so the first real pool image is created `GALLERY`, never `MAIN`;
    DnD skips `tmp_`-prefixed rows (`:236`) so reordering silently drops unsaved additions; `Clear` on a
    pending assignment does nothing (`:303-311`, only a server row is deleted); and two writers use
    incompatible position scales in one bucket — `×10` on add (`:317`) vs dense `idx` on reorder (`:232`).
12. **No optimistic concurrency and a 774 L component.** `bulk-save` has no `expectedVersion`
    (report 02 §5.13); `ShopifyPanel.tsx` is 774 L inside a 1019 L `ImagesTab.tsx`.
13. **A queue that accepts work it will not run.** `ScheduleSurface.tsx:118` offers SHOPIFY; the cron is
    default-OFF (`scheduled-image-publish.job.ts:144`).

## 6. Proposed home in the studio

### 6.0 Ship in v1, or defer? — **DEFER the Shopify image GRID; ship four things that need no fixture**

Ruling #125 made this conditional and #127 supplied the measurement: **zero** on every dimension, whole
catalogue scanned. Building the pool grid now means designing against a shape no row in the database
has — and report 02's own history says what that costs (three retractions in one session from reading a
picture instead of the data). §6.1–6.6 below is therefore a **specification held ready**, not a v1 build.

But "defer the grid" is not "defer Shopify". Four items are **unconditional** — they are wrong today,
independent of any fixture, and three of them are safety:

| # | Ship in v1 | Why it needs no Shopify data |
|---|---|---|
| A | **Gate the image publish** on `getShopifyPublishMode()` + a caller `dryRun`, and put it behind a publish permission | §5.1/§5 permissions. A live storefront write with no gate and `products:edit` is wrong whether or not a product is linked |
| B | **The single-store scope model** — Shopify's chip stops being a market question (§6.4) | Parity 3.2 is graded 🔁 against a mechanism that does not exist; a deep link strands to Master with no notice (`contracts.tsx:626`) |
| C | **The honest disabled chip, reason ON SCREEN** | Owner's explicit ask; #315's amended criterion; layout review §2.3/§4.5 left it |
| D | **Scope the rollback surface honestly** (§5.10) — it lies on eBay today | Amazon-only by construction; the false sentence is on screen now |

**C, concretely — the reason must not live only in a tooltip.** `ScopeBar` gains `disabledNote?: string`
rendered as a DS `Banner variant="info"` **in the scope row's trailing slot** whenever the active
market's disabled set is non-empty, reading the server's own words:

> *Shopify · WooCommerce · Etsy are not connected. Shopify: no store credentials, no product linked,
> no images. Connect a store at Settings → Integrations.*

Sourced from `publish-readiness` (`configured`/`enabled`/`mode`, already fetched by the planner) plus
the readiness note — never a hardcoded sentence, so it self-corrects the day a store is connected. The
chip keeps `opacity: .5` **and** gains `aria-describedby` pointing at that banner, so the reason is one
string for sighted and screen-reader operators (the ScopeBar's own doctrine, `:68-70`). On the Images
tab, `ImagesTab.tsx:158-165`'s statement stays but stops saying "this product" about a catalogue fact:
*"Shopify images are not built. Measured 2026-09-01 across all 37 products: no store connected, no
product linked, no Shopify picture anywhere. The surface is specified (pool + per-colour assignment) and
waits on a connected store."*

### 6.1 Primary home + mirrors (when it is built)

**PRIMARY — H8, the Images tab, Shopify scope: the same media substrate as eBay, in a TWO-ROW model.**
Report 02 §6.1's rule transfers exactly — *a photo's identity is (bucket, position), not (row, field)* —
and Shopify declares **no image property**, so §A.3a's "every declared property is a column" again
produces zero image columns. `NexusGrid` + `MediaCell` + `MEDIA_MATRIX_GRID_OPTIONS`, mounted directly
per **#447** (never a second host duplicating planner/record/schedule). Two row kinds, because Shopify
has two different objects:
- **Row 1 `Pool`** — position columns `1 · featured`, `2`, `3` … The order IS the meaning, as on eBay.
- **Rows 2..n, one per axis value** — **exactly ONE cell** (`Assigned`), not a position track. Shopify
  has no per-variant gallery; rendering twelve empty cells per colour would promise a capability the
  channel does not have. The remaining position columns are `null`-rendered on these rows with a header
  note, not disabled-looking cells.

**MIRROR 1 — H2, one derived read-only column on the Shopify channel sheet: `shopifyPhotos`.** The sheet
must answer "does this product have its pictures?" without changing tab, and cannot: the identity band's
count is the **master** `ProductImage` count (`studio-sheet.service.ts:1255`). See 6.2.

**MIRROR 2 — H5, `CONTEXT(alias-group)` verb `publish-shopify-images`, preflight-first.** The unit is the
product-in-the-store: `publishShopifyImages` keys on one productId and one `shopifyProductId`. Shopify
has exactly one alias, so the band is the single "Primary" band. Row and SELECTION scopes must **not** be
offered — "publish these 3 SKUs' images" is not something the endpoint can express. Mirrored on the
band's ⋯, the drawer's actions, and **H10 `Publish ▾`** as *Shopify · images*.

**MIRROR 3 — H3 row verb `open-images`**, focusing that row's colour assignment. Navigation only.

**MIRROR 4 — H7, an images section in the drawer's Listings pane** — featured thumb, pool count vs 250,
per-colour assignment chips with "in pool ✓ / not in pool ⚠", curated-vs-live diff where a read-back
exists, link out to the storefront. Read + navigate; no verb lives only here (channel-ops §3.2).

**MIRROR 5 — H9, Errors & Sync** — FATAL `ChannelImagePublishJob` rows, assignments skipped for not
being in the pool, variants missing `shopifyVariantId`, and read-back drift. Grouped by cause, jumping
back to the sheet row or the tab. Invisible today: it exists only inside a response payload.

**MIRROR 6 — H6, SheetToolbar `trailing`: "Refresh what's live on Shopify"** — the read-back, which must
say `NO_CREDS` / `NO_PRODUCT_ID` **in words** (the service already returns them,
`shopify-live-images.service.ts:32`) instead of an empty strip.

**MIRROR 7 — H11, the existing pages, unchanged.** Locations stay at
`/fulfillment/stock/shopify-locations`; store credentials stay in Settings → Integrations
(`permissions-manifest.ts:134`); the listings overlay stays at `/listings/shopify`.

**Not proposed:** an `imageAxis` cell. eBay needed one because eBay *chooses* an axis; Shopify's variant
assignment follows the family's own axis with no channel choice to store. **H12 (drop):** the pool's
`×10` position scheme and the empty-pool master-preview rows — replaced by dense positions and the
substrate's own "add" cell.

### 6.2 What the sheet shows at rest, per scope

| Scope | At rest |
|---|---|
| **master** | unchanged — identity band thumbnail + `photoCount`, `imageInherited` → `ProvenanceMark` |
| **Shopify (no market)** | **`shopifyPhotos`** (H2, derived, read-only, filterable): `18 · featured set` when covered; `⚠ no featured image` when the pool is empty; `⚠ 3 colours unassigned`; `⚠ Rosso → not in pool` where an assignment would be skipped (§5.3); a drift mark where a read-back disagrees. Tooltip per §A.3a: *"Curated in Images · Shopify. 18 pool pictures, featured set, 4 of 4 colours assigned. Publishing REPLACES the store's picture set."* Plus **`onlineStore`** (H2) from `isPublished` — Shopify's own visible/hidden fact, which `ShopifyListingsClient.tsx:12-15` already names |
| **Shopify, variant rows** | `shopifyPhotos` shows **the colour's assignment**, and only that — one image per variant is the model, so this cell is meaningful per row (unlike eBay, where a bucket is an axis value and a per-row column would repeat one fact) |
| **the other 30 columns** | they are the MASTER's, and the header band must say so until #171's write side names SHOPIFY: *"Shopify has no content layer — these are the master's values, and an edit here changes every channel."* #315's amended criterion, applied to the sheet rather than to enrichment |

`shopifyPhotos` is **not** 250 media cells; per **#80** a "required and empty" verdict is a MATRIX-level
statement anyway.

### 6.3 The interaction, step by step

**Editing the pool (H8).** Click a cell → DS `Modal` picker (master gallery + DAM) → place → ONE
`bulk-save` transaction → `reload()`. **The pool is NOT exclusive** — this is the sharpest contrast with
eBay: `placeInBucket`'s one-bucket invariant and its single upsert+delete transaction
(`channel/ebay/buckets.ts:143-148`, `useEbayEdits.ts:42-50`) **must not be reused**, because one Shopify
picture legitimately sits in the pool *and* is pointed at by three colours. A Shopify `place()` is an
add, never a move. Removing a pool picture that a colour points at must **warn and offer to clear the
assignment**, since the publisher would skip it (§5.3). Keyboard: arrows move, `Enter` opens the picker,
`Delete` removes with a **featured-photo confirm** showing which picture takes over — the featured image
is the storefront's search thumbnail, exactly the change an operator must see. Reorder by drag (dense
positions, only rows whose position changed are written — eBay's `renumber` shape) and by the position
picker `Modal`, so it is reachable without pointer drag.

**Assigning a colour (H8, the second row kind).** Click the colour's one cell → the picker is
**restricted to the pool**, with a stated reason and a "add it to the pool first" action. This is the
design consequence of §5.3: the constraint lives in the picker, not in a post-publish warning.

**Publishing (H5), preflight-first, registry order.**
- **COLLECT** — one product, one store. No market picker, no alias picker.
- **PREFLIGHT** — `GET /products/:id/shopify-images/preflight` (**new**, §7). Contacts no channel.
  Returns: pool count vs 250, featured present, per-colour assignment with `inPool: boolean`, variants
  missing `shopifyVariantId`, `shopifyProductId` present, the resolved axis **and where it came from**,
  `mode` from `getShopifyPublishMode()`, `configured`. It populates `ActionImpact`: `findings` per
  colour, `consequences` = "18 pool pictures, featured set, 4 colours assigned, to <shop>", and
  `sideEffects` = **"this REPLACES the product's picture set on Shopify — anything added in Shopify admin
  and not in this pool is deleted"** plus "2 colours point at pictures outside the pool and will be
  skipped". `payload` carries the preflight snapshot so `run` applies what was approved (#118).
- **CONFIRM** — `ActionConfirm` at the level the preflight returned, never a fixed flag. Gate closed →
  the verb is **`unavailable`** with the server's own sentence, as `AliasPublishControl` reads
  `notSendable` today.
- **RUN** — `POST /shopify-images/publish` with `{ activeAxis, dryRun, expectedSnapshot }`. Repaint:
  `invalidation: 'page'` (#114), the grid's buckets, the publish record, any skip straight into H9.

**With the drawer open** the sheet stays live (layout-v2 §5); the Images tab replaces the sheet rather
than overlaying it.

**DS components:** `NexusGrid` + `MediaCell`/`MediaCellView` + `MEDIA_MATRIX_GRID_OPTIONS`; `Modal`,
`Thumbnail`, `FileDropzone`, `Button` (picker / featured confirm / upload); `Banner` (validation, stale,
the replace-warning, the disabled-scope reason); `Pill`/`Badge` (pool count, featured, live/failed);
`ActionConfirm` + `useActionPress`; `Card`/`KeyValue` (drawer); `EmptyState`. **One new DS prop**
(`ScopeBar.disabledNote`), **no new DS component.**

### 6.4 Per-scope rules — single-store vs market channels

- **The Shopify scope has NO market dimension, and the frame must say that rather than encode it as a
  market mismatch.** Concretely: `StudioScopeOptions` gains `ChannelOption.singleStore: boolean`, derived
  where every option is derived — a channel whose only `Marketplace` code is `GLOBAL` (`scopes.ts`,
  pure). Then (a) `StudioBar` does not disable a single-store chip for the active market; (b) selecting
  it **hides the market switcher** and shows `Store <shop-name>` in its place; (c) `contracts.tsx:626`
  stops falling a single-store deep link back to Master, and `setMarket`'s `strands` branch (`:863`)
  never strands one; (d) the URL drops `?market` on that scope — which is exactly what the OLD page did
  (`ProductEditClient.tsx:118,310`) and what parity row 3.2 claims is already covered.
- **Shopify's real second dimension is LOCATIONS, and it is NOT a switcher.** A location is a stock fact
  (`StockLocation.type = 'SHOPIFY_LOCATION'`, `externalLocationId`), owned by
  `/fulfillment/stock/shopify-locations` and the webhook path. It must **not** be dressed as the market
  switcher renamed: swapping the market control for a Location control would imply a location changes
  what content you are editing, which it never does. If the studio surfaces locations at all it is as a
  read-only per-row availability roll-up on the sheet (and `reference_available_is_the_stock_rollup`
  applies), with the manager page as H11.
- **Pool images are `marketplace: null`** — one picture set per store, which is the truth here (unlike
  eBay, where `marketplace: null` is a *simplification* the header must disclose, report 02 §6.4).
- **alias band** — Shopify has exactly one alias; the band is "Primary" and carries the publish verb.
- **master** — no Shopify concepts. A master delete referenced by a Shopify pool row must warn, not cascade.
- **Amazon / eBay** — unchanged; per-market, and Amazon's declared locators are columns.

### 6.5 Provenance / autosave / readiness / publish

- **Provenance.** Every pool tile is `provenance: 'own'` (the eBay grid's choice, `EbayGrid.tsx:85-87`):
  Shopify's pool is not a cascade. An assignment cell whose picture is not in the pool gets a **warn**
  mark, which is a real state here rather than #80's unreachable src-less case.
- **Autosave.** Placement autosaves per edit through `write()` → `useSaveReporter()`, so the header's one
  indicator speaks for image work; the old panel's staged-then-flush controller is correctly dropped
  under per-cell autosave — the reviewable batch it protected is now the publish preflight.
  `bulk-save` still needs `expectedVersion` (§7).
- **Readiness.** One server definition (`services/pim/readiness.service.ts`) needs a Shopify image rule
  (featured present, pool non-empty, every colour assigned and in-pool) or the chip's ⚠ can never be
  caused by a missing storefront picture. Today Shopify returns `pct: null` with "declares no required
  fields", which is honest and empty.
- **Publish.** `publishModeFor` must return `getShopifyPublishMode()` (`sheet-publish.service.ts:121-123`)
  and `notSendableReason` must stop asserting "no publish route" for a channel whose **image** route is
  live. Until item A lands, the verb is `unavailable` with that stated as the reason.

### 6.6 ASCII mockup

```
 Sheet · IMAGES · Analytics·Ads · Activity · Errors&Sync    Shopify ⚠   Store  gale-racing ▾
┌───────────────────────────────────────────────────────────────────────────────────────┐
│ Shopify images · 18 of 250 pool pictures · 4 colours · one picture set for the store  │
│ ⚠ Publishing REPLACES the store's picture set. Pictures added in Shopify admin and    │
│   not in this pool are deleted.                                                        │
│ ⚠ Rosso points at a picture that is not in the pool — Shopify would skip it.           │
├──────────────────────┬────────────┬───────┬───────┬───────┬─────┬─────────────────────┤
│                      │ 1 ·FEATURED│   2   │   3   │   4   │  5  │ …  18   +           │
├──────────────────────┼────────────┼───────┼───────┼───────┼─────┼─────────────────────┤
│ Pool  (the store)    │   [img]★   │ [img] │ [img] │ [img] │[img]│ …       +           │
├──────────────────────┼────────────┴───────┴───────┴───────┴─────┴─────────────────────┤
│ ASSIGNED PER COLOUR  │ one picture each — Shopify has no per-variant gallery          │
│  Nero                │ [img]  in pool ✓                                    Change ⌄   │
│  Giallo              │ [img]  in pool ✓                                    Change ⌄   │
│  Rosso               │ [img] ⚠ not in the pool — would be skipped          Change ⌄   │
│  Blu                 │  ·     no picture assigned                          Assign  ⌄   │
└──────────────────────┴───────────────────────────────────────────────────────────────┘
 [Preview publish to Shopify]   Live read-back: unavailable — no store credentials.
 ── Recent ────────────────────────────────────────────────────────────────────────────
 (no Shopify publish has ever run — 0 jobs)
```

## 7. Contracts and data

**Reused unchanged** — `GET /images-workspace` · `POST /images-workspace/bulk-save` ·
`POST /images-workspace/copy-scope` · `POST /shopify-images/publish` · `GET /image-publish-jobs` + retry ·
`GET|POST /live-channel-images[/refresh]` · `GET /api/listings/publish-readiness` ·
`GET|POST|PATCH /api/stock/shopify-locations*`.

**Server changes (PES.5, all additive; 1–2 and 8 are the v1 set)**
1. **Gate the publish** — `getShopifyPublishMode()` + circuit + rate limiter + `writeAttemptLog` in
   `shopify-image-publish.service.ts`, plus a caller `dryRun`, on the `amazon-batch-feed.service.ts:240-268`
   shape #247 named. **Owner-gated (§9 Q1).**
2. **Permission** — `/shopify-images/publish` behind a publish permission, one manifest entry above `:412`.
3. **`GET /products/:id/shopify-images/preflight`** — new, contacts no channel; the §6.3 shape. Mirrors
   `amazon-images/validate|stale|preview`, which is the server truth
   `ChannelValidationBanner`/`ChannelStaleBanner` never had.
4. **Match by `src`, not by index** (§5.4) — the response carries it.
5. **Honest stamping** (§5.5) — stamp only what was sent, from the push's own per-call results; never
   `updateMany` across the whole platform on either path.
6. **One axis source** — `readImageAxisPreference(productId)` instead of `?? 'Color'` (§5.6).
7. **`expectedVersion` on `bulk-save`**; **`jobId` in the Shopify audit metadata**
   (`channel-image-publish.routes.ts:112-119` omits `result.jobId`, which is on the result).
8. **`publishModeFor`/`notSendableReason`** to call the Shopify gate and stop asserting "no publish
   route" (`sheet-publish.service.ts:121,138`).
9. **Sheet contract** — `shopifyPhotos` and `onlineStore` derived columns; a `singleStore` flag on the
   scope options payload. Later: SHOPIFY in `marketplaceContexts[].channel` (#171's write side) — that is
   the Owner-queue item, not this feature.
10. **Readiness** — a Shopify image rule.
11. **Docs** — inventory §2.2's "read-back not wired"; `schema.prisma:4899`'s Shopify `slot` comment;
    parity 3.2's 🔁 and 5.54's empty cell.

**Schema:** **none.** `NULLS NOT DISTINCT` on `ChannelLiveImage`'s unique index (§5.9) is the only
candidate and only if that hypothesis confirms — additive, and it would fix eBay at the same time.

**Lane ownership** — **PES.1**: `singleStore` in `scopes.ts` + `StudioBar` + `contracts.tsx`, the
`ScopeBar.disabledNote` banner, the `Publish ▾` entry. **PES.7**: the two-row grid, the pool-restricted
assignment picker, featured-removal confirm, drawer section, preflight UI, and the rollback scoping
(§5.10 — theirs, and it is an eBay defect today). **PES.3**: `shopifyPhotos` / `onlineStore` columns, the
`publish-shopify-images` context verb, the master-values header note. **PES.2**: nothing new — the media
substrate covers it. **PES.4**: the drawer pane slot. **PES.5**: all of §7. **DS.1**:
`ScopeBar.disabledNote`. **PES.6 / PES.8**: nothing (no mapping, no AI — ruling #13 holds).

## 8. Risks and traps

- **The gate is the whole risk.** Shopify is unconfigured today, so the image publish fails on a missing
  credential — an accident of configuration, not a safety. Setting `SHOPIFY_SHOP_NAME` +
  `SHOPIFY_ACCESS_TOKEN` for the **locations/stock** features (which are built and want them) arms an
  ungated live storefront write that **replaces the picture set** and needs only `products:edit`.
  Ordering matters: close the gate **before** any credential lands.
- **Local dev hits the PRODUCTION API** (`_studio/images/api.ts:9-11`) — a click in a local Images tab is
  a real write. And `reference_endpoint_safety_is_not_interaction_safety`: a "preview" that blurs a field
  can commit. Any Shopify verification must be a `dryRun` on a deliberately-created fixture product.
- **A fixture is a WRITE to prod.** #125/#127's Owner choice "deliberate XAVIA Shopify fixture" means
  creating a real Shopify product on a real store. That is spend and a live storefront — Owner's call,
  and it needs the gate closed first.
- **Never publish a Shopify image set from a snapshot taken on Amazon** — `restorePlan.ts:103` hardcodes
  `platform: 'AMAZON'` (§5.10); fix the scoping before any restore reaches a second channel.
- **Untouchable:** FBA quantity, the existing import flows, the flat-file editors. `ShopifyPanel.tsx` is
  the SOLE importer of four shared channel components (§2), so they survive the swap regardless.
- **AI dark** (#13) — nothing here generates.
- **Per-channel oversell / Amazon EU shared quantity** — not this feature, but Shopify **locations** are
  a stock dimension and `reference_oversell_is_per_channel_not_summed` applies to anything that reads
  them; keep locations out of the image surface entirely.
- **The "two surfaces" trap** — the studio would offer a Shopify chip whose sheet writes MASTER
  (`studio-sheet.service.ts:522`). Say it on the band, per #315, or the operator edits every channel
  believing they edit one.

## 9. Open questions for the Owner (max 3)

1. **Shopify images in v1, or an explicit deferral?** #127 measured zero on every dimension across all 37
   products. **Recommend DEFER the grid** and ship §6.0's A–D: an honest disabled chip with the reason
   **on screen** (a `Banner` in the scope row, sourced from `publish-readiness`, not a tooltip), the
   single-store scope model, the closed publish gate, and the rollback scoped honestly. The grid
   specification in §6.1–6.6 is ready and is an **M** the day a store is connected. Building it now means
   designing against no data, which #125 already refused.
2. **Close the Shopify image-publish gate now?** `getShopifyPublishMode()` exists, is default-safe, and
   is applied to the *same* `PUT /products/{id}.json` by `outbound-sync.service.ts:1833` — the image path
   has none of it and only `products:edit` guards it. **Recommend YES**, exactly as #247 recommended for
   the batch path: unify onto the gate, one-way, with a caller `dryRun`. Nothing depends on it (zero jobs
   have ever run), so the cost is nil and the risk is a storefront that loses its pictures.
3. **Does a Shopify fixture get created, and where?** A fixture means a real product on a real store.
   **Recommend: not yet.** Do #1 and #2 first; when a store is connected for the locations work, the
   *read-back* (`refreshShopifyLiveImages`, already wired and credential-guarded) gives a safe, read-only
   first fixture — real rows in `ChannelLiveImage` to build the grid against, with no write at all.

## 10. Effort and dependencies

| Piece | Effort | Depends on |
|---|---|---|
| **A** Gate + permission on the image publish | **S** | **Q2 ruling** |
| **B** `singleStore` scope model (options, chip, switcher hidden, URL drops `?market`, no strand) | **M** | PES.1; parity 3.2 regrade |
| **C** `ScopeBar.disabledNote` + the on-screen reason + the honest tab statement | **S** | DS.1 for the prop |
| **D** Rollback scoped honestly (fixes eBay today) | **S** | PES.7 |
| `GET /shopify-images/preflight` | **M** | PES.5 |
| Server hardening: src-match, stamping, axis, `jobId`, `expectedVersion` | **M** | none |
| The two-row pool + assignment grid | **M** | **Q1/Q3**; substrate in place |
| Pool-restricted assignment picker + featured-removal confirm | **S** | the grid |
| `shopifyPhotos` + `onlineStore` derived columns | **M** | PES.5 §7.9 |
| `publish-shopify-images` CONTEXT verb + `Publish ▾` entry | **M** | the preflight; **Q2** |
| Drawer images section (H7) | **S** | PES.4 pane slot + `GalleryImage.inherited?` (#125) |
| Skip/failure rows in Errors & Sync (H9) | **M** | honest stamping + `jobId` |
| "Refresh what's live on Shopify" scope verb, honest `NO_CREDS` | **S** | none — service already returns it |
| Readiness rule for Shopify images | **S** | PES.5 |
| Shopify channel content layer (sheet becomes a real channel scope) | **L** | **Owner-queue #171/#315**, not this feature |

Cross-feature: **01 Amazon images** and **02 eBay images** share the media substrate and the
planner / publish-record / schedule surfaces — build those once (#447: mount the per-scope grid
directly). §5.10's rollback defect is **shared with 02** and should be fixed by whichever lane lands
first. §6.4's `singleStore` flag is shared with **every** Shopify/Woo/Etsy feature in this research set,
so it belongs to PES.1 once, not to this report's lane.
