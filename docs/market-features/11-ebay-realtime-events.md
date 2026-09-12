# 11 — eBay REALTIME channel events

## 1. What it is (operator terms)

Two operators and a dozen background jobs write the same product. A pricing cascade, a flat-file
import, an eBay `ItemRevised` notification, a colleague's sheet edit, an Amazon suppression from the
SQS poller — any of them can move the record while someone has it open. This feature is how the page
*tells you that happened*: a liveness dot so you know whether the page is still hearing anything, a
non-modal "changed elsewhere — reload" notice so you decide when to take the new data, and
channel-side facts (suppressed, feed resolved, push failed, account warning) arriving as marks
instead of being discovered tomorrow. Who uses it: anyone editing a record that another human or a
cron also writes — which, on this platform, is every record. When: continuously, passively; the
whole design goal is that it costs no attention until it has something to say.

## 2. Old UI — inventory

**Entry point.** `EbayCockpit.tsx:207-208` mounts the hook, `:352` the dot, `:466` the toast. LIVE,
not dead — three importers, all in the eBay cockpit only. Amazon's cockpit has no equivalent.

- **`realtime/useEbayChannelEvents.ts:46-133`** — the filter. Takes `{productId, marketplace,
  siblingListingIds, currentListingId}`, returns `{connected, lastEvent, listingUpdatedAt,
  masterChangedAt, siblingChangedAt, secondsSinceLast}`. Reads TWO rails: the shared SSE hook
  (`:52`) and the BroadcastChannel (`:93-105`). Refs (`:57-68`) keep the sibling/current ids current
  without re-subscribing. A 1s ticker (`:110-113`) re-renders for `secondsSinceLast`. Browser-local
  only — it round-trips nothing itself.
- **`realtime/HeartbeatDot.tsx:31-68`** — four tones (`live-pulse` <10s, `live-solid`, `idle` never
  seen an event, `down` disconnected), hardcoded Tailwind colours (`:45-49`), `title` tooltip.
- **`realtime/CrossTabChangeToast.tsx:37-132`** — a slim inline banner (not a real toast). Stacks up
  to three change kinds into one decision point (`:53-65`), `Refresh` → `router.refresh()` (`:83-87`),
  **auto-dismisses at 30s** (`:67-78`), 5s ticker for the relative clock. Browser-local.

**The pipes underneath are app-wide infrastructure, NOT cockpit code** — this matters for §6:

- `apps/web/src/lib/sync/use-listing-events.ts:66-181` — ONE `EventSource` per tab on
  `${backend}/api/listings/events` (`:76-77`), 12 named listeners (`:146-161`), and an **explicit**
  SSE-type → invalidation-type map (`:87-135`). Its own comment (`:121-130`) states the trap: a type
  the chain does not name reaches nobody, whatever the publisher calls it.
- `apps/web/src/lib/sync/invalidation-channel.ts` — BroadcastChannel `nexus:invalidations`, ~45
  typed invalidation types (`:49-124`), and `emitInvalidation` re-dispatches to the *sending* tab via
  a `window` CustomEvent (`:172-180`) because BroadcastChannel does not.
- `apps/web/src/lib/sync/dev-stream-gate.ts:6-31` — the measured socket-pool gate; `streamsEnabled()`
  at `:55-63`.
- `_shared/draft-bus/useProductDraftBus.ts` — module-scope singleton for **unsaved** values,
  same-page only, and it says so (`:18-20`): "cross-window updates ride a different rail". Nothing to
  port: the studio's per-cell autosave retires the concept.

**Dead:** nothing in this feature. All three files have a live importer.

## 3. Backend that exists

**Two SSE routes, and they carry different vocabularies.**

| route | file:line | carries | replay |
|---|---|---|---|
| `GET /api/listings/events` | `listings-syndication.routes.ts:3021` | record/refresh hints | **none** |
| `GET /api/orders/events` | `orders.routes.ts:1694` | channel + account facts | `?since=<ms>` |

- Listing route: `ping` on open (`:3023-3025`), 25s comment-line heartbeat (`:3036-3043`),
  `await new Promise(() => {})` to hold it open (`:3049`). Headers from
  `apps/api/src/lib/sse.ts:9-29` — CORS rebuilt by hand (the cors plugin never runs for a raw
  `writeHead`) plus `X-Accel-Buffering: no`.
- Orders route already has what the listing route lacks: `?since=` flushes the replay buffer before
  live streaming and emits a `replay.done` marker (`orders.routes.ts:1717-1732`).

**The buses.** `services/listing-events.service.ts` — 12 types (`:101-105`), built from the shared
factory (`:107-110`) with **no replay configured**. `services/order-events.service.ts:225-241` — the
channel set: `listing.suppressed`, `feed.processing.finished`, `flat_file_feed.status_changed`,
`ebay_push.status_changed`, `account.health.changed`, `competitive.buyBoxLost`, `sync.*` alerts —
with `replay: {max:100, ttlMs:5*60_000}` (`:243-249`). Both cross replicas via
`lib/events/bus.ts:74+` (local sync delivery `:89-101`, self-echo suppression `:176`, BROADCAST not
consumer-group `:166-172`) — landed in `835152bab` / `69e52d3e0`. `lib/events/ephemeral.ts:1-23`
states the lane rule: refresh hints ephemeral, domain facts through the outbox.

**The studio's own writes are already on the wire.** `PATCH /api/products/bulk` →
`productEventService.emitMany` (`products.routes.ts:2985`) with `BULK_OP_APPLIED`, which
`ssePayloadFor` (`product-event.service.ts:95-120`) maps to `product.updated`, fanned out at
`:253-272`. This holds for `target: 'channel'` writes too — same route, same aggregate. **So another
operator's sheet edit already reaches every open tab today.** What the payload does NOT carry:
a version, a row id, or an actor (`:221-225` sends `{type, productId, reason, ts}` only).

`listing.updated` publishers (10 sites): `listings-syndication.routes.ts:1302, 2327`
(`suppression-opened`), `:2361` (`suppression-resolved`), `:3122, 3160, 3182, 3213`;
`ebay-publish.service.ts:112`; `pim/listing-snapshot.service.ts:274`; `bulk-action.service.ts:430,702`.

**eBay channel-side ingestion — thinner than it looks.**
`routes/ebay-notification.routes.ts:389` reads `metadata.topic`. Handled: `MARKETPLACE_ACCOUNT_DELETION`
(`:435`), `ItemRevised` / `marketplace.inventory_item.updated` (`:452-497`, → `recordChannelStockEvent`),
legacy sale topics (`:507`), `marketplace.order.created/cancelled` (`:547,581`). Everything else:
`logger.info('unhandled topic')` (`:619`). **`ItemRevised` writes a `ChannelStockEvent` row
(`schema.prisma:4920`) and publishes NOTHING on any bus** — so today an eBay-side revision is
invisible to an open page.

**🔴 There is no `listing.ended` event anywhere.** `packages/events/catalog.ts` has
`listing.suppressed` (`:604-615`, Amazon-shaped: `asin`/`sku`/`marketplaceId`/`status`, published by
`jobs/amazon-sqs-poll.job.ts:204`) and no ended/ending type. eBay ended state lives only as
`EbayListingIndex.endedAt`, populated by an index pull and read by the ads routes
(`ebay-ads.routes.ts:129, 290, 345, 431`). Surfacing "listing ended" is a READ, not an event, unless
the topic is subscribed.

Other models: `AmazonSuppression` (`schema.prisma:2102`), `ListingIssue` (`:2131`) — both measured at
**zero rows** on prod (`_studio/channel-ops/syncQueue.ts:1-16`).

**Permissions.** `lib/auth/permissions-manifest.ts:107` covers `/api/events` (auditView) only.
**Neither SSE route has a `preHandler`** — grep of `listings-syndication.routes.ts` finds
`allowApiKeyScope` at `:3237/3275/3314` and nothing on `:3021`. Both streams are unauthenticated.

## 4. Studio today

**The frame already holds the pipe** — the parity audit's row 3.50 is right about the SHEET and
misleading about the page. `_studio/contracts.tsx:480-517` `useLiveRefresh`:

- `useListingEvents(streamsEnabled())` at `:494` — ONE pipe for the whole studio, gated off against a
  local backend with the measurement written in place (`:483-493`).
- `useInvalidationChannel(['product.updated','listing.updated','channel-pricing.updated'])` at
  `:502-503`, 800ms coalesce (`:509-512`), productId filter on `product.updated` only (`:507`).
- Returns a nonce that **only the readiness query** depends on (`:459`, and `:476` says so:
  "The frame refreshes only what the FRAME owns: readiness").

So the scope chips move on a foreign change; the grid rows do not. That is the gap.

**The version machinery is built.** `sheet/master/useMasterSheet.ts`: `writer.seed(...)` teaches
every row's version before the first edit (`:174`); `readRow` is a **quiet** single-row read that
touches no React state (`:99-109`) with the reason written in place; `onConflict` collects row ids
(`:113`) → footer link "N rows changed elsewhere — refresh" (`MasterSheet.tsx:1841-1846`);
`reload()` is a nonce (`:187`). `reconcileRead.ts:28` keeps `null` (did not answer) apart from `{}`
(row is empty). `reloadGuard.ts:34` `reloadImpact()` decides whether Reload must ask first.
`design-system/grid/editors/sheetWriter.ts:150-151, 351` is the `onConflict` contract; `:115-122`
requires `version` back on success *and* on 409. `MasterSheet.tsx:537` shows `refreshCells({force:true})`
already used for a targeted repaint.

**🔴 The channel scope is asymmetric and it is a live defect.** `ChannelSheet.tsx:414`:
`onConflict: () => reload()` — a full re-read fired immediately, unasked. Master *offers*; the
channel scope *takes*. `reloadImpact()` is not consulted, so a refused or typed value is discarded
without the question `reloadGuard.ts` exists to ask.

**Errors & Sync (H9) is static.** `channel-ops/ErrorsSyncConsole.tsx` fetches in a `useEffect`; grep
for `useInvalidationChannel|poll|interval|refresh` finds nothing. `syncQueue.ts` does the grouping
(by cause, per ruling #127) and states its coverage honestly.

**Toasts.** `ToastProvider` is mounted at `StudioClient.tsx:39` and `useToast` is used by both
sheets; nothing subscribes to `listing.synced` (parity 8.21).

**Parity rows:** `docs/pes-parity-audit.md:176` (3.50, 🕳), `:458` (8.20, ✅ PARITY — the frame's
pipe), `:459` (8.21, 🕳 toasts), `:457` (8.19, ✅ nav guard).

**Hub rulings that bind this:**
- **#602** (`docs/pes-claims.md`, and Owner item 37 at `:12538`) — the socket budget. 3 global chrome
  streams + the studio's pipe = 4-5 persistent HTTP/1.1 connections per tab against Chrome's
  6-per-host-**per-profile** limit; a sheet write waited ~30s for a socket while the server answered
  in 0.8-4s, proven with a curl control served continuously alongside. Ruled: **ONE `EventSource`
  per tab, fan-out on the invalidation channel — `contracts.tsx:476` is the design.** Scheduled
  after wave 4. Prod "likely unaffected (HTTP/2)" — explicitly **not measured**.
- **#162** — root cause of the app-wide stall was an ungated `CompetitiveAlertWatcher` in the root
  layout; the pool is **per ORIGIN, shared across tabs**, so a fresh tab does not help. Also banked:
  an open stream leaves **no** resource-timing entry, so "no EventSource is open" from an empty
  entry list is the instrument lying.
- **#164** — the retraction. The API's 500s were **Neon unreachable**, not SSE starving Prisma. Do
  not carry the "SSE starves the server pool" story forward; only the *browser* pool claim survives.
- `docs/2026-09-01-pes7-images-inventory.md:762-790` — the measurement: 18 requests, **17 permanently
  pending**, curl 200 in 0.84s; two SSE streams plus two stacking polls exhaust the pool.

## 5. Defects and slowness

1. **The sheet learns nothing.** `contracts.tsx:459` wires the nonce to readiness only; no sheet hook
   subscribes to the invalidation channel. Another operator's write moves the chips and leaves the
   grid showing stale values until the operator presses Reload. — CODE-READ.
2. **Channel scope reloads without asking** (`ChannelSheet.tsx:414`) — destroys typing and refusals
   that `reloadGuard.reloadImpact()` was written to protect. — CODE-READ.
3. **`product.updated` carries no version, no row id, no actor** (`product-event.service.ts:221-225`)
   — so the only possible response is "refetch the whole sheet". Per-row repaint is impossible on
   today's payload. — CODE-READ.
4. **Suppression cannot reach the studio.** `listing.suppressed` is on the ORDER bus
   (`order-events.service.ts:236`) and absent from `LISTING_BUS_TYPES_LIST`
   (`listing-events.service.ts:101-105`); the studio mounts only `useListingEvents`. — CODE-READ.
5. **eBay `ItemRevised` publishes nothing** (`ebay-notification.routes.ts:481-487`) — a channel-side
   change lands in `ChannelStockEvent` and no open page hears it. — CODE-READ.
6. **No replay on the listing bus** (`:107-110`) — a tab that reconnects after a drop has no way to
   catch up, while the orders route already solved this (`orders.routes.ts:1717-1732`). — CODE-READ.
7. **Both SSE routes are unauthenticated** — no `preHandler` on `listings-syndication.routes.ts:3021`
   or `orders.routes.ts:1694`. — CODE-READ.
8. **Errors & Sync never refreshes** — a queue console that is stale the moment it renders. — CODE-READ.
9. **Socket budget**: 4-5 streams per tab, 6 allowed, pool shared across tabs. — MEASURED-IN-DOC
   (#602, #162, pes7 §13).
10. **Old-tree duplication**: `useEbayChannelEvents` mirrors the invalidation map that
    `use-listing-events.ts:87-135` already applies — two places deciding which types matter, in the
    shape the memory's mirrored-types trap names. — CODE-READ.
11. **Prod HTTP/2 is a hypothesis.** #602 says "likely unaffected, to be measured before anything is
    scheduled". Nothing in the repo records that measurement. — HYPOTHESIS.

## 6. Proposed home in the studio

### 6.1 Primary home + mirrors

**Recommendation: ONE multiplexed stream — the pipe that already exists — widened server-side, with
a version-carrying payload, and a *conditional* version poll as the fallback. Not a new stream, and
not a poll as the primary.**

**Primary home: H2** — a per-row `changed elsewhere` mark, plus the sheet footer's existing ONE note
slot for the page-level statement. H2 because the fact is per-row and derived: a row whose stored
version has moved past the grid's copy. It is not a value the operator edits (not H1) and not an
operation (not H3-H6). Drawing it as a mark in the lane that already carries provenance and refusal
marks means it filters, sorts and tooltips for free, and the footer note (`SheetFooterNote`, shared
by all three scopes since 2026-09-04) states the page-level count in the slot that already exists —
so nothing new appears in the geometry and the strip height does not change.

**Mirror H9 — Errors & Sync.** Channel-side facts (suppression, feed resolved, push failed, account
warning) are queue-shaped and cross-row: `syncQueue.ts` already groups by cause. The console gains a
live count and a subscription; it does not gain a new pane. A queue must never be inline-only
(channel-ops research §3.2) and a channel event that only marks a row is inline-only.

**Mirror H6 — SheetToolbar `Reload`.** The existing Reload gains the count ("Reload (3 changed)") and
must route through `reloadImpact()`. This is the *verb* half: the notice offers, the toolbar acts, so
the capability is not drawer-only or footer-only.

**Mirror H7 — drawer Listings/History pane.** Depth: which fields moved, when, and by whom once the
payload carries an actor. The drawer is non-modal, so reading the foreign change does not stop the
sheet from receiving the next one.

**H12 — drop the toast SHAPE.** `CrossTabChangeToast` auto-dismisses at 30s (`:67-78`); a notice that
can vanish before the operator looks is worse than a footer line that persists. Keep `useToast` for
`listing.synced` *outcomes* (parity 8.21) — a transient result deserves a transient surface.

### 6.2 What the sheet shows at rest

| scope | at rest | on a foreign change |
|---|---|---|
| master | nothing | `⟳` mark on the identity cell of each moved row; footer "3 rows changed elsewhere — reload"; header liveness Pill |
| channel × market | nothing | the same, plus the **alias band** carries the mark when the change is the listing's own (`AliasBandCell.tsx:131` already renders `listingStatus`); channel-event marks (`⊘` suppressed, `⚑` push failed) on the band |
| any scope, stream down | header Pill reads `Reconnecting` | the conditional version poll arms after 10s down and the footer says which instrument it is using |

At rest, **nothing** — that is the point. The dangerous version of this feature is chrome that claims
liveness it cannot deliver.

### 6.3 The interaction, step by step

1. **Open.** `contracts.tsx` mounts the one pipe (unchanged). Header renders a DS `Pill tone="neutral"
   size="sm"`: `Live` / `Reconnecting` / `Not live (local)`. Three honest states, no new component.
2. **Collect.** An event lands. `use-listing-events.ts` re-emits it onto the invalidation channel
   (its existing job). The sheet hooks — `useMasterSheet` and `useChannelSheet` — each add one
   `useInvalidationChannel` subscription and compare `event.version` against the version
   `writer.seed` holds for that row.
3. **Preflight.** Three outcomes, decided by a pure rule (a new `foreignChange.ts` beside
   `reloadGuard.ts`, so it is testable):
   - the row has **no local edit and no pending write** → quiet `readRow(rowId)` (the primitive
     already exists, `useMasterSheet.ts:99-109`) then `refreshCells({force:true, rowNodes:[node]})`.
     Repaint, no question. This is the common case and it should be invisible.
   - the row has a **pending or refused** cell → mark only. Never repaint under typing.
   - **many rows** (>5) or a `versionOf` we cannot match → footer note with the count, no repaint.
4. **Confirm.** Only for the footer/toolbar reload, and only through `reloadImpact()` — which already
   returns `null` when nothing is at risk, so the common press asks nothing.
5. **Run → repaints.** Per-row repaint via `refreshCells`, never `setLoading(true)` (the reason is
   written at `useMasterSheet.ts:93-98`: a loading state drops the rows and takes the marks with them).
6. **Keyboard.** Nothing new. The footer note's action is a `Button variant="link"`, reachable in tab
   order; the mark is a tooltip, not a focus stop.
7. **With the drawer open.** Non-modal, so the drawer's pane repaints from the same event. If the
   drawer is showing the moved row, its History pane gains the new entry; the sheet still marks.

DS components: `Pill`, `Button variant="link"`, `GridSheetNote` (a new `kind="foreign"` occupant of
the slot `SheetFooterNote` already owns), the grid's existing mark lane, `Tooltip`. **No new DS
component needed.**

### 6.4 Per-scope rules

- **Master** — CAS token is `Product.version`; the event's `versionOf` must read `'product'`.
- **Channel** — CAS token is `ChannelListing.version` (`channel/types.ts:307`, and
  `useChannelSheet.ts:268-282` is the file that learned this the hard way). An event carrying a
  product version must NOT be compared against a listing row: that is the memory's
  `Product.version ≠ row version` trap and it produced a "someone changed this listing (v1)" message
  before. So the event payload carries `versionOf` exactly as the write response does.
- **Alias bands** — a listing-scoped event marks the band and its children; a product-scoped event
  marks every band (the master value is inherited by all of them).
- **Single-store channels (Shopify)** — `marketplace: 'GLOBAL'`; one band, no market fan-out.
- **Market channels (eBay, Amazon)** — a sibling market's change is *informational only* (the old
  `siblingChangedAt`): it must not mark this scope's rows. Amazon's shared EU quantity is the one
  exception where a sibling change genuinely moves this coordinate's value.

### 6.5 Provenance / autosave / readiness / publish

- **Provenance** is untouched — `⟳` is a *staleness* mark in the same lane, never a layer claim. A
  repaint re-reads the row and therefore re-reads its provenance from the server; it never infers one.
- **Autosave** — a foreign change never repaints a row with a pending or refused cell (§6.3 step 3).
  The in-flight guard (`contracts.tsx:533-596`) is unaffected.
- **Readiness** — unchanged: `useLiveRefresh`'s nonce already re-pulls it. The new subscriptions are
  *additional* consumers of the same events, not a second pipe.
- **Publish** — a `feed.processing.finished` / `ebay_push.status_changed` event is the honest end of a
  publish: today the operator polls. This is the strongest single argument for widening the bus.
  eBay stays preview-only; nothing here sends anything.

### 6.6 ASCII mockup

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ ‹ Products  GALE Pro Racing Suit · GALE-KAN-PRO · ● Active   autosave ✓ (Live) │
├────────────────────────────────────────────────────────────────────────────────┤
│ SCOPE [Master 96%][Amazon ●92%][eBay ⚠71%]   Sheet·Images·…·Errors&Sync ③      │
├────────────────────────────────────────────────────────────────────────────────┤
│ 21 rows · 2 selected [View ▾][Missing required (7)]  Find…  [Reload (3)]       │
├────────────────────────────────────────────────────────────────────────────────┤
│  ⟳ ① Primary · ACTIVE · 85% ────────────────────────── ⊘ suppressed on IT      │
│  ⟳   GALE-KAN-PRO-BLK-M   │ 199.00 │ 12 │ …   ← version moved, repainted       │
│      GALE-KAN-PRO-BLK-L   │ 199.00 │  8 │ …                                    │
│  ✎   GALE-KAN-PRO-RED-M   │ 209.00*│  4 │ …   ← your edit pending: MARK ONLY   │
├────────────────────────────────────────────────────────────────────────────────┤
│ 21 rows · autosave ✓ · 3 rows changed elsewhere — reload · Enter to edit       │
└────────────────────────────────────────────────────────────────────────────────┘
    (stream down)  autosave ✓ (Reconnecting) … footer: "checking for changes every 20s"
```

### 6.7 The socket budget, stated

- **Budget: ONE stream for the studio route** — the pipe `contracts.tsx:494` already opens. Every
  capability in this report is delivered by widening that one stream, not by adding another. Adding
  `/api/orders/events` for the channel events would take the route from 4 to 5 of 6 on HTTP/1.1 and
  is **refused** on ruling #602's own terms.
- The 3 global-chrome streams (`layout.tsx:124/126/140`) are all `streamsEnabled()`-gated
  (`CompetitiveAlertWatcher.tsx:62`, `GlobalDlqBanner.tsx:117`, `GlobalAccountHealthBanner.tsx:91`),
  so local dev sees 0 and prod sees 4 total. Prod HTTP/2 is UNMEASURED (§5.11) — the budget rule
  stands regardless, because it costs nothing to obey.
- **Fallback when the stream is unavailable** (never opened, or `connected === false` for >10s):
  arm a **20s conditional version poll** on a new `GET /api/products/:id/studio/versions` returning
  `{productVersion, rows:[{id, version, listingVersion}]}` — a few hundred bytes. Disarm the moment a
  `ping` lands. Two rules from the measured trap: the interval must exceed the observed response time
  (a poll shorter than the answer stacks copies — pes7 §13), and a single in-flight request at a time.
  It is a fallback, not a second rail: two instruments running at once is how the old cockpit ended up
  with two invalidation maps.
- The footer says which instrument is live. A page that silently degrades from stream to poll and
  claims the same freshness is exactly the dishonest-UI failure the 100%-honest-UI rule names.

## 7. Contracts and data

**Reused, unchanged:** `GET /api/listings/events`; `use-listing-events.ts`; `invalidation-channel.ts`;
`dev-stream-gate.ts`; `SheetWriter.onConflict`; `readRow`/`reconcileRead`; `reloadImpact`;
`refreshCells`; `PATCH /api/products/bulk`.

**Server changes (all additive) — PES.5:**
1. `LISTING_BUS_TYPES_LIST` (`listing-events.service.ts:101-105`) gains `listing.suppressed`,
   `feed.processing.finished`, `flat_file_feed.status_changed`, `ebay_push.status_changed`,
   `account.health.changed`. **Gated on §8 risk 1 first.**
2. `replay: {max:100, ttlMs:5*60_000}` on the listing bus + `?since=` on the route — copy
   `orders.routes.ts:1717-1732`. Producer and consumer land together (memory rule).
3. `product.updated` / `listing.updated` payloads gain `version: number`,
   `versionOf: 'product'|'channelListing'`, `rowId: string|null`, `actor: string|null`. Additive to
   the envelope schema in `packages/events/catalog.ts`; every existing consumer ignores unknown fields.
4. `GET /api/products/:id/studio/versions?market=&channel=` — the fallback read.
5. `ebay-notification.routes.ts:481-487` also publishes `listing.updated` after
   `recordChannelStockEvent`.
6. Auth on both SSE routes.

**No schema change is required.** `ChannelStockEvent`, `AmazonSuppression`, `ListingIssue` and
`OutboundSyncQueue` already exist; the two suppression models hold zero rows, so the console must
keep saying so.

**Lane ownership:** PES.5 all six server items. PES.2 the grid-side rule (`foreignChange.ts`, the
mark, the footer occupant, per-row repaint) and the `ChannelSheet.tsx:414` defect. PES.1 the header
Pill and the fan-out wiring in `contracts.tsx`. PES.3 the H9 live count. PES.4 the drawer pane. Grid
substrate (design-system/grid) needs only the new `GridSheetNote` kind.

## 8. Risks and traps

1. **🔴 Unauthenticated SSE.** Neither route has a `preHandler`. Widening the listing bus to carry
   `account.health.changed` puts account-suspension strings on an unauthenticated stream. **Gate the
   routes before item 1 of §7, not after.** Biggest risk in this report.
2. **Do not promise "listing ended".** No such event exists (§3). eBay's `ItemEnded` is not a
   subscribed topic and falls through `ebay-notification.routes.ts:619`. Surfacing it means either
   subscribing the topic (a channel-config change) or reading `EbayListingIndex.endedAt` — a read
   dressed as an event would be a claim the data cannot support.
3. **`Product.version` vs `ChannelListing.version`** — §6.4. An event compared against the wrong
   table's number poisons the next CAS.
4. **Local dev writes PROD** — a foreign event in local dev triggers a re-read of production, and a
   quiet `readRow` against a live listing is harmless but a repaint that lands mid-edit is not.
   Verification of this feature must use the `enableDevStreams(true)` toggle deliberately, one tab.
5. **An open stream leaves no resource-timing entry** (#162). Any verification claiming "no stream is
   open" from `performance.getEntriesByType('resource')` is measuring nothing.
6. **Do not carry #164's retracted story.** SSE does not demonstrably starve the API's Prisma pool;
   only the browser socket pool claim is measured.
7. **Amazon EU shared quantity** — a quantity event on IT legitimately moves DE/FR/ES. The
   sibling-is-informational rule (§6.4) must carve this out or it will suppress a real change.
8. **Untouchables** — nothing here enters the flat-file editors, FBA quantity logic or the import
   flows. The `flat_file_feed.status_changed` event is *read* by the studio; the flat-file pages keep
   their own consumer.
9. **AI stays dark** — `AI_CONTENT_GENERATED` maps to `product.updated`
   (`product-event.service.ts:114`), so an AI draft written elsewhere would mark rows. Correct: the
   mark reports a stored change; it does not generate anything.
10. **A repaint is a write-adjacent act.** `refreshCells` after a `readRow` replaces what is on
    screen. The pending/refused carve-out is not a nicety — it is the difference between this feature
    and the `reloadGuard.ts:1-13` defect being reintroduced by a different door.

## 9. Open questions for the Owner (3)

1. **Gate the SSE routes before widening the bus?** — Recommend **yes, and block item 1 of §7 on
   it.** Both streams are currently open to anyone who can reach the API; `account.health.changed`
   carries suspension and policy-violation text. The gate is a `preHandler`, not a redesign.
2. **When a row the operator has NOT touched moves, do we repaint silently or only mark?** —
   Recommend **repaint silently, mark everything else.** A stale value the operator is about to copy
   into a decision is worse than a repaint they did not ask for, and the carve-out (pending, refused,
   or >5 rows) covers every case where a repaint could take work. The footer still states the count,
   so nothing changes without a trace.
3. **Liveness: a three-state Pill in the header, or silence-unless-down?** — Recommend the
   **three-state Pill** (`Live` / `Reconnecting` / `Not live (local)`). Silence-unless-down is
   cheaper but makes "live" unfalsifiable from the screen, and the freshness of what is on the sheet
   is exactly the thing an operator cannot otherwise check.

## 10. Effort and dependencies

| piece | lane | effort |
|---|---|---|
| Auth on both SSE routes | PES.5 | **S** |
| Fan-out subscriptions in the two sheet hooks + `foreignChange.ts` rule + tests | PES.2 | **M** |
| Per-row repaint via `readRow` + `refreshCells` | PES.2 | **S** (primitives exist) |
| Fix `ChannelSheet.tsx:414` to offer, not take | PES.2 | **S** (independent bug fix; do first) |
| Footer `GridSheetNote kind="foreign"` + toolbar Reload count | PES.2 / grid substrate | **S** |
| Header liveness Pill | PES.1 | **S** |
| Widen `LISTING_BUS_TYPES_LIST` + replay + `?since=` | PES.5 | **M** (blocked on auth) |
| Version/actor/versionOf on the event payload | PES.5 | **M** |
| `GET /studio/versions` fallback + conditional poll | PES.5 + PES.2 | **M** |
| H9 live count + subscription | PES.3 | **S** |
| Drawer History pane on a foreign change | PES.4 | **S** |
| eBay `ItemRevised` → `listing.updated` | PES.5 | **S** |

**Dependencies.** Feature 09 (Errors & Sync / suppression marks) consumes the same widened bus — land
the bus once, not twice. Feature 12-shaped publish work (`ebay_push.status_changed`) is the strongest
consumer of item 1. The socket budget rule constrains every other feature that might want a stream:
**the answer is always "use the pipe at `contracts.tsx:494`"**. Ruling #602 scheduled the one-stream
consolidation after wave 4; this report's server items should ride that slot rather than open a
second front.

## What NOT to rebuild

- **`use-listing-events.ts`, `invalidation-channel.ts`, `dev-stream-gate.ts`** — these live in
  `lib/sync/**`, are app-wide, and the studio already imports all three (`contracts.tsx:33-35`).
  §2.10's "old tree is specification" governs `products/[id]/edit/tabs/**`; it does not license
  rewriting the platform's event transport.
- **`lib/events/**` — the cross-replica bus, ephemeral lane, broker, relay.** Landed and crossing
  replicas (`835152bab`, `69e52d3e0`). Add types to a list; do not touch the factory.
- **`useProductDraftBus`** — autosave retired the concept.
- **`SheetWriter` conflict handling, `readRow`, `reconcileRead`, `reloadGuard`.** The version
  machinery, the quiet read and the "what am I about to destroy" rule are all built and tested. Wire
  them; the temptation to write a fresh "refetch on event" path is how the two-invalidation-maps
  duplication in the old cockpit happened.
- **`syncQueue.ts` grouping and the Errors & Sync console.** It gains a subscription and a count.
- **A second `EventSource`, a WebSocket, or a permanent sheet poll.** All three are refused by the
  measured socket budget.
- **`HeartbeatDot` and `CrossTabChangeToast` as components.** The capability survives as a DS `Pill`
  and a footer note occupant; the four-tone Tailwind dot and the 30s self-dismissing banner do not.
