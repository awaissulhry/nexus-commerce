# 26 — REPLICATE a coordinate to sibling markets + BROADCAST one field to sibling listings

## 1. What it is (operator terms)

A pan-EU seller perfects the product on ONE coordinate — Amazon·IT, say — and then needs the same
thing on DE / FR / ES / NL. Two different operations wear that description, and the old page ships
both. **REPLICATE** is the whole coordinate: "take everything I did on IT and put it on these four
markets", with a mode (all fields / text only / attributes / price only) and an optional translate.
**BROADCAST** is one value: "this `Materiale` is `Cordura`; put that on every other market too",
reached from the field's own `⋯` menu while the operator is already editing it. The first is a
migration an operator does once when a market goes live or a season's copy is rewritten; the second
is a keystroke-scale habit performed dozens of times a session by whoever is filling attributes.
They differ in unit (coordinate vs cell), in blast radius (hundreds of cells vs one) and therefore
in how hard they must ask — which is why they must not become one verb. Report 12 §6.1's table
already ruled that "other MARKETS" stays out of `copy-listing-setup`; this report is that row.

## 2. Old UI — inventory

**REPLICATE — `ReplicationPanel`**, `tabs/ChannelListingTab.tsx:735-960` (the panel function starts
at `:740`, rendered at `:495-501` behind `siblingMarkets.length > 0`). Reachable, not dead: three
call sites pass the prop — `ProductEditClient.tsx:1531`, `:1579`, `:1629`, all as
`channelMarkets.filter((m) => m.code !== selectedMarket)` — and both cockpits forward it
(`AmazonCockpit.tsx:416`, `EbayCockpit.tsx:295`).
- Collapsed `Card` with a hand-rolled disclosure `<button>` (`:816-841`). Target markets are
  hand-rolled toggle chips (`:854-871`) with Select all / Deselect all (`:844-852`). Mode is four
  hand-rolled cards (`:875-925`) — `all` / `text` / `attributes` / `price` — plus an "Also replicate
  price override" checkbox that the `price` mode force-sets (`:897-899`, `:927-940`).
- `text` mode sends `fields: ['item_name','product_description','bullet_point']` (`:759`);
  `attributes` sends `ATTR_FIELDS = undefined` — i.e. **the same "all attributes" as `all`**
  (`:760`), so two of the four modes differ only by the `includeSetup` flag being identical. The
  mode labels promise a distinction the body does not carry. **CODE-READ.**
- ONE round trip: `POST /api/products/:id/listings/:channel/:marketplace/replicate` (`:786-789`),
  body `{ targetMarketplaces, includeSetup, includePrice, fields? }`. No preflight, no diff, no
  confirmation, no undo. Nothing is browser-local.
- **No `credentials: 'include'` on that fetch** — and none anywhere in the 1334-line file. It works
  only because `NEXUS_RBAC_MODE !== 'enforce'` short-circuits the filter (`lib/auth/field-filter.ts:67`);
  the panel 401s the day enforce flips (`reference_rbac_enforce_ssr`). **CODE-READ.**
- Result reporting is a sentence: `${replicated}/${total} replicated. Failed: …` by market code
  (`:800-810`), then `onDone()`. It never names a field, a row, or a value it overwrote.

**BROADCAST — the per-field `⋯` override menu.** `_shared/attribute-editor.tsx:1320-1500`
(`OverrideMenu`). Under "Apply this value to" it offers exactly three canned target sets, no
multi-select: **All other channels** (`:1437`), **Other {platform} marketplaces** (`:1459` — this is
the sibling-markets case), and one entry per saved `channelGroup` (`:1477-1494`). The handler is
`ChannelFieldEditor.tsx:964-1021` (`broadcastToChannels`): it resolves the source value, then fires
**one `PUT /api/products/:id/listings/:channel/:marketplace` per target in parallel** (`:993-1003`)
with `{ attributes: { [fieldId]: value } }`, swallows every failure (`return null` on `!res.ok` and
in the `catch`), and patches the local `siblings` snapshot from whatever came back. No confirmation,
no diff, no undo, no report — a broadcast to five markets where three fail looks identical to one
where all five succeeded. **CODE-READ.**
- Sibling of it: `copyFromSibling` (`:1028-1060`) — the PULL direction, staged into the debounced
  save rather than sent per target. Two directions, two write paths.
- The menu's "Translate from base for {market}" (`attribute-editor.tsx:1414-1426`) calls
  `onTranslate` (`ChannelFieldEditor.tsx:1088-1145`) → `POST /api/products/:id/generate-content`.
  **That is AI generation, not a translation memory** — so the old panel's "optional translate" is a
  live model call and is dark under ruling #13. `translateAllFields` (`:1156-1213`) is the toolbar's
  whole-listing version.

**A third, unrelated propagate exists** and is worth knowing about for its field taxonomy: the
Reconciliation page's Propagate tab → `POST /api/reconciliation/propagate/start`
(`reconciliation.routes.ts:270-292`) → `services/amazon/flat-file-propagate.service.ts`. Per target
market it does verbatim copy → AI text translation → AI enum mapping → sync, as a polled in-memory
job (`:59-124`). Its `TEXT_FIELDS` (`:34-41`) and `SKIP_TRANSLATE` (`:45-55`) are the best existing
statement of what must never be copied or translated across markets: `item_sku`, `product_type`,
`parent_sku`, `variation_theme`, `purchasable_offer`, `standard_price`, `fulfillment_availability`,
`quantity`, and every image locator. Flat-file territory, untouchable — read as specification.

## 3. Backend that exists

**Route A — per-listing replicate.** `POST /products/:id/listings/:channel/:marketplace/replicate`,
`routes/marketplaces.routes.ts:621-742`, registered `prefix: '/api'` at `index.ts:699`. Reads the
source `ChannelListing` by `findFirst({ productId, channel, marketplace })` (`:656`), then **per
target sequentially** (`:668`): resolve `Marketplace` by `channel_code`, read the target listing,
shallow-merge `platformAttributes.attributes`, copy `title` / `description` /
`bulletPointsOverride` / optional `variationTheme` / optional `price` + `pricingRule` +
`priceAdjustmentPercent`, then `update` or `create`. Returns `{ ok, replicated, total, results }`.

**Route B — cross-product, cross-channel replicate.** `POST /products/bulk-replicate`,
`routes/products.routes.ts:4425-4694`. Caps 1000 productIds × 20 targets (`:4478`, `:4487`).
Two batched reads (`:4491`, `:4515`) — no N+1. Has two things Route A lacks: an
**`Idempotency-Key`** guard (`:4464-4471`, `:4687-4689`) and a **source-drift check** — the source
`updatedAt` is snapshotted and re-read immediately before each upsert, and a moved value drops that
productId with `'source listing changed during replicate — re-run…'` (`:4535-4586`). Cross-channel
attributes go through `CROSS_CHANNEL_ATTR_MAP` / `mapAttributesCrossChannel` (`:4801`). No web
caller: `grep -rn 'bulk-replicate' apps/web/src` → 0 hits. **DEAD from the UI.**

**Route C — the fan-out the studio needs.** `PATCH /api/products/bulk`, `products.routes.ts:1011-…`.
`marketplaceContexts?: Array<{ channel: 'AMAZON'|'EBAY'; marketplace: string; aliasKey?: string }>`
(`:1042-1051`, R.1). `changes[].target: 'master'|'channel'` (`:1030`). Contract facts that bind this
feature:
- The fan-out loop is `upsertChannelListings` (`:2372-2445`) for the six mapped columns and
  `channelAttrByCoord` / `platformPatchByCoord` (`:2518-2556`) for override-bag and
  `platformAttributes`-path writes. All three iterate `effectiveContexts`, so ONE change lands on
  N markets in one request. `ON CONFLICT` names the five-column key including `aliasKey` (`:2432-2439`).
- A coordinate with no listing is **born `DRAFT` + `isPublished: false`** (`:2588-2596` doc, ruling #177).
- `attr_*` writes need `registryMarketplace` or they are refused by name (`:1471`) — the memory
  pointer, still true.
- `marketplaceContexts[].channel` is typed `'AMAZON' | 'EBAY'`, so **Shopify/Etsy/Woo cannot be
  expressed at all** (ruling #177; `studio-sheet.service.ts:519-524`).
- `bodyLimit: 5MB`, `rateLimit: 300/min`, `changes` capped at 1000 (`:1140-1156`, `:1195`).
- `dryRun: true` returns before every write, structurally (`:1129-1136`).

**The diff/apply/revert pipeline — the thing this feature should be built on.**
`POST /products/:id/import/diff` (`product-studio.routes.ts:273`) → `computeImportDiff`
(`services/pim/import-diff.service.ts`) → `storePreview` → `POST …/import/jobs/:jobId/apply`
(`:549`) → `POST …/revert` (`:574`), all in `services/pim/import-jobs.service.ts`.
- **`computeImportDiff` is already multi-coordinate.** Headers are `key@CHANNEL:MARKET:locale`
  (`parseHeader`, `import-diff.service.ts:78-112`), and the diff does **one studio-sheet read per
  distinct coordinate the headers name** (`:256-269`). So a diff spanning IT→DE/FR/ES is one call.
- It returns `DiffCell{ rowId, aliasKey, fieldKey, scope, verdict: 'unchanged'|'changed'|'refused',
  pins, before, after, reason }` plus `counts{unchanged,changed,refused,wouldPin}`,
  `unknownColumns`, `ignoredColumns`, `unmatchedRows` (`:22-68`). `pins` is precisely the
  "this cell follows master today and the write will pin it" flag a replicate must surface.
- Refusals come from the **write path's own dry run**: `validateBatch` injects
  `PATCH /api/products/bulk` with `dryRun: true`, grouped by scope, with `marketplaceContexts` built
  per group (`product-studio.routes.ts:336-357`). One validator, three surfaces.
- **The diff token IS the job** (`import-jobs.service.ts:1-19`): the stored `BulkOperation` is what
  apply replays, so the operator's approved before→after is what runs; a cell whose value moved is
  skipped and recorded, never written (`:210-222`). `expiresAt` is the revert window.
- Permission: `/api/products/**` → `RW(productsView, productsEdit)` (`permissions-manifest.ts:412`),
  so every one of these — including both replicate routes — already needs **`products.edit`**, the
  same permission every studio channel verb needs (`channelActions.ts:52`). No change, unlike report
  12's `channels.sync` problem. (`/api/reconciliation/**` is `inventory.adjust` at `:302` — a
  content propagate gated on an inventory permission; noted, not this feature's to fix.)

**Snapshots.** `GET/POST /products/:id/listings/:listingId/snapshots` and `…/:snapshotId/restore`
(`product-studio.routes.ts:705`, `:716`, `:741`) over `services/pim/listing-snapshot.service.ts`.
`SNAPSHOT_FIELDS` (`:69-82`) covers exactly what a replicate writes — `title`, `description`,
`price`, `quantity`, `platformAttributes`, `overrideData`, every `*Override`, every `followMaster*`,
`variationTheme`. Restore writes back as DRAFT, auto-snapshots the current state first, bumps
`version` and reports `versionOf: 'channelListing'` (`:243`, `:259-260`) — BE-13's "restore does not
bump version" is FIXED and must not be relayed forward. `SnapshotCoordinateMismatchError` (`:51-59`)
**refuses a restore across coordinates**: "Restoring across coordinates would write one market's
content onto another." That is the doctrine this feature deliberately crosses, so its undo must be
N per-target restores, never one snapshot re-pointed.

**Prisma / data.** `Marketplace.currency` and `.language` exist (`schema.prisma:1854-1855`).
`AMAZON_EU_SHARED_MARKETS = {IT,DE,FR,ES,NL,BE,PL,SE,IE}` and the intent guard live in
`services/amazon-eu-quantity-guard.ts` — enforced in exactly two places, `sync-control.routes.ts:29`
and `outbound-sync.service.ts:31`. **Neither replicate route nor the bulk PATCH calls it.**
No cron touches any of this. No replicate path makes a marketplace call.

## 4. Studio today

**Nothing for replicate.** Parity **3.9** = 🕳 (`docs/pes-parity-audit.md:127`): "no
replicate-to-sibling-markets. The nearest thing is `marketplaceContexts` fan-out in the write path,
which no UI exposes." Row **3.13** is ✅ but explicitly carves out **3.13n** (`:131`, `:206`):
"broadcast to listings … has no studio path … Closest gap to close." Triage order (#86, #88, ledger
`:20972`, `:21060`): 3.47 snapshot/restore → 3.4 pull → **3.13n broadcast** → 3.38n lock.

**Broadcast is DECLARED and permanently DISABLED.** `broadcastToListings`
(`sheet/channel/channelActions.ts:304-358`) is a full COLLECT → PREFLIGHT → typed-CONFIRM → RUN
verb whose confirm phrase is the channel name (`:341`) and whose RUN is deliberately dark
(`:353-356`). But `ChannelSheet.tsx:726-727` passes **`siblingMarkets: []` and
`pickMarkets: async () => null`**, and `available()` returns
`disabled('${channel} has no other market connected to broadcast to')` at zero siblings (`:315-317`).
So the verb never even reaches its picker. **The data is in the same file**: `compareTargets`
(`:1351-1384`) already derives every sibling market from `options.channels.find(c => c.id === channel)
?.markets` — the wiring is two lines, not a feature. **CODE-READ.**

**The one-target case is BUILT.** `drawer/panes/ComparePane.tsx` renders one field × N coordinates
with a per-cell **"Copy here"** button (`:232-238`), and `RecordDrawer.tsx:382-414` (`handleCopy`)
routes it through the drawer's single mutator: `write(column, from.value, 'pin', target.scope)` —
the same `PATCH /api/products/bulk`. Overwriting a PINNED value asks first with both values shown
(`:389-408`); overwriting an inherited one does not. `useCompare.ts:1-20` states the pattern the
preflight should copy: N targets = N `GET /studio/sheet?scope=…&market=…` reads in parallel, "so the
compare pane and the sheet see byte-identical values by construction". **The other market IS a
compare target** (`ChannelSheet.tsx:1381`).

**The import drawer is the surface shape.** `_studio/import/ImportDrawer.tsx` is a DS `Drawer`
(never a page) doing file → diff → apply, rendering the diff in a `NexusGrid` inside a `GridPanel`,
with every count, verdict and refusal sentence coming from pure, tested `diffModel.ts` (63 cases).
It is **LIVE** since #561. `diffModel.listingWriteWarning` (`:183-203`) already writes the sentence
this feature needs: "…these columns route by their name whatever scope you exported from. If those
listings are live, applying this changes what buyers see."

**Contract pieces already present.** `SheetColumn.group` + `groups: SheetGroup[]` with the
channel's own localised titles (`sheet-columns.service.ts:103`, `:192-193`, `:471`) — the field-set
picker needs no invented taxonomy. `SheetColumn.writeTarget` / `writeVerb` / `affectsAllChannels`
(`studio-sheet.service.ts:160-179`) is the server's own verdict on whether a cell is per-coordinate
at all. `sheetWriter.pending` and `flush()` ("Send every queued cell now… Used by tests and by
Publish", `editors/sheetWriter.ts:262`) give the verb a way to quiesce autosave. `ProductAiDraft`
is keyed on `(channel, marketplace, aliasId, locale, market)` (`schema.prisma:11986-12024`) — a
translation draft per target coordinate is expressible today, with generation dark.

**Rulings that bind.** **#118** COLLECT → PREFLIGHT → CONFIRM → RUN, the lane owns the picker and
runs it first; `ActionImpact.payload` carries the preflight's snapshot into `run` to close the TOCTOU
(ledger `:20202-20219`). **#114** a context verb must name its axis; the confirm level comes from
the preflight. **#110** one action registry. **#177** Shopify/Etsy/Woo have no channel write route;
a coordinate born from a cell edit is DRAFT + unpublished. **#171** `aliasKey`, `''` = primary.
**#13** no live AI generation. **#127** the Errors & Sync console is sync-queue-first. **#123**
channel verbs need `products.edit`. **#690** the three channel verbs are on right-click and the ⋯.

## 5. Defects and slowness

1. **The old replicate has no schema filter.** Every source attribute is merged into the target's
   bag (`marketplaces.routes.ts:690-694`) with no check that the target market's `ChannelSchema`
   declares the key. `cloneMapping` (PES.6, `schema-mapping.service.ts:588-609`) does exactly that
   filter and reports `skipped`; `computeImportDiff` reports `unknownColumns`. Replicate is the one
   of the three that writes junk silently. **CODE-READ.**
2. **`bulk-replicate` copies `quantity` unconditionally** (`products.routes.ts:4594-4596`) with no
   call to the Amazon EU intent guard. Amazon holds ONE merchant quantity per SKU across
   `{IT,DE,FR,ES,NL,BE,PL,SE,IE}` — "pushing 0 to DE zeroes IT, FR and ES in the same instant …
   302 market-scoped Zero & Pins blanked the entire IT storefront"
   (`amazon-eu-quantity-guard.ts:1-21`). The guard is wired at `sync-control.routes.ts:29` and
   `outbound-sync.service.ts:31` and nowhere else, so the push layer is the only belt.
   **CODE-READ + MEASURED-IN-DOC (the incident).**
3. **Price replicates across currencies unconverted.** `Marketplace.currency` exists
   (`schema.prisma:1854`) and neither replicate route reads it; `includePrice` copies `priceOverride`
   verbatim (`marketplaces.routes.ts:713-717`). IT→UK is EUR→GBP, IT→SE is EUR→SEK. Parity 3.3n
   notes currency is surfaced nowhere on a channel scope. **CODE-READ.**
4. **`attributes` and `all` modes send the same field set.** `ATTR_FIELDS = undefined`
   (`ChannelListingTab.tsx:760`) means "all attributes", identical to `all` except `includeSetup`,
   which both set to `true` (`:762`). Four labelled modes, three behaviours. **CODE-READ.**
5. **No undo on either replicate path, and no snapshot.** `ChannelListingSnapshot` and
   `captureSnapshot` exist and are unused by both routes. An operator who replicates onto four
   markets and regrets it has no path back. **CODE-READ.**
6. **Broadcast swallows every failure** (`ChannelFieldEditor.tsx:997`, `:1005`) and reports nothing.
   Partial success is indistinguishable from total success. **CODE-READ.**
7. **The bulk PATCH's context dedupe drops `aliasKey`.** `products.routes.ts:1169-1184` dedupes on
   `` `${c.channel}:${c.marketplace}` `` while every consumer downstream reads
   `(ctx as {aliasKey?: string}).aliasKey` (`:2257`, `:2393`, `:2519`). So two contexts differing
   only by alias collapse to the first, and **a single PATCH cannot fan out across aliases of one
   market**. Harmless today (0 non-null `aliasId` on prod) and a wall for any per-alias broadcast.
   Also: `rawContexts` is locally typed without `aliasKey`, which is why nine call sites carry a
   cast — a mirrored type drifting inside one file (`reference_wire_parse_boundary_rules`).
   **CODE-READ.**
8. **🔴 One `expectedVersion` cannot guard N coordinates.** `mappedListings`
   (`products.routes.ts:2355-2368`) fetches every listing matching the contexts, and
   `upsertChannelListings` CASes each matched row against **the same** `expectedVersion`
   (`:2404-2422`). Listing versions differ on 868 of 977 rows (89%, `useChannelSheet.ts:216-218`),
   so a fan-out sent with the source listing's token will P2025 on every target that is not
   coincidentally at the same version. **A broadcast must send NO `expectedVersion`** — which means
   it gives up CAS and must therefore be preflighted against read-back values instead. **CODE-READ.**
9. **🔴 The apply/revert staleness check is single-coordinate.** `jobWriters`
   (`product-studio.routes.ts:483-506`) loads ONE sheet from the job's stored scope and market, and
   `currentOf` (`:510-513`) looks the cell up in that one sheet, **ignoring `cell.scope`** — while
   `computeImportDiff` explicitly supports many coordinates in one diff. `applyStoredJob` compares
   `currentOf(c)` against `c.before` and refuses on mismatch (`import-jobs.service.ts:216-220`), so a
   multi-market diff would compare each target against the SOURCE market's value: false "changed
   since the preview" refusals, or false acceptances. Unreachable today (a single-scope export names
   one coordinate on every header), and **replicate is the first consumer that makes it routine.**
   `jobWriters` also hardcodes `aliasKey: ''` (`:532`) in both writers. **CODE-READ.**
10. **A per-target sheet read is not cheap on non-IT markets.** `/studio/sheet` master measured
    **12.75 / 12.72 / 12.68 / 9.76 s on DE and ES** against 0.18–0.28 s warm on IT, and
    readiness-for-market steady state is 4.11–4.86 s (ledger, BE.1 §4 and its two corrections). A
    four-market preflight built as four sheet reads can therefore take tens of seconds cold.
    **MEASURED-IN-DOC.**
11. **The "33 of 35 columns write the shared master record" notice may be STALE.**
    `rows.ts:344-352` and `ChannelSheet.tsx:1918-1930` assert it, and `SheetColumn`'s own doc
    (`studio-sheet.service.ts:168-179`) still says only six fields can reach a ChannelListing — but
    `resolveWriteRouting` now routes every non-`storage:'column'` cell to `overrideData` and sets
    `affectsAllChannels: Boolean(coordinate) && !routesToChannel` (`:517-539`), whose own comment
    says "now just the identity/column fields". The two cannot both be true. This matters directly:
    it decides which columns replicate can meaningfully move. **Do not take either number — derive
    the set per column from the live payload** (`reference_a_list_of_members_is_a_set_claim`,
    `reference_a_banked_rule_can_go_false`). **CODE-READ, needs re-measurement.**
12. **Zero tests** reference `replicate`, `bulk-replicate` or `broadcastToListings` outside
    `channelActions.vitest.test.ts`, which asserts the disabled path with `siblingMarkets: []`
    (`:50-51`, `:117`) — a test that passes *because* the verb is dead. **CODE-READ.**
13. **No `credentials: 'include'`** on the old replicate POST (§2). **CODE-READ.**
14. **Route A is not idempotent** (Route B is, `:4464`). A double-clicked Replicate writes twice.
    **CODE-READ.**
15. **`router.refresh()`-class repaint.** Route A's caller only calls `onDone()`, so the operator's
    only feedback is a count sentence; nothing shows what changed. **CODE-READ.**

## 6. Proposed home in the studio

### 6.1 Primary home + mirrors

**BROADCAST — primary: H3 ROW + H4 SELECTION verb on the FOCUSED CELL's column,
`broadcast-to-listings`, relabelled "Copy this value to markets…".**

The verb already exists and is already rendered on the row context menu and the ⋯ column by the same
adapter (`menuAdapters.tsx:58` renders `ROW ∪ SELECTION` for a single row; #690 confirms all three
verbs are on right-click). What is wrong is not its home but its **unit**: today it promises to
broadcast "the fields this scope carries" (`channelActions.ts:333`), which is unbounded and cannot
be honestly confirmed. The honest unit is the **cell** — one column × the selected rows — because
that is what the operator is looking at when the thought occurs, and `ChannelSheet` already tracks
the focused cell (`lastDataCell.current`, used at `:733` to open the drawer on it). So the verb gains
one dep, `focusedColumn`, and its title becomes a sentence a person can check: *"Copy Materiale from
eBay·IT to DE, FR on 6 SKUs?"*. H4 needs one new surface: the channel sheet has **no selection bar**
— master has `FamilySelectionBar` on DS `BulkActionBar` in its grid footer
(`MasterSheet.tsx:1845`), the channel scope has nothing. That bar is the H4 home.

*Mirror — H7 drawer Compare pane.* Already built, already correct for one target
(`ComparePane.tsx:232`), already shows each market's current value and layer. It becomes the
one-field review surface: broadcast writes, Compare shows what landed. Nothing to build but the
reload.

**REPLICATE — primary: H6 SheetToolbar `trailing` verb, beside Import, opening the EXISTING
diff→apply→revert drawer.**

Not H5. `CONTEXT(alias-group)` is the wrong axis: an alias band is one listing *of this market*, and
replicate crosses markets. Not `CONTEXT(product-family)` either — the family is the rows, and every
row goes. The subject is the **scope** (this channel × this market), which is exactly what H6 is for,
and the toolbar's own comment already places Import beside Export because "they are the same idea in
two directions" (`SheetToolbar.tsx:243-244`). Replicate is a third direction of the same idea: an
import whose source is a sibling coordinate instead of a file. Putting it there is not placement by
convenience — it is placement by **contract**, because `computeImportDiff` already accepts
multi-coordinate headers and already does one sheet read per coordinate (§3), so replicate is a new
*source* for a pipeline that exists, is live, and has a revert.

*Mirror A — H5 `CONTEXT(alias-group)`, wave-2:* "replicate alias ② to eBay·DE's alias ②". Blocked
twice over — by PES.5-ii (no alias can exist yet) and by defects 7 and 9. It should be declared
HIDDEN with the reason rather than omitted, so the axis is not silently empty forever.

*Mirror B — H7 drawer Listings pane:* the per-coordinate outcome of the last replicate and its
revert token, so an operator who has switched markets can still find the undo.

**Explicitly NOT.** No H9 console: unlike report 12's cross-family case, every target here is
*another market of the same product*, one market-chip click away — and the Errors & Sync console is
bound to `OutboundSyncQueue` (`syncQueue.ts:1-16`), so routing replicate outcomes there would mean a
second source in a console ruled sync-queue-first (#127). No H2 status column: "was replicated" is a
history fact and belongs in H7 History. No H1 cell. No H11 page.

### 6.2 What the sheet shows at rest, per scope

- **master scope:** both verbs `HIDDEN`. A master record has no coordinate to copy from or to, and a
  greyed control here teaches something false (`registry.ts:50-57`).
- **channel × market (the source):** nothing new at rest. Broadcast lives in the cell's context menu
  and the (new) selection bar; replicate is a toolbar button. Ruling #739 fixed the alias band's slot
  table and nothing here re-opens it.
- **channel × market (a target, after a run):** the copied cells are ordinary channel overrides — a
  `✎` at `layer: 'channel'`, and on a variant row under a changed alias, #16's `inheritedOverride`.
  That is the honest rendering: a replicated value *is* a pinned channel override, and a fifth
  provenance state for "arrived by copy" would be a vocabulary nobody asked for. **Where a replicate
  is visible is a different market's sheet**, which is the surface problem §6.3 step 7 addresses.
- **the scope bar:** the market switcher should carry a small "changed" dot on any market the current
  session wrote to by fan-out — the single cheapest honesty fix, because otherwise a 400-cell write
  leaves no trace on screen at all.
- **no new column anywhere.** The replicable/non-replicable distinction is a *column property*
  (`writeTarget`, `affectsAllChannels`), already available to the picker; putting it in the grid
  would be 100 tooltips for a decision made once per operation.

### 6.3 The interaction, step by step

**BROADCAST** (DS: `Menu` → `Modal` + `MultiSelect` + `PressableRow` → `ActionConfirm`):
1. **Open.** Operator has a cell focused (or N rows selected). Right-click → *"Copy Materiale to
   markets…"*, or the ⋯ column, or the selection bar. Label resolved by `actionLabel(action, rows)`
   so it words itself from what is actually ticked (#363).
2. **COLLECT.** `pickMarkets` — a DS `Modal` over `MultiSelect`, offering
   `options.channels.find(c => c.id === channel).markets` minus the current one, each row showing
   **that market's current value for this column** and its layer chip. This is the "show each
   market's current value" requirement, and it is one read: N `GET /studio/sheet` calls in parallel,
   the `useCompare` pattern (`useCompare.ts:8-16`). Under defect 10 the picker must render the market
   list immediately and fill values in as they land, never block on the slowest.
3. **PREFLIGHT.** From the reads already in hand: `findings[]` one per (row × market) with
   `previous → next`, severity `info` when the target is empty, `warn` when it holds its own pinned
   value, `error` when the target column does not exist in that market's schema (the
   `unknownColumns` case) or the coordinate is Shopify/Etsy/Woo (#177 — refuse, do not offer).
   `payload` carries the exact values, so run applies what was approved (#118).
4. **CONFIRM.** `ActionConfirm`; `level` from the preflight. `type-to-confirm` with
   `confirmPhrase = deps.channel` the moment any target alias carries an `externalListingId` — the
   existing rule (`channelActions.ts:329-341`), and `validateImpact` refuses a typed level with no
   phrase (`registry.ts:266-275`).
5. **RUN.** `await writer.flush()` first (the sheet's own quiesce, `sheetWriter.ts:262`) so an
   in-flight autosave cannot race — this is `reference_autosave_still_needs_a_nav_guard` and the
   "in-flight autosave UNDID an API revert" pointer. Then **ONE** `PATCH /api/products/bulk`:
   `changes: [{ id, field, value, target }]` × rows, `marketplaceContexts: [{channel, marketplace,
   aliasKey}]` × targets, **no `expectedVersion`** (defect 8), and an `Idempotency-Key`.
6. **Repaint.** `invalidates: { kind: 'none' }` for the current sheet — nothing on screen changed —
   plus a toast naming the markets and the count, with *"Review in Compare"* opening the drawer's
   Compare pane on that field. Keyboard: the verb is in the row menu's tab order, `useActionPress`
   owns the sequence, the modal traps focus and returns it to the cell. With the drawer open the
   modal overlays it; the drawer's Compare pane repaints from the same reload.

**REPLICATE** (DS: `Drawer` + `SegmentedControl` + `Checkbox` + `NexusGrid` + `Banner` + `Stepper`):
1. **Open.** Toolbar `[Replicate…]` beside `[Import]`.
2. **CONFIGURE (step 1 of 2).** Three controls in one pane:
   *(i)* **Targets** — `MultiSelect` of the channel's other markets, each row carrying its readiness
   pill, its currency, and its language.
   *(ii)* **Field set** — `Checkbox` groups built from the contract's own `groups: SheetGroup[]` in
   the channel's own localised titles (`sheet-columns.service.ts:192`). The old four modes become
   presets over those groups, not a parallel taxonomy: *Text only* = the Content group,
   *Attributes* = the attribute groups, *All fields* = everything offered. **Three exclusions are
   structural, not unticked defaults**, and the pane says why: **quantity is absent** (Amazon EU
   holds one number per SKU — defect 2); **price is a separate opt-in that refuses across
   currencies** (defect 3); and every column the server marks `affectsAllChannels` /
   `writeTarget: 'master'` is absent, because "replicating" a master field to four markets writes
   master four times and would make the confirm lie about what changed (defect 11 — derive the set
   from the payload, never from a list).
   *(iii)* **Translate** — a `Checkbox`, **present and disabled**, its reason on the row: *"Machine
   translation is built but held (no AI generation for now). Replicating copies the source text
   verbatim."* Two honest futures, both cheap from here: queue a `ProductAiDraft` per target cell so
   the target market shows `✦` drafts nobody has approved (`schema.prisma:11986-12024`, generation
   dark under #13), or push the translate into the MAPPING as PES.6's `addTranslate` transform
   already does (`schema-mapping.service.ts:566-583`) — that one is config-level and spends nothing.
   Recommend the first: it keeps the value per product and per coordinate, which is what an operator
   reviews.
3. **DIFF (step 2 of 2).** ONE call to the existing pipeline: build `headerRow` as
   `field@CHANNEL:MARKET:locale` for every (field × target) and `rows` from the source coordinate's
   values, then `computeImportDiff` + `storePreview` — which gives, for free, the write path's own
   refusal sentences, `unknownColumns` for fields a target market's schema lacks, `pins` for cells
   that follow master today, and server-stated `counts` that `reconcileCounts` checks the client's
   against. Rendered in the SAME `NexusGrid` the ImportDrawer already uses — rows are SKUs, column
   groups are markets, each cell `before → after` with its verdict. `applyBlockedReason` and
   `listingWriteWarning` are reused verbatim, including *"If those listings are live, applying this
   changes what buyers see."*
4. **Restore point.** Before apply, `POST /listings/:listingId/snapshots` with
   `reason: 'pre-replicate'` and a shared `label` for every target that **already has a listing**;
   `SNAPSHOT_FIELDS` covers everything a replicate writes (§3). A target with no listing yet has no
   pre-state — its undo is the job's own revert (which restores `before`, i.e. empty), and the pane
   must say that rather than promise a snapshot that does not exist.
5. **CONFIRM + RUN.** Apply replays the stored diff (`applyStoredJob`), skipping and recording any
   cell whose value moved. Typed confirm when any target listing is live.
6. **REVERT.** `POST …/import/jobs/:jobId/revert` — one control, in the drawer and in H7's Listings
   pane, live until `expiresAt`. Per-target snapshot restore stays as the second, coarser undo.
7. **What repaints.** The source sheet: nothing (correctly — no cell on screen changed). The market
   switcher gains the changed-dot. The drawer's Compare pane, if open, now shows the new values on
   the target coordinates. **Why a two-step drawer and not a five-step wizard:** PES.7 settled this
   idiom for the same class of operation — "a wizard would only add steps between the operator and a
   decision they can see whole" (`BulkApplyModal.tsx:5-7`), whose `bulkApply.ts` classifies every
   target `fill | pin | overwrite | skip` on one screen. Configure and diff genuinely cannot share a
   screen (the diff is a grid, and it costs a server round trip), so `Stepper` with **two** steps is
   right; targets · fields · translate · diff · run as five steps would be four screens for three
   decisions. This is a recommendation, not a ruling — the Owner's shape is Q1 below.

### 6.4 Per-scope rules

- **master:** both HIDDEN.
- **Amazon channel scope:** one offer per ASIN, so the alias list is always Primary — irrelevant
  here, since the axis is markets. But **Amazon EU shares quantity** and **images are global per
  ASIN**, so quantity is absent from the field set and images are not in it at all (H8 owns them, and
  the studio's image copy-to-markets is still 🕳 — the old `crossMarketCopy.ts` with its
  `SHARED_TARGET` PLATFORM scope is the specification, not this feature).
- **eBay channel scope:** same shape. A Lane-B (adopted/shared) alias must be refused as a target for
  the same reason report 12 gives, and refused *by alias*, which defect 7 currently prevents — hence
  wave-1 targets the primary listing of each market only, with the alias axis declared and disabled.
- **Single-store channels (Shopify / Etsy / Woo):** both verbs HIDDEN, and honestly so —
  `marketplaceContexts[].channel` is typed `'AMAZON' | 'EBAY'`, so the write is *unreachable*, not
  merely unbuilt (#177, `studio-sheet.service.ts:519-524`). These channels have one store; there is
  no sibling market to replicate to.
- **A target market with no listing:** allowed. The upsert creates it **DRAFT + `isPublished: false`**
  (#177), and the diff pane says how many listings would be born.
- **Cross-CHANNEL replicate (Amazon·IT → eBay·IT)** — `bulk-replicate` supports it via
  `CROSS_CHANNEL_ATTR_MAP`. **Out of scope, deliberately:** the field namespaces barely overlap, the
  caps differ, and the honest surface for "the same value on two channels" is the Compare pane's
  copy-across, one field at a time, which already exists.

### 6.5 Provenance / autosave / readiness / publish

- **Provenance.** Every copied cell lands at `layer: 'channel'`, `pinned` — a `✎` on the target's
  sheet. `pins` from the diff is what tells the operator *before* the run how many cells stop
  following master, and `pinSentence` (`diffModel.ts:355`) already words it.
- **Autosave.** Neither verb is autosave. Both `await writer.flush()` first and are `disabled` with
  that reason while `writer.pending > 0` cannot be cleared. Broadcast sends no `expectedVersion`
  (defect 8), which is a real loss of CAS and the reason its preflight must read the targets rather
  than assume them.
- **Readiness.** Never recomputed client-side. A replicate that fills 12 required fields on DE moves
  DE's chip because the server said so; the source scope's readiness does not move at all, which is
  correct and will look like nothing happened — the changed-dot on the market switcher is the fix.
- **Publish.** Untouched. Nothing here calls a marketplace; a created listing is DRAFT and
  unpublished. Publishing stays explicit, per channel, preflight-first, mode from the server.

### 6.6 ASCII mockup

```
 21 rows · 1 selected   [View ▾][Missing required (7)]  Find…  [Customise][Export ▾][Import][Replicate…][Reload]
┌─ eBay · IT ─────────────────────────────────────────────────────────────────────────────┐
│ ▾ P Primary        ACTIVE  256566101420  ████████░░ 84%   ⋯                             │
│   ▸ GALE-KAN-PRO-NE-S  🔗Nero  ✎ Cordura ◀ right-click ─┐                               │
└──────────────────────────────────────────────────────────┼──────────────────────────────┘
   ┌── Copy Materiale to markets… ────────────────────────┘   ┌─ Replicate eBay·IT → … ──┐
   │ FROM  eBay · IT   value: "Cordura"                   │   │ ①Configure ─── ②Diff      │
   │ TO    ☑ DE  currently "Polyester"      ✎ pinned  ⚠   │   │ TARGETS ☑DE ☑FR ☐UK(GBP) │
   │       ☑ FR  currently (empty)          🔗 inherited  │   │ FIELDS  ☑Contenuto (6)   │
   │       ☐ UK  not in this market's schema — cannot  ✕  │   │         ☑Attributi (24)  │
   │  → 6 SKUs × 2 markets = 12 cells; 1 pinned value     │   │         ☐Prezzo  ⚠ EUR→  │
   │    would be replaced                                 │   │         (quantità esclusa)│
   │                        [Cancel]  [Preview change]    │   │ TRANSLATE ☐ held (no AI) │
   └──────────────────────────────────────────────────────┘   │      [Cancel] [Show diff]│
                                                              └──────────────────────────┘
```

## 7. Contracts and data

**Reused, unchanged.**
- `PATCH /api/products/bulk` with `marketplaceContexts` fan-out — broadcast's whole write
  (`products.routes.ts:1042`, `:2372`, `:2518`). No `expectedVersion`.
- `GET /api/products/:id/studio/sheet?scope=channel&channel=&market=` × N targets — both preflights,
  the `useCompare` pattern.
- `POST /products/:id/import/diff` → `storePreview` → `…/apply` → `…/revert` — replicate's whole
  pipeline (`product-studio.routes.ts:273`, `:549`, `:574`).
- `POST /products/:id/listings/:listingId/snapshots` with `reason: 'pre-replicate'` (free string).
- `GET /products/:id/studio/history?aliasId=` — where "replicated at 14:02 by …" shows.

**New — small, and mostly server-side (PES.5).**
- `POST /products/:id/studio/replicate/diff` — `{ fromScope, targets[], fieldKeys[] }` → builds
  `headerRow`/`rows` from the source coordinate and calls the SAME `computeImportDiff` +
  `storePreview`, returning the same `{ jobId, diff }` the import drawer already renders. **The only
  genuinely new code is the candidate builder**; everything after it exists.
- `GET /products/:id/studio/broadcast-targets?channel&market&field` → per market `{ value, layer,
  pinned, inSchema, live }`. Optional: N sheet reads answer it, at the cost of N full-family payloads
  per keystroke-scale verb. Recommend building it, because defect 10's 9–13 s non-IT sheet read makes
  the sheet-read version unusable as a menu.
- **Two server fixes this feature REQUIRES, both PES.5:** `jobWriters.currentOf` must resolve per
  `cell.scope` with a cached sheet per coordinate, and must stop hardcoding `aliasKey: ''`
  (defect 9); and the bulk PATCH's context dedupe must include `aliasKey`, with `rawContexts` typed
  to carry it so the nine casts go away (defect 7).

**Additive schema.** None required. Optional, both nullable: `ChannelListingSnapshot.batchId String?`
so an N-target restore is one query (or reuse `publishEventId`, as report 12 notes).

**Read-contract additions.** `MarketOption` gains `currency` and `language`
(`_studio/types.ts:84-89`; `MarketplaceLite` at `:69-75` already reads `language` and must add
`currency` from `Marketplace.currency`) — the picker cannot warn about EUR→GBP otherwise.
Wire→UI mirroring per the standing rule.

| piece | lane |
|---|---|
| `replicate/diff` candidate builder; `broadcast-targets`; `currentOf` scope fix; dedupe `aliasKey` fix | **PES.5** |
| `MarketOption.currency/language` on the read + the scope-bar changed-dot | **PES.5** read, **PES.1** render |
| wiring `siblingMarkets` + `pickMarkets` (two lines, `ChannelSheet.tsx:726`); the market picker modal; the focused-column dep; the channel selection bar | **PES.3** |
| `Replicate…` toolbar entry + the Configure step; reusing `ImportDrawer`'s diff grid | **PES.3** (+ **IO.1**'s drawer) |
| promoting a `collect` hook into the registry (`registry.ts:217-219` — "the moment a second lane needs it") | **PES.2** |
| Compare-pane reload after a broadcast; the revert control in Listings | **PES.4** |
| the translate checkbox's dark reason + `ProductAiDraft` per target (if Q3 says drafts) | **PES.8** |

## 8. Risks and traps

- **Amazon EU shared quantity is the sharpest one.** Quantity must not be in the field set at all,
  and the pane must say why. The guard exists and is unwired on every write path this feature
  touches; a replicate that includes quantity is the 302-Zero-&-Pins incident with a nicer UI.
- **Currency.** Price replicate refuses across currencies, or it silently prices a jacket at 149 GBP.
- **Every eBay·IT listing in the fixture family is ACTIVE with a real ItemID** (40 of 40,
  `channelActions.ts:18-19`). There is no safe fixture, and both verbs write the LOCAL record only —
  which is what makes them shippable at all. Typed confirm the moment any target is live.
- **Local dev writes the PROD DB.** The picker and the diff must be strictly read-only until apply,
  and `dryRun` is the default on the wire.
- **A green preflight on an empty target set is a vacuous pass** — with zero eligible markets the
  verb is `disabled` with the reason, never `available` with an empty confirm
  (`reference_control_must_target_the_branch`). Today's `siblingMarkets: []` is exactly the inverse
  failure: permanently disabled with a reason that is FALSE (the markets exist).
- **N sheet reads are slow on non-IT markets** (9–13 s measured). Render the list first, fill values
  as they land, and never block a keystroke-scale menu on the slowest market.
- **The stale-comment trap.** Both "33 of 35 columns write master" and the `SheetColumn` doc's "only
  six fields can reach a ChannelListing" contradict the routing code. Derive the replicable set from
  the live payload; do not relay either number.
- **Untouchables.** The flat-file Propagate job (`flat-file-propagate.service.ts`) and the
  reconciliation page stay untouched — read for their field taxonomy only. Sync Control keeps
  `followPool` / `stockBuffer`.
- **AI stays dark** (#13). The translate control is present, disabled, and explains itself.
- **`bulk-replicate` should not be resurrected.** It is dead from the UI, cross-product and
  cross-channel, capped at 1000×20, and carries the quantity defect. Its two good ideas —
  `Idempotency-Key` and the source-drift re-check — belong in the new path.

## 9. Open questions for the Owner (max 3)

1. **Is replicate a two-step drawer beside Import, or a five-step wizard?**
   *Recommendation: the two-step drawer.* It reuses a live, tested pipeline that already has a real
   diff, the write path's own refusals, and a **revert** — none of which a new wizard would have on
   day one — and it follows PES.7's settled idiom of one screen per decision the operator can see
   whole. The cost is that "Replicate" sits in the toolbar rather than reading as a ceremony.
2. **Does broadcast act on the FOCUSED COLUMN, or on a chosen field set?**
   *Recommendation: the focused column.* It is the only unit whose confirmation can be checked by
   reading it, it matches where the thought occurs (mid-edit), and "several fields to several
   markets" is replicate with a small field set — the same operation, already covered. The cost is
   that broadcasting three fields means three passes.
3. **When translate is unheld, does it generate into the target CELLS or into `ProductAiDraft`?**
   *Recommendation: drafts.* The target market's sheet shows `✦` cells nobody has approved, review
   and approve replay through the same bulk PATCH, and a bad translation never silently becomes the
   listing. It also means replicate ships today with the checkbox honest and disabled, and needs no
   change when the hold lifts.

## 10. Effort and dependencies

| piece | size | lane | depends on |
|---|---|---|---|
| Wire `siblingMarkets` + `pickMarkets` (the data is in the same file at `ChannelSheet.tsx:1381`) | **S** | PES.3 | — |
| Market picker modal showing each market's current value + layer | **M** | PES.3 | `broadcast-targets` (or N sheet reads) |
| Focused-column dep + relabel + preflight/findings + un-dark the RUN | **M** | PES.3 | Owner answer to Q2 |
| Channel-scope selection bar (DS `BulkActionBar`, master's pattern) | **S** | PES.3 | — |
| `GET broadcast-targets` | **S** | PES.5 | — |
| `POST replicate/diff` candidate builder over `computeImportDiff` + `storePreview` | **M** | PES.5 | — |
| 🔴 `currentOf` per-`cell.scope` + drop the `aliasKey: ''` hardcode | **S** | PES.5 | **blocks any multi-market apply** |
| 🔴 Dedupe `aliasKey` in `effectiveContexts` + type `rawContexts` properly | **S** | PES.5 | blocks per-alias fan-out |
| `Replicate…` toolbar entry + Configure step + reuse of the diff grid | **M** | PES.3 + IO.1 | Q1 |
| `pre-replicate` snapshots per target + the revert control in H7 | **S** | PES.5 + PES.4 | snapshot service (exists) |
| `MarketOption.currency/language` + the currency refusal | **S** | PES.5 + PES.1 | — |
| Scope-bar "changed" dot | **S** | PES.1 | — |
| Registry `collect` promotion | **S** | PES.2 | second consumer (this is it) |
| Translate → `ProductAiDraft` per target | **M** | PES.8 | Q3; stays dark under #13 |

**Blocking dependencies.** Nothing blocks broadcast — the endpoint, the verb, the picker contract and
the permission all exist; it is two lines of wiring plus a picker, which is why the audit called it
"the closest gap to close". Replicate blocks on the two PES.5 server fixes above (defects 7 and 9),
both small and both latent defects in their own right. The alias axis blocks on PES.5-ii, as
everything alias-shaped does. Report 12's `copy-listing-setup` and this report's two verbs must land
in one review pass: three verbs writing channel cells, one of which never runs, is exactly the drift
the single registry exists to prevent.
