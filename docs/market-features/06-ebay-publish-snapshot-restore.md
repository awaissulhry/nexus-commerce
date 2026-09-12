# 06 — eBay PUBLISH drawer + publish SNAPSHOT / RESTORE + version history

## 1. What it is (operator terms)

A listings operator has edited an eBay listing — title, aspects, price, quantity, images — and now
has to push it outward. Publish is the one action in the studio the operator cannot take back by
retyping a cell: it changes what a buyer sees on ebay.it. So the feature is two halves that only
make sense together. **Publish** is the guarded outward action: see what is about to be sent, learn
which rows would be refused, know whether the platform is really going to send anything, fire it,
watch it, read the result. **Snapshot/restore** is the undo: every publish records what was sent,
so when the 14:02 push turned out to carry the wrong Italian title the operator can put the 13:40
state back — into a *draft*, never onto the live listing, with the current state captured first so
the undo is itself undoable. The parity audit calls this the most important of the 22 missing
capabilities precisely because it is "the operator's undo for an outward-facing action"
(`docs/pes-parity-audit.md:218-219`, note 3.47n).

## 2. Old UI — inventory

**Entry points** (both in the eBay cockpit's shell action row):
- `tabs/ebay-cockpit/EbayCockpit.tsx:386-393` — primary `Publish` button → `setPublishDrawerOpen(true)`.
- `EbayCockpit.tsx:411-423` — `History` button with a snapshot-count badge → `setVersionDrawerOpen(true)`.
- No keyboard path for either (the cockpit's `Cmd+Shift+P` shortcut belongs to the *Amazon* cockpit,
  `useCockpitShortcuts.ts`, audit row 3.36).

**`publish/PublishDrawer.tsx`** (475 lines, five phases in one component):
- `:32` `Phase = 'preflight' | 'confirm' | 'running' | 'success' | 'failure'`; hand-rolled drawer at
  `:167-178` (`fixed inset-0`, own backdrop, own `role="dialog" aria-modal`), not a DS component.
- Preflight (`:233-265`) renders `hardFails` computed **in the caller's JSX**, `EbayCockpit.tsx:774-794`
  — four client-side checks (category / price / title / images) with an inline comment admitting they
  are "cheap client-side guards".
- Confirm (`:268-314`) is a six-row summary table: Title, Category, Price, Quantity, Images (count),
  Aspects (count). Round-trips nothing; every value is passed in from `useEbayCompositor`.
- Run: one `POST /api/ebay/cockpit/publish` (`:102-106`). The three-step progress list is
  **reconstructed client-side** from `failedStep` + `ok` (`:108-130`) because "the adapter is
  synchronous from the client's perspective — we don't get per-step events".
- Failure (`:413-474`) offers `Retry` and `Restore pre-publish snapshot` →
  `POST /api/ebay/cockpit/snapshot/restore` (`:142-150`), keyed on `result.snapshotId`.
- Publish-mode honesty: `PublishModeBadge channel="ebay"` at `:188`, which does its **own** fetch to
  `GET /api/listings/publish-readiness` (`apps/web/src/components/PublishModeBadge.tsx:27`).

**`versioning/VersionHistoryDrawer.tsx`** (257 lines):
- Takes `history` as a **prop** — it never fetches. `EbayCockpit.tsx:183-196` reads it out of
  `listing.platformAttributes._versionHistory`, so the list is only as fresh as the SSR payload and
  is refreshed by `router.refresh()` (`:107`, `:129`).
- `Snapshot now` → `POST /api/ebay/cockpit/snapshot` with `reason: 'manual'` (`:98-102`).
- Per-row `Restore` → `POST /api/ebay/cockpit/snapshot/restore` (`:120-124`).
- Four reason labels with icons at `:41-46` (manual / auto / pre-publish / pre-restore).
- `summarise()` at `:56-77` is a **client-side** digest of the payload (category, aspect count,
  price, qty, axes, Best Offer). There is **no field-level diff** — no old→new, no per-field
  selection. Restore is all-or-nothing.
- Header says "oldest first dropped after 10" (`:162`); footer states the pre-restore guarantee (`:251`).

**Browser-local vs server:** nothing here is localStorage — both drawers are server-backed. What *is*
browser-local is the freshness: the history list is derived from a prop, so a snapshot taken in
another tab is invisible until a refresh.

**Dead / unreachable:** nothing in this pair is dead — both drawers have a live importer
(`EbayCockpit.tsx:73-74`). The `auto` reason in `REASON_ICON` (`:43`) has **no writer**: no server
path emits `reason: 'auto'` (`grep -rn "'auto'" apps/api/src/routes/ebay-cockpit.routes.ts` — the
route's own doc comment at `:900` promises it, the code never writes it). CODE-READ.
Adjacent and separate: `tabs/SnapshotModal.tsx` (464 lines) + `TimelineTab.tsx:356` are the
**master**-record time-travel (`GET /state?at=`, `POST /restore`) — audit row 4.13, a different
mechanism, already rebuilt in the studio (§4).

## 3. Backend that exists

**Legacy eBay cockpit trio** — `apps/api/src/routes/ebay-cockpit.routes.ts` (1944 lines, registered
`apps/api/src/index.ts:694` with prefix `/api`):

| method + path | file:line | what it does |
|---|---|---|
| `POST /api/ebay/cockpit/snapshot` | `:901-949` | Writes a snapshot **into `platformAttributes._versionHistory`**, a JSON array capped at 10 (`:935`). Strips the previous history first so it does not snapshot snapshots (`:921-924`). |
| `POST /api/ebay/cockpit/snapshot/restore` | `:955-1030` | Finds the entry by id, auto-snapshots current state as `pre-restore` (`:995-1004`), then writes `platformAttributes` + `priceOverride` + `quantity` back (`:1014-1023`). |
| `POST /api/ebay/cockpit/publish` | `:1039-1246` | Mode gate (`:1053-1056`, 503 on `gated`) → pre-publish snapshot (`:1082-1103`) → payload build (`:1105-1211`) → `EbayPublishAdapter.publish()` → persist (`:1214-1240`). |

Publish payload assembly reads `platformAttributes.categoryId/conditionId/itemSpecifics`, product
images capped at 24 (`:1112`), price falls back `priceOverride → listing.price → product.basePrice`
(`:1120-1126`), a hardcoded numeric→enum condition map (`:1137-1148`), policies + `merchantLocationKey`
from `platformAttributes` (`:1190-1195`), eBay Motors fitment (`:1197-1199`) and a GPSR/CE regulatory
container from `resolveComplianceById` (`:1154`). Compliance blockers are enforced **only when the
mode is `live`** (`:1158`) and can be overridden with `overrideCompliance: true` (logged, `:1167`).

**Safety gates** — `apps/api/src/services/ebay-publish-gate.service.ts`:
- `isEbayPublishEnabled()` `:30-33` reads `NEXUS_ENABLE_EBAY_PUBLISH`, default **false**.
- `getEbayPublishMode()` `:40-46` → `'gated'` when the flag is off, else `EBAY_PUBLISH_MODE` ∈
  `live | sandbox | dry-run`, **default `dry-run`**.
- `getEbayApiBaseForMode()` `:58-62` returns `''` for gated/dry-run so a stray `fetch` fails loudly.
- Token bucket 10/s, burst 100 (`:77-79`), one token per publish *attempt* (all three HTTP calls).
- `EbayPublishAdapter` (`services/listing-wizard/ebay-publish.adapter.ts`, 779 lines) reads the mode
  at `:262`, writes a `ChannelPublishAttempt` row at every boundary (`:273, :309, :331, :361, :388, :415`
  via `channel-publish-audit.service.ts:84`), and short-circuits dry-run at `:344-378`.
- `NEXUS_EBAY_REAL_API` is a **different** gate — it guards the Trading-API provider
  (`providers/ebay.provider.ts:218,263`) and the read-only crons, not the Inventory publish.

**The PES.5 doctrine backend — already built, and it is the right shape:**
`apps/api/src/services/pim/listing-snapshot.service.ts` (303 lines), written to ruling #110:
- `captureSnapshot()` `:118-138` — writes a `ChannelListingSnapshot` row; for `pre-publish` the
  caller is required to pass **the payload actually SENT**, and the header says why (`:111-117`).
- `listSnapshots()` `:140-158` — summaries only, with `sizeBytes` instead of the payload.
- `restoreToDraft()` `:187-302` — coordinate-mismatch refusal (`:199-204`, `SnapshotCoordinateMismatchError`),
  pre-restore auto-snapshot inside the transaction (`:218-229`), the write sets `isPublished: false`
  + `listingStatus: 'DRAFT'` + `version: { increment: 1 }` (`:231-246`), marks the source snapshot
  `restoredAt` (`:248-251`), then emits `listing.updated` and a `CHANNEL_LISTING_UPDATED` product
  event *outside* the transaction (`:272-300`).
- `SNAPSHOT_FIELDS` `:69-82` — an explicit 21-field allow-list; `externalListingId`, `id`, `version`
  and sync bookkeeping are deliberately excluded. `overrideData` and `platformAttributes` are
  included, so per-cell provenance survives a restore.

Routes — `apps/api/src/routes/product-studio.routes.ts:699-749`:
- `GET  /api/products/:id/listings/:listingId/snapshots` `:705-713`
- `POST /api/products/:id/listings/:listingId/snapshots` `:716-731` (reason `manual` only — "publish-time
  capture is the publish path's job", `:715`)
- `POST /api/products/:id/listings/:listingId/snapshots/:snapshotId/restore` `:741-749`
- Sibling, for the master record: `GET /api/products/:id/restore-points` `:669-677`,
  `GET /api/products/:id/state` (`products.routes.ts:673`), `POST /api/products/:id/restore` (`:766`).

**Prisma** — `packages/database/prisma/schema.prisma`:
- `ChannelListingSnapshot` `:1800-1842` — `channelListingId`, denormalised `channel`/`marketplace`/
  `aliasKey` ("so a restore can verify it is landing on the coordinate it was taken from", `:1806-1808`),
  `reason`, `publishEventId`, `payload Json`, `label`, `capturedBy`, `restoredAt`/`restoredBy`.
- `ChannelPublishAttempt` `:12689-12739` — `mode`, `outcome`, `payloadDigest` (sha256, for
  duplicate/drift detection), `submissionId`, `durationMs`.
- `ChannelListing` `:1427-1712` — `listingStatus` `:1531`, `isPublished @default(true)` `:1545`,
  `version` `:1646`, `aliasKey @default("")` `:1685`.
- `EbayPushJob` `:8160-8181` — the flat-file push's job log (`mode: 'api' | 'feed'`, `perSkuResults`).

**Jobs/crons:** none owns snapshots. `jobs/latency-watchdog.job.ts:170` and `jobs/fba-flip-guard.job.ts:63`
read `ChannelPublishAttempt`; `listings-syndication.routes.ts:2940` surfaces attempts on the
publish-readiness dashboard.

**Permissions** (`apps/api/src/lib/auth/permissions-manifest.ts`, ordered prefix rules):
- `/api/ebay/**` → `:354` `RW(listingsView, channelsSync)` → **eBay publish/snapshot/restore needs
  `channels.sync`**.
- `/api/products/**` → `:412` `RW(productsView, productsEdit)` → **the PES.5 snapshot routes need
  `products.edit`**.
- `ebay-cockpit.routes.ts` declares **no `preHandler`** of its own (only a rate limit on `ai-improve`,
  `:1276`) — RBAC is entirely the manifest's prefix rule. The two halves of one feature therefore sit
  in two permission namespaces (the `reference_family_verbs_split_permissions` trap).

## 4. Studio today

| piece | file:line | state |
|---|---|---|
| Alias publish preflight | `_studio/sheet/channel/AliasPublishControl.tsx` (181 lines) | Two-step, preview-only. `POST /api/products/sheet/publish-preview` at `:79`. Renders the server's `publishMode` as a Pill (`:129-133`) and its `notSendable` sentence verbatim (`:147-149`). The send button exists but **sets an error string instead of sending** (`:166-171`). |
| Where it renders | `_studio/sheet/channel/ChannelSheet.tsx:1904-1914` | **In the SheetToolbar `trailing` slot, once per alias** — `data.aliases.map(...)`. Three aliases = three `Preflight ①(20)` buttons in the toolbar. |
| Header `Publish ▾` | `_studio/PublishMenu.tsx` (105 lines) | Every item `disabled: true` with a readiness note; a footer row states `NOT_WIRED` (`:31-32`). Sends nothing, and says so on every item. |
| Drawer History pane | `_studio/drawer/panes/HistoryPane.tsx` (242 lines) | A `SegmentedControl` with **two** modes: `Field history` / `Restore record` (`:74-77`). Field history is per-cell who/when/old→new/layer with `coverageSince` honesty; it has an explicit `unavailable` state saying the API has not shipped (`:148-159`). |
| Drawer Restore mode | `_studio/drawer/panes/RestoreMode.tsx` (495 lines) | **Master-record** restore only, and its header says so explicitly: "Master restore is a DIFFERENT mechanism from the listing snapshot/restore of PES.5 §12" (`:13-20`). Field-level checkboxes, server-graded `coverage`, `uncertain` fields excluded not defaulted-off (`:25-31`), `DrawerConfirm` with `acknowledge` (`:144`). |
| Restore points | `_studio/drawer/useRestorePoints.ts` + `restorePoints.vitest.test.ts` | Reads `GET /products/:id/restore-points`; non-restorable points shown-but-inert with the reason on the row (`:15-19`). |
| Listings pane | `_studio/drawer/panes/ListingsPane.tsx` (216 lines) | Read-only **by decision**: "a 'Publish' button inside a record drawer is exactly how a preview-only channel gets published by reflex" (`:8-9`). Shows `Pushed to channel` and `Offer` as two separate facts (`:105-135`). Renders registry `actions` at `:213`, declares none. |
| Action registry | `design-system/grid/actions/registry.ts` | `ROW`/`SELECTION`/`contextOf('alias-group' \| 'product-family')` (`:33-42`); `ActionImpact.level ∈ none \| confirm \| type-to-confirm` chosen by the preflight (`:69`, `:84-85`); `findings[]` explicitly designed so "MS.5's publish-preview … should feed a verb's confirmation directly" (`:101-108`). |
| Channel verbs declared | `_studio/sheet/channel/channelActions.ts:402` | Three: `offerVerb` (`:138`), `broadcastToListings` (`:304`), `openRecordAction` (`:378`). **No publish verb, no restore verb.** Header at `:15-21`: nothing here sends to a channel because every eBay·IT listing in the fixture family is ACTIVE with a real ItemID (40 of 40 measured). |
| Errors & Sync console | `_studio/channel-ops/ErrorsSyncConsole.tsx`, `ErrorsSyncTab.tsx`, `syncQueue.ts` | Built; the studio tab is wired at `StudioTabHost.tsx:48`. Reads `GET /products/:id/sync-queue` (`product-studio.routes.ts:679`). |

**Parity audit rows:**
- **3.47** (`docs/pes-parity-audit.md:173`) — 🔁 for publish, and **"Snapshot/restore has no equivalent"**.
- **3.48** (`:174`) — 🕳 "no version history / restore for a channel listing".
- **3.14** (`:132`) — 🔁; note **3.14n** (`:208-209`): "the preflight names blocked rows and their
  fields but does not list the fields that WOULD be published. An operator cannot see the outgoing
  payload before sending."
- **4.13** (`:272`) — 🕳 for the master half; the studio has since built it (`RestoreMode.tsx`).
- **3.47n** (`:218-219`) and the triage order (`:221-223`): **3.47 is first** of the 22.

**Hub rulings that bind this feature:**
- **#105 · D3** (`docs/pes-claims.md:105`) — "restore NOW = offer PAUSE/ACTIVATE + TIME-TRAVEL RESTORE
  → PES.4 … restore as a drawer pane on `state?at=` + `restore`". The offer half and the master
  time-travel half are built; the **listing** half is not.
- **#110** (`:110`) — D1 decided the three-legged hybrid: drawer = depth, ONE action registry with
  verbs on row menu / ⋯ / selection bar, Errors & Sync as a tab, and "**publish-undo follows the CMS
  doctrine** (snapshot on publish; restore lands in DRAFT never live; pre-restore auto-snapshot)".
  Wave 1 dispatched **PES.4** the "drawer publish-history/restore pane" and **PES.5** the
  "snapshot-on-publish + restore-to-draft BACKEND … EXECUTING a restore against a live listing stays
  gated". PES.5 built the storage and the endpoints; PES.4's pane was never built.
- **#118** — COLLECT → PREFLIGHT → CONFIRM → RUN, in that order, per verb.
- Channel-ops research (`docs/2026-09-01-channel-ops-research.md:82-85`) — snapshot/restore is
  "essentially ABSENT from the commerce cohort (Akeneo removed its channel-snapshot feature in Feb
  2024)"; the doctrine is CMS-side (Webflow, Contentful) and is "genuinely novel among comparables".
  §3.2 (`:96-99`): **verbs must NOT live only in the drawer**. §3.4 (`:103-105`): "drawer history pane
  + publish flow", "consider field-level restore".
- Layout doc `docs/2026-09-01-product-edit-studio-layout.md:108-113` — "Publish stays explicit per
  channel (preflight-first, dry-run default …; eBay publish stays preview-only; publish mode from
  `getAmazonPublishMode()`/`getEbayPublishMode()`, NEVER re-derived from env)."

## 5. Defects and slowness

1. **🔴 Snapshot-on-publish is NOT a server fact.** The doctrine's clause 1 is unmet: `captureSnapshot`
   has exactly one caller, the *manual* route (`product-studio.routes.ts:721`). No publish path calls
   it — `grep -rn "'pre-publish'" apps/api/src` returns two hits only:
   `ebay-cockpit.routes.ts:1087` (the legacy `_versionHistory` blob) and the type literal in
   `listing-snapshot.service.ts:28`. The table, the service and the endpoints exist; the *capture*
   does not happen. **CODE-READ.**
2. **🔴 `restoreToDraft`'s central safety claim is unenforced for eBay.** Its header states
   (`listing-snapshot.service.ts:13-15`) that the restore "sets `isPublished = false`, which is what
   stops the outbound push". `isPublished` appears **once** in the entire outbound/eBay service
   surface — as a *sibling filter* in Amazon's EU shared-quantity guard
   (`outbound-sync.service.ts:989`). The eBay push gates on `syncPaused` (`:882`, `:1128-1134`) and
   `offerClosedAt`, never on `isPublished` or `listingStatus === 'DRAFT'`; `ebay-flat-file.routes.ts`
   (the surface that owns the real send, per `sheet-publish.service.ts:136`) contains no
   `isPublished` reference at all. So a restored "draft" listing can still be revised by the next
   stock or price sync. Matches `reference_ebay_draft_still_live`. **CODE-READ.**
3. **🔴 A dry-run publish stamps a FAKE ItemID onto the row and marks it ACTIVE.** The adapter's
   dry-run short-circuit returns `ok: true` with `listingId: 'dry-run-listing-…'`
   (`ebay-publish.adapter.ts:350-377`); the cockpit route then persists
   `externalListingId: result.listingId`, `isPublished: true`, `listingStatus: 'ACTIVE'`
   (`ebay-cockpit.routes.ts:1226-1234`). Two knock-ons: the drawer's success copy reads "The listing
   is now live" **regardless of mode** (`PublishDrawer.tsx:379-382`), and the studio's own liveness
   rule — "the channel has an id for it" (`channelActions.ts:117-120`) — would read a dry-run row as
   live. **CODE-READ.**
4. **The pre-publish snapshot is taken before the payload is validated.** `ebay-cockpit.routes.ts:1095-1103`
   writes the snapshot, then `:1114` and `:1127` return 409 for a missing category or price. Every
   blocked attempt therefore consumes one of the ten history slots (`:1094` `.slice(0, 10)`) and
   evicts the oldest real one. **CODE-READ.**
5. **The legacy restore neither bumps `version` nor drops `isPublished`.**
   `ebay-cockpit.routes.ts:1014-1023` writes `platformAttributes`/`priceOverride`/`quantity` and
   nothing else. `ChannelListing.version` exists (`schema.prisma:1646`); PES.5's own path increments
   it and its comment names the defect this avoids (`listing-snapshot.service.ts:239-243`: "Omitting
   it let a stale client's CAS succeed and undo the restore without a 409"). The legacy path has
   exactly that hole, and restores straight onto the live row. **CODE-READ.**
6. **Snapshots live inside the row they snapshot.** `platformAttributes._versionHistory` means every
   read of the listing carries up to ten full attribute bags, and a concurrent write to
   `platformAttributes` (the studio autosaves into that column) is a last-write-wins race against the
   history. The capped array also *silently* drops the eleventh (`:935`). **CODE-READ.**
7. **The history list is a prop, not a fetch.** `EbayCockpit.tsx:183-196` derives it from the SSR
   payload, so both drawers refresh via `router.refresh()` (`VersionHistoryDrawer.tsx:107,129`) — a
   full RSC round-trip of the whole cockpit to add one row. **CODE-READ.**
8. **Two sources of publish mode on one screen.** The drawer's badge fetches
   `/api/listings/publish-readiness` (`PublishModeBadge.tsx:27`) while the publish response carries
   the mode the gate actually used. They can disagree. **CODE-READ.**
9. **No field-level diff, no field-level restore.** `summarise()` (`VersionHistoryDrawer.tsx:56-77`)
   produces chips, not old→new. Restore is whole-record. Compare this with the master half, which
   already does per-field selection with server-graded coverage (`RestoreMode.tsx:93-108`). The
   research explicitly names field-level rollback as part of the doctrine
   (`channel-ops-research.md:85`). **CODE-READ.**
10. **The step list is fiction.** `PublishDrawer.tsx:108-130` invents per-step statuses from a single
    response field; a failure at `publishOffer` reports the first two steps as `done` whether or not
    they were. **CODE-READ.**
11. **Phase never resets across opens.** `useState` initialiser at `:82-84` runs once and `:164`
    returns `null` without unmounting, so a previous `success` (or `failure` with a stale
    `snapshotId`) is what the operator sees on reopen. The comment at `:93-95` asserts otherwise.
    **CODE-READ.**
12. **`hardFails` is a fresh array literal built inside JSX** (`EbayCockpit.tsx:774-794`) — a new
    prop identity on every cockpit render, and the drawer's initial phase depends on its length.
    **CODE-READ.**
13. **Zero tests on the PES.5 snapshot path.** No test file references `listing-snapshot`,
    `restoreToDraft` or `captureSnapshot` under `apps/api/src`. The coordinate-mismatch guard, the
    version increment and the transaction ordering are all untested. **CODE-READ.**
14. **N publish controls in one toolbar.** `ChannelSheet.tsx:1904-1914` renders one
    `AliasPublishControl` per alias in the `trailing` slot, each of which expands *in place* into a
    mode Pill, a summary line and up to five blocked-row rows when previewed. On a three-alias
    product the toolbar becomes the publish surface. **CODE-READ** — and this is the placement
    question the Owner asked.
15. **The old preflight is client-side and thinner than the server's.** Four checks
    (`EbayCockpit.tsx:780-792`) against the readiness service's per-field issue list
    (`sheet-publish.service.ts:81-93`). The old drawer could pass its own preflight and be refused by
    eBay. **CODE-READ.**
16. `PublishDrawer.tsx:380-382` tells the operator about "SP-API … eBay's indexer" — Amazon's API
    name on an eBay success screen. Cosmetic, but it is the sentence an operator reads at the moment
    they most need to trust the surface. **CODE-READ.**

## 6. Proposed home in the studio

### 6.1 Primary home + mirrors

**PRIMARY — H5, a `CONTEXT(alias-group)` verb `Publish this listing…` on the alias band.**
An eBay listing *is* an alias: one alias band, one ItemID, N child-SKU rows beneath it
(`AliasBandCell.tsx:52-83` already carries `listingStatus`, `externalListingId` and readiness for
exactly that object). Publish is not a row operation — publishing one child SKU of a variation
listing is not a thing eBay offers — and it is not a scope operation either, because a scope can hold
three aliases. The alias band is the only surface in the studio whose subject is the thing being
published, and the registry already has the axis for it (`contextOf('alias-group')`,
`registry.ts:33-42`). This also fixes defect 14: the verb moves out of the toolbar's `trailing` slot
and onto the band it belongs to, once per listing instead of N times in one strip.

**MIRROR — H10, the header `Publish ▾`.** It stays where the approved layout puts it and keeps
listing channels (`PublishMenu.tsx:38-69`), but each channel item now *opens the same drawer*
pre-scoped to that channel's aliases in the current market. It still sends nothing itself — the menu
is a router, and the one implementation of COLLECT→PREFLIGHT→CONFIRM→RUN lives behind it. This is the
ruling-#110 discipline: the drawer is never where the verb is born, and the header is never a second
send path.

**MIRROR — H3/H4, `Restore this listing…` as a registry verb** on the row context menu, the `⋯`
column, the selection bar and the drawer's action row. Research §3.2 is explicit that a verb must not
live only in the drawer (`channel-ops-research.md:96-99`). Scope is `CONTEXT(alias-group)` for the
same reason publish is; a `SELECTION` variant covers "restore these four listings to their
pre-14:02 state" after a bad broadcast.

**DEPTH — H7, a third mode in the drawer's History pane: `Publish history`.** The pane already owns
the mode switch (`HistoryPane.tsx:63-89`) and the Owner already ruled that record restore is *a mode,
not a fifth pane* (`RestoreMode.tsx:6`). Listing snapshots are the third question the same pane
answers — "what did we send, and when" — and they belong beside "what happened to this field" and
"what did the record look like". `RestoreMode.tsx:13-20` already draws the line between the two
mechanisms in prose; making it a third mode makes the line visible instead of only documented.

**QUEUE — H9, failed publishes land in the Errors & Sync console.** A publish that fails is a
`ChannelPublishAttempt` with `outcome: 'failed'` and an `errorCode`; that is queue-shaped and belongs
in the console the studio already has (`ErrorsSyncConsole.tsx`), grouped by cause, each row jumping
back to the alias band. A drawer cannot triage twenty failed pushes.

### 6.2 What the sheet shows at rest

- **Master scope:** nothing. Master has no publish target and `PublishMenu.tsx:98-100` already says
  so in the trigger's title. No column, no mark.
- **Channel scope, alias band (240px):** the band gains two marks beside the readiness pill —
  (a) a **publish state** word derived from the listing row: `Published 2h ago` / `Draft — not pushed`
  / `Never published`, three states not two (the `ListingsPane.tsx:105-121` rule: "Pushed to channel"
  and "Offer" are different facts and an operator acts differently on each); (b) a **snapshot glyph**
  `⟲ 4` when the listing has snapshots, which opens the drawer's Publish-history mode on that alias.
  A listing with zero snapshots shows no glyph — never `⟲ 0`, which reads as "we checked and there
  are none" when it may mean "capture has not run for this row".
- **Channel scope, variant rows:** nothing new. Publish is alias-level; a per-row publish column
  would invite the operation eBay does not support.
- **Status column (H2), off by default:** one derived read-only column `Last publish` (timestamp +
  mode + outcome, from `ChannelPublishAttempt`), filterable, so "which listings have never actually
  gone out" is answerable in the sheet. Off by default because it is a two-alias-wide fact rendered
  on N rows; available in the Customise dialog and in a `Never published` view preset.
- **Tooltips:** the band's single-sentence title (`bandTitle`, `AliasBandCell.tsx:65-83`) gains the
  publish state and the snapshot count — it is already the place everything the 240px band cannot
  show goes.

### 6.3 The interaction, step by step

**Publish.** Alias band `⋯` (or header `Publish ▾ → eBay · IT`, or the row context menu on a child)
→ `Publish this listing…`.

1. **COLLECT.** When the scope holds more than one alias and the operator came from the header, the
   verb's own picker runs first (#118): a `Listbox` of aliases with their readiness. One alias =
   skipped.
2. **PREFLIGHT.** `POST /api/products/sheet/publish-preview` with the alias's child-row ids — the
   call `AliasPublishControl.tsx:79` already makes. Its answer becomes `ActionImpact.findings[]`,
   which the registry designed for exactly this (`registry.ts:101-108`), and its `publishMode` sets
   `ActionImpact.level`: `confirm` for dry-run/sandbox, **`type-to-confirm` for `live`**. The confirm
   level comes from the preflight, never a fixed flag.
3. **CONFIRM.** A DS `Drawer` (`variant="modal"`, `width={640}`) with a DS `Stepper`
   (`components/Stepper.tsx:27-36`) across four steps — *Preflight · Payload · Send · Result*. The
   **Payload** step is the answer to note 3.14n: a `DataGrid` of every field that would be sent —
   field, value, source layer (`🔗` inherited / `✎` pinned / `✦` AI draft), and a `would be truncated`
   flag where the channel caps a length. This is the one thing the old confirm never showed
   (`PublishDrawer.tsx:284-291` showed six summary rows) and the one thing the parity note names.
   The mode `Banner` sits at the top of the drawer for the whole flow, carrying the **server's own
   words** — never a client guess.
4. **RUN.** For eBay, in the current gate state, there is no run: the drawer's Send step renders the
   server's `notSendable` sentence (`sheet-publish.service.ts:136`) as a `Banner tone="warning"`, and
   the step is marked **`refused by the platform gate`** — not `skipped`, not greyed. The button is
   present and disabled with that reason on it (`reference_disabled_control_cannot_explain`). When the
   Owner opens the gate, the same button posts to whichever route PES.5 exposes, and the drawer
   subscribes to the attempt rather than inventing step statuses (defect 10).
5. **REPAINT.** On a real send: the alias band's publish state and readiness pill, the `Last publish`
   column if shown, the drawer's Publish-history list (a new `pre-publish` snapshot row), and — on
   failure — a new row in the Errors & Sync console. The sheet's cells do not repaint: a publish reads
   the row, it does not write it.

**Restore.** Drawer → History → `Publish history` → pick a snapshot → the list expands into a
**field-level diff** (was → now, per field, from the two payloads) with a checkbox per field, the
same shape and the same honesty rules as `RestoreMode.tsx:93-108`: fields the server cannot grade are
listed **with the reason and not selectable**, never silently dropped. Then `DrawerConfirm` with
`acknowledge` (`RestoreMode.tsx:144`) whose body states the three true things and nothing more: the
listing row changes, the current state is captured first as `pre-restore`, and **the marketplace is
not touched** — eBay keeps serving what it last received. On confirm,
`POST /api/products/:id/listings/:listingId/snapshots/:snapshotId/restore`; the response's
`currentVersion` feeds the sheet's CAS token and `undoSnapshotId` becomes an `Undo this restore`
affordance in the pane.

**Keyboard.** The registry's surfaces already carry it: `⌥↓`/context-menu key on the band opens the
verb list, `Enter` runs, `Esc` cancels at every step. Inside the drawer, `Tab` walks the Stepper's
completed steps (`Stepper.onSelect` + `canSelect`, `Stepper.tsx:31-34`). No new global shortcut —
audit row 3.36 is a separate, unowned gap and a `Cmd+Shift+P` that fires an outward action is exactly
the reflex `ListingsPane.tsx:8-9` warns about.

**With the drawer open.** The publish drawer is `variant="modal"` deliberately — it is the one flow
in the studio where the sheet should *not* stay live, because a cell edit mid-publish changes what is
being sent after the operator has read the payload table. The record drawer is `dock` and stays
beside the sheet; opening the publish drawer overlays both, and closing it returns focus to the band
cell the verb was pressed on. The history *pane* is the opposite: it is inside the docked record
drawer, non-modal, and the sheet stays editable behind it.

### 6.4 Per-scope rules

- **Master scope:** no publish verb, no publish history. `RestoreMode`'s master restore stays exactly
  where it is and keeps its own copy — the two mechanisms must not converge on one label
  (`RestoreMode.tsx:11-23`).
- **Channel × market (eBay·IT, ·DE, …):** one verb per alias. A snapshot is bound to
  `(channel, marketplace, aliasKey)` and `restoreToDraft` already refuses a cross-coordinate landing
  (`listing-snapshot.service.ts:199-204`) — the UI must never offer a DE snapshot on the IT band, and
  the pane filters by `channelListingId` so it physically cannot.
- **Amazon vs eBay:** same verb, different Send step. Amazon has a dry-run and a send route
  (`publish-amazon`); eBay has neither from the sheet (`sheet-publish.service.ts:134-140`). The
  difference is the **server's sentence**, rendered, not a client branch.
- **Alias bands:** a multi-alias eBay product is the normal case (the shared-SKU model — the same
  child SKUs across N listings). Publishing alias ② must not touch ①, so the verb's row set is
  `variantRowsOf(rows, alias.id)` (`AliasPublishControl.tsx:72`) and the confirm names the alias mark.
- **Single-store channels (Shopify):** `aliasKey = ''`, one band, no COLLECT step. Snapshot storage
  is identical — `ChannelListingSnapshot.aliasKey @default("")` (`schema.prisma:1811-1812`).

### 6.5 Provenance / autosave / readiness / publish integration

- **Provenance survives a restore.** `overrideData` and `platformAttributes` are both in
  `SNAPSHOT_FIELDS` (`listing-snapshot.service.ts:71`), and the `follows*` booleans are too (`:73-74`),
  so a restored cell comes back with the same `🔗 inherited` / `✎ pinned` state it had. A restore that
  wrote values without the follow flags would silently *pin* every inherited cell.
- **Autosave.** A restore is a server-side write to the listing row, so the sheet must refetch, not
  merge — and it must do so **after** any in-flight autosave settles, or the pending PATCH lands on
  top of the restore (`reference_autosave_still_needs_a_nav_guard`; the studio has already been bitten
  by an in-flight autosave undoing an API revert). The restore's `currentVersion`
  (`listing-snapshot.service.ts:171`) is what the sheet's `expectedVersion` must be reset to; the
  server already emits `listing.updated` with `reason: 'snapshot-restore'` (`:272-279`) so the live
  refresh path exists.
- **Readiness.** One server definition (`services/pim/readiness.service.ts`) feeds the preflight, the
  band pill and the drawer — the preflight must not re-derive it. `AliasPublishControl.tsx:114-116`
  already handles the `unlisted` case by dropping the count rather than showing a count of rows in a
  listing that does not exist.
- **Publish integration.** Publish-time capture must move **into the publish path**, not the UI. The
  operator-facing consequence of getting this wrong is the whole feature: a history whose rows were
  written by a re-read rather than by the sender is a history that can lie about what went out
  (`listing-snapshot.service.ts:111-117` says this in the code and then nobody called it).

### 6.6 ASCII mockup — the alias band and the publish drawer

```
CHANNEL SHEET — eBay · IT                                    [Publish ▾]  autosave ✓
┌──────────────────────────────────────────────────────────────────────────────────┐
│ ▾ ① GALE Pro Racing Suit          ACTIVE 1103…  ⚠71% ▓▓▓▓▓░░  ⟲ 4   Published 2h │ alias band
│   │ ⋯ ┌──────────────────────────────────────┐                        ago · dry-run│
│   │   │ Publish this listing…            ⏎  │                                     │
│   │   │ Restore this listing…               │                                     │
│   │   │ Pause offer                          │                                     │
│   │   │ Broadcast field to listings…         │                                     │
│   │   └──────────────────────────────────────┘                                     │
│   ├ GALE-KAN-PRO-48   Giallo  48   €489.00   12   🔗 Kanguro   ⚠ GPSR              │
│   ├ GALE-KAN-PRO-50   Giallo  50   €489.00    3   ✎ pinned                          │
│ ▸ ② GALE Pro Racing Suit (shared)  DRAFT  1104…  ○—        —      Never published  │
└──────────────────────────────────────────────────────────────────────────────────┘

DRAWER (modal, 640px) — Publish ① to eBay · IT
 ⚠ platform mode: dry-run — a green result means "this would have worked", not "this is listed"
 ①Preflight ──── ②Payload ──── ③Send ──── ④Result
 ▸ 20 sendable · 0 blocked · 2 warned
   FIELD              VALUE                              SOURCE     NOTE
   Title              Tuta GALE Pro Racing Gialla         ✎ pinned   68/80 chars
   Category           Tute in pelle (57998)               ✎ pinned
   Colore             Giallo                              🔗 master
   GPSR responsible   —                                   —          ⚠ warned
 ③ Send  ⛔ refused by the platform gate — "eBay is preview-only from the sheet: its
    publish route updates an existing offer and has no dry run, so it cannot be rehearsed."
                                              [Cancel]  [Send 20 for real ⛔]
```

## 7. Contracts and data

**Reused unchanged:**
- `POST /api/products/sheet/publish-preview` (`products-sheet.routes.ts:113`) → the Preflight step.
  It already returns per-row verdicts, `publishMode` from the gates and `notSendable`.
- `GET  /api/products/:id/listings/:listingId/snapshots` (`product-studio.routes.ts:705`)
- `POST /api/products/:id/listings/:listingId/snapshots` (`:716`)
- `POST /api/products/:id/listings/:listingId/snapshots/:snapshotId/restore` (`:741`)
- `design-system/grid/actions/registry.ts` + `useActionPress` — no new confirm machinery.

**Server changes (PES.5):**
1. **Call `captureSnapshot` from the publish path**, with `reason: 'pre-publish'`, the payload that was
   actually sent, and `publishEventId` set to the `ChannelPublishAttempt.id` — the schema field exists
   for exactly this ("so the drawer can show 'the state sent at 14:02' rather than an anonymous list",
   `schema.prisma:1819-1820`). Capture **after** validation, so a 409 does not burn a slot (defect 4).
2. **A payload/diff endpoint:** `GET …/snapshots/:snapshotId?include=payload` (or
   `GET …/snapshots/:a/diff/:b`) returning per-field `was`/`now` with a server-graded coverage word,
   mirroring `GET /products/:id/state`'s `coverage` contract so the pane can reuse `RestoreMode`'s
   rendering rules rather than re-derive them client-side.
3. **A field-subset restore:** `POST …/restore` accepts an optional `fields: string[]` intersected with
   `SNAPSHOT_FIELDS`, so "restore the title only" is one write and the response's `fieldsWritten`
   (`listing-snapshot.service.ts:177`) stays the source of truth for what happened.
4. **Make `isPublished: false` mean something for eBay** (defect 2) — or change the restore to set
   `syncPaused = true`, which is the flag the eBay outbound path actually reads
   (`outbound-sync.service.ts:882, 1128`). One of the two must happen before any restore verb ships,
   because the doctrine's second clause is currently a comment rather than a guarantee.
5. **Stop persisting dry-run ids** (defect 3): the publish route must branch on the mode before
   writing `externalListingId` / `isPublished` / `listingStatus`.
6. **Tests** on the snapshot service: coordinate mismatch, version increment, transaction ordering,
   field-subset intersection (defect 13).

**Schema — additive only:** nothing new is needed. `ChannelListingSnapshot` already carries
`aliasKey`, `publishEventId`, `payload`, `label`, `capturedBy`, `restoredAt`/`restoredBy`. If the
`Last publish` column proves slow, an additive `ChannelListing.lastPublishedAt`/`lastPublishMode` pair
would denormalise it — but measure first.

**Lane ownership:**
- **PES.5** — items 1–6 above. The doctrine backend is theirs by ruling #110.
- **PES.3** — the `publishAlias` and `restoreListing` verbs in `channelActions.ts`, the alias band's
  publish-state + `⟲ n` marks in `AliasBandCell.tsx`, and **removing** `AliasPublishControl` from the
  toolbar's `trailing` slot (`ChannelSheet.tsx:1904-1914`).
- **PES.4** — the `Publish history` mode in `HistoryPane.tsx`, the field-level diff list, and the
  restore confirm. This is the pane ruling #110 dispatched to them and it is the piece that never landed.
- **PES.2** — the publish Drawer + Stepper shell as a grid-substrate flow host (so Amazon reuses it),
  and the `Last publish` status column renderer.
- **PES.1** — routing header `Publish ▾` items into the same verb instead of `disabled: true`.

## 8. Risks and traps

- **🔴 Every eBay·IT listing in the fixture family is LIVE.** 40 of 40 measured with a real ItemID
  (`channelActions.ts:15-21`), and a DRAFT row still carries one (`:112-118`,
  `reference_ebay_draft_still_live`). There is no safe fixture for a publish rehearsal. Anything built
  here ships preview-first, and "safe" means *verified no push path*, not *the status says DRAFT*.
- **🔴 Local dev writes the production database and hits the production API.** A restore executed
  from a local studio is a real restore on a real listing. Ruling #110 already gated this:
  "EXECUTING a restore against a live listing stays gated".
- **🔴 The gate is env-driven and the browser cannot know it.** `getEbayPublishMode()` reads
  `NEXUS_ENABLE_EBAY_PUBLISH` + `EBAY_PUBLISH_MODE` in the API process
  (`ebay-publish-gate.service.ts:30-46`). The production values are not measurable from here —
  **HYPOTHESIS** that eBay is `gated` or `dry-run` today; the surface must render the server's answer
  and never a default. `AliasPublishControl.tsx:10-15` already states this rule correctly.
- **Two permission namespaces for one feature** (§3): publish via `/api/ebay` needs `channels.sync`,
  restore via `/api/products` needs `products.edit`. A refusal message that names the wrong one
  teaches an operator something false about their own account
  (`reference_family_verbs_split_permissions`, and `channelActions.ts:43-71` is the pattern to copy —
  including the three-state `no-session` case, because local dev holds no API-origin cookie).
- **Untouchable:** the eBay flat-file editors keep the real send today
  (`sheet-publish.service.ts:136`). Do not propose changes inside `ebay-flat-file/**`; the studio
  routes *to* it or waits for PES.5 to expose a per-alias send.
- **Per-channel oversell:** the payload table shows `quantity` for one coordinate only. A quantity
  summed across channels is an oversell (`ListingsPane.tsx:141`), and eBay's is per-listing where
  Amazon EU's is shared per SKU.
- **Images are global per ASIN on Amazon** and per-ItemID on eBay; a publish payload table must not
  imply that restoring a snapshot restores images — `ProductImage` rows are not in `SNAPSHOT_FIELDS`.
  Say so in the confirm.
- **AI stays dark** (ruling #13). A `✦ AI draft` provenance mark may appear in the payload table as a
  *source*; nothing here generates.
- **The doctrine is novel.** No commerce comparable ships it and Akeneo removed theirs
  (`channel-ops-research.md:82-85`). There is no incumbent to copy, so the copy has to be exactly
  right — every sentence in the confirm is the only thing standing between the operator and a wrong
  belief about whether the marketplace changed.

## 9. Open questions for the Owner (max 3)

1. **Does the studio get a real eBay publish send at all, or does it stay preview-only and hand off?**
   Everything downstream depends on it: whether the drawer's Send step is a button or a refusal, and
   whether snapshot-on-publish can be a server fact for eBay at all (there is nothing to snapshot if
   the studio never sends). **Recommendation: stay preview-only for now, and build the drawer's Send
   step as the server's refusal rendered honestly.** Then make capture happen in the *flat-file* push
   path, so the history is real even while the studio does not send — which also gives the restore
   verb something to restore *to* on day one.
2. **Restore lands in DRAFT — but `isPublished = false` does not stop the eBay push (defect 2). Set
   `syncPaused = true` on restore instead, or fix `isPublished` to gate the push?**
   **Recommendation: set `syncPaused = true` as well as `isPublished = false`**, because `syncPaused`
   is the flag the outbound path already honours and it is reversible by an existing operator control;
   changing `isPublished`'s meaning would alter the behaviour of the Amazon EU shared-quantity guard
   that reads it (`outbound-sync.service.ts:989`).
3. **Field-level restore in wave 1, or whole-snapshot first?** The research says "consider" it
   (`channel-ops-research.md:104`); the master half already has it. **Recommendation: build the
   field-level diff VIEW in wave 1 and the whole-snapshot restore write only.** Seeing what changed is
   most of the value and carries no risk; the per-field write needs the server contract change (§7
   item 3) and can follow once the diff is on screen and being read.

## 10. Effort and dependencies

| piece | lane | effort | depends on |
|---|---|---|---|
| Capture-on-publish wired into the publish path + `publishEventId` | PES.5 | **M** | Q1 (which path sends) |
| Diff endpoint (per-field `was`/`now` + coverage) | PES.5 | **M** | — |
| Field-subset restore (`fields[]`) | PES.5 | **S** | Q3 |
| `syncPaused` / `isPublished` restore-safety fix | PES.5 | **S** | Q2 — **blocks any restore verb shipping** |
| Stop persisting dry-run ids (defect 3) | PES.5 | **S** | — |
| Tests on the snapshot service | PES.5 | **S** | — |
| `publishAlias` + `restoreListing` verbs in `channelActions.ts` | PES.3 | **M** | registry (done); the safety fix |
| Alias band publish-state + `⟲ n` mark | PES.3 | **S** | — |
| Remove `AliasPublishControl` from the toolbar `trailing` slot | PES.3 | **S** | the H5 verb landing first |
| Publish Drawer + Stepper flow host (payload table = the 3.14n gap) | PES.2 | **L** | the preview contract (done) |
| `Last publish` status column | PES.2 | **S** | `ChannelPublishAttempt` read (exists) |
| `Publish history` mode + field-level diff list + restore confirm | PES.4 | **L** | the diff endpoint |
| Header `Publish ▾` routes into the verb | PES.1 | **S** | the H5 verb |

**Cross-feature dependencies:** the readiness service (one definition, feeds preflight + band + pane);
the Errors & Sync console (failed attempts land there); the action registry and `useActionPress`
(both exist and are mutation-tested); PES.7's images lane (a payload table must be honest that images
are not part of a listing snapshot); and feature 05/whichever owns pull-from-channel — "what does the
channel actually hold" is the question a restore operator asks next, and 3.4 is the audit's second
triage priority right behind this one.
