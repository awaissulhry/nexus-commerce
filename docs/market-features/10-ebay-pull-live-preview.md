# 10 — eBay PULL-FROM-CHANNEL + LIVE LISTING PREVIEW

## 1. What it is (operator terms)

Two questions an operator asks about one eBay listing, which today have no honest answer in the
studio. **(a) "What does eBay actually hold right now?"** — before editing, before publishing, and
especially after somebody changed the listing in Seller Hub: refresh our record from the channel and
show me, field by field, what differs from what we hold, then let me choose which of those
differences to adopt. **(b) "What will the buyer see?"** — render the themed HTML description, the
gallery and the aspects as an eBay page, at desktop and phone width, so an obviously broken listing
is caught before a push rather than after. The user is the listing operator on a channel scope
(eBay · IT/DE/FR/ES/UK), at two moments: triage ("why is this listing wrong?") and pre-publish
("is this ready?"). Neither is a per-cell edit, and that is why neither belongs in a cell.

## 2. Old UI — inventory

**Pull entry point.** `tabs/ChannelListingTab.tsx:362-364` — a single "Pull" button, `loading={pulling}`
(`:109`), calling `handlePullFromChannel()` (`:193`). eBay branch `:229-262`: requires `product.sku`
(`:232`), builds `GET /api/ebay/pull-listing?sku=&marketplace=` (`:237`), wrapped in
`fetchWithRateLimitRetry` (`:173-191` — reads `Retry-After`, clamps 1–8s, retries **once**).
**What it does with the answer: nothing.** Best case it writes one sentence into the tab's status
bar — `Pulled latest title: "…"` (`:252`). No diff, no field list, no write. Everything else the
route returned (description, quantity, condition, imageUrls, aspects) is discarded client-side.
Browser-local: the status message and `pulling`. Server round-trip: exactly one GET.

**Live preview.** `tabs/ebay-cockpit/EbayLivePreview.tsx` (458 lines), mounted at
`tabs/ebay-cockpit/EbayCockpit.tsx:686` inside a **384px (`w-96`) sticky right rail** — while its own
desktop skin declares `max-w-[820px]` (`EbayLivePreview.tsx:302`). Skin toggle from the shared
`_shared/cockpit-preview/PreviewSkinToggle.tsx` (54 lines, mobile/desktop, channel-themed classes).
`_shared/cockpit-shell/CockpitPreviewBand.tsx` (82 lines) is the collapsible preview+health band —
**Amazon's**; eBay does not use it (no `CockpitPreviewBand` import in `EbayCockpit.tsx`). Data comes
from `useEbayCompositor.ts:111` — a pure `useMemo` over props the parent already fetched, so the
preview is **entirely browser-local, zero round-trips**, and it composes title/description/price/qty
with a source label (`manual` / `master` / `default`) at `:120-180`.

**Dead / dishonest in the old preview** (CODE-READ):
- `DescriptionRow` (`:444-457`) renders the description as **plain text** (`whitespace-pre-wrap`,
  `line-clamp-4`). The themed HTML body — the single biggest thing an eBay buyer sees — is never
  rendered. `htmlDescriptionOverride` is composed at `useEbayCompositor.ts:143` and then never used
  by the preview.
- Invented facts presented as the listing's: `+ shipping` (`:272`), `or Best Offer · Free returns`
  (`:348`), `Standard shipping` / `30-day returns` (`:436-440`). None is read from the listing.
- The colour swatch in `VariationSelector` is a fixed grey chip (`:96-99`) with the value name as
  `title` — it does not show the colour.

The honest preview already exists elsewhere and is not this component:
`products/ebay-flat-file/DescriptionStudio/EbayDescriptionStudio.tsx:1074` — a `sandbox=""` `srcDoc`
iframe (`:580-584`), DS `SegmentedControl` Desktop 920px / Mobile 375px (`:62-63,:870-873`), scaled
to fit with the scale stated on screen (`:1092-1093`), fed by `POST /api/ebay/description-preview`
(`:539`).

## 3. Backend that exists

**The studio-facing pull route, and why it is nearly useless.**
`GET /api/ebay/pull-listing` — `apps/api/src/routes/ebay.routes.ts:349` (doc block `:335-347`).
Resolves the primary EBAY connection via `tryResolveConnection` (`:360`), gets a token, then fetches
**only** `GET /sell/inventory/v1/inventory_item/{sku}` (`:373`). 404 → `{success:true, found:false}`
(`:385`), non-OK → 502 with the body's first 200 chars (`:391-400`). Returns a normalised summary
(title, description, quantity, condition, imageUrls, aspects) at `:417-430`. **It writes nothing —
no snapshot, no ChannelListing update, no audit row.** `marketplace` is explicitly informational
(`:343-346`), so an IT pull and a DE pull return the same seller-account-scoped item.

**The real per-SKU eBay read, already built and much richer.**
`EbayService.fetchListingForFlatFile(sku, marketplaceId, productId)` —
`apps/api/src/services/marketplaces/ebay.service.ts:863`. Two calls in sequence (`:854-858`):
`inventory_item/{sku}` then `offer?sku=` filtered to the requested `marketplaceId`. Returns 21
fields: title, description, condition, categoryId, price, quantity, bestOffer floor/ceiling/enabled,
handlingTime, imageUrls, aspects, the three policy ids, itemId, offerId, listingStatus, ean, mpn,
brand (`:867-890`). Every call is wrapped in `recordApiCall` so it lands in the API-call audit.

**Its job-shaped consumer** (the working pull-with-diff, inside the untouchable editor):
`apps/api/src/services/ebay-flat-file-pull-preview.service.ts` (264 lines) — in-memory job queue,
`POST /api/ebay/flat-file/pull-preview/start` (`routes/ebay-flat-file.routes.ts:3766`),
`GET …/status/:jobId` (`:3777`), `POST …/apply` (`:3846`) which writes the audit row. Rows are
`EbayPullRow` (`:36-64`). The loop is `for (const product of products)` at `:181` — **strictly
serial, one product at a time, no concurrency and no backoff**, capped at 2000 products (`:163`).

**The account-wide mirrors that already hold "what eBay holds".**
- `EbayListingIndex` — `packages/database/prisma/schema.prisma:13079`: per (marketplace, itemId)
  title, imageUrl, categoryId, price, currency, quantity, quantitySold, format, `variationSkus[]`,
  `aspects Json`, `lastSeenAt`, `endedAt`, `detailSyncAt`, `productIds[]`, `matchStatus`. Written by
  `services/marketing/ebay-listing-index.service.ts:151` (`discoverEbayListings`) from Trading
  `GetMyeBaySelling` ActiveList + `GetItem` detail, capped at `NEXUS_EBAY_DISCOVERY_DETAIL_MAX`
  (default 50, `:148`). Cron `25 */4 * * *` (`jobs/ebay-ads-sync.job.ts:102`). Pure parsers
  `parseActiveList` (`:77`) and `parseItemDetail` (`:103`) are exported and tested
  (`ebay-listing-index.vitest.test.ts`).
- `ChannelLiveImage` — `schema.prisma:4876`: the per-product "what is live" mirror for IMAGES, with
  `GET /api/products/:id/live-channel-images` (`routes/product-images-crud.routes.ts:1139`) and
  `POST …/live-channel-images/refresh` (`:1162`), eBay branch at `:1188-1195` →
  `services/images/ebay-live-images.service.ts:123`.
- `ListingReconciliation` — `schema.prisma:13915`: `externalSku`-keyed channel-side title /
  channelPrice / channelQuantity / channelStatus + match result + operator decision.
  `runEbayReconciliation` (`services/listing-reconciliation.service.ts:763`) fetches ALL offers for
  a marketplace and upserts in `$transaction` batches of 50 (`:836-839`).
- `FlatFilePullRecord` (`schema.prisma:13965`) + `FlatFilePullJob` (`:14012`) — the pull audit and
  recovery models: `skusRequested`, `skusReturned`, `columnsApplied`, `rowsApplied`, `fieldsApplied`,
  `appliedAt` (null = operator cancelled the diff modal). The exact audit shape this feature needs,
  already migrated.
- `ChannelListingSnapshot` (`schema.prisma:1800`) — `reason` ∈ pre-publish | pre-restore | manual,
  `payload Json` = what was actually SENT, `restoredAt`. The snapshot-before-write store exists.

**The honest preview endpoint.** `POST /api/ebay/description-preview` —
`routes/ebay-description-themes.routes.ts:320`. Calls `renderListingDescriptionSafe`
(`services/ebay-description-theme.service.ts:348`) — **the same renderer the push uses**
(`routes/ebay-flat-file.routes.ts:2256,2624`). Derives single/group mode with
`resolveDescriptionMode` rather than defaulting, with the reason stated at `:326-334`: *"a preview
that lies about what goes live is worse than no preview."* Empty body is a WARNING, not an error
(`:352-356`). Accepts `themeHtml` for an unsaved draft. Renders no eBay call and writes nothing.

**Safety gates.**
- Writes: `callTradingApi` (`services/ebay-trading-api.service.ts:230`) refuses in production
  without `NEXUS_EBAY_REAL_API=true` and **in dev returns a fake success**
  `{ack:'Success', itemId:'DRYRUN-<call>', raw:''}` (`:246`).
- `getEbayPublishMode()` (`services/ebay-publish-gate.service.ts:40`): `gated` unless
  `NEXUS_ENABLE_EBAY_PUBLISH`, else `EBAY_PUBLISH_MODE` (default `dry-run`).
- Reads deliberately bypass that gate: `ebay-listing-index.service.ts:5-9` — *"READ-ONLY Trading
  calls via direct authenticated fetch — deliberately NOT callTradingApi, whose
  NEXUS_EBAY_REAL_API gate exists for WRITES and would return DRYRUN fakes in dev."*

**Permissions.** `lib/auth/permissions-manifest.ts:354` — `RW(F.listingsView, F.channelsSync,
pfx('/api/ebay'))`: the pull GET needs `listings.view`; anything POSTed under `/api/ebay` needs
`channels.sync`. `:361` does the same for bare `/ebay`, so **`POST /ebay/description-preview` — a
pure render that touches nothing — is gated behind a WRITE permission** (CODE-READ). Existing
studio channel verbs gate on `products.edit` (`_studio/sheet/channel/channelActions.ts:52`).

## 4. Studio today

- **Nothing pulls.** Parity row **3.4** is `🕳`: *"No pull-from-channel anywhere in the studio. An
  operator cannot refresh a coordinate from Amazon/eBay. Read-only surfaces (drawer ListingsPane)
  show what we hold, not what the channel holds."* (`docs/pes-parity-audit.md:122`.) The audit's own
  triage order puts it **second of 22** — *"3.47 snapshot/restore → 3.4 pull-from-channel (nothing
  else tells you what the channel actually holds)"* (`:222`).
- **Nothing previews.** Parity row **3.17** is `🕳`: *"no live PDP preview anywhere in the studio"*
  (`:139`).
- **`ListingsPane.tsx`** (216 lines) is explicitly "what THIS scope's channel currently thinks the
  record is" — but every fact comes from the sheet row, *"No second fetch, so this pane and the
  sheet's readiness chip cannot disagree"* (`:17-19`). It is our record, not eBay's.
- **`ComparePane.tsx`** (258 lines) compares one field across master / locale / alias with
  copy-across, and names *"accept channel value into master"* as the verb `DiffVsMasterPanel`
  deliberately left out (`:7-9`). Its reads come from `useCompare.ts:60` →
  `GET /api/products/:id/studio/sheet?scope=&market=&channel=&locale=` — **one NEXUS scope read per
  target**. `CompareCell.layer` is typed `Layer` (`drawer/types.ts:294-306`) = PES.5's **seven
  server layers verbatim** plus three source-only extensions. There is no `channel-live` layer and
  inventing one puts a client-side value into the union the server owns.
- **The precedent is in the images lane, and it is the right one.**
  `_studio/images/channel/amazon/ChannelTruthPanel.tsx:4-13`: *"🔴 …**'not checked' is not 'no
  drift'.** The live read-back cache is empty until someone refreshes it (measured on GALE-JACKET: 0
  rows), and a panel that rendered that as a clean bill of health would be asserting something
  nobody has looked at."* Button label follows state — `Check Amazon` / `Check again` / `Asking
  Amazon…` (`:99-101`). The diff is a **pure, tested** module
  (`images/channel/amazon/channelTruth.ts`) that keeps STALE and DRIFT apart on purpose (`:5-14`)
  and compares URLs by identity, not bytes (`sameImage`, `:51`). eBay has no field equivalent.
- **Verb substrate is ready.** Hub ruling **#118(1)** approved `ActionImpact.payload?: unknown` +
  `run(rows, impact?)` **specifically so pull would not have to fetch twice**
  (`docs/pes-claims.md:20205-20213`) — *"a confirm describing data that is not what lands is
  precisely the dishonesty the whole shape exists to prevent"* — and **it has landed**:
  `design-system/grid/actions/registry.ts:122` (`payload`) and `:203` (`run(rows, impact?)`), with
  the reason quoted in the type doc at `:110-121`. Ruling **#118(2)** fixed the order
  COLLECT → PREFLIGHT → CONFIRM → RUN (`registry.ts:221`). `findings[]` (`:107`) already carries
  per-row verdicts and `ActionConfirm.tsx:110-121` renders them. The same ledger entry records
  *"PES.3 proceeds on pause/activate + broadcast against the type as it stands; **pull waits on
  (1)**"* — the dependency is now discharged.
- Existing channel verbs to sit beside: `offer-toggle` (ROW, `channelActions.ts:162`),
  `broadcast-to-listings` (SELECTION with a COLLECT picker, `:308`), `open-record` (ROW, `:380`).
  `SheetToolbar` has `leading`/`trailing` slots (`_studio/sheet/SheetToolbar.tsx:92-94`) and an
  `AbsentControl {control, reason}` contract for honestly-absent controls (`:37-41`).
- Ruling **#169 / layout §1b** — chrome is expensive, the sheet is ~90–95% of viewport; the drawer
  slides over at ~519–520px (`docs/2026-09-01-layout-v2-spec.md:89`) and must stay non-modal
  (`:769-781`). `RecordDrawer.tsx:471-538` builds its pane list as a DS `Tabs` array — four today.

## 5. Defects and slowness

1. **CODE-READ — the pull reads a store our own publisher may never have written.**
   `pull-listing` (`ebay.routes.ts:373`) and `fetchListingForFlatFile` (`ebay.service.ts:855`) both
   read **only** the Inventory API. But multi-variation and shared listings are published through
   **Trading `AddFixedPriceItem`** (`services/ebay-shared-listing-push.service.ts:476` →
   `ebay-trading-api.service.ts:285`), which creates no inventory item. For those listings the pull
   returns `found:false` / `null` — *"No eBay inventory item with SKU X"* — for a listing that is
   live. `EbayListingIndex` reads the Trading side and is the only mirror that sees them.
2. **CODE-READ — every failure is reported as "not on eBay".** `ebay.service.ts:928-932` is
   `catch { return null }` with the comment *"Treat all errors as 'not on eBay'"*, and `:972-974`
   is `catch { offers = [] }`. A 401, a 429 and a 500 are indistinguishable from a genuine 404, and
   `ebay-flat-file-pull-preview.service.ts:189-192` then counts them as `skipped`. This is exactly
   `reference_could_not_measure_vs_measured_empty`, in the code path a new pull would reuse.
3. **CODE-READ — a pull built on `callTradingApi` would silently invent an empty listing.** In dev
   it returns `{ack:'Success', itemId:'DRYRUN-GetItem', raw:''}` (`ebay-trading-api.service.ts:246`).
   Every parser (`parseItemDetail`, `parseGetItemQuantities`) would read that as "eBay holds
   nothing", and an "adopt" step would then blank our record. `ebay-listing-index.service.ts:5-9`
   avoids this deliberately; a new lane must be told to.
4. **CODE-READ — multi-value aspects are flattened, which will manufacture drift.**
   `ebay.service.ts:985`: `aspects[k] = Array.isArray(v) ? v.join(', ') : String(v ?? '')`. The
   approved model makes eBay MULTI aspects a **list** shape
   (`docs/2026-09-04-channel-attribute-model-design.md:153`), so a `|`-separated or per-slot column
   compared against `"a, b"` differs on every multi-value aspect. IT has 4 such aspects declared
   (`:56`).
5. **CODE-READ — the two channel readers disagree about aspect KEY LANGUAGE.** Inventory
   `product.aspects` returns whatever the seller sent; Trading `parseItemDetail`
   (`ebay-listing-index.service.ts:107-113`) parses `ItemSpecifics/NameValueList/Name` — the
   **localised** names. Measured in the design doc: *"23 Italian-keyed aspects per GALE child"* on
   247 of 252 IT listings (`:58`), while columns are keyed `aspect_<English>` (`:96-97,:120-122`).
   Without the `localizedName → englishName` map (it exists —
   `services/pim/channel-specs/ebay.ts:29,184`; `services/ebay-category.service.ts:1221`) every
   aspect reads as drift.
6. **CODE-READ — there is nowhere for most of a pull to LAND.** `CHANNEL_FIELD_MAP`
   (`services/pim/channel-field-map.ts`) has **6 entries**; only `ebay_title`, `ebay_description`
   and `ebay_variationTheme` are eBay's. Everything else arrives as `attr_*` + `target:'channel'`
   and merges into the `overrideData` JSONB bag (`routes/products.routes.ts:1022-1029,2450`). eBay
   aspects live on listings in `platformAttributes.itemSpecifics`, and eBay·IT has **0 aspect
   columns today** (`channel-attribute-model-design.md:57`). An "adopt aspects" button today would
   be a write nothing reads — the same shape as the `overrideData.amazon_title` defect the map's own
   header describes.
7. **CODE-READ — retry lives in the browser, once.** `ChannelListingTab.tsx:173-191` is the only
   rate-limit handling in the whole pull path; there is no shared server-side backoff for eBay reads
   (no generic helper under `apps/api/src/utils`; each service rolls its own). A studio verb that
   fetches during PREFLIGHT cannot re-fetch during RUN (#118) — so the single fetch must be the
   robust one, on the server.
8. **CODE-READ — serial N+1 on a family pull.** `ebay-flat-file-pull-preview.service.ts:181` loops
   products one at a time, 2 HTTP calls each, no concurrency. A 21-row GALE family = 42 sequential
   eBay calls, where one Trading `GetItem` on the alias returns the whole variation set
   (`parseItemDetail` already extracts `variationSkus`).
9. **CODE-READ — the preview renders the wrong thing in the wrong box.** Description as plain text
   (`EbayLivePreview.tsx:444-457`) while the themed renderer exists server-side; hardcoded
   shipping / returns / Best-Offer copy (`:272,:348,:436-440`) presented as this listing's terms —
   a `feedback_100_percent_honest_ui` violation; and an 820px desktop skin inside a 384px rail
   (`EbayCockpit.tsx:684-690`).
10. **MEASURED-IN-DOC — "last synced" is not "last checked", and the server says so.**
    `services/pim/studio-sheet.service.ts:1271-1276`: *"this is when a sync last RAN, which is NOT
    'last checked against the channel': nothing here polls the channel to confirm the remote still
    matches. Named `lastSyncedAt` so a renderer cannot label it as a freshness check it is not."*
    Any drift surface needs its own `checkedAt`, and must not borrow this one.
11. **CODE-READ — `pull-listing` ignores its own `marketplace`** (`ebay.routes.ts:343-346`), so on a
    per-market studio scope it answers a question that is not the one asked.
12. **CODE-READ — no test covers the pull path end to end.** `ebay-listing-index.vitest.test.ts`
    tests the Trading parsers; there is no test for `fetchListingForFlatFile`, for `pull-listing`,
    or for any field-level diff. The images twin, by contrast, has a pure tested diff module.

## 6. Proposed home in the studio

### 6.1 Primary home + mirrors

**This is two features and they must not share a surface.** One is a verb with a write behind it;
the other is a read-only rendering. Collapsing them into one "eBay panel" is how a preview button
becomes a channel write.

**A — Pull: primary `H5 CONTEXT(alias-group)`, mirrored `H3 ROW` + `H4 SELECTION`, at rest `H2`,
depth `H7`, backlog `H9`.**
H5 is primary for a *mechanical* reason, not a tidiness one: on eBay a multi-variation listing is
**one ItemID**, and one Trading `GetItem` returns the whole variation set — `parseItemDetail` already
pulls `variationSkus`, `aspects`, `categoryId`, quantities out of a single response
(`ebay-listing-index.service.ts:103-121`). The alias band is therefore the natural unit of one
channel round-trip; a per-row pull on the same family costs 2N Inventory calls for the same answer
(defect 8), and the second call is the one that gets throttled. `H3 ROW` stays, because a single
non-variation SKU *is* one listing and an operator triaging one row should not have to find its
band. `H4 SELECTION` is the same verb over N rows/aliases with one preflight — the registry gives
this for free once `available()` accepts a mixed selection, exactly as `offer-toggle` does
(`channelActions.ts:184-214`). The verb is declared **once** in `channelActions.ts` and therefore
appears on the row menu, the `⋯` column, the selection bar and the drawer's `RecordActions` without
a second declaration — channel-ops research §3.2's rule, and *"A verb must NEVER live only in the
drawer."*

**B — Live preview: primary `H7` drawer pane, mirrored `H6` SheetToolbar `trailing`, plus `H10`
link-out.**
A preview is depth, it is read-only, and it needs 400–900px of continuous vertical space with the
sheet still visible behind it — which is the drawer's exact brief (`layout-v2-spec.md:769`). It is
*not* the cell (H1): a description cell holds the **body** an operator edits; the preview is the
composed *page* that body lands in, and it changes when the theme, the gallery, the price or the
aspects change — none of which are that cell. It is *not* the Images tab (H8): the gallery is only
one of its three parts. The `H6` trailing button ("Preview listing") is the scope-level entry so the
capability is reachable without first opening a record — it opens the drawer on the Preview pane for
the focused row, so there is still only one preview surface. `H10` carries the link-out to the real
eBay page (`_studio/drawer/listingUrl.ts` already builds it, and `ListingsPane.tsx:60-62` already
uses it) — because for a **live** listing the only 100%-honest "as the buyer sees it" is eBay's own
page, and our render must never pretend otherwise.

**Why the diff is NOT a `ComparePane` target = `channel-live`.** Three mechanical reasons, in order
of severity: (1) `useCompare` resolves every target with one `GET /studio/sheet?scope=…` read
(`useCompare.ts:72-77`) — a channel-live target is not a scope of ours and cannot be answered by
that route, so it would need a second read path inside a hook whose whole design is one read shape
per target. (2) `CompareCell.layer: Layer` is *"PES.5 §3.2 `StudioCellValue.layer` — the SERVER's
seven, verbatim"* (`drawer/types.ts:294-296`); a client-invented `'channel-live'` member puts a
value the server never sends into a union the server owns, and `isInherited()` (`:406`) and
`ProvenanceChip` would both have to be taught a case that means nothing on the wire. (3) The **axis
is wrong**: ComparePane is one field × N coordinates (`:24-27`, and it argues at length why that is
not a grid); a pull diff is N fields × 2 sides. Rendered in ComparePane's card idiom, a 21-field
diff becomes 21 stacked sections in a 520px panel. So the diff gets **its own H7 pane, built in
ComparePane's card idiom** so the two read alike — the same relationship `ComparePane` and
`ListingsPane` already have (`ComparePane.tsx:29-30`).

### 6.2 What the sheet shows at rest, per scope

| scope | at rest |
|---|---|
| **master** | Nothing. Master is not a channel; `ListingsPane.tsx:64-74` already says so in words, and the pull verb returns `HIDDEN` off master. No column, no mark. |
| **eBay · market, alias band** | Two facts on the band, **never merged into one number** (`channelTruth.ts:5-14`): a `Pill` reading `checked 2h ago` / **`never checked`**, and — only when a check has happened — `⚠ 3 fields differ`. `never checked` is a distinct, first-class state, not a clean bill of health. |
| **eBay · market, variant rows** | ONE `H2` status column, `Channel check`, sortable + filterable, whose cell is a `ProvenanceMark`-style glyph + count and whose tooltip names the drifted fields. Three states: `—` never checked · `✓ matches` · `⚠ N differ`. It is **read-only and derived** — it is not a value anyone can edit, so it never takes an editor and never participates in the fill handle. |
| **Amazon · market** | The same column and the same verb id, wired to the Amazon reader. The twin exists (rows 3.4 / 3.17 are one row each for both channels) and the column must not be eBay-shaped. |
| **Shopify (single store)** | Column present, verb `DISABLED` with a reason ("no Shopify reader yet"), never hidden — `SheetToolbar`'s `AbsentControl` doctrine (`:37-41`) and the registry's "a disabled verb with a reason teaches the operator something" (`registry.ts:227-229`). |

A **view chip** `Drift (N)` joins the existing chip row (`channel/viewChips.ts`) and filters to the
drifted rows — the same shape as `Missing required (7)`, which the audit calls better than
jump-to-card (`pes-parity-audit.md:140`).

### 6.3 The interaction, step by step

**Pull.** Operator right-clicks an alias band (or ticks rows and uses the selection bar, or opens
the drawer and uses `RecordActions`) → **Pull latest from eBay**.

1. **COLLECT** — none. The coordinate and the rows are the selection; there is nothing to ask.
2. **PREFLIGHT** — ONE server call, `POST /api/products/:id/channel-pull/preview`, which fetches
   eBay once, persists the snapshot, computes the diff and returns it. The verb builds an
   `ActionImpact`: `title` = *"Pull eBay · IT listing 226… into 4 of 21 rows?"*; `findings[]` = one
   entry per differing field, `label` = ``Title — eBay: "GALE Pro…" · ours: "GALE Pro Racing…"``,
   `severity: 'warn'` when it would overwrite a **pinned** value and `'info'` when the target is
   inherited or empty; `consequences[]` names the fields that WILL be written; `sideEffects[]` names
   what the operator did not ask for (*"Adopting Description breaks 'follows master' on this
   listing"* — `channel-field-map.ts:38-45`); `payload` = the fetched snapshot id + the resolved
   per-field values, so **RUN applies the snapshot the operator approved** (#118). `level` is
   derived, never fixed: `'confirm'` when nothing pinned is touched, `'type-to-confirm'` with
   `confirmPhrase` = the **ItemID** when it is (a real value, never the word DELETE —
   `registry.ts:123`). A failed fetch sets `unavailable` and the verb does not run
   (`validateImpact`, `:270-278`).
3. **CONFIRM** — `ActionConfirm` from the sheet (`ActionConfirm.tsx:84`), `DrawerConfirm` from the
   drawer (the z-order trap is documented at `layout-v2-spec.md:776-781`). The findings list is
   **checkable**: the operator adopts a subset. Unchecking everything degrades the verb to "just
   record the check", which is a legitimate outcome and is what `FlatFilePullRecord.appliedAt = null`
   already models (`schema.prisma:13990-13991`).
4. **RUN** — the adopted fields go through the **one** write path: `PATCH /api/products/bulk` with
   `expectedVersion` and `marketplaceContexts`, i.e. the same `SheetWriter` every cell edit uses.
   No pull-specific write path, because *"a second write path is a second provenance story"*
   (`ComparePane.tsx:39-42`). One `ChannelPullRecord` audit row is written server-side.
5. **REPAINT** — `invalidates: {kind:'page'}` (the channel sheet has no row-level refetch — the
   registry says so explicitly at `:130-139`), so the adopted cells repaint with their new
   provenance and the `Channel check` column flips to `✓ matches` for the rows that now agree.

DS components: `Menu` / `MenuItemDef` (row menu, already wired through `AliasBandCellParams.menuItems`),
`BulkActionBar` (selection), `Modal` via `ActionConfirm`, `Checkbox` per finding, `Pill` + `Badge`
for the band and column, `Tooltip` for the drifted-field list, `Spinner` during the fetch, `Banner`
for a partial result ("eBay answered for 3 of 4 rows — 1 was rate-limited"), `EmptyState` for
never-checked. Keyboard: the verb inherits `useActionPress`; the confirm is a DS `Modal` with focus
trap and Esc; **nothing is bound to a bare key** — a channel round-trip must never be one keystroke
away. With the drawer open the sheet stays live behind it, the confirm renders as `DrawerConfirm`,
and the drawer's own `⌘↑`/`⌘↓` record-walk keeps working (`RecordDrawer.tsx:304`).

**Preview.** Operator opens a record (identity cell / `open-record` / Enter on identity — the only
three gestures, `layout-v2-spec.md` §5.5) → **Preview** pane; or clicks `Preview listing` in the
toolbar's `trailing` slot, which opens the drawer on that pane for the focused row.

1. The pane calls `POST /api/ebay/description-preview` with `{productId, marketplace, sku}` and
   renders `result.html` into a `sandbox=""` `srcDoc` iframe — the mechanism
   `EbayDescriptionStudio.tsx:580-584` already proves, and `sandbox=""` blocks scripts, forms and
   navigation, which is the whole point when the HTML is operator-authored theme markup.
2. `result.warnings[]` render as a DS `Banner` **above** the frame, never inside it — an empty body
   is a warning, not an error (`ebay-description-themes.routes.ts:352-356`), and a preview that
   swallowed its own warnings would be the dishonesty the endpoint's own comment warns about.
3. Skin toggle: DS `SegmentedControl`, `Desktop 920px` / `Mobile 375px`, with the scale stated on
   screen when the frame is scaled to fit (`:1092-1093`). The state is a per-viewer convenience →
   `localStorage`, wrapped in try/catch.
4. Above the frame, two read-only strips built from the row the sheet already holds (no second
   fetch, `ListingsPane`'s rule): the **gallery** (DS `Thumbnail` row, from the resolved image
   cascade) and the **aspects** (DS `KeyValue`, showing the `aspect_*` columns' resolved values).
5. **A `Live` / `Draft` selector, not a fake PDP.** `Draft` renders what a push WOULD send.
   `Live` renders the stored channel snapshot from the last pull — and when no pull has happened it
   says **"never checked"** and offers the pull verb, rather than rendering our draft under a
   "Live" label. That reuse of the pull's snapshot is why these two features share a data store
   while staying separate surfaces.

### 6.4 Per-scope rules

- **Master**: verb `HIDDEN`, no column, no preview pane (there is no channel to preview). The pane
  shows `ListingsPane`'s existing sentence instead of an empty card.
- **Channel scope, alias band vs variant row**: the band pull is one Trading `GetItem` on the
  ItemID and lands on every row of the alias; the row pull is Inventory-API-keyed by SKU and lands
  on one row. The *verb* is one id with one preflight; the *reader* branches on whether the target
  has an `externalListingId` — that branch lives on the SERVER, so no client re-derives it.
- **Shell aliases** (22 measured on prod, childless, 6 ACTIVE / 16 DRAFT at quantity 0 —
  `AliasBandCell.tsx:25-28`): the pull is *especially* valuable here, because a shell is precisely a
  listing we hold nothing about. The confirm must say "this will populate 0 rows — it records what
  eBay holds" rather than looking like a no-op failure.
- **Market channels vs single-store**: `pull-listing`'s marketplace amnesia (defect 11) must not be
  inherited — the new reader takes the marketplace and filters offers to it, as
  `fetchListingForFlatFile` already does (`ebay.service.ts:857-858`). For Shopify/GLOBAL the
  coordinate has no market dimension and the column reads `—` with a reason.
- **Amazon twin**: same verb id, same column, same pane; the reader is
  `getListingsItem`-based and the images half already exists (`refreshAmazonLiveImages`).

### 6.5 Provenance / autosave / readiness / publish

- **Provenance.** An adopted value is a normal channel write and takes the normal mark: `✎ pinned`
  on the layer it landed on. It must **not** get a new "from channel" provenance glyph — the layer
  union is the server's (`drawer/types.ts:294`) and the *fact* that it came from a pull belongs to
  the audit row and the History pane, not to the cell's identity. The drift column is derived and
  carries **no** provenance mark at all.
- **Autosave.** RUN writes through `SheetWriter` / `PATCH /api/products/bulk` with
  `expectedVersion`; a 409 repaints and refetches exactly as any cell edit does. 🔴 The known trap
  applies: an in-flight autosave can undo a bulk apply, so the verb must not run while the row has
  queued cells — `useSaveReporter` already knows the unsaved count, and the preflight should refuse
  with `unavailable` rather than racing.
- **Readiness.** Untouched. Readiness has ONE server definition
  (`services/pim/readiness.service.ts`) and drift is not an issue class in it. A drifted listing can
  be perfectly ready; a ready listing can have drifted. Merging them would repeat the STALE/DRIFT
  collapse `channelTruth.ts:11-14` warns against. Adopted values change readiness only because they
  change *values*, through the normal path.
- **Publish.** A pull is a READ and is available in every publish mode, including `gated` — that is
  the point, and `ebay-listing-index.service.ts:5-9` is the precedent. Nothing on either surface
  publishes: `ListingsPane`'s reasoning applies verbatim (*"a 'Publish' button inside a record
  drawer is exactly how a preview-only channel gets published by reflex"*, `:5-8`). eBay stays
  preview-only; `AliasPublishControl` remains the only publish entry. The preview's `Draft` mode
  should render from the same `resolveDescriptionMode` derivation the push uses, so it cannot show a
  page the push would not send.

### 6.6 ASCII mockup — the alias band + drift column + drawer panes

```
┌ eBay · IT ─────────────────────────────────────────────────────────────────────────────┐
│ 21 rows · 4 selected  [View ▾][Missing required (7)][Drift (3)]  Find… [Preview listing]│
├──────────────────────┬──────────┬─────────────┬──────────────┬─────────┬───────────────┤
│ ▾ ① GALE-KAN-PRO     │ ● Active │ ✎ Title     │ 🔗 Price     │ Ready   │ Channel check │
│   Listing 2264…  71% │          │             │              │  84%    │ ⚠ 3 differ    │
│   ├ GALE-KAN-PRO-N-S │ ● Active │ GALE Pro R… │ € 249.00     │ ⚠       │ ⚠ 2 differ    │
│   ├ GALE-KAN-PRO-N-M │ ● Active │ GALE Pro R… │ € 249.00     │ ✓       │ ✓ matches     │
│   └ GALE-KAN-PRO-N-L │ ● Draft  │ GALE Pro R… │ € 249.00     │ ⚠       │ — never check…│
│ ▸ ② GALE-KAN-PRO-ALT │ ○ Draft  │  no variations and no stock behind it yet            │
└──────────────────────┴──────────┴─────────────┴──────────────┴─────────┴───────────────┘
   right-click ① →  ⟨ Pull latest from eBay ⟩  Open record   Broadcast to other markets…

┌ CONFIRM ───────────────────────────────────────────────────────────────────┐
│ Pull eBay · IT listing 2264… into 4 of 21 rows?                            │
│ 3 fields differ — tick what to adopt:                                      │
│  ☑ Title        eBay "GALE Pro Racing Suit"   ·  ours "GALE Pro Suit"   ✎  │
│  ☐ Description  eBay 4,102 chars              ·  ours 3,880 chars       🔗 │
│  ☑ Quantity     eBay 4                        ·  ours 6                 ✎  │
│ Also happens: adopting Description breaks "follows master" on this listing.│
│ Type the ItemID to confirm ▸ [ 2264…            ]     [Cancel] [Pull]      │
└────────────────────────────────────────────────────────────────────────────┘

drawer (520px, slides over, sheet stays live)
 Record │ History │ Compare │ Listings │ Channel truth │ Preview
        └─ Channel truth: checked 2h ago · 3 differ · [Check again]
        └─ Preview: (Live ▾)  [Desktop 920px | Mobile 375px]   ⓘ 1 warning
                    ┌──────────────── sandboxed iframe ────────────────┐
```

## 7. Contracts and data

**Reused unchanged:** `POST /api/ebay/description-preview` (`ebay-description-themes.routes.ts:320`)
— the preview pane's only server dependency, no change needed beyond the permission fix below.
`PATCH /api/products/bulk` — the adopt write. `ActionImpact` / `GridAction` as they stand
(`registry.ts`), including `payload` and `run(rows, impact?)`. `listingUrl.ts` for the link-out.
`EbayService.fetchListingForFlatFile` and `parseItemDetail` as **reader implementations**, called
from a new service — not edited, and the flat-file editor's own routes untouched.

**New, server (PES.5):**
- `POST /api/products/:id/channel-pull/preview` — body `{channel, marketplace, aliasKey?, rowIds?}`.
  Fetches ONCE (Trading `GetItem` when the coordinate has an `externalListingId`, Inventory
  `inventory_item` + `offer` otherwise), persists a snapshot, returns
  `{snapshotId, checkedAt, fields:[{key, channelValue, ourValue, ourLayer, differs, adoptable,
  adoptBlockedReason?}], unreadable:[{rowId, reason}]}`. `unreadable` is the fix for defect 2: a
  transport failure, a 401 and a 429 are each named, and **never** rendered as "not on eBay".
- `POST /api/products/:id/channel-pull/apply` — body `{snapshotId, fieldKeys[]}`. Writes through the
  same bulk-PATCH internals, records the audit row. Refuses a snapshot older than N minutes rather
  than applying a stale approval.
- A read-only eBay reader module that **must not** import `callTradingApi` (defect 3), with the
  reason in its header, plus a shared `Retry-After`-aware backoff for eBay reads (defect 7).
- A **pure, tested diff module**, the exact sibling of `channelTruth.ts`: normalises multi-value
  aspects to arrays before comparing (defect 4), maps localised aspect names to English through
  `channel-specs/ebay.ts` (defect 5), and compares by MEANING not by string (trailing whitespace,
  HTML entity form, decimal formatting).
- **Additive schema only:** `ChannelPullSnapshot { id, productId, channel, marketplace, aliasKey,
  externalListingId?, checkedAt, payload Json, fetchedVia ('trading'|'inventory'), capturedBy }`
  and `ChannelPullRecord` (mirroring `FlatFilePullRecord`'s columns:
  `fieldsRequested/fieldsApplied/rowsApplied/appliedAt/operatorNote`). Plus a derived
  `driftFieldCount` + `checkedAt` on the studio sheet's `SheetListing` — a **new** field, never
  `lastSyncedAt`, whose own comment forbids that reuse (`studio-sheet.service.ts:1271-1276`).
- **Permission fix:** move `/ebay/description-preview` (and the new `channel-pull/preview`) to a
  read permission. Rendering HTML and reading a channel are `listings.view`, not `channels.sync`
  (`permissions-manifest.ts:354,361`). The **apply** stays a write (`products.edit`, matching
  `CHANNEL_VERB_PERMISSION`, `channelActions.ts:52`).

**New, client:** PES.3 — the verb in `channelActions.ts` (H5/H3/H4) + the `Channel check` column +
the `Drift (N)` view chip + the band pill. PES.4 — two drawer panes (`ChannelTruthPane`,
`PreviewPane`) and one more DS `Tabs` entry each in `RecordDrawer.tsx:471`. PES.2 — nothing new is
required of the substrate; `payload` and `run(rows, impact?)` are already there, and the checkable
findings list is a change inside `ActionConfirm`'s body, which PES.2 owns. PES.7 — hands over
`channelTruth.ts` as the pattern and keeps the images half where it is (H8); the two must not merge.
PES.6 — owns the eBay `ChannelFieldSpec` adapter that gives the aspect half of the diff somewhere to
land (defect 6); until it exists the pull adopts only mapped fields and **reports** the aspect
differences read-only.

**ONE new DS component** (nothing in `design-system/**` renders an iframe — verified, zero `iframe`
or `srcDoc` occurrences): `SandboxedHtmlFrame` — `sandbox=""` + `srcDoc`, a declared frame width,
scale-to-fit with the scale exposed so a caller can state it, and an explicit `title`. Both the
studio preview pane and (later) the rebuilt Description Studio need exactly this, which is the bar
for a DS component rather than a page-local element.

## 8. Risks and traps

1. **🔴 A pull built on `callTradingApi` fakes an empty listing in dev, and "adopt" would then blank
   a live record.** (`ebay-trading-api.service.ts:246`.) The reader must fetch directly, with the
   reason in its header. This is the single highest-consequence trap in this feature.
2. **🔴 Local dev writes the PRODUCTION database and every eBay listing in the fixture family is
   LIVE.** The *pull* is a read; the *apply* is a real write to prod ChannelListings, and the
   preview's `Draft` mode must be verified to make no channel call at all. Any exercise of the
   apply path belongs on a probe SKU inside the fixture family, never on a live ASIN/ItemID.
3. **🔴 "Could not measure" ≠ "measured empty."** Defect 2 is in the code a new pull would reuse.
   The contract must carry `unreadable[]` with a reason, and the UI must render "we could not check"
   differently from "eBay holds nothing" — otherwise a rate limit reads as an empty listing and an
   operator adopts a blank.
4. **🔴 "Never checked" is not "no drift."** `ChannelTruthPanel.tsx:4-9` measured the equivalent
   emptiness on GALE-JACKET (0 rows). The column's third state is mandatory, not decoration.
5. **A preview that lies is worse than no preview** (`ebay-description-themes.routes.ts:330`). The
   old skins invent shipping, returns and Best-Offer terms (defect 9). Ship description + gallery +
   aspects rendered from the real renderer, and link out for the rest.
6. **Aspect key language and cardinality will manufacture drift** (defects 4, 5): 23 Italian-keyed
   aspects on 247 of 252 IT listings vs English-keyed columns, and multi-value aspects flattened to
   `"a, b"`. Without the mapping and the array normalisation, the drift column will read `⚠` on
   every row on day one and be ignored by day two.
7. **The Inventory/Trading split means a live listing can report as absent** (defect 1). The reader
   must branch on `externalListingId`, and a `found:false` on a coordinate that HAS an ItemID is a
   defect to surface, not a result to render.
8. **Rate limits.** One band pull is one call; a 21-row selection pull is up to 42 (defect 8).
   Preflight must collapse rows to distinct listings before fetching, and the single fetch must
   carry server-side `Retry-After` backoff, because #118 forbids re-fetching in RUN.
9. **Untouchables.** No edits in `products/ebay-flat-file/**` or `amazon-flat-file/**` (the
   Description Studio is being rebuilt, so its iframe mechanism is SPEC to re-derive, not code to
   import), none in FBA quantity logic, none in the import flows. `ebay-flat-file.routes.ts` and
   `ebay-flat-file-pull-preview.service.ts` are read as specification; the new service sits beside
   them.
10. **AI stays dark** (ruling #13). Nothing here generates copy; the preview renders stored values
    and `✦ AI draft` cells keep their own provenance if a drafted value happens to be previewed.
11. **Per-channel oversell / Amazon EU shared quantity / global-per-ASIN images.** Adopting a
    channel `quantity` into our record is not an inventory decision and must not touch stock
    buffers or the per-channel oversell math; on Amazon the quantity is EU-shared, so the twin's
    quantity row must be flagged, not silently adopted. Images are out of scope here — that is
    H8's `ChannelLiveImage` path, already built.
12. **Drawer tab overflow.** Four panes today, six proposed, in 520px. The DS `Tabs` row will need
    icon-only or overflow behaviour; that is a PES.4/UX.1 geometry question, and adding two panes
    without measuring the row would repeat the chrome complaint ruling #169 exists to prevent.
13. **Autosave race.** A queued cell write landing after an apply would silently revert an adopted
    field (the banked in-flight-autosave trap). Refuse the verb while the coordinate has unsaved
    cells.

## 9. Open questions for the Owner (max 3)

1. **Does "Pull" WRITE our record, or only report what eBay holds?**
   *Recommended: both, in one flow, but never automatically.* The confirm lists the differing
   fields with checkboxes; unticking everything still records the check. Phase 1 adopts only the
   fields that have a real destination — title, description, price, quantity (`CHANNEL_FIELD_MAP`
   plus the pricing route) — and **reports** aspects read-only until PES.6's eBay adapter gives them
   columns (defect 6). Adopting into a bag nothing reads would be a green button that changes
   nothing, which is the defect `channel-field-map.ts` was created to end.
2. **Is a simulated eBay PDP wanted at all, or description + gallery + aspects + a link-out?**
   *Recommended: the latter.* The old skins' shipping, returns and Best-Offer lines are invented
   (defect 9), and a chrome we cannot keep truthful costs credibility on the parts we can. The
   themed description through the real renderer, the real gallery, the real aspects, at 920/375, and
   `Open on eBay` for everything else.
3. **Should the pull be available when `getEbayPublishMode()` is `gated`, and should a `Drift (N)`
   backlog also appear in the Errors & Sync console (H9)?**
   *Recommended: yes to both.* A read is not a publish, and the index service already sets that
   precedent (`ebay-listing-index.service.ts:5-9`); refusing to let an operator LOOK at a channel
   we will not write to is the wrong asymmetry. And drift across many rows is queue-shaped —
   channel-ops research calls the queue *"universal across all eleven platforms; never inline-only"*
   — so the console gets a `Drifted since last publish` group whose rows jump to the sheet.

## 10. Effort and dependencies

| piece | lane | effort |
|---|---|---|
| Read-only eBay reader (Trading + Inventory branch, shared `Retry-After` backoff, `unreadable[]`) | PES.5 | **M** |
| Pure tested diff module (aspect language + cardinality + meaning-compare) | PES.5 | **M** |
| `channel-pull/preview` + `/apply` routes, `ChannelPullSnapshot` + `ChannelPullRecord` (additive), `checkedAt`/`driftFieldCount` on `SheetListing` | PES.5 | **M** |
| Permission reclassification for the two read endpoints | PES.5 | **S** |
| Verb H5 + H3 + H4 in `channelActions.ts`, `Channel check` column, `Drift (N)` chip, band pill | PES.3 | **M** |
| Checkable `findings` in `ActionConfirm` / `DrawerConfirm` | PES.2 | **S–M** |
| `ChannelTruthPane` (H7) | PES.4 | **M** |
| `PreviewPane` (H7) + `H6 trailing` entry + `H10` link-out | PES.4 | **M** |
| DS `SandboxedHtmlFrame` | DS.1 | **S** |
| `Drifted` group in Errors & Sync (H9) | PES.3 | **S** |
| Amazon twin wired to the same verb + column | PES.5 + PES.3 | **M** |

**Dependencies.** Hub ruling #118(1) — **discharged**, `payload` + `run(rows, impact?)` are on disk
(`registry.ts:122,203`), so the verb is unblocked. **Blocking for the aspect half of the diff:**
PES.6's eBay `ChannelFieldSpec` adapter (`docs/2026-09-04-channel-attribute-model-design.md`
§A.1/A.3) — eBay·IT has 0 aspect columns today, so aspects can be *reported* now and *adopted* only
after. **Adjacent, must not merge:** PES.7's `ChannelLiveImage` / `ChannelTruthPanel` (H8) is the
images half of the same question and stays where it is; this lane borrows its doctrine and its
STALE-vs-DRIFT separation, not its surface. **Feeds:** decision D1 in
`docs/2026-09-01-channel-ops-research.md`, and parity rows 3.4 and 3.17 close together only if both
halves ship.
