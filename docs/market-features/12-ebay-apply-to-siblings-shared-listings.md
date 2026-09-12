# 12 — eBay APPLY-TO-SIBLINGS (template-apply) + SHARED / adopted listings + variation push

## 1. What it is (operator terms)

An operator perfects ONE eBay listing — its category, its item specifics, its business policies,
best-offer terms, variation axes, Motors compatibility — and then wants that same setup on the next
N listings without retyping it. Today that is one modal ("Apply layout to siblings") in the eBay
cockpit: pick target products, tick which layers to copy, apply; each target is snapshotted first so
it can be undone. Beside it sit two facts the modal knows nothing about. First, one product can
carry SEVERAL eBay listings on ONE market — 22 of them exist in production today as phantom
`EBAY_LISTING_SHELL` products, and PES.5's `ProductListingAlias` is where they belong. Second, one
eBay ItemID can carry variations from SEVERAL product families at once
(`SharedListingMembership`) — an "adopted" listing whose stock is pool-governed and which can only
be revised through the Trading API (Lane B), never through the Inventory API path the primary
listing uses (Lane A). So "copy this setup to my siblings" in the new page has to answer *which*
siblings: other aliases of this product, other products, or other markets — and it must refuse the
cases where the target is co-owned by somebody else's family.

## 2. Old UI — inventory

**Entry point.** `tabs/ebay-cockpit/EbayCockpit.tsx:403-410` — a hand-rolled `<button>` in the
cockpit header rail (`Layers` icon, label `products.edit.cockpit.ebay.applyToSiblings`) sets
`siblingsModalOpen` (`:177`); the modal renders at `:812-817`. Reachable, not dead. The Amazon twin
is `AmazonCockpit.tsx:561` → `:890-895`.

**Component.** `tabs/ebay-cockpit/templates/ApplyToSiblingsModal.tsx`, 404 lines, entirely
hand-rolled Tailwind (`fixed inset-0 z-50 … bg-slate-900/50`, `:177`) — no DS component anywhere.
Three local sub-parts: `ScopeChip` (`:331`), `CandidateRow` (`:353`), and the results list
(`:277-302`). Six scope toggles (`DEFAULT_SCOPE`, `:73-80`): aspects / policies / bestOffer /
variations / compatibility all default ON, **category defaults OFF** with an amber warning
(`:219-224`).

**Round trips.**
- On open (`:94-115`): `GET /api/ebay/cockpit/template-candidates?productId&marketplace`. No cache,
  no abort, re-fetched on every open.
- On apply (`:143-167`): `POST /api/ebay/cockpit/template-apply` with
  `{donorProductId, marketplace, targetProductIds, scope}`, then `router.refresh()` (`:161`) — a
  whole-page RSC refresh.
- Nothing is browser-local; no localStorage, no draft bus. Escape closes unless applying (`:117-124`).

**What is NOT what it looks like.** The "per-candidate diff preview" the header comment promises
(`:14-16`) is not a diff. `CandidateRow` renders the TARGET's own counts (`aspectCount`,
`hasPolicies`, `hasBestOffer`, axes, compatibility) plus a `≠ category` flag and a `live` pill
(`:356-399`). It never shows the donor→target delta, and never names which of the target's existing
values would be overwritten.

**Undo, as promised vs as built.** The footer says "Each target got a `pre-template-apply` snapshot
— undo per target via the History drawer" (`:297-300`). The drawer is
`versioning/VersionHistoryDrawer.tsx`; its reason table (`:41-46`) has keys
`manual | auto | pre-publish | pre-restore` and falls back with
`REASON_ICON[entry.reason] ?? REASON_ICON.manual!` (`:207`) — so a template-apply snapshot renders as
**"Manual snapshot"**. The drawer is also scoped to *this* product + marketplace, so undoing 40
targets means opening 40 product pages.

**"Sibling" is already two things in this tree.** `EbayCockpit.tsx:129` `siblingListings` = the same
product's listings on OTHER MARKETS (used at `:212`, `:535`, `:590`); `ApplyToSiblingsModal`'s
siblings = OTHER PRODUCTS of the same `productType`. The word carries both meanings today.

**Shared / adopted listings in the old tree** live entirely on the eBay flat-file page (untouchable):
`ebay-flat-file/EbayFlatFileClient.tsx:1895-1965` splits rows into Lane A / `'lane-b'` occurrences,
and `RelinkItemIdModal.tsx` names `SharedListingMembership` rows directly. Sync Control
(`sync-control.routes.ts`) is where `followPool` / `stockBuffer` are edited per membership.

## 3. Backend that exists

**Routes (registered: `index.ts:694` eBay, `:776` Amazon, both `prefix: '/api'`).**
- `GET  /api/ebay/cockpit/template-candidates` — `routes/ebay-cockpit.routes.ts:1592-1676`. Two
  queries (products, then their listings) — no N+1. Filters `productType` when set (`:1622`),
  `take` default 50 / max 200 (`:1594`).
- `POST /api/ebay/cockpit/template-apply` — `:1706-1845`. Builds a `layout` slice from the donor's
  `platformAttributes` per scope flag (`:1737-1768`); `category` is opt-IN (`:1725`). Then, **per
  target sequentially** (`:1776`): read the target listing, strip `_versionHistory`, prepend a
  `{reason:'pre-template-apply', snapshot:{platformAttributes, priceOverride, quantity}}` entry
  capped at 10 (`:1791-1801`), spread `layout` over `prevPlatform`, and create-or-update.
- Amazon twin — `routes/amazon-cockpit.routes.ts:101-210`, scope `{attributes, condition, category}`.
- eBay snapshot prior art: `POST /api/ebay/cockpit/snapshot` (`:907`) and `.../snapshot/restore`
  (`:961`).
- **No eBay/marketplace call anywhere in template-apply** — it writes `ChannelListing` rows only.
  That is the one thing about it that is unambiguously safe.

**Permissions.** Neither route declares a `preHandler`. They inherit the ordered manifest rule
`RW(F.listingsView, F.channelsSync, pfx('/api/ebay'))` — `lib/auth/permissions-manifest.ts:354` — so
POST needs **`channels.sync`**. Every studio channel verb needs **`products.edit`**, because
`/api/products/**` is caught at `:412` (`channelActions.ts:43-52`, ruling #123).

**Prisma.**
- `ChannelListing.aliasId` (nullable FK) + `aliasKey String @default("")` — `schema.prisma:1663-1685`.
  `aliasKey` exists because Prisma types every field of a compound unique as non-nullable, so a NULL
  discriminator can be *stored* but never *targeted* (`:1666-1679`). Both uniques widened to 5
  columns, `NULLS NOT DISTINCT` (`:1699-1700`).
- `ProductListingAlias` — `:1732-1775`: `productId` (family ROOT, never a child), channel,
  marketplace, connection, `label`, `position` (primary is rendered as position 0 with no row),
  `status ACTIVE|ARCHIVED`, `adoptedFromProductId`. Header comment `:1729-1731`: **quantity is per
  alias and is never summed.**
- `ChannelListingSnapshot` — `:1800-1842`: `channelListingId`, denormalised coordinate + `aliasKey`,
  `reason`, `publishEventId`, `payload`, `label`, `capturedBy`, `restoredAt/By`. Migration
  `20260901f_pes5_listing_snapshots` **applied**.
- `SharedListingMembership` — `:16001-16037`: `(marketplace, itemId, sku)` unique, `parentSku`,
  nullable `productId`, `variationSpecifics`, per-listing `price`, `followPool`, `stockBuffer`,
  `lastQtyPushed`, `flatFileSnapshot` (the Lane-B twin of `ChannelListing.flatFileSnapshot`).
- `EbayPushJob` — `:8160-8181` (mode api|feed, perSkuResults, warnings).

**Services.**
- `services/pim/listing-alias.service.ts` — `createAlias` (`:64`) creates the alias **and** one
  `ChannelListing` per family member with no overrides, `listingStatus:'DRAFT'`, `isPublished:false`
  (`:111-130`); `updateAlias` (`:136`); `archiveAlias` (`:154`, never deletes). **`createAlias`
  throws `AliasCreationBlockedError` while the pre-alias indexes stand** (`:76`, `:19-29`,
  `legacyAliasIndexesPresent` `:48`).
- `services/pim/listing-snapshot.service.ts` + routes `product-studio.routes.ts:705 / 716 / 741`
  (`GET`/`POST` snapshots, `POST …/restore`).
- `services/ebay-shared-listing-push.service.ts` (`buildSharedListingInput`, `:26`) — Lane B
  publisher; `POOL_DEFAULT_QTY_SENTINEL` (`:9`).
- `services/ebay-variation-push.service.ts` — `pushVariationGroup` (`:743`) is the Lane A
  publisher; `resolvePerMarketContent` (`:2442`); `resolveVariationAxes` (`:271`);
  `withAvailableQuantity` (`:591`).
- `services/ebay-description-push.service.ts:1-46` is the clearest statement of the **lane split**:
  Lane A = Inventory-managed primary (child CLs carry `__offerIds`), where a Trading revise is
  rejected outright and `inventory_item_group` is a **full-replace PUT** — so there is no
  description-only call and the only safe path is the full `pushVariationGroup`; Lane B = adopted
  Trading listings, revised field-by-field. Detector `INVENTORY_MANAGED_RE` `:42`,
  `LANE_A_SKIP_MESSAGE` `:44`.
- `ebay-shared-fanout.service.ts:1-35` — a stock change fans out to every ItemID containing the SKU;
  `ebay-membership-reconcile.service.ts:1-19` — adopt a live listing AS IT IS by matching variation
  specifics, not by parsing SKU conventions; `ebay-shared-membership-upsert.service.ts:1-17` — the
  ingest inverse (no eBay calls, never the stock pool); `ebay-label-guard.service.ts:44,98-112`
  walks Lane A ∪ Lane B.
- Safety gates: all outward calls go through `callTradingApi`'s real-API gate — without
  `NEXUS_EBAY_REAL_API` it is a dry-run in dev and a **hard refusal in production**
  (`ebay-description-push.service.ts:31-32`).

**Jobs/crons.** Shared fan-out rides `OutboundSyncQueue` with `payload.pushVia:'TRADING'`
(`ebay-shared-fanout.service.ts:5-6`). No cron touches template-apply.

## 4. Studio today

**Alias groups are BUILT and empty.** `services/pim/studio-sheet.service.ts:841` reads
`productListingAlias.findMany`; `:1268-1290` composes `AliasGroup[]`; `:932-934` keys listings by
`${productId}:${aliasId ?? ''}`. The primary listing is always
`{id: null, position: 0, label: 'Primary'}` so the client renders one uniform list
(`_studio/sheet/channel/types.ts:380-409`). `aliasKeyOf()` is the only key path
(`channel/rows.ts:200-206`).

**The band.** `channel/AliasBandCell.tsx` — 240px→365px pinned band (ruling #739) carrying expander,
picture, SKU, state-coloured `CompletenessPill`, `⋯`. Its `bandTitle` (`:65-83`) already says
"No variations and no stock behind it yet" when `isUnadoptedShell`. The alias mark (★ ①②③) and the
alias label render **only when `aliasCount > 1`** — Owner, 2026-09-05: a single-alias product must
read exactly as its master parent (`:52-57`, `:134-140`).

**`isUnadoptedShell`** — `channel/rows.ts:232-248`: `mine.length === 0 && !!alias.externalListingId`.

**`[+ Add listing alias]`** — `channel/ChannelSheet.tsx:1774-1791` + the button at `:1915-1917`, in
the toolbar `trailing` slot beside one `AliasPublishControl` per alias (`:1906-1914`). Calls
`addListingAlias` (`channel/useChannelSheet.ts:356-379` → `POST /api/products/:id/aliases`), which
is currently refused by the server with the PES.5-ii message.

**Verbs.** `channel/channelActions.ts` declares `offer-toggle` (`:162`, SELECTION),
`broadcast-to-listings` (`:308`, SELECTION) and `open-record` (`:380`, ROW). It imports **only `ROW`
and `SELECTION`** (`:28-37`). `contextOf('alias-group')` therefore has **zero verbs** — the axis
exists in the registry (`design-system/grid/actions/registry.ts:33,42`, rationale `:27-32`) and
nothing populates it. `AliasBandCellParams.menuItems` is documented as never rendering today
(`AliasBandCell.tsx:58-61`).

**Prior art for exactly this shape.** `broadcast-to-listings` (`channelActions.ts:294-358`) is
COLLECT (`deps.pickMarkets`) → PREFLIGHT → **typed** confirm whose phrase is the channel name
(`:341`) → RUN, and its RUN is deliberately dark: `ok:false, "Not sent. N rows would have gone to …"`
(`:353-356`), because every eBay·IT listing in the fixture family is ACTIVE with a real ItemID
(`:18-19`, 40 of 40). On master, `FamilyVerbs` renders `contextOf('product-family')` in the
`SheetToolbar` **`leading`** slot (`MasterSheet.tsx:1774-1785`, `FamilyBar.tsx:10-14,50`). The
channel scope passes **nothing** into `leading` (`SheetToolbar.tsx:92,150` — the slot is free).

**Parity audit.** Row **3.52** ("Apply-to-siblings for eBay layout") = 🕳 "no apply-to-siblings for
eBay" (`docs/pes-parity-audit.md:178`). Row **3.31** (Amazon twin) = 🕳 "no apply-to-siblings, and no
undo snapshot. Bulk-fill exists on the master sheet (PES.2), not per channel" (`:153`).

**Hub rulings that bind.**
- **#1** — the alias design is `ProductListingAlias` + nullable `aliasId`; PES.3's `aliasKey` sketch
  superseded.
- **#8(4)** — shell adoption approved IN PRINCIPLE, dry-run to the Owner first.
- **#16** — provenance must distinguish "inherited from a layer that is itself an override of
  master": on a variant row, alias-inherited ≠ master-inherited. Write ROUTING stays in PES.3.
- **#18 (Owner)** — "adopt all 22, end nothing (qty 0 can't oversell; ending live listings is
  destructive and would need its own ask)". Shells soft-deleted, never hard-deleted; **no eBay call
  of any kind**.
- **#23 (Owner, verbatim)** — 21 shells adopt (`IT-GALE-JACKET` → `GALE-JACKET`),
  `WATERPROOF-OVERJACKET-ALT1` stays a shell with its missing master flagged for investigation.
- **#110 / #114 / #118** — one action registry; a context verb must NAME ITS AXIS; the confirm level
  comes from the preflight; COLLECT → PREFLIGHT → CONFIRM → RUN.
- **#43 / #724 / #727** — readiness colour from STATE, never from the percentage; one
  `CompletenessPill`.
- **#739** — variant rows carry the C chip on both scopes, the band row the P chip, and on a channel
  the ★ alias mark sits beside it.
- **#794** — the hub stood down 2026-09-04; the Owner manages lanes from there on.
- Ruling numbers stop at #794; the 2026-09-05 alias-band decision reaches the code as an Owner quote
  in `AliasBandCell.tsx:134-140`, not as a numbered ruling.

## 5. Defects and slowness

1. **The eBay route does not bump `ChannelListing.version`; the Amazon twin does.** eBay:
   `prisma.channelListing.update({ data: { platformAttributes } })`
   (`ebay-cockpit.routes.ts:1821-1824`). Amazon: `casUpdateChannelListing(...)` with the explicit
   comment "bump version … so the flat-file editor detects the change and won't silently clobber it"
   (`amazon-cockpit.routes.ts:191-195`). So an eBay template-apply is **invisible to optimistic
   concurrency** and the next save from the sheet or the flat file overwrites it with a stale
   `expectedVersion` that still matches. **CODE-READ.**
2. **The promised undo has never existed in production.** `_versionHistory` is present on **0 of 977**
   listings — `docs/pes5-phase0-backend.md:963` ("Prior art to learn from, not a proven
   implementation to trust"). Since template-apply is the writer of that key, the feature has never
   successfully run on prod data, and its undo path has never been exercised.
   **MEASURED-IN-DOC + CODE-READ.**
3. **The undo surface mislabels its own snapshot.** `REASON_ICON` has no `pre-template-apply` key and
   falls back to `manual` (`VersionHistoryDrawer.tsx:41-46`, `:207`). The operator is told to look
   for a template-apply entry and shown "Manual snapshot". **CODE-READ.**
4. **Undo is per-target and per-page.** No batch id links the N snapshots; the drawer is keyed to
   (productId, marketplace). 40 targets = 40 page visits. **CODE-READ.**
5. **The "diff preview" is not a diff** — target's own counts + a `≠ category` flag, never the
   donor→target delta (`ApplyToSiblingsModal.tsx:353-399`). Under ruling #114/#118 this is exactly
   what an `ActionImpact.findings` must replace. **CODE-READ.**
6. **Snapshots live in the hot path and self-limit at 10.** `.slice(0, 10)`
   (`ebay-cockpit.routes.ts:1801`) inside `platformAttributes`, which every studio sheet read loads.
   PES.5 §12 rejected exactly this shape and replaced it with `ChannelListingSnapshot`
   (`pes5-phase0-backend.md:951-964`). **MEASURED-IN-DOC + CODE-READ.**
7. **The candidate parent guard is inverted for a child donor.**
   `parentId: donor.parentId ?? { not: productId }` (`:1620`) — when the donor HAS a parent this
   narrows candidates to the donor's own siblings, the opposite of the stated intent ("excluding the
   donor + its children — that's what EC.6 handles", `:1618-1619`). **CODE-READ.**
8. **A target listing created by the apply is born UNATTRIBUTED.** The `create` (`:1807-1819`) sets
   no `channelConnectionId`. `schema.prisma:1681-1684` names this as the latent MAP.2b trap: a null
   connection inside a compound unique can be stored and indexed but **never targeted** by an
   upsert/findUnique. Harmless only while 977/977 rows carry a connection. **CODE-READ.**
9. **Alias-blind write, latent.** The donor and target lookups are `findFirst` on
   `(productId, channel, marketplace)` (`:1728`, `:1782`) with no alias filter. Today that is the
   primary listing because prod has 0 non-null `aliasId`; after PES.5-ii it matches an arbitrary
   alias. **CODE-READ (latent).**
10. **Zero tests.** No `*.vitest.test.ts` / `*.test.ts` anywhere references `template-apply` or
    `template-candidates`, on either channel. **CODE-READ.**
11. **`router.refresh()` after an N-target write** (`ApplyToSiblingsModal.tsx:161`) — full RSC
    refresh; and candidates are re-fetched on every open with no abort (`:94-115`). **CODE-READ.**
12. **The permission would silently change on rebuild.** Today POST needs `channels.sync`
    (`permissions-manifest.ts:354`); a studio verb on `/api/products/**` needs `products.edit`
    (`:412`, `channelActions.ts:43-52`). This must be a decision, not a side effect. **CODE-READ.**
13. **`contextOf('alias-group')` is an empty axis** — `channelActions.ts:28-37` imports only ROW and
    SELECTION; `AliasBandCell.tsx:58-61` says the `⋯` does not render because nothing is declared.
    **CODE-READ.**
14. **The studio has no cross-product picker.** `attach-existing` is permanently disabled
    (`familyActions.ts:129` `disabled('Pick the products to attach first')`) because `MasterSheet`
    passes only `pending: { newVariation }` (`MasterSheet.tsx:433`). Any cross-product
    apply-to-siblings has to build that picker. **CODE-READ.**
15. **`SharedListingMembership` is invisible to the studio.** Zero references in
    `services/pim/studio-sheet.service.ts`; `AliasGroup` (`channel/types.ts:387-409`) carries no
    member list, no lane, no pool state. So the sheet cannot say "this ItemID also carries 14 SKUs
    from another family". **CODE-READ.**
16. **The unadopted-shell surface is built for a data shape that does not exist yet.**
    `isUnadoptedShell` needs a `ProductListingAlias` row with no listings under it
    (`rows.ts:248`); prod has 0 non-null `aliasId` (`pes5-phase0-backend.md:723`) and the 22 shells
    are still separate Products with their own studio pages. The only fixture is self-authored
    (`rows.vitest.test.ts:163-169`) — `reference_fixture_must_be_writer_produced`.
    **CODE-READ + MEASURED-IN-DOC.**
17. **Mapping is product-level, so a per-alias preflight cannot quote `mapped.value`.** Every alias
    projection of one product shows the SAME mapped value; the server says so via
    `meta.mapping.productLevelOnly` (`pes5-phase0-backend.md:773-775`). **MEASURED-IN-DOC.**
18. **Alias isolation is not yet proven on live data** — the `aliasKey` is in the `ON CONFLICT`
    target and unit-tested, but "write to alias ② leaves ① untouched" has never run end to end
    (`pes5-phase0-backend.md:1242-1245`). **MEASURED-IN-DOC.**

## 6. Proposed home in the studio

### 6.1 Primary home + mirrors

**Primary: H5 `CONTEXT(alias-group)` — one verb `copy-listing-setup`, labelled "Copy listing
setup to…", rendered by a new `AliasVerbs` bar in the channel `SheetToolbar` `leading` slot AND by
the alias band's existing `⋯`.**

Not `CONTEXT(product-family)` and not H4 SELECTION, for a measured reason. Every layer this
operation copies — item specifics, policies, best-offer terms, variation axes, compatibility,
category — is a fact about a LISTING, and in the studio's model a listing *is* an alias group:
PES.5 puts `externalListingId` and `listingStatus` on `AliasGroup`, and `StudioRow` carries no
listing at all (`channelActions.ts:79-84`). A SELECTION of variant rows literally cannot express
"this listing's layout", and a `product-family` context would let the verb appear on the master
scope, where no listing layout exists. `contextOf` was split into two axes precisely to stop that
one-level-up mistake (`registry.ts:27-32`). The bar goes in `leading` because that is where master
already renders its context verbs (`MasterSheet.tsx:1774`) and the slot is free on the channel
scope; the band `⋯` is its second adapter, so the verb is never drawer-only (channel-ops §3.2).

**Mirror A — H7 record drawer, Listings pane:** the *pull* direction ("copy setup FROM listing ②")
plus the per-listing facts the 240px band cannot hold — lane (Inventory-managed vs Trading),
`adoptedFromProductId`, and the shared-listing member list. The layout doc already asks the drawer
for "compare … another alias, with copy-across" (`docs/2026-09-01-product-edit-studio-layout.md:106`).

**Mirror B — H9 Errors & Sync console:** the run's per-target results. A cross-family target is not
on screen, so reporting it inline would be a claim about rows the operator cannot see; the console
is queue-shaped, groups by cause, and its rows jump to the target. The undo-all entry point lives
there too.

**Explicitly NOT here.** No new H1 cell (a template is not a value the operator types per row); no
H2 status column ("was templated" is a history fact → the H7 History pane, `?aliasId=`); no H6
scope-wide verb (the donor is one alias, not the scope); no H11 template library in wave-1 — the
donor is a live listing, not a saved theme, and inventing a library is a bigger feature than parity.

**"Siblings" means all three things, and they must stay three verbs, not one.**

| target kind | in the sheet? | home |
|---|---|---|
| (a) other **ALIASES** of this product on this coordinate | **yes**, they are bands | `copy-listing-setup`, wave-1 |
| (b) other **PRODUCTS** (other families) | **no** — the sheet is one family | `copy-listing-setup`, wave-2, needs the picker |
| (c) other **MARKETS** of this product | no | already `broadcast-to-listings` (`channelActions.ts:304`) — do NOT fold in |

Folding (c) in would give two verbs writing the same cells under different rules. Keeping (a) and
(b) in one verb is right because the *donor* and the *field set* are identical; only the target
resolver differs, and the picker separates them into two labelled sections.

### 6.2 What the sheet shows at rest, per scope

- **master scope:** nothing. The verb's `available()` returns `HIDDEN` — a master record carries no
  listing layout, and a greyed control here would teach the operator something false
  (`registry.ts:50-57`).
- **channel × market:** nothing new at rest on the donor. The alias band already carries everything
  the verb needs to identify itself (label, ★①②③ when `aliasCount > 1`, status, readiness pill, `⋯`)
  and ruling #739 fixed its slot table — adding a mark would re-open a settled geometry.
- **two new band facts, because they are new FACTS and not new chrome:** a `SHARED` DS `Tag` when the
  alias has foreign members, and the lane in the band's `bandTitle` hover
  (`AliasBandCell.tsx:65-83`) — "Trading (adopted) · also carries 14 SKUs from 2 other families".
  These are per-alias, so they belong on the band and nowhere else.
- **one new variant-scope H2 column, `pool_sync` (read-only, filterable):** `follows pool` /
  `paused (+N buffer)` from `SharedListingMembership.followPool` / `stockBuffer`. It is a fact the
  channel reports about that variant of that listing, which is exactly what H2 is for.
- **after a run, in-family targets:** the copied cells become ordinary pinned alias overrides — a
  `✎` at `layer:'alias'`. That is the honest rendering; a templated value *is* a pinned alias
  override, and inventing a "templated" provenance state would be a fourth vocabulary.
  Ruling #16's `inheritedOverride` state is what a variant row under a templated alias shows.
- **after a run, cross-family targets:** nothing on this sheet. A toast with a count + a link into
  Errors & Sync, and the console holds the rows.

### 6.3 The interaction, step by step

1. **Open.** Operator is on eBay·IT. `AliasVerbs` in `leading` shows one button per available
   context verb, exactly as `FamilyVerbs` does; or they right-click the band / open its `⋯`. With
   more than one alias the bar's verb is scoped by the band the `⋯` belongs to; from the bar it
   scopes to the alias whose band row is selected, and is `disabled('Pick a listing first')`
   otherwise — a disabled verb that explains itself (ruling #114).
2. **COLLECT.** DS `Modal` (`role=dialog`, focus trap, Escape) with three parts:
   *(i)* the field set — DS `Checkbox` groups over `ChannelFieldSpec` **column keys**, grouped by the
   spec's own `group`, never a raw JSON blob. Quantity, price and image fields are absent from the
   offer, not merely unticked. Category is present, off, and warned. Presets ("Specs", "Policies",
   "Everything but category") come from the same group metadata the Customise dialog uses.
   *(ii)* targets, in two labelled sections — **"Other listings of this product"** (the in-sheet
   aliases, DS `PressableRow` per band with its status and readiness), and **"Other products"** (DS
   `Combobox` over `GET /api/products/search`, wave-2).
   *(iii)* a live count line: "will change 27 cells across 3 listings".
3. **PREFLIGHT.** One server call returns a real `ActionImpact`: `findings[]` one row per target ×
   changed field with `previous → next` and a severity — `error` for a live-listing target, `warn`
   for a category change or a differing product type, `info` otherwise. `payload` carries the exact
   snapshot the run will apply (`registry.ts:109-120` — the time-of-check/time-of-use channel).
   `unavailable` is set, with its reason, when a target is a shared (Lane B) alias.
4. **CONFIRM.** `ActionConfirm` renders the impact. `level` comes from the preflight, never a flag:
   plain `confirm` when no target is live; **`type-to-confirm` with `confirmPhrase = the channel`**
   the moment any target has an `externalListingId` — matching `broadcast-to-listings`' rule
   (`channelActions.ts:329-341`) and `requiresTypedConfirm` (`registry.ts:259`).
5. **RUN.** One `POST`. The server snapshots each target into `ChannelListingSnapshot`
   (`reason:'pre-template-apply'`) under one `batchId`, writes through the same CAS path the sheet
   uses, and returns per-target results. `ActionResult.invalidates` repaints: in-family targets are
   rows of this sheet, so the affected bands and their cells repaint with `✎` marks and the
   readiness pills recompute from the server's one definition; cross-family targets produce a toast
   + console rows only.
6. **UNDO.** "Undo this copy" in the toast and in Errors & Sync → one call restoring the whole
   `batchId`. Per-target undo stays available in H7 History, and the restore itself snapshots first
   (`pes5-phase0-backend.md:988`), so the undo is undoable.

**Keyboard.** The bar's button is in the toolbar tab order; `useActionPress` owns the press
sequence. The dialog traps focus and returns it to the invoker. The sheet keeps its arrow keys
because the picker is a modal `Modal`, not a second grid — ruling #19's dock rule in the other
direction.

**With the drawer open.** The drawer is non-modal and 520px; the picker is a centred DS `Modal`, so
it overlays both. On close, if the drawer is open on a row belonging to a changed alias, its Record
pane repaints from the same invalidation; its Listings pane gains the new snapshot row.

### 6.4 Per-scope rules

- **master:** HIDDEN, as above.
- **channel × market (Amazon):** the same verb, different field set — the Amazon twin's layers are
  `attributes` / `condition_type` / `productType+browseNodeId`. Amazon allows one offer per ASIN, so
  the alias list is always just Primary: the "other listings of this product" section is empty and
  says so. **Amazon EU shares quantity across markets** and **images are global per ASIN** — both
  are reasons the field set is an allow-list of `ChannelFieldSpec` columns rather than the
  `attributes` blob the old route copies wholesale.
- **an alias band that is a SHARED (Lane B) listing:** refuse as a TARGET, with the reason. Its
  setup is co-owned by other families and its quantity is fan-out-governed. It may still be a
  DONOR — reading it is safe.
- **an unadopted shell alias** (`isUnadoptedShell`): refuse as a target — it has no rows to write
  to. Allow as a donor once adopted.
- **single-store channels (Shopify / Etsy / Woo):** the verb is HIDDEN, and honestly so —
  `marketplaceContexts[].channel` is typed `'AMAZON' | 'EBAY'` on the write endpoint, so the channel
  override route is *unreachable* there, not merely unprefixed (`pes5-phase0-backend.md:1209-1211`).

### 6.5 Provenance / autosave / readiness / publish

- **Provenance:** every copied cell lands at `layer:'alias'` with `pinned:true`. On a variant row
  under a templated alias, ruling #16's "inherited from a layer that is itself an override of
  master" state is what shows — the copy is what created that state at scale, so this verb is that
  ruling's first real consumer.
- **Autosave:** the run is NOT autosave. It is a deliberate, confirmed, batched write with its own
  endpoint, and it must go through the same CAS the sheet uses so the two cannot race. A cell edit
  in flight while the run lands is exactly `reference_autosave_still_needs_a_nav_guard` /
  "an in-flight autosave UNDID an API revert" — so the verb is `disabled` while
  `writer.pending > 0`, with that as its reason.
- **Readiness:** never recomputed client-side. The band's percent comes from
  `AliasGroup.readiness.percent` and the tone from `readinessMeta(state, 'row')`
  (`rows.ts:252-259`, `AliasBandCell.tsx:85-97`); `null` survives as `null`. A copy that fills 12
  required fields on alias ③ moves ③'s pill because the server said so.
- **Publish:** untouched. The copy writes the LOCAL record only — no eBay call, no `isPublished`
  change; a newly created target listing is born `DRAFT` + `isPublished:false`
  (`pes5-phase0-backend.md:1220-1222`). Publishing stays explicit, per channel, preflight-first,
  mode from `getEbayPublishMode()`, eBay preview-only. On Lane A the only safe publish is the full
  `pushVariationGroup` — the preflight must say so, because an operator who has just copied a
  description onto a Lane A alias will otherwise press a per-field publish that honestly skips
  (`LANE_A_SKIP_MESSAGE`).

### 6.6 ASCII mockup

```
 21 rows · 1 selected  [Copy listing setup to…]  [View ▾][Missing required (7)]  Find…   [+ Add listing alias]
┌─ eBay · IT ──────────────────────────────────────────────────────────────────────────────┐
│ ▾ P ★① Primary          ACTIVE  256566101420   ████████░░ 84%   ⋯                        │
│     ▸ GALE-KAN-PRO-NE-S   🔗Nero  🔗M    ✎ 149,00                                        │
│ ▾ P ★② Summer title test DRAFT   —              ███░░░░░░░ 31%   ⋯                        │
│ ▾ P ★③ Bundle listing    ACTIVE  257584954808  ██████░░░░ 62%   ⋯  [SHARED]              │
│        └ hover: Trading (adopted) · also carries 14 SKUs from 2 other families            │
└──────────────────────────────────────────────────────────────────────────────────────────┘
        ┌── Copy listing setup from ★① Primary ───────────────────────────────┐
        │ FIELDS   ☑ Item specifics (18)  ☑ Policies (4)  ☑ Best offer (3)   │
        │          ☑ Variation axes (2)   ☑ Compatibility  ☐ Category  ⚠     │
        │ TARGETS  Other listings of this product                            │
        │          ☑ ② Summer title test   DRAFT   31%                       │
        │          ☐ ③ Bundle listing      ACTIVE  SHARED — cannot receive   │
        │          Other products                     [search SKU or name ▾] │
        │          → will change 27 cells across 1 listing                   │
        │                                        [Cancel]  [Preview change]  │
        └────────────────────────────────────────────────────────────────────┘
```

## 7. Contracts and data

**Reused, no change.**
- `PATCH /api/products/bulk` with `changes[].target:'channel'` and
  `marketplaceContexts[].aliasKey` (`pes5-phase0-backend.md:1186-1198`) — the in-family / cross-alias
  write already exists and lands on the right alias via
  `ON CONFLICT (productId, channel, marketplace, channelConnectionId, aliasKey)`.
- `POST /api/products/:id/listings/:listingId/snapshots` + `.../restore`
  (`product-studio.routes.ts:716`, `:741`) — the undo. `ChannelListingSnapshot.reason` is a free
  string, so `'pre-template-apply'` needs no schema change.
- `GET /api/products/:id/studio/history?aliasId=` (`§3.5`) — where "templated at 14:02 by …" shows.

**New (PES.5 owns both).**
- `GET /api/products/:id/studio/copy-targets?channel&marketplace&fromAliasKey` →
  `{ aliases: [...], products: [...] }`, each target carrying a real **delta**:
  `changes: [{fieldKey, previous, next}]`, plus `live`, `lane`, `shared`, `productTypeMatches`. This
  replaces `template-candidates` — the old endpoint answers "what does the target have", the
  preflight needs "what would change".
- `POST /api/products/:id/studio/copy-listing-setup` →
  `{ fromAliasKey, targets:[{productId, aliasKey}], fieldKeys[], dryRun }` →
  `{ batchId, results:[{productId, aliasKey, ok, snapshotId, changed, error}] }`. `dryRun:true` is
  the preflight's own call, so the confirm and the run describe the same computation.
- `POST /api/products/:id/studio/copy-listing-setup/:batchId/undo` — restore the whole batch.

**Additive schema (pre-approved class).** Nothing required for the copy itself. Two optional
additions, both nullable columns: `ChannelListingSnapshot.batchId String?` (or reuse
`publishEventId`) so undo-all is one query; nothing else.

**Read-contract additions (PES.5, mirrored by PES.3 per the wire→UI rule).** `AliasGroup` gains
`lane: 'inventory' | 'trading' | 'unknown'`, `adoptedFromProductId: string | null`, and
`shared: { itemId, memberSkus, foreignSkus, families: [{productId, sku}] } | null`. The lane is
derived from the `__offerIds` marker the description-push service already uses
(`ebay-description-push.service.ts:13`), never guessed from `listingStatus`.

**Lane ownership.**
| piece | lane |
|---|---|
| `copy-targets` + `copy-listing-setup` + undo + snapshot batching | **PES.5** |
| `AliasGroup.lane / shared / adoptedFromProductId` on the read | **PES.5** |
| `AliasVerbs` bar in `leading`, band `⋯` adapter, the picker dialog, `SHARED`/lane marks, `pool_sync` column | **PES.3** |
| promoting a `collect` hook into the registry (`registry.ts:217-219` — "the moment a second lane needs it"; this is that lane) | **PES.2** |
| Listings-pane member list, lane row, adoption row, undo entry | **PES.4** |
| the per-target result queue + undo-all surface | **PES.9 / Errors & Sync** |
| shell adoption backfill (`scripts/pes5-adopt-shells.mts`) — **not a studio verb** | **PES.5**, Owner-gated |

**What "adopt shell" does in the studio: nothing, on purpose.** Adoption re-points a live ItemID's
`ChannelListing` at a different product and soft-deletes a `Product` row — a production data
mutation the Owner has ruled on twice (#18, #23) and which is already encoded as constants in
`scripts/pes5-adopt-shells.mts` (21 adopt, `WATERPROOF-OVERJACKET-ALT1` stays). It stays **H11**,
outside the studio. What the studio owes it is honesty on both sides of the event: *before*, each of
the 22 shell products opens its own studio page and should carry a scope-level DS `Banner` naming
what it is ("this product is a listing shell of GALE-JACKET, eBay·IT — it will be adopted as an
alias"); *after*, `adoptedFromProductId` appears in the drawer's Listings pane so the adoption stays
auditable and reversible, which is the field's stated purpose (`schema.prisma:1761-1763`).

## 8. Risks and traps

- **Every eBay·IT listing in the fixture family is ACTIVE with a real ItemID** (40 of 40,
  `channelActions.ts:18-19`). There is no safe fixture. The verb writes the local record only, and
  the typed confirm fires the moment any target is live.
- **Local dev writes the PROD DB.** The old modal fetches candidates from prod on open and POSTs to
  prod on apply. The rebuilt picker must be strictly read-only until RUN, and `dryRun` must be the
  default on the wire.
- **`version` must be bumped.** Defect 1 is the trap to not repeat: a bulk apply that leaves
  `ChannelListing.version` alone is silently clobberable by the next cell edit.
- **Never copy quantity or price.** Quantity is per alias and never summed
  (`schema.prisma:1729-1731`); on a shared alias it is fan-out-governed via `followPool` /
  `stockBuffer`; and **oversell is per-channel, never summed** across markets.
- **Amazon EU shares quantity; images are global per ASIN.** An `attributes`-blob copy on Amazon can
  move both. The allow-list of `ChannelFieldSpec` columns is the guard.
- **Category on a shared ItemID is the worst case** — one Trading revise changing a category on a
  listing other families depend on. Category stays opt-in AND refused on a shared alias.
- **Lane A cannot take a partial revise.** `inventory_item_group` is a full-replace PUT
  (`ebay-description-push.service.ts:16-21`); the only safe path is `pushVariationGroup`. Do not
  fork it, and say which lane an alias is on before offering a publish.
- **PES.5-ii is the hard gate.** `createAlias` refuses with a 409 while the pre-alias indexes stand
  (`listing-alias.service.ts:9-15`, `:76`), so wave-1's whole target set — other aliases of this
  product — cannot exist until that migration lands. And "parked" is not a safety state on this
  machine (ruling #10): a sibling's `migrate deploy` already dragged the alias migration in early.
- **Alias isolation is unproven on live data** (`pes5-phase0-backend.md:1242-1245`). The first thing
  this verb does at scale is write to alias ② — so the "② leaves ① untouched" rehearsal must run
  before, not after.
- **Untouchables.** The flat-file editors own the Lane-B save path
  (`ebay-flat-file.routes.ts`, `EbayFlatFileClient.tsx`) — no edits there; Sync Control owns
  `followPool`/`stockBuffer` — the studio's column is READ-ONLY and links out.
- **AI stays dark** (ruling #13): no generation anywhere in the copy path.
- **A green preflight on an empty target set is a vacuous pass.** With zero eligible targets the
  verb must be `disabled` with the reason, never `available` with a confirm that has nothing in it
  (`reference_control_must_target_the_branch`).

## 9. Open questions for the Owner (max 3)

1. **Does wave-1 include OTHER PRODUCTS, or only other listings of THIS product?**
   *Recommendation: other listings of this product only.* The targets are rows already on screen,
   the undo is trivial, and no picker has to be built; cross-product lands in wave-2 together with
   the picker `attach-existing` also needs (defect 14). This is the smaller half of the old
   capability, but it is the half the alias model makes newly possible and the half that can be
   verified on screen.
2. **Which permission?** Today's route needs `channels.sync`; every studio channel verb needs
   `products.edit`. *Recommendation: `products.edit`* — the write touches only the local record,
   and matching the other channel verbs is what stops a refusal message naming the wrong permission
   (ruling #123).
3. **May a SHARED (Lane B / adopted) listing ever RECEIVE a copy?**
   *Recommendation: no in wave-1, refused with the reason on the target row.* Its setup is co-owned
   by other product families and a mistake there is a Trading revise on a live multi-family listing.
   It may be a DONOR — reading it is safe.

## 10. Effort and dependencies

| piece | size | lane | depends on |
|---|---|---|---|
| `AliasVerbs` bar in `leading` + band `⋯` adapter (first `CONTEXT(alias-group)` consumer) | **S** | PES.3 | — |
| `copy-listing-setup` verb declaration + field-set picker (`Modal`, `Checkbox`, `PressableRow`) | **M** | PES.3 | registry `collect` hook (PES.2, S) |
| `GET copy-targets` with a real per-field delta | **M** | PES.5 | — |
| `POST copy-listing-setup` + `dryRun` + `ChannelListingSnapshot` batching + undo-all | **M** | PES.5 | snapshot service (exists) |
| `AliasGroup.lane / shared / adoptedFromProductId` + `SHARED` tag + hover | **M** | PES.5 read, PES.3 render | lane detector (exists) |
| `pool_sync` read-only column from `SharedListingMembership` | **S** | PES.5 read, PES.3 render | the read addition above |
| cross-product picker (`/api/products/search`) + cross-family result queue | **L** | PES.3 + Errors & Sync | Owner answer to Q1 |
| shell-product Banner before adoption; `adoptedFromProductId` row in Listings pane | **S** | PES.1 + PES.4 | adoption backfill (#18/#23) |

**Blocking dependencies:** PES.5-ii (`20260901d_pes5_ii_drop_legacy_alias_keys.sql`, parked) must
land before any alias exists → before wave-1 has any target at all. Shell adoption follows it
(#18/#23). The registry's `collect` promotion is the one substrate change. `broadcast-to-listings`'
dark RUN (`channelActions.ts:353-356`) should be settled in the same pass — two verbs writing the
same cells, one of which never runs, is the drift the single registry exists to prevent.
