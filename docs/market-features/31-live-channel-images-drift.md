# 31 — LIVE CHANNEL IMAGES: what is live on each marketplace, the refresh, drift ⚠, adopt, channel truth

## 1. What it is (one paragraph, in operator terms)

One question, asked by the person who owns a listing's pictures: **"what is Amazon/eBay/Shopify
actually showing right now, and is it what we think we sent?"** Nexus holds an *intent* (master
gallery → per-channel assignment) and a *record of attempts* (publish history). Neither answers what
the channel is serving today, because a picture can change on the channel side — a Seller Central
upload, a feed that half-applied, an image Amazon rejected and silently kept the old one for. So the
operator asks for a read-back (`ChannelLiveImage`), sees it beside our assignment, and when the two
differ has exactly two remedies: **adopt** the channel's picture into our record (the channel was
right, or at minimum we must stop being able to wipe it), or **re-publish** ours (we were right).
Two moments: pre-publish, because an exact-mirror publish DELETES what Amazon has and Nexus does not
(`amazon-mirror-diff.service.ts:9`); and triage, when a listing looks wrong on the marketplace and
nobody knows who last touched it. This is the IMAGE half of the same question report 10 owns for
FIELDS, and — the finding that shapes this whole report — on both Amazon and eBay it arrives in the
**same HTTP response** as the field half.

## 2. Old UI — inventory

**Entry points.** `tabs/images/LiveChannelStrip.tsx` (308 L) mounted three times:
`amazon/AmazonPanel.tsx:770-780`, `ebay/EbayPanel.tsx:499-506`, `shopify/ShopifyPanel.tsx:362-372`.
Drift modal `tabs/images/LiveImageDriftModal.tsx` (122 L) mounted **once**, Amazon only
(`AmazonPanel.tsx:1081-1089`).

**What round-trips.** Exactly one write-shaped call: `POST /api/products/:id/live-channel-images/refresh`
with `{channel, marketplace}` (`LiveChannelStrip.tsx:141-149`), then `onRefreshed()` → the whole
workspace reload. The rows themselves ride the workspace payload (`workspace.data.channelLiveImages`,
`ImagesTab.tsx:155`), so the strip re-reads nothing of its own.

**Browser-local.** The collapse state, per channel, in `localStorage` under
`ie.liveStrip.collapsed.<channel>` (`:64-72`); `refreshing` and `refreshError` (`:58-59`).

**Interactions.** Live thumbs are draggable onto an Amazon matrix cell with `sourceProductImageId`
deliberately empty — *"No master ProductImage yet"* (`:239-250`); click opens the drift modal, but
only where `onOpenDiff` was passed (Amazon only); an "Adopt" chip overlays a thumb, but only when
there is **no** matching Nexus row (`:270-281`); eBay groups by variation VALUE with a synthetic
`__gallery__` bucket (`:25,:100-117`) and shows one Refresh for the whole item (`:163,:207`).

**Dead / dishonest in the old surface** (all CODE-READ):
1. **`onRepublish` has no caller anywhere in the repo** (`LiveImageDriftModal.tsx:25,109-117`;
   verified by grep — the only hits are the prop's own declaration and use). Adopt renders only when
   `isOrphan` (`:99`). So for the case the modal is *named for* — a live image that DIFFERS from ours
   — the modal offers **nothing but Close**. The comment says the missing CTA "lands in IE.5b"
   (`:10-12`); it never did.
2. **The channel/marketplace/slot the panels thread through are discarded.** `AmazonPanel` passes
   `(url, 'AMAZON', marketplace, slot)` (`:777`) into an `ImagesTab` handler declared
   `handleAdoptToMaster(url: string)` (`ImagesTab.tsx:167`), wired as `(url) => handleAdoptToMaster(url)`
   at `:744`, `:777`, `:820`. The adopt then hardcodes `?type=LIFESTYLE` (`:174`), so an adopted MAIN
   lands in the master gallery as a lifestyle shot with no slot, no market and no link back.
3. **The adopt is a browser-side cross-origin `fetch(url)` + re-upload** (`ImagesTab.tsx:169-177`).
   Whether `m.media-amazon.com` serves CORS headers to our origin is not measured — HYPOTHESIS, but
   it is a failure mode the server-side path (§3) does not have.
4. **Drift is computed with a raw string compare and is structurally always true.**
   `nexusUrlFor()` returns null unless `channel === 'AMAZON'` (`:126-127`), and drift is
   `!nexusUrl || nexusUrl !== li.url` (`:226`) — no normalisation at all, against a live URL that is
   Amazon-hosted and a Nexus URL that is not (see §5.1). So eBay and Shopify have **no drift
   detection at all** and Amazon's flags every cell.
5. **Shopify's strip says the server is not wired when it is.** `supported = channel === 'AMAZON' ||
   channel === 'EBAY'` (`:160`) hides the Refresh button and prints "not yet wired" (`:196-198`) —
   while `POST …/refresh` has had a working `SHOPIFY` branch since PB.8b
   (`product-images-crud.routes.ts:1201-1209`). `ShopifyPanel` passes `onAdoptToMaster` into a strip
   that can never have rows to adopt.

## 3. Backend that exists

**Routes** (all under `prefix: '/api'`, `index.ts:789-795`):
- `GET /api/products/:id/live-channel-images?channel=&marketplace=` — `product-images-crud.routes.ts:1139`.
  Plain `findMany` + order; no auth logic of its own.
- `POST /api/products/:id/live-channel-images/refresh` — `:1162`. Branches AMAZON (`:1167`,
  marketplace REQUIRED → 400 `MARKETPLACE_REQUIRED`), EBAY (`:1189`), SHOPIFY (`:1201`), else 501
  `CHANNEL_NOT_IMPLEMENTED` (`:1211`).
- `POST /api/products/:productId/amazon-images/adopt` — `routes/images/amazon-images.routes.ts:167`,
  `{marketplaces?, dryRun?}`, audits `imagesAdopted` (`:177`). **No web caller** (grep across
  `apps/web/src`: zero).
- `GET  …/amazon-images/reconcile` — `:199`, `?refresh=1&marketplaces=IT,DE`. **No web caller.**
- `GET  …/amazon-images/mirror-diff?marketplace=` — `:223`. The only one the studio calls.
- `GET  …/amazon-images/stale?marketplace=` — `:406`. Amazon only; eBay/Shopify have no stale route.

**Services.**
- `refreshAmazonLiveImages` (`services/images/amazon-live-images.service.ts:64`) — SKU list = children
  + **the parent SKU too** (`:99-110`), then a **serial** loop (`:112`) of
  `getListingsItem({includedData:['summaries','images']})` (`:115`), upsert per slot (`:143`), then a
  stale sweep `deleteMany({fetchedAt: {lt: fetchedAt}})` per SKU (`:186-194`). Fail-soft per SKU
  (`:121-130`).
- `refreshEbayLiveImages` (`services/images/ebay-live-images.service.ts:123`) — one Trading `GetItem`
  with `OutputSelector` `PictureDetails.PictureURL` + `Variations.Pictures` (`:59-71`), regex-parsed
  (`:73-121`), then **delete-then-`createMany` for the whole `{productId, channel:'EBAY'}` set**
  (`:219-222`) with `marketplace: null` on every row and `externalSku` = the variation **VALUE**
  (`:213-217`). Falls back to `SharedListingMembership.itemId` for shells (`:149-156`). Guards:
  `NO_ITEM_ID`, `API_DISABLED` when `NEXUS_EBAY_REAL_API !== 'true'` (`:55-57,:163`), `NO_CREDS`.
- `refreshShopifyLiveImages` (`services/images/shopify-live-images.service.ts:69`) — one REST
  `products/{id}.json`; pool rows (`externalSku: null`) + per-variant assignment rows
  (`externalSku = variant.sku`, `slot = variant.id`) (`:8-13`).
- `adoptAmazonImages` (`services/images/amazon-adopt.service.ts:109`) — refresh live, then **gap-only**
  create of per-market `scope:'MARKETPLACE'` `ListingImage` rows with `publishStatus:'PUBLISHED'`
  (`:164-182`), `slotToRole()` mapping (`:41-46`). **This is "adopt into master" done properly** —
  and it lands on the per-market baseline, not on `ProductImage`, precisely so the first exact-mirror
  publish cannot wipe Seller-Central-only uploads (`:1-18`).
- `reconcileAmazonImages` (`:201`) + pure `categorizeReconcile` (`:66`) → `onlyOnAmazon /
  onlyInNexus / urlMismatch / inSync`.
- `buildMirrorDiff` (`services/images/amazon-mirror-diff.service.ts:69`) + pure `categorizeAsinDiff`
  (`:33`) → `adds / replaces / deletes / unchanged` per ASIN.

**Prisma.** `ChannelLiveImage` — `packages/database/prisma/schema.prisma:4876-4917`: `channel`,
`marketplace String?` (null for eBay/Shopify, `:4885-4887`), `externalSku String?`, `asin`, `slot`,
`url`, `width`, `height`, `sortOrder`, `etag`, `fetchedAt`, unique
`[productId, channel, marketplace, externalSku, slot]`. Also `ChannelListing.followMasterImages` —
the only followable field with **no override column**, *"the gallery is a relation, not a scalar"*
(`services/pim/channel-follows.service.ts:40-41`).

**External calls and gates.** `getListingsItem` (`clients/amazon-sp-api.client.ts:1254`) is a READ and
is **not** behind `getAmazonPublishMode()` — only the write methods are (`:568,:718,:841,:933`).
Rate limit: a 200 ms floor between requests, held in per-instance state
(`applyRateLimit`, `:324-335`), plus `[1000,2000,4000] ms` retries on 429/5xx (`:357-395`). eBay's
read goes through `callTradingApi`, which is a WRITE-shaped helper — hence the explicit
`hasRealApi()` pre-guard (`ebay-live-images.service.ts:163`) that returns `API_DISABLED` rather than
letting the dev fake through.

**Jobs/crons.** `ebay-image-readback` — `jobs/ebay-image-readback.job.ts:32-47`, default `45 */6 * * *`,
on when `NEXUS_ENABLE_EBAY_IMAGE_READBACK_CRON` or (default) `NEXUS_EBAY_REAL_API=true`; started at
`index.ts:1258`; manual trigger in `jobs/cron-registry.ts:374-379`. Sweep
`readbackAllEbayLiveImages` (`ebay-live-images.service.ts:250`) is deliberately sequential (`:268-270`).
**There is no Amazon and no Shopify cron** — the old strip's promise that "after IE.4b's cron ships
this strip is mostly read-only" (`LiveChannelStrip.tsx:12-13`) describes a job that exists for one
channel only.

**Permissions.** `has('/images')` is `path.includes('/images')` (`permissions-manifest.ts:34`), and
`live-channel-images` / `amazon-images` contain `-images`, not `/images` — so `:380` does **not**
match them and they fall through to `RW(F.productsView, F.productsEdit, pfx('/api/products'))`
(`:412`). Net: the GET needs `products.view`; **the refresh — a pure channel READ — needs
`products.edit`**, exactly the asymmetry report 10 found for `/ebay/description-preview`.

## 4. Studio today

- **BUILT, Amazon only:** `_studio/images/channel/amazon/ChannelTruthPanel.tsx` (159 L), mounted at
  `AmazonMatrix.tsx:252`. Three parallel GETs on scope change — stale, live rows, mirror-diff — all
  from data we already hold, no channel call (`:46-65`). `refreshLive` POSTs the refresh through the
  image write ledger (`writeSubject.surface('amazon-live-refresh')`, `:71-73`) then re-GETs (`:75-77`).
  Renders `not checked` / `N images read back` pills (`:96-97`), the withheld-stale sentence
  (`:106-114`), the mirror statement (`:126-128`), the ASINs that would lose images (`:130-143`) and
  up to 24 thumbnails (`:145-156`). Button label follows state (`:100`).
- **`channelTruth.ts`** (151 L, 16 tests) — `sameImage` (`:50`), `imageIdentity` (`:64`), `findDrift`
  (`:102`), `staleActionability` (`:138`).
- **`mirrorPlan.ts`** (104 L, 8 tests) — `readMirrorDiff` withholds the totals entirely when the live
  cache is empty (`:66-79`).
- **eBay and Shopify have none of it.** `_studio/images/ImagesTab.tsx:147` mounts `EbayGrid` with no
  truth panel; `:158-167` is Shopify's honest "not built" statement. The inventory says so:
  *"Amazon has equivalents … via `ChannelTruthPanel` + `PublishHistory`; eBay and Shopify do not"*
  (`docs/2026-09-01-pes7-images-inventory.md` §30.1).
- **Parity audit row 5.52** (`docs/pes-parity-audit.md:346`) names exactly this feature —
  **Status column empty.** The whole Area 5 (images, rows 5.1–5.57) is unfilled, unlike Area 3.
- **Docs.** §15 (`:868-918`) is the design record: STALE vs DRIFT kept apart, the `cdnFit` trap, the
  measured empty cache (0 rows on GALE-JACKET), 23 stale rows naming zero targets, and — decisive
  for this report — *"**'Check Amazon' was NOT clicked** … the drift comparison therefore remains
  verified by test only, not against a live read-back"* (`:914-918`). §17 (`:959-978`) records the
  mirror-diff trap and its raw reading `240 adds · 0 replaces · 0 deletes` over an empty cache. §21
  (`:1095-1155`) is the method fault to inherit: **a claim about a SET must be measured across the
  set**, and *"a durable property must survive a second reading at a different time"*.
- **Hub rulings that bind.** **#197** (`docs/pes-claims.md:17446-17463`) lists **`adopt-to-master`
  among the 17 capabilities NOT rebuilt**, with the Owner-queue recommendation to schedule a
  PES.7-ii, and states the audit rule *"a false positive in an audit is worse than a false negative
  — it retires a capability nobody rebuilt."* **#447** (`:10081-10101`) — the Images tab is on
  **every** scope and branches by scope; the seam is the per-scope component, never a second host.
  **#127** (`:19905-19917`) — Errors & Sync approved sync-queue-first (the other three sources
  measured at zero), and **Retry ships PREVIEW-FIRST, "consistent with every other live-channel
  verb"**; also **all three channels report `gated` on the server**. **#118 / #114** —
  `ActionImpact.payload` + `run(rows, impact?)` (`design-system/grid/actions/registry.ts:122,:203`),
  `findings[]` (`:108`), lane-declared invalidation, order COLLECT→PREFLIGHT→CONFIRM→RUN (`:221`).
  **#34** — the frame ships the chip registry, the PRODUCER owns the count.

## 5. Defects and slowness

1. **🔴 CODE-READ (structural) — the drift comparison compares two different URL namespaces, so
   every filled slot must read as "different".** `categorizeAsinDiff` compares
   `norm(liveUrl) !== norm(planUrl)` (`amazon-mirror-diff.service.ts:38,:45`); `normalizeAmazonImageUrl`
   is a **no-op on any non-Amazon URL** (`normalize-amazon-image-url.ts:15-18`). The live side is
   Amazon-hosted (`m.media-amazon.com/images/I/…` — the reason that normaliser and
   `imageIdentity`'s Amazon branch, `channelTruth.ts:79-81`, exist at all). The plan side is the
   MASTER's URL, substituted deliberately: `resolveAmazonImages` overrides `ListingImage.url` with
   `productImage.url` whenever `sourceProductImageId` is set (`amazon-image-feed.service.ts:180-196`).
   A Cloudinary identity can never equal an Amazon asset id, so `replaces` = every slot both sides
   fill, and `findDrift` would return `kind:'different'` for all of them. **The boundary proves the
   mechanism:** a row created by `adoptAmazonImages` has `sourceProductImageId` null and an Amazon
   `url` (`amazon-adopt.service.ts:165-181`), so *those* rows compare correctly — which is exactly
   why `reconcileAmazonImages`' own doc says *"After a clean adopt, onlyOnAmazon should be empty"*
   (`:196-199`). **The drift surface is only sound on a product that has been adopted, and the adopt
   route has no caller.** Zero-cost falsification, no channel call: one unit case feeding a real
   (Cloudinary plan, Amazon live) pair into `categorizeAsinDiff` / `findDrift`.
2. **🔴 CODE-READ — the tested pure module has no production consumer, and its fixture pins the very
   dimension that breaks it.** `ChannelTruthPanel.tsx:22` imports only `staleActionability` and the
   `LiveImage` type; grep across `apps/web/src` finds `findDrift` / `sameImage` / `imageIdentity`
   **only in `channelTruth.vitest.test.ts`**. And every `findDrift` case passes a **Cloudinary** URL
   as the LIVE url (`channelTruth.vitest.test.ts:10-15,:49,:55,:59`) — Cloudinary-vs-Cloudinary and
   Amazon-vs-Amazon are both covered; the cross-host arm, the only one production produces, is never
   run. Sixteen green tests over a function nothing calls, on the one axis that matters.
3. **🔴 CODE-READ — `findDrift` cannot see an eBay or Shopify row at all.** It filters
   `(l.marketplace ?? '').toUpperCase() === market.toUpperCase()` (`channelTruth.ts:108`), and every
   eBay row is written with `marketplace: null` (`ebay-live-images.service.ts:213-217`). Generalising
   the panel is therefore **not** a parameter change: eBay's join key is the bucket (axis value, not
   a SKU) and Shopify's is the pool position / variant id.
4. **🔴 CODE-READ — a 404 counts as a successful check and then DELETES the cached truth.**
   `getListingsItem` returns `{success:true, asin:null, status:null}` with no `images` on a 404
   (`amazon-sp-api.client.ts:1304-1313`); `refreshAmazonLiveImages` then scores `skusOk++`, upserts
   nothing, and sweeps `fetchedAt < now` for that SKU (`:186-194`). The parent SKU is deliberately in
   the list while being *"structural, not buyable"* (`:105-107`), so it is the likeliest 404. Net: a
   refresh can *reduce* the cache and report success — and the panel then renders `not checked`
   (`ChannelTruthPanel.tsx:84`), which is indistinguishable from never having asked. This is
   `could_not_measure_vs_measured_empty` inside the write path.
5. **🔴 MEASURED-IN-DOC (`pes-claims.md:12587`, PES.5) — off Railway the SP-API refresh token is
   revoked** (`invalid grant parameter : refresh_token`), the error is caught per ASIN, and the run
   *"summarises as clean — a FALSE NEGATIVE that reads exactly like"* an empty answer. Any exercise
   of this refresh must use `cd apps/api && railway run --service "/api" …`.
6. **CODE-READ — the refresh's own result is thrown away.** `ChannelTruthPanel.tsx:71-77` ignores
   `skusOk / skusFailed / errors[]` and simply re-GETs, so "Amazon answered for 3 of 21 SKUs" renders
   as a complete picture. `refreshEbayLiveImages`' `skipped` codes (`NO_ITEM_ID` / `API_DISABLED` /
   `NO_CREDS`) and `error` have no studio reader at all.
7. **CODE-READ — `neverChecked` is `live.length === 0`** (`:84`). A channel that genuinely serves no
   images, and a channel nobody has asked, print the same sentence. `fetchedAt` is on every row
   (`schema.prisma:4913`) and the panel never renders it — so "checked 2h ago" does not exist, and
   §15's own distinction is only half kept one level down.
8. **CODE-READ — four independent answers to two questions.** DRIFT: `channelTruth.findDrift` (web,
   dead), `categorizeAsinDiff` (server), `categorizeReconcile` (server, different normaliser),
   `LiveChannelStrip.nexusUrlFor` (web, no normaliser). STALE: `GET …/amazon-images/stale` (server,
   Amazon) vs `findStaleListingImages` (client, eBay/Shopify —
   `tabs/images/ChannelStaleBanner.tsx:43-60`). The banked rule applies: put the rule in the engine
   and assert parity, or they drift.
9. **CODE-READ — three mirrors of one row type in web.** `tabs/images/types.ts:117`,
   `_studio/images/types.ts:183-197` (`ChannelLiveAsset`), `channelTruth.ts:17-24` (`LiveImage`). None
   is imported from the server's shape. This is the wire→UI mirror-drift class that cost the sheet the
   image trio (`_studio/sheet/channel/types.ts:310-322`).
10. **CODE-READ — the studio fetches the live rows twice and drops one copy.**
    `images-workspace.routes.ts:176` selects every `ChannelLiveImage` for the product and returns it
    as `channelLiveImages` (`:389`); the studio type declares it (`_studio/images/types.ts:233`); and
    `useImageWorkspace.ts:144-150` never exposes it. `ChannelTruthPanel` then re-fetches the same rows
    from `/live-channel-images`. Wasted round-trip **and** two read paths that can disagree.
11. **CODE-READ — the `etag` column is written and never read.** `hashImages` promises a
    *"short-circuit if Amazon's response is unchanged"* (`amazon-live-images.service.ts:52-62`), the
    value is stored (`:164,:173`), and grep finds no reader in `apps/api/src`. A comment asserting a
    property the code does not have; every re-check spends the full N calls.
12. **CODE-READ — N+1 twice over in the adopt.** `adoptAmazonImages` loops markets → serial refresh
    (N+1 SP-API calls each) → then per live row does `resolveVariationId` + `listingImage.findFirst`
    (`:146-163`) — one or two DB round-trips per image, inside a per-market loop.
13. **CODE-READ — eBay's refresh is a full replace with no market dimension.**
    `deleteMany({productId, channel:'EBAY'})` (`:219`) with `marketplace` hardcoded `null` while
    `marketplace` is used only to pick the siteId (`:148,:185`). Correct while eBay is IT-only
    (`project_active_channels`); the moment a second eBay market exists, a DE refresh silently wipes
    IT's truth.
14. **CODE-READ — no test anywhere covers a live-image path end to end.** `apps/api/src/services/__tests__/`
    holds `amazon-mirror-diff.test.ts` (pure `categorizeAsinDiff` only). Nothing tests
    `refreshAmazonLiveImages`, `refreshEbayLiveImages`, `refreshShopifyLiveImages`,
    `adoptAmazonImages`, or the 404-wipes-the-cache path.

## 6. Proposed home in the studio

### 6.1 Primary home + mirrors

**Primary `H8` (Images tab, per-scope) · at rest `H2` FOLDED into report 10's `Channel check`
column · verbs `H3` ROW + `H4` SELECTION + `H5` CONTEXT(alias-group) · backlog `H9` · NO new drawer
pane.**

**H8 is primary because the answer is per-slot and only the Images tab has slots.** Drift is not
"this listing differs" but "MAIN and PT03 differ, PT07 exists only on Amazon" — three kinds
(`channelTruth.ts:26-32`) at coordinates that exist nowhere else in the studio. The sheet has one
picture per row (`imageUrl`/`photoCount`/`imageInherited`, `studio-sheet.service.ts:1353-1355`); the
matrix has the grid the diff is shaped like. #447 already settled that the Images tab is per-scope
and that the seam is the per-scope component — so the generalisation is: `ChannelTruthPanel` becomes
channel-agnostic with a **per-channel reader + join-key adapter**, mounted under `AmazonMatrix.tsx:252`,
under `EbayGrid.tsx:107-117`'s header, and under the Shopify pool when it exists.

**H2 must be report 10's column, not a second one — and the reason is mechanical, not tidiness.**
The field truth and the image truth arrive in **one HTTP response** on both channels: Amazon's
`getListingsItem({includedData:['summaries','images']})` carries the summaries and the image variants
together (`amazon-sp-api.client.ts:1262-1267`; `amazon-live-images.service.ts:119`), and one eBay
Trading `GetItem` can carry `PictureDetails` and `ItemSpecifics` in the same `OutputSelector` list
(`ebay-live-images.service.ts:67-70`). Two columns with two `checkedAt`s would mean two calls for one
answer, two refresh verbs an operator must remember to run in pairs, and two timestamps that
disagree. So: **ONE `Channel check` column, ONE `checkedAt`, ONE refresh verb**, whose count is a sum
and whose tooltip names the halves — `⚠ 5 differ (3 fields · 2 images)`. Clicking the images half
takes the operator to the Images tab; the fields half stays in the sheet. Read-only and derived: no
editor, no fill handle, no provenance mark.

**Verbs.** `channel-check` (the refresh) is the SAME verb id report 10 declares, extended to fetch
both halves — declared once in `channelActions.ts`, so it appears on the row menu, the `⋯` column,
the selection bar and `RecordActions` without a second declaration. `adopt-live-images` is a second
verb whose **primary surface is H8** (the operator must see which slots they are adopting) with an
`H5` alias-band mirror for "adopt everything this listing has that we do not".

**No new drawer pane (H7).** Four panes today, and report 10 proposes two more inside 520 px; a
seventh for images would repeat the chrome cost #169 exists to prevent. The record images strip
(`_studio/images/record/useRecordImages.ts`) gains **one line** — `checked 2h ago · 2 differ` linking
to the tab — which is a mirror, not a home.

**H12 for one thing:** the drift modal's "Republish to fix" (`LiveImageDriftModal.tsx:109-117`) is a
dead prop **and** all three channels report `gated` on the server (#127), so re-publish cannot be the
remedy today. Say that in words rather than shipping the button; the shipped remedy is adopt.

### 6.2 What the sheet shows at rest, per scope

| scope | at rest |
|---|---|
| **master** | Nothing. Master is not a channel; the verb returns `HIDDEN` and no column appears. |
| **Amazon · market** | One `Channel check` cell per variant row: `—` never checked · `✓ matches` · `⚠ N differ`, tooltip naming fields and slots. Amazon images are per-child ASIN, so the row IS the unit. |
| **eBay · market, alias band** | Two facts on the band, never merged (`channelTruth.ts:5-14`): a `Pill` reading `checked 2h ago` / **`never checked`**, and only after a check `⚠ 3 differ`. Variant rows show `—` for the image half, because eBay images key on the BUCKET not the SKU (defect 3); the tooltip says so instead of implying a per-row answer. |
| **Shopify (single store)** | Column present, verb **enabled** — the server branch has worked since PB.8b (`product-images-crud.routes.ts:1201`) and the old UI's "not wired" is false (defect 5). No market dimension, so `checkedAt` is per store. |

A view chip **`Drift`** joins the channel chip row, and it should use the registry's existing honesty
contract verbatim: **`count: null` = "nobody has counted", rendered with no number and never hidden**
(`_studio/sheet/channel/viewChips.ts:8-24,:34-42`). That contract was written for readiness and
already models "never checked" exactly — this feature needs no new vocabulary for its hardest state.

### 6.3 The interaction, step by step

**Refresh (`channel-check`).** Right-click a row or the alias band, or tick rows → **Check the
channel**.
1. **COLLECT** — none.
2. **PREFLIGHT** — one server call per distinct **listing**, not per row: rows collapse to
   `{coordinate, externalListingId | sku set}` before anything is fetched. Returns
   `{checkedAt, fields[], images[], unreadable[]}`. `unreadable[]` is mandatory and carries the
   reason (401 / 429 / transport / `API_DISABLED` / `NO_CREDS`), because defects 4–6 all reduce to
   rendering an unreadable channel as an empty one. A failed fetch sets `unavailable` and the verb
   does not run (`registry.ts:126`).
3. **CONFIRM** — the refresh is a read that changes only our replica; `level: 'confirm'` with the
   call cost stated ("21 SKUs × Amazon IT — about 5 seconds"). Never a bare keystroke.
4. **RUN** — persists the replica; `invalidates: {kind:'page'}` (the channel sheet has no row-level
   refetch — `registry.ts:132-139`).
5. **REPAINT** — column flips, band pill re-times, the Images tab's truth panel re-reads.

**Adopt (`adopt-live-images`).** From the truth panel (per-slot checkboxes) or the band.
1. **PREFLIGHT** — `POST …/amazon-images/adopt` with **`dryRun: true`** (`amazon-images.routes.ts:175`
   already supports it) → `perMarket[{liveRows, created, skippedExisting}]`. `findings[]` = one entry
   per slot; `severity:'info'` where the slot is empty in Nexus, `'warn'` where a `PUBLISHED` row
   already exists (gap-only means it will be **skipped**, not overwritten — the confirm must say so
   or the operator will read a skip as a failure). `consequences[]` names the count that will be
   created; `sideEffects[]` names the real one: **adopting turns the channel's picture into our
   published baseline, which is what stops the next exact-mirror publish from deleting it** —
   `amazon-adopt.service.ts:1-18` in the operator's words. `payload` carries the dry-run result so RUN
   applies what was approved (#118).
2. **CONFIRM** — `ActionConfirm` from the sheet, `DrawerConfirm` from the drawer. `type-to-confirm`
   with the **ASIN** as the phrase when the adopt would touch more than one market (`registry.ts:124`
   — a real value, never "DELETE").
3. **RUN** — the same route with `dryRun: false`. It already writes an `imagesAdopted` audit row
   (`:177-186`). **A restore point, not a mutation of the operator's gallery:** the adopt writes
   per-market `ListingImage` rows, NOT `ProductImage` — the old UI's master-gallery-as-LIFESTYLE
   behaviour (defect 2) is the thing to drop.
4. **REPAINT** — `{kind:'page'}`; the matrix shows the adopted slots and the drift count drops.

DS components: `Pill` + `Badge` (band, column), `Tooltip` (the named slots), `Menu`/`MenuItemDef`
(row menu), `BulkActionBar` (selection), `Modal` via `ActionConfirm`, `Checkbox` per finding,
`Thumbnail` (the live strip — replacing the panel's raw `<img>` at `ChannelTruthPanel.tsx:150`),
`Banner` for a partial answer, `EmptyState` for never-checked, `Button` for the state-labelled check.
**No new DS component is needed.** Keyboard: `useActionPress`; confirm is a focus-trapped `Modal`;
nothing on a bare key. With the drawer open the sheet stays live and the confirm renders as
`DrawerConfirm` (the z-order trap #127 records).

### 6.4 Per-scope rules

- **Master**: verb HIDDEN, no column, no panel. Master has no channel to be true to.
- **Amazon · market**: per-child-ASIN, so N calls are irreducible on `getListingsItem` — but the
  **parent SKU must be dropped from the list unless it carries an ASIN** (defect 4), and the market
  is required, never inferred (the route already 400s without it).
- **eBay · alias band**: one `GetItem` per ItemID answers the whole variation set, including shells
  via `SharedListingMembership` (`ebay-live-images.service.ts:149-156`). The band is the unit. The
  full-replace write must gain a `marketplace` dimension before eBay has a second market (defect 13).
- **Shopify (GLOBAL)**: one call, no market; pool positions and per-variant `image_id` assignments are
  two different row shapes and must render as two things, not one list.
- **Alias bands with no children** (the 22 measured shells): the check is *most* valuable here — a
  shell is exactly a listing we hold nothing about. The confirm must say "this records what eBay
  holds; it will populate 0 rows" rather than looking like a no-op failure.

### 6.5 Provenance / autosave / readiness / publish

- **Provenance.** An adopted row is a normal channel-scope write and takes the normal mark. It gets
  **no** new "from channel" glyph — the layer union is the server's, and "it came from a pull" belongs
  to the audit row (`imagesAdopted`) and the History pane. The `Channel check` column is derived and
  carries no mark at all.
- **Autosave.** The adopt must refuse while the coordinate has unsaved image writes — the ledger
  already knows, keyed by SUBJECT (`_studio/images/imageWrites.ts:1-22`), and an in-flight write
  landing after a bulk apply silently reverts it. Refuse with `unavailable`, do not race.
- **Readiness is untouched.** `readiness.service.ts:201-288` has no image or drift issue class; it
  evaluates required fields, lengths, enums and deprecations. A drifted listing can be perfectly
  ready and a ready listing can have drifted — folding drift in would repeat the STALE/DRIFT collapse
  `channelTruth.ts:5-14` exists to prevent. Adopted values change readiness only by changing values.
- **Publish.** The check is a READ and stays available in every publish mode, including `gated` — that
  is the point, and it is why `getListingsItem` sits outside the write gate. Nothing on this surface
  publishes. The **drift → re-publish** remedy is unavailable today (all three channels `gated`,
  #127) and must be stated, not implied by a button; the **mirror-publish** decision keeps its
  existing honest refusal (`mirrorPlan.ts:66-79`).
- **H9 / Errors & Sync.** A `Drifted images` group is right in principle — the console is
  queue-shaped and grouped by cause — but the console today is deliberately **one pane over
  `OutboundSyncQueue`** because the other three sources measured zero (#127,
  `channel-ops/syncQueue.ts:1-17`). Drift rows exist only after a check, so the group must be a
  second source with the chips' `count: null` semantics: present, uncounted, and saying why. It must
  never render an unchecked product as a clean queue.

### 6.6 ASCII mockup — the generalised truth panel (Images tab, eBay · IT)

```
┌ eBay images · IT ─────────────────────────────────────────────────────────────────────┐
│ 3 buckets · 16 photos · max 12 per variation      [one bucket per photo]              │
├───────────────────────────────────────────────────────────────────────────────────────┤
│ WHAT EBAY HAS   checked 14:22 (2h ago)   ⚠ 2 differ   1 unreadable   [Check again]    │
│                                                                                       │
│  ⚠ Item 2264… was read; 1 variation set could not be (eBay answered 429). That set    │
│    is NOT reported as matching — we did not see it.                                   │
│                                                                                       │
│  Default   ours ▢▢      eBay ▢▢          ✓ both photos match                          │
│  Nero      ours ▢▢▢▢▢   eBay ▢▢▢▢▢▢   ⚠ position 6 exists only on eBay  [Adopt ▾]  │
│  Giallo    ours ▢▢▢▢▢▢▢ eBay — — — —    ⚠ could not read                             │
│                                                                                       │
│  A mirror publish would REMOVE what eBay has and we do not fill. Adopt first, or       │
│  publishing loses position 6. (eBay publishing is disabled on the server today.)      │
└───────────────────────────────────────────────────────────────────────────────────────┘

sheet at rest (eBay · IT) — ONE column, shared with the field pull
│ ▾ ① GALE-KAN-PRO   Listing 2264…  │ checked 2h ago │ ⚠ 5 differ (3 fields · 2 images) │
│   ├ GALE-KAN-PRO-N-S              │                │ ⚠ 2 differ  (fields)             │
│   └ GALE-KAN-PRO-N-L              │                │ — never checked                  │
```

## 7. Contracts and data

**Reused unchanged.** `GET /live-channel-images` and `POST …/refresh`
(`product-images-crud.routes.ts:1139,:1162`) — the three per-channel services behind them are the
readers. `POST …/amazon-images/adopt` with `dryRun` (`amazon-images.routes.ts:167`) — the preflight
and the run, already audited. `GET …/amazon-images/mirror-diff` (`:223`) and `…/stale` (`:406`).
`ActionImpact` / `GridAction` as they stand, including `payload` and `run(rows, impact?)`.

**Server changes (PES.5 + PES.7).**
- **Fix the comparison first — it is the feature.** One shared identity function that compares by
  MEANING across namespaces: match on `(slot, sourceProductImageId)` or on a stored content hash,
  and where only URLs exist, compare Amazon's live URL against **what we last sent for that slot**
  (the feed submission), not against the current master URL. Put it in the engine and assert parity
  between `categorizeAsinDiff`, `categorizeReconcile` and whatever the panel renders, so defect 8
  cannot come back.
- `unreadable[]` on every refresh response, with the reason named; the studio must render
  "could not read" differently from "holds nothing" (defects 4, 6, 7).
- Drop the parent SKU from the Amazon SKU list unless it has an ASIN, and **never sweep on a 404** —
  a SKU that was not read keeps its cached rows (defect 4).
- Read the `etag` you already write (defect 11), or delete the column and the comment.
- Give the eBay replica a `marketplace` before eBay has a second market (defect 13).
- Additive only: `checkedAt` + `driftCount` on `SheetListing` (`studio-sheet.service.ts:1288-1293`
  forbids reusing `lastSyncedAt`, in words), and a `ChannelImageAdoptRecord` mirroring
  `FlatFilePullRecord`'s audit shape if the `imagesAdopted` audit row proves too thin.
- Reclassify the refresh to a READ permission. `products.edit` for asking a channel what it serves is
  the same defect report 10 found; the **adopt** stays a write (`permissions-manifest.ts:380,:412`).
- An Amazon (and Shopify) read-back cron to match eBay's, or say out loud that Amazon is
  manual-only — the old UI promised one for four months (`LiveChannelStrip.tsx:12-13`).

**Client changes.** **PES.7** — generalise `ChannelTruthPanel` with a per-channel reader/join-key
adapter and mount it on all three scopes; render `fetchedAt` and `unreadable[]`; consume the refresh
RESULT; swap the raw `<img>` for DS `Thumbnail`. **PES.3** — fold the image half into report 10's
`Channel check` column and the `Drift` chip; declare `adopt-live-images` beside `offer-toggle`
(`channelActions.ts:162`). **PES.4** — one line in the record images strip; no new pane. **PES.2** —
the checkable `findings` list inside `ActionConfirm` (shared with report 10, built once). Delete one
of the three web mirrors of `ChannelLiveImage` and import the other two from it; have
`useImageWorkspace` expose the `channelLiveImages` the payload already carries (defects 9, 10).

## 8. Risks and traps

1. **🔴 The number the whole feature exists to show is, on today's code, structurally always "all of
   them" (defect 1).** Shipping the panel on eBay/Shopify before the comparison is fixed multiplies a
   wrong answer across three channels. Fix the compare, then generalise.
2. **🔴 An adopt is a real write to the PRODUCTION database, from local dev.** The refresh is a read;
   `adoptAmazonImages` creates `ListingImage` rows with `publishStatus:'PUBLISHED'`. Exercise it with
   `dryRun: true` only, and any live run inside the fixture family with the family announced first.
3. **🔴 "Never checked" is not "no drift", and "could not read" is not "holds nothing."** Both
   collapse in the current code (defects 4, 6, 7); both must be distinct states on screen. §15's own
   record — the check was never clicked — means every claim about what a populated cache looks like
   is a prediction until someone with authorisation runs it on Railway (defect 5).
4. **🔴 A refresh can make the truth WORSE.** The 404-sweep (defect 4) and eBay's full replace
   (defect 13) both delete cached rows on a partial answer. A read-back that can lose data needs the
   same care as a write.
5. **Images on Amazon are global per ASIN, and EU quantity is shared.** Adopting per market writes
   `MARKETPLACE`-scope rows per market (`amazon-adopt.service.ts:150-157`), which is right for
   country-specific uploads; but the operator must not read "adopted on IT" as "IT only" for slots
   Amazon serves globally. Say which is which, or say it is not known.
6. **The remedy for drift is unavailable.** All three channels `gated` (#127); the exact-mirror
   publish is the only thing that can push our version back, and it DELETES what we do not fill
   (`amazon-mirror-diff.service.ts:9`). Adopt-then-publish is the safe order and the panel should say
   so; a "Republish to fix" button today would be #197's false positive in button form.
7. **Untouchables.** No edits in `products/amazon-flat-file/**` or `ebay-flat-file/**`; FBA quantity
   untouched; import flows untouched. The old `tabs/images/**` tree is SPECIFICATION.
8. **AI stays dark** (#13). Nothing here generates or analyses a picture; the three no-caller image AI
   routes (§30.1) are a separate gap and stay dark.
9. **Rate limits and cost.** See below — and note the 200 ms floor is **per process**
   (`amazon-sp-api.client.ts:324-335`), so two API replicas double the effective rate against a limit
   the client assumes is 5 rps.
10. **The audit's own trap.** Row 5.52 has no status and #197 lists `adopt-to-master` as not rebuilt.
    Do not fill 5.52 as `✅` off the existence of `ChannelTruthPanel`: the panel covers the *stale*
    and *mirror* halves and neither the drift nor the adopt.

### The refresh's cost / rate-limit budget

| channel | calls per check | floor | notes |
|---|---|---|---|
| Amazon · one market | **N children + 1** (`amazon-live-images.service.ts:99-110`) — 21 on GALE | ≥ 200 ms each → **≥ 4.2 s**, serial | +1–7 s per 429/5xx retry (`:357`); the parent call is usually a wasted 404 |
| Amazon · adopt, all EU markets | 5 × (N+1) = **105** | **≥ 21 s** plus per-image DB round-trips (defect 12) | never offer this from a single button; require a market |
| eBay · one product | **1** `GetItem` | one call | the alias band is the natural unit; shells resolve via `SharedListingMembership` |
| eBay · cron sweep | 1 per eBay-listed parent (**22 products measured**, #127) every 6 h at `:45` | sequential *"gentle over fast"* (`:268-270`) | the only automated freshness in the feature |
| Shopify · one product | **1** REST call | one call | works today; the UI hides it |

Budget rule to adopt: **one channel call per COORDINATE per check, and the check is always explicit.**
Never on tab load (the panel already gets this right, `ChannelTruthPanel.tsx:44-45`), never
"all markets", and the `etag` short-circuit that was already written should actually be read so a
re-check on an unchanged listing costs the calls once and the downstream work zero.

## 9. Open questions for the Owner (max 3)

1. **Does "adopt" write the MASTER gallery, or the per-market channel baseline?**
   *Recommended: the channel baseline only.* `adoptAmazonImages` already does exactly that, gap-only,
   with the audit row — and its reason is the one that matters: it is what stops the first
   exact-mirror publish from wiping images that only ever lived in Seller Central. The old UI's
   master-gallery adopt pushed the channel's bytes into the operator's own gallery as a `LIFESTYLE`
   with no slot and no market (defect 2); that behaviour should be dropped, not rebuilt. If the Owner
   wants "put this picture in my master gallery too", that is a separate, explicit second step from
   the viewer.
2. **One `Channel check` column for fields AND images, or two?**
   *Recommended: one.* Both halves arrive in the same channel response on Amazon and on eBay, so two
   columns cost two calls, two refresh verbs and two timestamps that will disagree. One column, one
   `checkedAt`, a summed count, and a tooltip that names the halves. This is the one decision that
   binds report 10's lane and this one together; it needs answering before either builds the column.
3. **Do we spend one authorised `Check Amazon` on the fixture family to settle defect 1 on real
   data?**
   *Recommended: no channel call is needed, and that is the point.* One unit case feeding a real
   (Cloudinary plan URL, `m.media-amazon.com` live URL) pair into `categorizeAsinDiff` settles it for
   free. Spend the authorised live read afterwards, on Railway, to confirm the fix — not to discover
   the defect.

## 10. Effort and dependencies

| piece | lane | effort |
|---|---|---|
| Fix the drift comparison across URL namespaces + parity assertion over the 3 (4) implementations | PES.5 | **M** |
| `unreadable[]` on every refresh; stop the 404 sweep; drop the ASIN-less parent SKU; read the `etag` | PES.5 | **M** |
| `checkedAt` + `driftCount` on `SheetListing` (additive); permission reclassification | PES.5 | **S** |
| Generalise `ChannelTruthPanel` (per-channel reader + join key: slot / bucket / pool) + mount on eBay & Shopify | PES.7 | **M–L** |
| Panel honesty pass: render `fetchedAt`, consume the refresh result, split "unreadable" from "empty", DS `Thumbnail` | PES.7 | **S–M** |
| `adopt-live-images` verb (preflight = `dryRun:true`) + per-slot checkboxes | PES.7 + PES.3 | **M** |
| Fold the image half into `Channel check` + the `Drift` chip | PES.3 | **S–M** |
| Checkable `findings` in `ActionConfirm` / `DrawerConfirm` (shared with report 10) | PES.2 | **S–M** |
| One line in the record images strip | PES.4 | **S** |
| `Drifted images` group in Errors & Sync (second source, `count: null` semantics) | PES.3 | **S–M** |
| Amazon (+ Shopify) read-back cron, or an explicit "manual only" statement | PES.5 | **S** |
| eBay replica gains a `marketplace` dimension | PES.5 | **S** |
| Collapse the three web mirrors of `ChannelLiveImage`; expose `channelLiveImages` from the workspace hook | PES.7 | **S** |

**Dependencies.** **Blocking:** the comparison fix — everything else renders a number that is wrong
by construction (defect 1). **Shared, must be built once:** report 10's `Channel check` column, its
`checkedAt`, and the checkable `findings` list; if this lane and report 10's build separate columns,
that is the two-builders-drift pattern on day one. **Adjacent:** report 10's field pull is the same
verb and the same HTTP call — the two lanes should share one server reader per channel, branching on
what to parse, not on what to fetch. **Waiting on the Owner:** the Shopify fixture decision (#127)
gates the third scope; #197's PES.7-ii schedule gates whether the adopt is v1 at all. **Feeds:**
parity row 5.52 (currently blank) and decision D1 in `docs/2026-09-01-channel-ops-research.md`.
