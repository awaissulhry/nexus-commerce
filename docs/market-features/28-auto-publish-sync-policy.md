# 28 — Auto-publish-content toggle · SyncChannelPolicy · the outbound sync queue · Errors & Sync

## 1. What it is (operator terms)

Three levers and one queue, and today they live in three different places. **Auto-publish content**
is a per-listing opt-in: with it on, saving a title/description/image *anywhere* enqueues a
`FULL_SYNC` that an autopilot pushes to the channel within ~60s, so the operator never presses
Publish. **`ChannelListing.syncPaused`** is the per-listing kill switch, and
**`SyncChannelPolicy.pushesPaused`** is the same switch one level up, per channel × marketplace ×
connected account. Between the edit and the marketplace sits **`OutboundSyncQueue`** — 37,846 rows,
2,553 of them dead (measured on prod 2026-09-01, ruling #130) — with retries, deferrals, a
10-minute grace window and a dead-letter state. A merchandiser turning auto-publish on wants to know
what an edit will do before they make it; whoever is on support wants to know why 2,000 writes
failed and whether retrying them could possibly work. The studio has the console for the second
question and *nothing at all* for the first.

## 2. Old UI — inventory

**Entry point: the auto-publish pill on the channel tab.**
- State seeded from the listing's JSON bag, not a column:
  `apps/web/src/app/products/[id]/edit/tabs/ChannelListingTab.tsx:125-131` —
  `!!(listing?.platformAttributes as any)?._autoPublishContent`.
- The toggle: `ChannelListingTab.tsx:141-171`. Optimistic set, `PATCH` , revert on failure
  (`:168`), 1.5s "Saved" flash (`:163-164`). Round-trips to the server; nothing browser-local.
- Render: `ChannelListingTab.tsx:386-424` — a hand-rolled `<button>` with emerald/slate Tailwind, a
  `title=` tooltip that names the behaviour ("content changes (title, description) push to this
  channel automatically. Saves immediately on click"), and a bare `⚠` glyph carrying the error in a
  `title` (`:420-422`). The comment at `:132-140` records it as the *spec-permitted single-control
  exception* to the old page's explicit-save contract.

**🔴 The parity audit names the wrong route.** `docs/pes-parity-audit.md:124` (row 3.6) says
`PATCH .../listings/:channel/:marketplace`. The code calls
`PATCH /api/products/:id/auto-publish-content` with `{markets:[{channel,marketplace,enabled}]}`
(`ChannelListingTab.tsx:149-160`). CODE-READ; the audit row should be corrected.

**What is NOT on the old edit page at all:** `syncPaused` and `pushesPaused`. The old page's
Pause/Activate controls (`tabs/MasterDataTab.tsx:1252-1259,1282,1393-1399`) toggle **`offerActive`**
— market offer availability, a different field with a different meaning. The only UI for the two
real sync levers is outside the product entirely, at `/fulfillment/stock/sync-control`
(`SyncControlClient.tsx:353-390` for policies, `:234-286` for listing PAUSE/RESUME). There is also a
separate drift queue at `/fulfillment/stock/channel-drift` over `ChannelStockEvent`
(`ChannelDriftClient.tsx:139`).

**Dead / decorative:** nothing here is dead, but `images/autoPublishPrefs.ts:13`
(`nexus.images.autoPublish` localStorage, parity row 5.9) is a *different, browser-local*
auto-publish concept for image pushes and must not be conflated with this one.

## 3. Backend that exists

**Routes**
| method + path | file:line | notes |
|---|---|---|
| `PATCH /api/products/:id/auto-publish-content` | `apps/api/src/routes/marketplaces.routes.ts:293-329` | writes `platformAttributes._autoPublishContent`; one `findFirst` + one `update` **per market** (`:310-322`) — an N+1 over the `markets` array, and a read-modify-write of the whole JSON bag with no CAS |
| `POST /api/stock/sync-control/actions` (`PAUSE`/`RESUME`/`ZERO_PIN`) | `sync-control.routes.ts:893-950` | the only `syncPaused` writer; audits into `SyncControlAudit` |
| `PATCH /api/stock/sync-control/policies` | `sync-control.routes.ts:1090-1150` | the only `pushesPaused` writer |
| `GET /api/products/:id/sync-queue` | `product-studio.routes.ts` (`'/products/:id/sync-queue'`) → `services/pim/sync-queue.service.ts:155` | the studio console's read |
| `GET /api/outbound-queue` | `outbound-queue.routes.ts:37` | global monitor |
| `POST /api/outbound-queue/:id/retry` · `/cancel` | `outbound-queue.routes.ts:140-186` · `210-228` | resets `retryCount:0`, clears `isDead`, re-enqueues on BullMQ with a fresh jobId |
| `POST /api/outbound-queue/bulk-retry` · `bulk-cancel` | `:229-272` · `:275-292` | **unscoped when `ids` is omitted** — see §5 |
| `GET /api/listings/publish-readiness` | `listings-syndication.routes.ts:2639` | the mode the console already reads |

**Service — the enqueue.** `apps/api/src/services/content-auto-publish.service.ts`.
`enqueueContentSyncIfEnabled(listingIds)` (`:23-97`) filters on `_autoPublishContent` (`:55`),
`!l.isPublished` → skip (`:56`), and a three-channel allowlist `AMAZON|EBAY|SHOPIFY` (`:57`); builds
a `FULL_SYNC` with `payload {title, description, images, source:'CONTENT_AUTO_PUBLISH'}` (`:63-80`),
`maxRetries: 3`, and `holdUntil = now + 10min` described as a "10-min grace: batch rapid edits"
(`:79`); then `enqueueOutboundRowsInstant(..., {skipDuplicates:true})` (`:86-89`).
`enqueueContentSyncForProduct(productId)` (`:104-131`) additionally requires
`followMasterTitle !== false` (`:120`).

**Who calls it — this is the whole story for the studio.**
`amazon-flat-file.routes.ts:1593`, `ebay-flat-file.routes.ts:1129,1183`, and
`products-catalog.routes.ts:1433-1436` (`PATCH /api/products/:id`, **only** when `name` or
`description` is in the body). Nothing else. **`PATCH /api/products/bulk` — the studio's one
SheetWriter path (`useChannelSheet.ts:250`, `masterWrite.ts:123`) — never enqueues.** Verified
absence, independently, in `docs/pes-claims.md:7847` (#561 quoting #542(c)): "`products.routes.ts`
contains NO `outboundSyncQueue`/`enqueueSync`/`OutboundSync` reference — the bulk PATCH has no push
path, a verified absence". `product-studio.routes.ts` and `services/pim/sheet-rows.service.ts` have
no enqueue either (grep, CODE-READ).

**Prisma**
- `OutboundSyncQueue` — `packages/database/prisma/schema.prisma:6396-6453`. `syncStatus`,
  `payload`, `retryCount`/`maxRetries`, `nextRetryAt`, `holdUntil`, `isDead`/`diedAt`, `syncedAt`,
  `targetChannel`/`targetRegion`, `syncType`. Nine `@@index`, **no `@@unique`**.
- `SyncChannelPolicy` — `:16044-16064`. `pushesPaused`, `newListingDefaultMode` (`FOLLOW|PAUSED`),
  `newListingModeSetAt` (SC.5 cutoff), `channelConnectionId` (MAP.2a/b — without the account axis
  "pausing eBay would pause every eBay account at once"), unique on
  `(channel, marketplace, channelConnectionId)`.
- `ChannelListing` sync fields (`awk` over the model): `listingStatus`, `lastSyncedAt`,
  `lastSyncStatus`, `lastSyncError`, `syncRetryCount` (`:104-109`), `syncFromMaster`, `syncLocked`
  (`:113-115`), `isPublished` (`:119`), `offerActive` (`:124`), six `followMaster*` (`:128-142`),
  `syncPaused` (`:139`), `syncStatus`/`syncRetryLastAt` (`:162-163`), `syncAttempts` relation
  (`:199`), `version` (`:220`).
- `ChannelStockEvent` (`:4920+`) is the *inbound* drift lane; not this feature.

**Precedence, in one place.** `services/sync-control-core.ts:156` — policy `pushesPaused` →
`PAUSED via POLICY`; `:159` — listing `syncPaused` → `PAUSED via LISTING`. Policy wins.

**Dispatch gates.**
- Amazon (`outbound-sync.service.ts:857`): `syncPaused` at **`:882`**, `offerClosedAt` at **`:887`**,
  `pushesPaused` at **`:892`** — all three *before* any payload branch, "re-checked at send time so
  a pause set after enqueue still holds" (`:877-879`).
- eBay (`:1094`): `syncPaused` at **`:1128`** and `pushesPaused` at **`:1133`** — both **inside
  `if (payload.quantity !== undefined && product?.id)` (`:1113`)**. Then the publish-mode gate
  `getEbayPublishMode()` at `:1208-1216` and the dry-run short-circuit at `:1256-1281`.
- `computeFailureDisposition` (`:123-168`): circuit-open / rate-limit / revise-debounce are
  **deferrals** that do not consume retry budget (5m / 1m); auth-class defers 15m (`:147-151`);
  otherwise backoff `30s / 2m / 10m` (`:96`) and `MAX_RETRIES_EXCEEDED` at the cap (`:158-159`).
  Terminal rows are dead-lettered with `isDead`, `diedAt` and a `SYNC_DEAD` ProductEvent
  (`:2175-2190`).

**Jobs / crons.** `initializeSyncWorker()` runs **unconditionally**, no Redis needed
(`apps/api/src/index.ts:432-436`), scheduling `* * * * *` through `lib/cron/clustered.ts` — the
EV.4 per-tick Redis claim that **fails OPEN** if Redis is unreachable (`clustered.ts:26-30`).
`sync.worker.ts:50-110` holds a process-local `isProcessing` lock with a 5-minute stale-lock
force-reset (`:53-58`). When `ENABLE_QUEUE_WORKERS=1` the cron becomes a backstop that skips
BullMQ-owned rows (`buildBullMQSkip`, `:24-44`); the instant lane is
`services/outbound-enqueue.ts:41-71`, delay = `holdUntil − now`, `jobId = row.id`.

**Permissions** (`lib/auth/permissions-manifest.ts`, `pfx` = `startsWith`, `:33`, first-match-wins
`:402`): `/api/products` → `productsView` / `productsEdit` (`:412`) covers both
`auto-publish-content` and `sync-queue`; `/api/outbound` → `adminView` / **`syncManage`** (`:431`)
covers every retry/cancel; `/api/stock` → `inventoryView` / **`inventoryAdjust`** (`:298`) covers
PAUSE/RESUME and the policy write. 🔴 `lib/auth/rbac-hook.ts:29-31`: the mode is **`shadow` unless
`NEXUS_RBAC_MODE=enforce`** — the manifest logs, it does not deny.

## 4. Studio today

- **Errors & Sync exists and is good.** `_studio/channel-ops/ErrorsSyncTab.tsx:15-68` (scope →
  props, `jump` at `:39-45`), `ErrorsSyncConsole.tsx:88-372`, and 447 lines of tested pure logic in
  `syncQueue.ts`. Facets `Dead · Retrying · Stuck · All` as DS `FilterChip` (`:81-86`, `:203-213`);
  cause grouping with a message normaliser (`syncQueue.ts:193-226`); the server's authoritative
  cause rollup consumed rather than re-derived (`:129`, #357); `gateNote` refusing to imply a retry
  could work while the channel is `gated` (`:347-378`); the always-rendered coverage note
  (`ErrorsSyncConsole.tsx:361-369`, #131); `jumpTargetOf` returning **null** rather than guessing
  `primary` (`syncQueue.ts:396-401`, #143). Cause rows are the DS `PressableRow` (`:269-307`).
- **🔴 The console has NO verbs.** No retry, no cancel, no drop — `ErrorsSyncConsole.tsx` renders
  only the jump `Button variant="link"` (`:335-342`). Ruling **#127** approved the console *and*
  ruled "**Retry ships PREVIEW-FIRST** — it shows what would be re-sent and to which listing,
  behind a confirm" (`docs/pes-claims.md:19905-19909`); that half was never built, and #127 itself
  notes "`RecordActions` has never rendered on screen because PES.3 has declared no verbs yet".
- **Auto-publish has no studio equivalent at all.** `docs/pes-parity-audit.md:124` row 3.6: "🕳 —
  auto-publish-content toggle has no studio equivalent." Grep of `_studio/**` for
  `autoPublishContent`: zero hits outside the images lane's unrelated localStorage prefs.
- **The wire is one field short in three places.** `SheetListing`
  (`services/pim/studio-sheet.service.ts:1277-1296`) already carries `version`, `listingStatus`,
  `isPublished`, `offerActive`, `lastSyncedAt` and the six `follows` flags — but **not `syncPaused`
  and not `_autoPublishContent`**. `AliasGroup` (`:244-256`) carries `isPublished`, not `syncPaused`.
- **Verbs today:** `sheet/channel/channelActions.ts:162` `offer-toggle` (ROW, writes `offerActive`),
  `:308` `broadcast-to-listings` (SELECTION), `:380` `open-record` (ROW). The wave-1 convention is
  set at `:258-262` and `:277-280`: a live listing is *named in the impact* and then **refused in
  `run`** — "wave-1 channel verbs are preview-only".
- **The band row can carry a column.** `columns/spanRow.ts:58-64` computes the span **within the
  cell's pinned section only** ("a span cannot cross AG's pinned boundary", ruling #67), and the
  identity column is pinned (`ChannelSheet.tsx:1569-1584`). So unpinned columns *do* render their
  own cell on the `rowKind:'parent'` band row, and `sheet/channel/rows.ts:173` states it outright:
  "the alias-level row IS the group node — it carries the listing's own values."
- **The pre-edit warning already exists.** `rows.ts:113` (`channelWriteGate` → `'acknowledge'`),
  `:357-369` (`cellHoverNote`), `:371-383` (`crossChannelColumnCount`), ack flow
  `ChannelSheet.tsx:531-560` — ruling **#58**, BINDING.
- Report 11 §6 binds the realtime half: primary **H2** mark + the one `SheetFooterNote` slot,
  mirror **H9** for a live count, ONE stream (§6.7 budget, ruling #602), and gate the SSE routes
  before widening the bus (§8 risk 1).

## 5. Defects and slowness

1. **🔴 The studio's autosave cannot trigger auto-publish, at all.** `PATCH /api/products/bulk` has
   no enqueue path (CODE-READ + the independent verified absence at `docs/pes-claims.md:7847`).
   Rebuild the toggle as-is and it is a switch wired to nothing: the operator turns it on, edits a
   title in the sheet, and nothing is ever pushed. **This is the single most important fact in this
   report.**
2. **🔴 eBay's pause is not honoured for content pushes.** The `syncPaused` and `pushesPaused`
   checks sit inside `if (payload.quantity !== undefined …)` (`outbound-sync.service.ts:1113`,
   `:1128`, `:1133`), and `enqueueContentSyncIfEnabled` builds a payload with **no `quantity`**
   (`content-auto-publish.service.ts:70-75`). So a content `FULL_SYNC` on eBay passes both pause
   gates and reaches the mode gate. Amazon checks all three unconditionally (`:882/:887/:892`).
   CODE-READ, not run — but the asymmetry is on the page and the Amazon lane is the proof of what
   "correct" looks like. **This answers report 06's finding precisely: the eBay push does gate on
   `syncPaused` rather than `isPublished` — but only on the quantity branch.** `isPublished` gates
   at *enqueue* instead (`content-auto-publish.service.ts:56`), which is why the two reports appear
   to disagree: they are describing two different points in the pipeline.
3. **🔴 `skipDuplicates: true` is a no-op.** `OutboundSyncQueue` has no `@@unique`
   (`schema.prisma:6447-6452`; no unique index in any migration). `createMany`'s `skipDuplicates`
   only suppresses rows that violate a unique constraint, so N rapid edits produce N `FULL_SYNC`
   rows, each with its own 10-minute hold — the comment "10-min grace: batch rapid edits"
   (`content-auto-publish.service.ts:79`) describes batching that does not happen. CODE-READ.
4. **🔴 `bulk-cancel` and `bulk-retry` are unscoped by default.** With no `ids` and no `channel`,
   `bulk-cancel` cancels **every** `PENDING`/`IN_PROGRESS` row in the table
   (`outbound-queue.routes.ts:279-286`) and `bulk-retry` re-enqueues **every** `FAILED`/`isDead`
   row (`:236-243`) — 2,553 dead writes, on a route whose only gate is `syncManage` in a manifest
   running in shadow mode. If the studio's Retry/Drop verbs are wired to these, they must always
   send explicit `ids`.
5. **A dead letter is invisible in real time.** `SYNC_DEAD` is a ProductEvent, and
   `product-event.service.ts:96-119` returns `null` for any non-`Product` aggregate and falls into
   `default: return null` for `SYNC_DEAD` — asserted by
   `services/__tests__/product-event-sse.test.ts:108-116`. It is not in
   `LISTING_BUS_TYPES_LIST` (`listing-events.service.ts:101-105`) either.
6. **`listing.synced` / `listing.syncing` are not raised by the autopilot.** Their only publishers
   are `listings-syndication.routes.ts:3122,3161,3183,3214` — the *manual* resync route. Grep of
   `outbound-sync.service.ts`, `workers/bullmq-sync.worker.ts` and `workers/sync.worker.ts` for
   `publishListingEvent`: zero hits. So an auto-published push emits no event on either end.
7. **`SyncAttempt` and `ChannelListing.lastSyncStatus` are not written by the queue drain.**
   `SyncAttempt` is written only at `listings-syndication.routes.ts:3102,3156,3178,3205`;
   `lastSyncStatus` only by `channel-sync.worker.ts:214,245`, `ads-sync.worker.ts:263`,
   `ebay-status-reconcile.job.ts:227`, `marketplaces.ts:268,313,476`, `sync-control.routes.ts:941`.
   **Consequence for the design: `OutboundSyncQueue` is the only faithful per-row sync-state source
   in the system.** A column reading `ChannelListing.syncStatus` would be reporting a field nothing
   on this path maintains.
8. **PAUSE silently skips FBA.** `sync-control.routes.ts:904-908` excludes FBA rows fail-closed and
   reports `result.skippedFba`. A studio pause lever that does not render that number lies on every
   Amazon FBA listing.
9. **A market-scoped queue read can drop rows.** `sync-queue.service.ts:198` filters
   `targetRegion: input.marketplace`, and `targetRegion` is written as `l.region ?? l.marketplace ??
   undefined` (`content-auto-publish.service.ts:67`) — a row whose listing had neither falls out of
   every market-scoped view *and* out of the coverage note's arithmetic. HYPOTHESIS (needs a count).
10. **`content-auto-publish.service.ts` has zero tests** (no `*.test.ts` / `*.vitest.test.ts`
    references it). Every failure mode is swallowed as non-fatal (`:92-96`, `:125-130`).
11. **`_autoPublishContent` is a JSON key, not a column.** The write is a read-modify-write of the
    whole `platformAttributes` bag with no CAS (`marketplaces.routes.ts:315-321`), so a concurrent
    write to any other key in that bag loses one of them. It also means the flag cannot be filtered,
    indexed, or written by `PATCH /api/products/bulk`, whose channel writer accepts exactly the 7
    mapped columns in `CHANNEL_FIELD_MAP` plus the `attr_*` bag
    (`services/pim/channel-field-map.ts:22-36`, `:60-61`).
12. Old-UI slowness: `ChannelListingTab.tsx:141-171` fires one request per market with no batching
    and a `window.setTimeout` flash that races unmount (`:163`). Superseded by the rebuild.

## 6. Proposed home in the studio

### 6.1 Primary home + mirrors

**H1 — "Auto-publish content" as a boolean cell on the ALIAS BAND row.** It is a per-listing value
the operator edits, which is the definition of H1, and the band row is the only row in the sheet
whose subject *is* the listing. Because `bandColSpan` spans only within the pinned section
(`spanRow.ts:58-64`), an unpinned listing-level column renders its own cell on the band and can be
edited there while showing an inherited-locked mark on every variant row beneath. This also settles
the Owner's framing question for this feature: it does **not** go in a toolbar and it does **not**
go beside the description cell — a listing-level policy belongs on the listing's own row, in a
column, next to the other listing-level facts (`listingStatus`, publish control) the band already
carries. Its tooltip must name the policy chain, because the flag alone does not decide anything:
*"Auto-publish is ON. A saved content change enqueues a push. Pushes are currently PAUSED for this
listing (Sync Control) — nothing will be sent."*

**H2 — a "Sync" status column, per row, on channel scopes only.** `queued · sent · failed · dead`
plus a `last sent` relative time. H2 is right because this is a fact the pipeline reports, not a
value anyone edits, and it must filter and sort. The precedent is already in the repo: the /products
grid has exactly this rollup with exactly this precedence — `dead > failed > pending > synced`, and
`syncedAt` = the most recent *successful* row — pinned by
`apps/api/src/routes/__tests__/products-sync-queue-rollup.test.ts:1-40`. Reuse that fold, keyed by
`channelListingId` instead of `productId`. Per §5.7 it must be computed from `OutboundSyncQueue`,
never from `ChannelListing.syncStatus`.

**H9 — Errors & Sync stays the queue's home, and gains the verbs it was approved with.** A queue
must never be inline-only (channel-ops research §3, "universal across all eleven platforms"), and
the console already does the hard part — grouping by cause. It gains: **H3 `retry-write` (ROW)**,
**H4 the same on a selection**, **H3 `drop-write`**, and it keeps the existing jump. Per **#127**
Retry is **preview-first**: the preflight names each listing and each `syncType` that would be
re-sent, and per the wave-1 convention (`channelActions.ts:277-280`) `run` is **refused on a live
listing** until the Owner lifts wave-1. `drop-write` maps to `POST /api/outbound-queue/:id/cancel`
with explicit ids, never the unscoped bulk route (§5.4).

**H5 — the pause/activate lever, as a `CONTEXT(alias-group)` verb on the band.** *This is where the
pause belongs.* `syncPaused` is per-listing, so its scope is the alias group, and it is a verb (a
state change with consequences and a confirm), not a cell — the same shape as the existing
`offer-toggle`, which it must sit beside without being confused for it. Its preflight must state
which of the three levers is actually in force, using the server's own precedence
(`sync-control-core.ts:156-159`: policy beats listing), and must render `skippedFba` (§5.8).
`pushesPaused` is **H11 — it stays at `/fulfillment/stock/sync-control`**: it is account- and
channel-level config with its own audit trail, `newListingDefaultMode` and a MAP.2b account axis,
and duplicating that in a product page would be a second writer to a global switch. The studio
*reads* it and says so.

**H7 — the drawer's Listings pane gains a Sync section.** Depth for one listing: the three levers
with their provenance, `lastSyncedAt` (already on the wire,
`studio-sheet.service.ts:1288-1293`), the last few queue rows with their verbatim messages, and the
10-minute grace window with a **Cancel** while it is still open. Non-modal, so the sheet keeps
receiving events while it is read.

**H12 — drop the old pill's shape.** The emerald/slate hand-rolled button and the `title`-only error
glyph do not survive; the capability does.

### 6.2 What the sheet shows at rest, per scope

| scope | at rest |
|---|---|
| **master** | **nothing.** Master has no listings, no queue and no policy. The Errors & Sync tab is already hidden on master (`ErrorsSyncTab.tsx:49-55`, `visibleTabs()`); the Auto-publish and Sync columns are absent from the master column set for the same reason. |
| **channel × market** | Band row: the `Auto-publish content` checkbox cell + the Sync column's roll-up for that listing. Variant rows: an inherited-locked mark in the Auto-publish column (tooltip: "set on the listing"), and their own Sync value. A paused listing draws a `⏸` in the Sync column's mark lane with the *reason* in the tooltip ("paused on this listing" / "paused for eBay·IT by policy"). A `gated` channel draws nothing per-row — it is a scope fact and belongs in the existing `gateNote` sentence. |
| **alias band, multi-alias** | one Auto-publish cell **per band** — the flag is per `ChannelListing`, so two aliases can legitimately disagree, and a single product-level control would be wrong. |
| **stream down** | the Sync column's last-known value plus report 11's `Reconnecting` Pill; the column must never claim freshness the pipe cannot deliver. |

### 6.3 The interaction, step by step

**A. Turning auto-publish on.** Click/Space the band cell → the substrate's `writeGate` runs. The
flag is listing-level and touches no other channel, so **no `affectsAllChannels` acknowledgement**
applies (`rows.ts:113` — keyed on the flag, not on the verb, per #58). The write goes to
`PATCH /api/products/:id/auto-publish-content` — *not* to the SheetWriter, because
`CHANNEL_FIELD_MAP` cannot route it (§5.11) — and reports through the same `useSaveReporter`
subject as every other cell so the header's `autosave ✓` covers it. On success the cell repaints and
the Sync column's tooltip changes to include "auto-publish is on".

**B. What an autosaved cell edit does when auto-publish is ON — and what the sheet owes the operator
first.** This is the crux, and it needs a server change (§7 item 1) to be true at all.
1. **BEFORE the edit lands** the cell already tells the operator where the write goes, via
   `cellHoverNote` (`rows.ts:357-369`) and the toolbar's standing "33 of 35 columns write the shared
   master record" notice (`crossChannelColumnCount`, `:371-383`). With auto-publish on, that
   sentence must gain a second clause: *"Editing this on eBay·IT changes the shared master record —
   every channel sees it — **and auto-publish will send it to 3 listings**."* An
   `affectsAllChannels` column plus auto-publish on N listings is a fan-out the operator cannot see
   from the cell, and it is the same class of surprise as Amazon's shared EU quantity.
2. **The edit autosaves** through the one SheetWriter with `expectedVersion` — unchanged.
3. **The server enqueues** only for listings whose flag is on, only for content fields, with the
   existing 10-minute `holdUntil`. It does **not** publish; it queues.
4. **The sheet repaints** the Sync column for the affected rows to `queued · sends in 9:52` and the
   footer's one note slot states the page-level fact — the *same slot* report 11 §6.1 uses, one
   occupant at a time.
5. **A preflight, not a preview.** Enqueue is cheap and reversible for ten minutes; a modal on every
   keystroke would be intolerable. So the honest design is: **enqueue quietly, but never send
   silently** — the grace window is the confirm, surfaced as `queued · sends in 9:52` with an
   **Undo** in the footer note and in the drawer's Sync section, backed by
   `POST /api/outbound-queue/:id/cancel`. If the Owner wants a hard confirm instead, it must be a
   *scope-level* arm/disarm, never per cell.
6. **When the mode is `gated` or `dry-run`** the Sync column must say so rather than showing
   `queued` — `gateNote` (`syncQueue.ts:347-378`) already has the exact sentences; reuse them, do
   not rewrite them.
7. **Keyboard.** Space toggles the band checkbox; the Sync column is read-only and never a tab stop
   (its mark is a `Tooltip`). Retry/Drop reach the keyboard through the row context menu, as every
   registry verb does.
8. **With the drawer open.** Non-modal; the drawer's Sync section repaints from the same event, and
   an in-flight autosave is never repainted over (report 11 §6.3 step 3).

DS components: `Checkbox` (band cell), `Tooltip`, `Pill`, `FilterChip` (console facets, already),
`PressableRow` (already), `Button variant="link"`, `ActionConfirm` via `useActionPress`, plus one new
`GridSheetNote` kind — the same slot report 11 asks for, so the two must agree on one occupant.
**No new DS component is needed.**

### 6.4 Per-scope rules

- **Master**: no columns, no verbs, no console. Non-negotiable — the tab is already hidden.
- **Channel × market (eBay, Amazon)**: everything above. `pushesPaused` is looked up per
  `(channel, marketplace, channelConnectionId)`; the *account* axis matters (MAP.2b) and a lever
  that ignores it would report the wrong pause on a multi-account tenant.
- **Amazon FBA rows**: the pause verb must render `skippedFba` and refuse rather than appear to work.
- **Amazon EU shared quantity**: a content push is per-marketplace, but if a `FULL_SYNC` ever
  carries a quantity it fans out across DE/FR/ES/IT. The Sync column must not imply the change was
  scoped to the market in view.
- **Single-store channels (Shopify)**: `marketplace: 'GLOBAL'`, one band. Ruling #127 measured
  Shopify to **zero** across the whole catalogue (0 products with `SHOPIFY` in `syncChannels`, 0
  `shopifyProductId`, `publish-readiness` → `{enabled:false, mode:'gated'}`), so the Shopify column
  renders `—` and says why; it does not render a plausible-looking `queued`.
- **A listing with no `ChannelListing` row**: no flag to set. The cell is disabled with the reason,
  the same way `offer-toggle` refuses (`channelActions.ts:197-200`) — the toggle must never
  side-effect a DRAFT listing into existence.

### 6.5 Provenance / autosave / readiness / publish

- **Provenance** is untouched. Auto-publish is a listing *policy*, not a value with layers, so its
  cell carries **no** `🔗 inherited / ✎ pinned` mark on the band; the variant rows' lock mark is a
  *scope* statement ("this is set on the listing"), rendered distinctly from a provenance mark.
- **Autosave**: the flag persists immediately, like every other cell — the old page's "spec-permitted
  single-control exception" (`ChannelListingTab.tsx:132-140`) dissolves, because in the studio every
  cell already autosaves. It reports through the same reporter subject so the header cannot show
  `autosave ✓` while this write is in flight.
- **Readiness** is unaffected: readiness is one server definition
  (`services/pim/readiness.service.ts`) about *field completeness*. A dead sync row is not an
  incomplete field and must not move a readiness percentage — but it **must** show in the scope
  tab's alarm count via the console's existing `'errors'` chip (#131).
- **Publish**: auto-publish is the *implicit* path and the header `Publish ▾` is the explicit one.
  They must never contradict each other, so both read the same mode from
  `GET /api/listings/publish-readiness` and the same `gateNote` sentences. eBay stays preview-only;
  nothing in this feature sends anything new.

### 6.6 ASCII mockup

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ ‹ Products  GALE Pro Racing Suit · GALE-KAN-PRO · ● Active     autosave ✓  [Publish ▾]│
├──────────────────────────────────────────────────────────────────────────────────────┤
│ SCOPE [Master 96%][Amazon ●92%][eBay ⚠71%]  Sheet·Images·Analytics·Activity·Errors&Sync ③│
├──────────────────────────────────────────────────────────────────────────────────────┤
│ 21 rows · 1 selected [View ▾][Missing required (7)]  Find…      [Customise][Reload]  │
├───────────────────────────────┬──────────┬──────────────────────┬────────────────────┤
│  IDENTITY (pinned)            │ Auto-pub │ Sync                 │ Title              │
├───────────────────────────────┼──────────┼──────────────────────┼────────────────────┤
│ ▾ P ① Primary · ACTIVE · 85%  │   [✓]    │ ⏸ paused (listing)   │ GALE Pro Racing …  │
│     GALE-KAN-PRO-BLK-M        │   ᴵ ✓    │ ● queued · sends 9:52│ GALE Pro Racing …  │
│     GALE-KAN-PRO-BLK-L        │   ᴵ ✓    │ ✓ sent · 4h ago      │ GALE Pro Racing …  │
│     GALE-KAN-PRO-RED-M        │   ᴵ ✓    │ ✖ dead · gave up ×3  │ GALE Pro Racing …  │
│ ▸ P ② Trade listing · DRAFT   │   [ ]    │ — never sent         │ GALE Pro Racing …  │
├───────────────────────────────┴──────────┴──────────────────────┴────────────────────┤
│ 21 rows · autosave ✓ · 1 push queued for eBay·IT — sends in 9:52 · [Undo] · Enter to edit│
└──────────────────────────────────────────────────────────────────────────────────────┘
   band cell tooltip: "Auto-publish ON. Pushes are PAUSED for this listing (Sync Control)
                       — a saved change will queue and will not be sent. eBay·IT policy: active."
   ᴵ = set on the listing (locked here)      Errors&Sync ③ = 3 causes need someone
```

## 7. Contracts and data

**Reused unchanged:** `GET /api/products/:id/sync-queue` + `services/pim/sync-queue.service.ts`;
`GET /api/listings/publish-readiness`; `POST /api/outbound-queue/:id/retry` and `/cancel`;
`PATCH /api/products/:id/auto-publish-content`; `POST /api/stock/sync-control/actions`;
`PATCH /api/products/bulk`; the action registry; `syncQueue.ts` whole.

**Server changes — all additive.**
1. **🔴 PES.5 — enqueue from the studio's write path.** `PATCH /api/products/bulk` calls
   `enqueueContentSyncIfEnabled(listingIds)` for the content columns it just wrote, per affected
   listing. Without this the whole feature is decorative (§5.1). Producer and consumer land
   together: the response must return what it enqueued so the Sync column can repaint from the
   write instead of re-reading.
2. **🔴 PES.5 — hoist eBay's pause gate out of the quantity branch** (`outbound-sync.service.ts:1113`
   → before it, mirroring Amazon's `:882-895`), and add the missing `offerClosedAt` check. Fix
   before item 1, or item 1 ships a push that ignores the pause.
3. **PES.5 — `syncPaused` and `autoPublishContent` on the wire.** Add both to `SheetListing`
   (`studio-sheet.service.ts:1277-1296`) and `syncPaused` + the resolved
   `pausedVia: 'POLICY'|'LISTING'|null` to `AliasGroup` (`:244-256`). Derive `pausedVia` from
   `sync-control-core.ts:156-159` — do not re-derive the precedence client-side.
4. **PES.5 — a per-listing sync rollup.** Extend the sheet response with
   `{queued, failed, dead, syncedAt, mostUrgentStatus}` per listing, lifting the fold from
   `__tests__/products-sync-queue-rollup.test.ts` into a shared helper (the test's own header asks
   for exactly that extraction) so the /products grid and the studio cannot drift.
5. **PES.5 — a unique index + a real batch.** `@@unique([channelListingId, syncType, syncStatus])`
   (or an explicit "supersede the pending row" upsert) so `skipDuplicates` means something and 20
   keystrokes do not become 20 pushes (§5.3). Additive, pre-approved class of migration.
6. **PES.5 — the bus, riding report 11's widening, not a second front.** Add
   `sync.queued` / `sync.failed` / `sync.dead` to `LISTING_BUS_TYPES_LIST`
   (`listing-events.service.ts:101-105`) in the *same* change as report 11 §7 item 1, map
   `SYNC_DEAD` in `ssePayloadFor` (`product-event.service.ts:96-119`), and publish from the drain
   (`outbound-sync.service.ts:2175-2190`). Consumed over **the one pipe at `contracts.tsx:494`** —
   ruling #602's socket budget, report 11 §6.7. **Blocked on report 11 §8 risk 1: gate both SSE
   routes first.**
7. **PES.5 — write the flag properly.** Either promote `_autoPublishContent` to a
   `ChannelListing.autoPublishContent` column (filterable, indexable, CAS-able) or give the existing
   route `expectedVersion`. The JSON-bag read-modify-write (§5.11) is a lost-update waiting to
   happen the moment a second surface writes `platformAttributes`.
8. **PES.5 — tests for `content-auto-publish.service.ts`** (currently zero, §5.10), including one
   that fails if the eBay pause gate moves back inside a payload branch.

**Lane ownership.** PES.5: all eight server items. PES.3: the console's Retry/Drop verbs, the
preview-first preflight, the live count. PES.2: the boolean band cell + the Sync status column in
the grid substrate, the band-row lock mark, the `GridSheetNote` occupant (coordinated with report
11). PES.4: the drawer's Sync section and the grace-window Undo. PES.1: nothing beyond the footer
slot it already owns.

## 8. Risks and traps

1. **🔴 This feature's whole purpose is to make writes leave the building.** Every other studio verb
   is wave-1 preview-only (`channelActions.ts:277-280`); auto-publish is the one capability whose
   *point* is an unattended push. It must not go live before item 2 of §7, and the Owner should
   arm it per channel, not globally.
2. **🔴 Local dev writes PROD** and `initializeSyncWorker()` runs unconditionally with no Redis
   (`index.ts:432-436`) — a local API is a **second autopilot draining the production queue** every
   minute. `clustered.ts` fails OPEN when Redis is unreachable (`:26-30`), so the cluster lock does
   not save you. Any verification of this feature runs with `NEXUS_DISABLE_BACKGROUND_JOBS=1`.
3. **🔴 Every eBay listing in the fixture family is LIVE** — 40 eBay·IT listings across
   GALE/AIREON/MISANO/XRI01 are `ACTIVE`, `isPublished: true`, with real ItemIDs, and even the 20
   `DRAFT` rows carry real ItemIDs (`docs/pes-parity-audit.md:589-595`). There is no inert target
   for a retry rehearsal. Any exercise of Retry must be preview-only or use `mode: 'dry-run'` and
   read the queue row, not the response.
4. **A retry against a `gated` channel is theatre.** 368 rows already carry
   `NEXUS_ENABLE_*_PUBLISH=false` verbatim (`syncQueue.ts:170-180`). `gateNote` says this; the
   Retry verb's `available()` must **disable** on `gated`, not just warn.
5. **The unscoped bulk routes** (§5.4) are one careless `fetch` away from cancelling the whole
   production queue. Always send `ids`.
6. **Three pauses and an `isPublished`, all called "pause".** `offerActive` (buyability),
   `syncPaused` (listing pushes), `pushesPaused` (channel×market×account pushes), `isPublished`
   (enqueue-time gate), `offerClosedAt` (Amazon terminal). The UI must name which one it is
   changing, every time. The old page conflated the first with the rest and had no lever for the
   others.
7. **A `queued` chip is not a `sent` chip.** With `mode: 'dry-run'` a write "succeeds" without
   touching the listing (`outbound-sync.service.ts:1256-1281`). The Sync column must never render
   `sent` for a dry-run outcome — 100%-honest-UI.
8. **Untouchables.** The flat-file editors are the *existing* callers of
   `enqueueContentSyncIfEnabled` (`amazon-flat-file.routes.ts:1593`,
   `ebay-flat-file.routes.ts:1129,1183`). Do not touch those call sites; add the studio's alongside.
   FBA quantity logic is untouched — hence risk in §5.8 being surfaced rather than worked around.
9. **AI stays dark.** An approved AI draft replays through `PATCH /api/products/bulk`
   (`_studio/ai/api.ts:67`), so after §7 item 1 an AI approval becomes a **channel push**. That is a
   material change and the Owner should rule on it explicitly rather than inherit it.
10. **`nextRetryAt` must be read `> now()`, never `IS NOT NULL`** — 2,494 of 2,553 dead rows carry a
    past one (`syncQueue.ts:78-85`). If it is ever rendered, the honest label is "retry window
    passed".
11. **RBAC is in shadow mode** (`rbac-hook.ts:29-31`). A disabled Retry button is currently the only
    thing standing between an operator without `syncManage` and the queue.

## 9. Open questions for the Owner (max 3)

1. **Does an autosaved cell edit with auto-publish ON enqueue silently, or ask first?**
   *Recommend: enqueue silently, never send silently.* The 10-minute `holdUntil` already in the
   service is the confirm — surfaced as `queued · sends in 9:52` with an Undo in the footer and the
   drawer. A modal per keystroke is unusable, and a silent send is the dishonest-UI failure. If you
   want a hard gate, make it a scope-level arm/disarm, not a per-cell confirm.
2. **Do we go live with auto-publish at all in wave 1, or ship the toggle honest-but-inert?**
   *Recommend: build the surface, land §7 items 1–5, and keep the ENQUEUE live while the SEND stays
   behind the existing publish-mode gate.* The queue becomes visibly correct, the operator sees
   exactly what would go, and no unattended write reaches a live listing until you flip
   `NEXUS_ENABLE_*_PUBLISH` — which is a lever you already own.
3. **Where does the listing pause live — a verb on the band, or a cell?** *Recommend: a
   `CONTEXT(alias-group)` verb beside `offer-toggle`.* It has consequences, needs a confirm that
   names which of the three levers is in force, and must report `skippedFba`; a checkbox cell can
   carry none of that. `pushesPaused` stays at `/fulfillment/stock/sync-control` and the studio
   only reads it.

## 10. Effort and dependencies

| piece | lane | effort |
|---|---|---|
| Hoist eBay's pause gate out of the quantity branch (+ `offerClosedAt`) | PES.5 | **S** — do first, independent bug fix |
| Enqueue from `PATCH /api/products/bulk` (+ what-was-enqueued in the response) | PES.5 | **M** |
| `syncPaused` / `autoPublishContent` / `pausedVia` on the wire | PES.5 | **S** |
| Per-listing sync rollup + extract the shared fold | PES.5 | **M** |
| Unique index / supersede-pending + `skipDuplicates` made real | PES.5 | **S** (additive migration) |
| Promote `_autoPublishContent` to a column (or add `expectedVersion`) | PES.5 | **S** |
| Tests for `content-auto-publish.service.ts` | PES.5 | **S** |
| Boolean band cell + inherited-lock mark on variants | PES.2 | **M** |
| Sync status column (renderer, mark, tooltip, filter) | PES.2 | **M** |
| Footer `GridSheetNote` occupant + Undo action | PES.2 (with PES.1's slot) | **S** |
| Console Retry / Drop verbs, preview-first per #127 | PES.3 | **M** |
| Pause/activate `CONTEXT(alias-group)` verb with `skippedFba` | PES.3 | **M** |
| Drawer Sync section + grace-window cancel | PES.4 | **M** |
| `sync.*` on the listing bus + `SYNC_DEAD` SSE mapping | PES.5 | **M** (blocked on SSE auth) |

**Dependencies.** **Report 11** owns the bus widening, the one-stream budget and the footer note
slot — land the bus once, in their change, with `sync.*` riding along; and their §8 risk 1 (gate
both SSE routes) blocks the event half of this feature. **Report 06** (publish snapshot/restore)
shares the `syncPaused`-vs-`isPublished` finding and the same `gateNote` sentences. **Report 16**
(Amazon preflight/publish) is the explicit path this feature is the implicit twin of; the two must
read one mode from one endpoint. **Parity row 6.28** (`docs/pes-parity-audit.md:393`) is still
UNOWNED and writes `OutboundSyncQueue` rows of its own via `apply-mapping.service.ts` — whoever
takes it will need the same rollup and the same column.

## What NOT to rebuild

`syncQueue.ts` (447 lines, tested, and every comment in it is a measurement someone paid for),
`sync-queue.service.ts`, `computeFailureDisposition`, `outbound-enqueue.ts`, `clustered.ts`, and the
`/fulfillment/stock/sync-control` page. The studio consumes all of them.
