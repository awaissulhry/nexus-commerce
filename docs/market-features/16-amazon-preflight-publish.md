# 16 — Amazon PREFLIGHT (local + `live=1`) + PUBLISH (multi-market submit, feed polling, review/confirm, fields-being-published)

## 1. What it is (operator terms)

The last two things an operator does before a listing goes out, and the only two that are hard to
reverse. **Preflight** answers *"what is wrong with this listing, and what would change on the
channel if I sent it now?"* — locally (required/byte-length/conditional/schema/GPSR), plus mirrored
Amazon issues, plus an optional **live** arm that asks Amazon's own validator
(`mode=VALIDATION_PREVIEW`). **Publish** then submits — per market, as a JSON_LISTINGS_FEED — and
watches the feed until Amazon says DONE/FATAL, showing per-SKU accept/reject rows. Used by whoever
owns the listing, at the end of an editing session, on one product across several markets at once;
and again the next morning, when the question is "did yesterday's feed land?". Everything else in
the studio is reversible with ⌘Z; this is the part that isn't, which is why it is the one flow that
must be explicit, preflight-first, dry-run by default, and honest about which mode the server is in.

## 2. Old UI — inventory

**Amazon cockpit (the fullest implementation).** `tabs/amazon-cockpit/AmazonCockpit.tsx:626` mounts
`PreflightPanel`, `:629` mounts `PublishCard`, side by side in the left card column.
`useCockpitShortcuts.ts:8,26` binds ⌘⇧P and `1` to jump to the publish card.

- `preflight/PreflightPanel.tsx:44-207` — always-on card. Fetches
  `GET /api/products/:id/preflight?marketplace=<MP>` on mount (`:62`, `:75-77`), re-fetches with
  `&live=1` on **"Run Amazon validation"** (`:170-183`), opens the confirm modal on
  **"Review & Publish"** (`:184-191`, `:199-205`). Tone/chip derived from `counts.errors/warnings`
  (`:83-106`). `validationPreview === 'ran'` renders "Validated against Amazon" (`:153-157`).
- `preflight/PreflightBody.tsx:67-110` (`PreflightIssues`, errors-then-warnings, each with a
  detector tag) and `:141-153` (`PreflightDiff`, live→pending per attribute). Shared by the panel
  and the modal — the one piece of the old tree that was already factored.
- `preflight/types.ts:1-60` — a hand-written **mirror** of the API response, plus `FIELD_LABEL`
  covering exactly three fields (`item_name`, `price`, `quantity`), which is also all `buildDiff`
  emits.
- `preflight/ReviewConfirmModal.tsx:32-225` — the publish gate. Always fetches `live=1` (`:52`),
  BLOCKS on any error (`:81`, `:188-193`), requires a checkbox acknowledgement for warnings
  (`:82`, `:177-187`), then `POST /api/products/:id/publish-amazon` with `{marketplaces:[mp]}`
  (`:88-96`) and reports `submissions[0]`. Esc closes unless publishing (`:69-75`). No mode banner —
  it reports "Submitted to Amazon (feed …)" even when the server ran a dry run.
- `publish/PublishCard.tsx:120-546` — multi-market submit. Per-market checkbox grid with the active
  market's health score (`:429-488`); `window.confirm()` override when the active market is BLOCKED
  (`:158-166`); `POST /publish-amazon` with the checked set (`:186-196`); `PublishModeBadge`
  (`:418`); a dry-run banner naming `AMAZON_PUBLISH_MODE` (`:422-426`); **browser polling**
  `GET /api/amazon/flat-file/feeds/:feedId` every 5 s per market, self-terminating at 240 ticks /
  20 min (`:264-379`); expandable per-feed detail with the first 6 processing-report rows
  (`:600-653`). Telemetry via `postCockpitEvent` (`:224`, `:323`).

**Per-coordinate modal (ChannelListingTab).** `tabs/ChannelListingTab.tsx:425-428` a `Send` button
sets `showPublishModal`; `:553-560` mounts a **locally defined** `PublishReviewModal` (`:954-1240`).
It computes a 6-item readiness checklist in the browser (`:1061-1075` critical vs optional), builds
the **fields-being-published table** by walking `platformAttributes.attributes` (`:1032-1058`,
truncating each value at 120 chars), and posts
`POST /api/products/:id/listings/:channel/:marketplace/publish` (`:1061-1080`). Nothing here talks
to any preflight endpoint; its checklist is a third, hand-rolled definition of readiness.

**Listing-hub modal (a fourth surface, same name).** `tabs/PublishReviewModal.tsx:89-301` — imported
only by `tabs/MasterDataTab.tsx:37,1425`. Calls `POST /api/products/:id/publish-preflight` (`:118`),
renders per-coordinate rows with an **effective action** badge (`amazon-live` / `amazon-dry-run` /
`amazon-unconfigured` / `mark-active`, `:68-80`), publishes only the READY coordinates in parallel
(`:151-168`), and offers **Retry failed** (`:289-296`).

**Browser-local / dead.** All polling state, all selection state, the ack checkbox and the results
are component state — nothing survives a tab close (no localStorage either; the durable feed list at
`GET /api/amazon/flat-file/feeds` exists and no cockpit surface reads it). `types.ts:56-60`'s
`FIELD_LABEL` is effectively dead beyond three keys. Two components named `PublishReviewModal` with
different props, different endpoints and different verdict vocabularies coexist in one folder.

## 3. Backend that exists

**Preflight (three of them).**
- `GET /api/products/:id/preflight?marketplace=&live=1` — `routes/amazon-preflight.routes.ts:20-35`
  → `services/amazon/preflight-report.service.ts:128-248`. Unions byte-length, static required,
  conditional (allOf), local schema type/enum, and mirrored open `ListingIssue` rows (`:185-197`);
  builds the diff from a **live SP-API `getListingsItem`** (`:201`, via
  `services/marketplaces/amazon.service.ts:1249-1276`); on `live=1` composes the feed body and calls
  `amazonSpApiClient.validateListing` (`:205-232`), mirroring Amazon's verdict back into
  `ListingIssue`. Reuses the publish path's own `buildRow` (`:158`) — the one thing that makes the
  report describe what would actually be sent.
- `POST /api/products/:id/publish-preflight` — `routes/marketplaces.routes.ts:1142-1240`. Read-only,
  no SP-API; four hardcoded checks; derives the mode from `process.env.AMAZON_PUBLISH_MODE` directly
  (`:1181`).
- `POST /api/products/sheet/publish-preview` (**MS.5**) — `routes/products-sheet.routes.ts:107-131`
  → `services/pim/sheet-publish.service.ts:62-142`. Makes **no channel call at all**; verdicts
  `ready | warned | unlisted | blocked` per row from `readiness.service`; `publishMode` from
  `getAmazonPublishMode()`/`getEbayPublishMode()` (`:120-124`); `notSendable` explains, in the
  server's words, why eBay cannot be sent from the sheet (`:134-141`).

**Publish.**
- `POST /api/products/:id/publish-amazon` — `routes/amazon-cockpit-publish.routes.ts:231-531`.
  `dryRun = body.dryRun === true || getAmazonPublishMode() !== 'live'` (`:239-241`); max 10 markets;
  auto-creates a `ChannelListing` shell when none exists (**B7**, `:310-337`); `buildRow` (`:340`);
  **the dry-run short-circuit is here** (`:344-352`); then schema hints, `buildJsonFeedBody`, the
  byte-length gate (`:364-380`), the `VALIDATION_PREVIEW` pre-check that blocks on Amazon-confirmed
  errors (`:387-430`), then createFeedDocument → PUT upload → createFeed (`:433-465`), then a
  best-effort `platformAttributes.__alaPublishMeta` stamp (`:470-505`).
- `POST /api/products/:id/listings/:channel/:marketplace/publish` — `marketplaces.routes.ts:948-1140`.
  Amazon → `putListingsItem` (gated in the client); others → mark active + queue sync.
- `GET /api/amazon/flat-file/feeds/:feedId` — `routes/amazon-flat-file.routes.ts:865-905`. A
  `dryrun-`-prefixed id returns a synthetic `DONE` (`:878-887`); otherwise `reconcileFeedJob`
  (`services/amazon-flat-file-feed.service.ts:283-400`) polls, parses the processing report, resolves
  issue `attributeNames` → editor columns, and updates the durable job row.
- `GET /api/amazon/flat-file/feeds` — `:908-930`, durable submission list.
- `GET /api/listings/publish-readiness` — `routes/listings-syndication.routes.ts:2639`. One read, all
  three channels' `{enabled, mode}` — the studio's existing source of truth for mode.

**Gates.** `services/amazon-publish-gate.service.ts:35-53` — master flag
`NEXUS_ENABLE_AMAZON_PUBLISH` → `gated`, else `AMAZON_PUBLISH_MODE` → `live|sandbox|dry-run`
(default-safe); plus a token bucket (`:104-146`) and a circuit breaker (`:193-271`).
`clients/amazon-sp-api.client.ts:924-947` short-circuits `putListingsItem` on `gated|dry-run`;
`:1050-1140` `validateListing` is deliberately **not** gated (non-mutating) and always hits the
production host. `services/channel-batch/amazon-batch-feed.service.ts:217-268` is the only submit
path that honours BOTH the deployment gate and a caller-requested rehearsal, with a comment
forbidding the refactor that broke it before.

**Prisma.** `AmazonFlatFileFeedJob` (`schema.prisma:8127-8156`: feedId unique, marketplace,
productType, status, skus, resultSummary, perSkuResults, poll bookkeeping — **no productId /
channelListingId / aliasId**). `ChannelPublishAttempt` (`:12689-12740`: channel, marketplace,
sellerId, sku, productId, `mode`, `outcome`, submissionId, payloadDigest, duration).
**Cron.** `jobs/amazon-flat-file-feed-poll.job.ts:24-40` advances IN_QUEUE/IN_PROGRESS feed jobs with
no tab open — the mechanism that makes feed status durable.
**Permissions.** `lib/auth/permissions-manifest.ts:412` — everything under `/api/products` is
`products.view` (read) / `products.edit` (write). So `publish-amazon`, the per-coordinate publish and
`publish-preview` all sit on `products.edit`, and `GET /preflight?live=1` sits on `products.view`.
The `listingsPublish` flag exists (`:162,345-346`) and none of these routes use it.

## 4. Studio today

- `_studio/sheet/channel/AliasPublishControl.tsx:65-181` — **preflight-first, two steps, dry-run
  default**, per alias. Calls MS.5's `publish-preview` (`:79-84`), renders the server's mode sentence
  (`:129-133`), the summary counts (`:135-138`), the first five blocked rows with their named field
  (`:140-145`), eBay's `notSendable` refusal verbatim (`:147-149`), a `Dry run` checkbox (`:152-156`)
  and a send button that **sets an error string instead of sending** (`:166-171`: "the per-alias send
  is not wired yet — preflight only (PES.5 request #7)"). Rendered N times in the **SheetToolbar's
  `trailing` slot**, one control per alias (`ChannelSheet.tsx:1902-1912`) — not on the band it names.
- `_studio/PublishMenu.tsx:34-105` — header `Publish ▾`. Lists only channels this market serves,
  each with its readiness note, **every item `disabled: true`** (`:67`) plus a footer sentence
  explaining that neither the sheet flow nor readiness is wired to it (`:31-32`, `:71-80`).
- `_studio/images/channel/amazon/publishPlan.ts:98-190` + `PublishPanel.tsx:56-95` — the studio's
  **working** publish gate: preflight first, dry run default, mode from
  `/listings/publish-readiness`, never the word "published" (only "queued"), and the outcome taken
  from the server's answer alone. This is the shape feature 16 should generalise, not re-invent.
- `_studio/channel-ops/syncQueue.ts:313-378` — one shared `PublishMode`, `modeForChannel` (returns
  `null`, never a guess) and `gateNote` (a sentence per mode, including an unrecognised one).
- `design-system/grid/actions/registry.ts:84-127` — `ActionImpact` already carries `findings[]`
  (documented as the adapter for MS.5's per-row verdicts), `payload` (the approved snapshot, so run
  does not re-fetch), `confirmPhrase`, `unavailable`; `:259-280` `requiresTypedConfirm` /
  `validateImpact` refuse a typed confirm with no phrase and a confirmation built on a failed
  preflight. `PARAMETERISED_VERB_ORDER` (`:221`) = collect → preflight → confirm → run.
- `design-system/grid/renderers/readiness.ts:30-67` — row vocabulary already includes
  `live` = "Already published on this channel"; `AliasBandCell.tsx:64-82` already renders status +
  external id + readiness percent on the band.
- DS has `Drawer` (`components/Drawer.tsx`: `variant: 'modal' | 'dock'`, `width`, and an `overlay`
  slot precisely because a Modal spawned from a drawer opens behind it) and `Stepper`
  (`components/Stepper.tsx`, with `onSelect`/`canSelect`).

**Parity rows.** 3.14 🔁 (per-coordinate review modal — no fields-being-published table, **3.14n**),
3.18 🔁 (health panel → chips + filter), 3.19 🔁 (preflight — **`live=1` absent, 3.19n**),
3.20 🗳 → **signed off**: `docs/pes-parity-audit.md:132,140-142,208-211`.

**Rulings.** #105 D8 (`docs/pes-claims.md:20554-20555`, described at `:20996-21000`): five
"**Sign-offs, no build**", one of which is "*3.20 studio does not submit to Amazon*". Read exactly:
it ratifies the STATUS of row 3.20 — the studio's publish is preflight + dry-run and the send stays
on the routes that own it. It is not a ruling about images (PES.7's image feed does submit), and it
is not a ruling that the flow may not be built. #114/#116 (`:20254-20258`, `:21005-21015`) — the
registry's preflight DELEGATES, MS.5's publish-preview adapts rather than being reimplemented, and
the two safety rules above. #127/#130/#131 — Errors & Sync is a queue-shaped tab, never inline-only.
Layout §"Autosave & writes" (`docs/2026-09-01-product-edit-studio-layout.md:111-113`) and decision 7
(`:132`).

## 5. Defects and slowness

1. 🔴 **The dry run is a no-op, not a rehearsal** — CODE-READ. `publish-amazon` short-circuits at
   `amazon-cockpit-publish.routes.ts:344-352`, i.e. **before** `getFeedSchemaHints`,
   `buildJsonFeedBody`, the byte-length gate and `VALIDATION_PREVIEW`. A "dry run" therefore returns
   `ok:true, messageCount:1` and a fake `dryrun-…` feedId for a payload it never composed, and
   because the gate defaults to non-live, **that is what every publish in this repo does today**.
   `channel-batch/amazon-batch-feed.service.ts:239-257` gets the order right (build, then check).
2. 🔴 **A cockpit publish leaves no durable record** — CODE-READ. The route creates no
   `AmazonFlatFileFeedJob` (grep: zero hits in the file) and writes no `ChannelPublishAttempt`.
   Consequences: the FFS.3 cron never advances the feed, `GET /flat-file/feeds` never lists it, and
   the outcome exists only inside the tab's 5-second `setInterval`. Close the tab and the answer to
   "did it land?" is gone.
3. 🔴 **`GET /preflight` makes a live SP-API call on every mount, while three places say it does
   not** — CODE-READ. `preflight-report.service.ts:201` calls `getListingState` (a real
   `getListingsItem`, `amazon.service.ts:1249-1276`) unconditionally, per listing, in a serial
   `for` loop (`:154`), alongside three per-listing schema fetches (`:161-166`). The route header
   (`amazon-preflight.routes.ts:10`), the service header (`:14-17`) and the panel's own footer
   (`PreflightPanel.tsx:194-197`) all claim "no extra SP-API call".
4. 🔴 **`live=1` is a GET that writes and calls production** — CODE-READ.
   `preflight-report.service.ts:224` mirrors Amazon's verdict into `ListingIssue`;
   `amazon-sp-api.client.ts:1066-1073,1110-1116` documents that `validateListing` is deliberately
   NOT gated and must hit the production host. The route resolves to `products.view`
   (`permissions-manifest.ts:412`) — a read permission that triggers a production marketplace call
   and a DB write.
5. 🔴 **`publish-preflight` re-derives the mode from env** — CODE-READ.
   `marketplaces.routes.ts:1181` reads `process.env.AMAZON_PUBLISH_MODE` and so cannot see
   `NEXUS_ENABLE_AMAZON_PUBLISH=false`: with mode=live and the flag off it renders "LIVE — changes
   submit to Amazon via SP-API" (`tabs/PublishReviewModal.tsx:203`) for a gate that will send
   nothing. Exactly the rule the layout doc states as "NEVER re-derived from env".
6. **Four readiness/verdict definitions for one question** — CODE-READ: `preflight-report.service`
   (issue list), `publish-preflight` (4 checks), `ChannelListingTab.tsx:1061-1075` (6 browser-side
   checks), `sheet-publish.service` (verdicts via `readiness.service`). Only the last delegates to
   the ONE definition (`services/pim/readiness.service.ts:1-52`).
7. **Two components named `PublishReviewModal`** — CODE-READ (`ChannelListingTab.tsx:954` local vs
   `tabs/PublishReviewModal.tsx:89`), different endpoints, different vocabularies, one folder.
8. **`__alaPublishMeta` is write-only** — CODE-READ: written at
   `amazon-cockpit-publish.routes.ts:495`, read by nothing (repo-wide grep: one hit). The one place
   a "last pushed" mark could have come from is dead data, and it records the request, not the
   outcome.
9. **Browser polling, per market, 5 s, 20 min, with a no-op cleanup** — CODE-READ:
   `PublishCard.tsx:264-379`; the `useEffect` at `:381-388` explicitly cleans up nothing, so
   unmounting mid-poll leaves N intervals to be GC'd with their fetches in flight.
10. **A dry-run feed reads as DONE** — CODE-READ: `amazon-flat-file.routes.ts:878-887` returns a
    synthetic terminal `DONE` for `dryrun-` ids. Honest (`dryRun:true` is in the body) but any
    surface that keys on `processingStatus` alone will report a successful publish.
11. **A hardcoded language tag on the per-coordinate publish** — CODE-READ:
    `marketplaces.routes.ts:1027,1033,1039` stamp `language_tag: 'it_IT'` and `currency: 'EUR'` for
    every market, including DE/ES/FR/UK.
12. **eBay/Shopify batch submits are live-by-default** — CODE-READ + repo set-scan:
    `channel-batch/ebay-parallel-batch.service.ts:67` and `shopify-bulk-mutation.service.ts:63` gate
    on `NEXUS_EBAY_BATCH_DRYRUN` / `NEXUS_SHOPIFY_BULK_DRYRUN`, neither of which is set anywhere in
    the repo, while `getEbayPublishMode()` exists and is not called (BE-11,
    `docs/pes-claims.md:12372`). Railway env is the authority — HYPOTHESIS per deployment, but no
    publish flow should route through these paths until it is checked.
13. **No test on the publish route** — CODE-READ: no `*publish-amazon*` test file exists; the tested
    pieces are the pure collectors (`listing-preflight.vitest.test.ts`,
    `amazon-flat-file-feed.vitest.test.ts`), never the route's dry-run/gate branch.

## 6. Proposed home in the studio

### 6.1 Primary home + mirrors

**Primary: H5 — a CONTEXT verb on the alias band, `contextOf('alias-group')`, id `publish-alias`,
opening ONE publish flow as a DS `Drawer` with a `Stepper`.** Publishing acts on a listing, and on a
channel scope a listing *is* an alias group — the band is the only surface that is exactly one
listing, already carries its status, external id and readiness (`AliasBandCell.tsx:64-82`), and is
where `AliasPublishControl` was always trying to be (it is currently rendered N times in the
toolbar's `trailing` slot, which makes a per-listing verb read as a scope-wide one). A context verb
also gets the registry's whole order for free: collect → preflight → confirm → run, with the confirm
level coming from the preflight rather than a flag (`registry.ts:221`, `:84-127`).

**Mirrors, in the order they matter:**
- **H10 header `Publish ▾`** — the product-level entry. It already lists this market's channels with
  their readiness (`PublishMenu.tsx:38-69`); picking one opens **the same flow** for that channel ×
  market, seeded with every alias on the coordinate. That is the "one publish flow across channels":
  the menu chooses a coordinate, never a different flow.
- **H4 SELECTION verb `publish-rows`** — the same flow seeded with the ticked child SKUs, for "just
  these three variants". Same preflight, same payload table, same confirm.
- **H2 two read-only status columns** — at rest, see 6.2. A verb must never be the only place a fact
  lives.
- **H9 Errors & Sync** — the run's outcome becomes a **job row** in the console (feed id, coordinate,
  mode, per-SKU accept/reject, "rehearsed" vs "submitted"), grouped with the sync queue by cause, and
  polled **server-side** by the existing FFS.3 cron. This is what replaces `PublishCard`'s
  `setInterval`: the console reads a durable row, so closing the tab loses nothing.
- **H7 drawer Listings pane** — this row's last publish attempt (from `ChannelPublishAttempt`) plus
  snapshot/restore (3.47) — the undo for the action this feature performs.

**Not H1, not H6, not a Modal.** There is no "publish" cell value. A toolbar control cannot name
which listing it publishes. And a `Modal` cannot carry four steps plus a payload table plus a live
result without becoming the page — while `Drawer` already solves the one hard problem here: its
`overlay` slot exists because a confirm spawned from a drawer opens *behind* it
(`Drawer.tsx:29-35`), which is exactly where the type-to-confirm has to live.

### 6.2 What the sheet shows at rest

| scope | at rest |
|---|---|
| **master** | Nothing publish-shaped. Master is stored truth with no publish target (`PublishMenu.tsx:96-100`); the scope chips' per-channel readiness % is the honest master-level signal, and `Publish ▾` is the only master entry. |
| **channel × market — alias band** | What it has today (status pill · external id · readiness bar) **plus a "last push" mark**: `⇧ 2 d ago · rehearsed` / `⇧ 2 d ago · 19 ok · 1 rejected` / nothing at all when never pushed. Tooltip: coordinate, feed id, mode at the time, outcome. Sourced from `ChannelPublishAttempt` (which records the resolved `mode` and `outcome`), **never** from `__alaPublishMeta` (dead, and it records the request). A rehearsal must never render as a push. |
| **channel × market — variant rows** | A `Publish` status column (H2), `readinessMeta(state,'row')`: `Live` · `Ready` · `Missing` · `Errors` · `Not listed`. Filterable, so "everything blocked on Amazon·IT" is a chip, and clicking a value reveals the offending cell (the `revealCell` capability the drawer already uses). |
| **both** | The existing `Missing required (n)` chip stays the guided-enrichment path; the publish flow never becomes the place you discover a missing field. |

### 6.3 The interaction

**Open** — `publish-alias` from the band's ⋯ / row context menu / Enter on the band, or `Publish ▾`
→ channel, or the selection bar. The flow refuses to open while writes are in flight
(`_studio/saveState.ts` `pendingWrites() > 0`) and says so: a payload assembled over an unaccepted
write describes a value the server does not have.

**Step 1 — Preflight (verdicts per row).** `POST /api/products/sheet/publish-preview` with the
alias's row ids: per-row `ready | warned | unlisted | blocked`, blocked rows naming their fields,
adapted straight into `ActionImpact.findings[]` (the shape ruling #114 created for exactly this).
Rendered as a compact table with a `Pill` per verdict and jump-to-cell on click. One **explicit**
secondary button, never automatic: **"Ask Amazon to validate"** →
`GET /preflight?marketplace=&live=1`, one alias at a time, with the standing caveat printed (a real
production SP-API call; see 6.5 and Q2). `validationPreview: 'unavailable'` renders as *"Amazon could
not be reached — this verdict is local only"*, never as a pass.

**Step 2 — Payload (fields being published, with provenance).** The table 3.14n asks for: every
field that would leave the platform, its resolved value, its **provenance mark** from the same
renderer the sheet uses (`🔗` inherited · `✎` pinned · `✦` AI draft), its write target, and — where
the channel shares a value across markets — a `shared` marker (EU quantity, global-per-ASIN images).
Needs a server projection (§7); today no endpoint returns it, which is why 3.14n is open. An `✦`
unreviewed AI draft is listed and **excluded**, with the reason (ruling #13: AI stays dark, and an
unreviewed draft must not leave the platform). The table's contents become `ActionImpact.payload` —
the snapshot step 4 runs against, closing the time-of-check/time-of-use gap the registry documents
at `:110-122`.

**Step 3 — Mode and confirm.** `GET /api/listings/publish-readiness` → `modeForChannel` →
`gateNote`: the server's own sentence about what a send would do, `null` never rendered as "live"
(`syncQueue.ts:323-378`). Destinations, not targets: markets that write the same thing are collapsed
with the mechanism named (the images lane's rule). A `Toggle` for **Rehearse (dry run)**, ON and —
while the gate is not live — `disabled` with the reason visible, exactly as `PublishPanel` does.
Then the D8 constraint, below.

**Step 4 — Result.** Per coordinate: the server's answer verbatim, the feed id, and the outcome from
**the server's field alone** (`undefined` = "the server did not say"). Wording is "queued", never
"published"; a `dryrun-` feed renders "rehearsed — nothing was sent". The row is simultaneously
written as an H9 job row, so the flow can be closed immediately and the console keeps the answer.
Polling is the cron's job, not the tab's; the console refreshes from the durable row.

**Keyboard / repaint / drawer.** `Stepper` steps go backwards only (`canSelect = done`). Esc closes
except while a run is in flight. On completion the flow invalidates `page` (PES.3 declares no
row-level refetch, per `ActionInvalidation`), so the band's status pill, the publish column and the
readiness bar all repaint from the server. The flow is `variant="modal"` at ~720px: the sheet behind
it must be inert, because a live sheet plus autosave would let a cell change between the payload the
operator approved and the payload that is sent. If the record dock is open it stays open behind the
backdrop — one decision surface at a time.

### 6.4 Per-scope rules

- **Master** — no flow. `Publish ▾` switches the coordinate and opens the flow there.
- **Amazon × market** — the full four steps; alias-group axis; multi-market from step 3 (the route
  takes up to 10 marketplaces). **EU quantity is one pool** — step 2 marks quantity `shared` and
  step 3 says which markets write it (`reference_oversell_is_per_channel_not_summed`,
  `reference_amazon_shared_eu_quantity`).
- **eBay × market** — steps 1–2 only. `notSendable` is the server's refusal and the flow prints it
  verbatim (`sheet-publish.service.ts:134-141`): eBay's publish route re-publishes an existing offer
  and takes no dry-run parameter, so there is nothing to rehearse. **Do not** route it through
  `ebay-parallel-batch` (defect 12). eBay draft rows are still live
  (`reference_ebay_draft_still_live`).
- **Shopify (single store, GLOBAL)** — one coordinate, no market axis; steps 1–2, with
  `notSendableReason`'s `"<channel> has no publish route wired to the sheet"` shown as the reason.
- **A single-alias product** must read exactly as its master parent (Owner, 2026-09-05) — the flow
  opens the same way, the band simply carries no `①` mark.

### 6.5 Provenance / autosave / readiness / publish integration

Provenance is what makes step 2 more than a JSON dump: an operator seeing `🔗` on 40 of 50 fields
knows the listing is mostly inherited, and `✎` on `price` is the one thing they changed today. Same
marks, same renderer — no second vocabulary. Autosave: the flow is gated on zero in-flight writes,
and the approved payload travels as `impact.payload` rather than being re-read. Readiness: step 1
consumes MS.5, which consumes `services/pim/readiness.service.ts` — the ONE definition — so the
chip, the band, the column and the publish verdict cannot disagree; the old tree's four definitions
collapse to one. Publish integration: mode always from the server, dry-run default, and the outcome
always from the server's own field.

### 6.6 Mockup

```
ALIAS BAND ① · Amazon·IT · ACTIVE · B0F7J163XJ · ▓▓▓▓▓▓▓░░ 71%  ⇧ 2 d ago · rehearsed   [⋯]
                                                                        └─ Publish this listing…
┌─ Publish · Amazon · IT · ① Primary ───────────────────────── 720px ─┐
│ ①──②──③──④   1 Preflight  2 What is sent  3 Mode  4 Result          │
│──────────────────────────────────────────────────────────────────────│
│ 20 rows · 18 sendable · 1 blocked · 1 new                            │
│  ⛔ GALE-JKT-BLK-3XL   Country of origin is empty        → jump       │
│  ⚠ GALE-JKT-BLK-XL    "Nero" is not on Amazon's colour list          │
│  ○ GALE-JKT-RED-M     no listing yet — this would create one         │
│                                     [ Ask Amazon to validate ]       │
│  Local checks only. Asking Amazon is a real call to the live         │
│  seller account, one listing at a time.                              │
│──────────────────────────────────────────────────────────────────────│
│ platform mode: dry-run — a green result means "this would have       │
│ worked", not "this is listed".                              (server) │
│ [x] Rehearse (dry run)   disabled — the server's gate is not live    │
│──────────────────────────────────────────────────────────────────────│
│ Send for real is not offered from the studio (Owner sign-off, D8).   │
│ The send lives on the Amazon flat-file surface.                      │
│                                    [ Cancel ]  [ Rehearse 18 rows ]  │
└──────────────────────────────────────────────────────────────────────┘
```

**How D8 constrains step 3.** The Owner signed off row 3.20 — *the studio does not submit to Amazon;
publish is preflight + dry-run and the send stays on the routes that own it*
(`docs/pes-claims.md:20554-20555`, `:20999`). So step 3 offers exactly **one** runnable action:
**Rehearse**, calling `publish-amazon` with `dryRun: true`. The real arm is **built and withheld**,
with the reason and the owning surface printed — a placeholder control that explains itself, not a
greyed button (`feedback_keep_placeholder_controls`, `reference_disabled_control_cannot_explain`).
The type-to-confirm is nonetheless built now, because `validateImpact` refuses a `type-to-confirm`
with no `confirmPhrase` and refuses any confirmation built on a failed preflight
(`registry.ts:270-280`) — retrofitting it the day D8 is lifted is how a five-listing send becomes one
click. The phrase is the coordinate + alias (`AMAZON:IT ①`), never the word "PUBLISH". Note the
asymmetry to put to the Owner: the studio's **image** publish already submits real Amazon feeds
(`_studio/images/.../PublishPanel.tsx:62-67`), so the typed confirm has a live arm today even while
the listing arm is dark.

## 7. Contracts and data

**Reused unchanged:** `POST /api/products/sheet/publish-preview` (step 1) ·
`GET /api/products/:id/preflight?marketplace=&live=1` (step 1's explicit live arm) ·
`GET /api/listings/publish-readiness` (step 3) · `POST /api/products/:id/publish-amazon` with
`dryRun: true` (step 3) · `GET /api/amazon/flat-file/feeds/:feedId` and `GET /…/feeds` (step 4 + H9).

**Server changes (PES.5), in value order:**
1. **Move the dry-run short-circuit below the build** in `amazon-cockpit-publish.routes.ts` so a
   rehearsal composes the feed body, runs the byte-length gate and (optionally) `VALIDATION_PREVIEW`
   — copy the ordering and the do-not-simplify comment from
   `channel-batch/amazon-batch-feed.service.ts:239-257`. Pin it with a test that fails if the
   branches are reordered. **Without this, the flow's only runnable action rehearses nothing.**
2. **Create an `AmazonFlatFileFeedJob` row on every publish** (rehearsal included, flagged), and add
   `productId`, `channelListingId`, `aliasId` to the model (additive) so a product-scoped console can
   filter. This is what hands polling to the FFS.3 cron and makes H9 possible.
3. **A payload projection** for step 2 — `publish-preview` with `?include=payload`, or a sibling
   `POST /products/:id/publish-payload`. The composer exists (`buildRow` + `buildJsonFeedBody`); what
   is missing is per-field provenance, write target and a `shared` flag. Closes 3.14n.
4. **Fix `publish-preflight`'s mode** to `getAmazonPublishMode()` (`marketplaces.routes.ts:1181`), or
   retire the route with its single consumer at swap.
5. **Re-permission the outward-facing routes** onto `F.listingsPublish`, and move
   `GET /preflight?live=1` off `products.view` (it calls production and writes `ListingIssue`).
   Order-sensitive: add before `pfx('/api/products')` and let
   `permissions-manifest-order.vitest.test.ts` prove it.
6. **`aliasId` on the write/send path** — already recorded as D4's precondition; without it a
   per-alias send cannot exist and the flow stays alias-scoped only for its preflight.

**Lane ownership.** **PES.2** — the flow shell as a GDS `ActionFlow` (Drawer + Stepper + `overlay`
confirm) driven by a **pure plan builder promoted from `images/.../publishPlan.ts`**, plus the two
status columns and the pushed mark. **PES.3** — declares `publish-alias` (context/alias-group) and
`publish-rows` (selection), their `preflight()` adapters onto MS.5, and the H9 job rows. **PES.4** —
the drawer Listings pane's last-attempt + snapshot/restore. **PES.5** — all six server items.
**PES.7** — hands `buildPublishPlan` over for promotion and keeps the image arm on the shared shell.
**PES.8** — the "unreviewed `✦` never enters a payload" rule. **PES.1** — wires `Publish ▾` to the
flow. **PES.6** — untouched (mapping is global).

## 8. Risks and traps

- **Every listing in the fixture family is live, and local dev writes the production database** —
  the flow's rehearse arm must be exercised only after server fix 1, and only against a coordinate
  whose gate is confirmed non-live via `/listings/publish-readiness`, read in the same session.
- **`validateListing` is un-gated by design and hits the production host** with a PUT/PATCH to the
  real SKU URL (`amazon-sp-api.client.ts:1066-1073`). It is non-mutating on Amazon's side but it
  **is** a real call on the live seller account and it **does** write `ListingIssue` rows locally.
  Same class as the "Check Amazon" live read-back already on the Owner's queue (#114) → Q2.
- **A rehearsal must never read as a push** — `dryrun-` feeds return a synthetic `DONE`
  (`amazon-flat-file.routes.ts:878-887`), and the pushed mark at rest is where that lie would
  become permanent.
- **eBay/Shopify batch paths are live-by-default** (defect 12) — the flow must not reach them; eBay
  stays preview-only in the server's own words.
- **EU shared quantity** and **images global per ASIN** — a multi-market step 3 can silently
  overwrite; destinations, not targets.
- **Per-channel oversell** — quantity is never summed across coordinates.
- **Untouchable** — `products/amazon-flat-file/**` and `ebay-flat-file/**` own the real send today
  and stay untouched; the studio's flow calls the shared services only.
- **AI dark** — an unreviewed `✦` value must be excluded from a payload, visibly.
- **The old tree is specification** — none of `PreflightPanel` / `PublishCard` / either
  `PublishReviewModal` is imported, wrapped or reskinned.

## 9. Open questions for the Owner (max 3)

1. **Does D8 hold after the swap?** The studio replaces the cockpit that owns `publish-amazon`, so
   after swap the only listing-content send is the flat-file surface. **REC: keep D8 for wave 1** —
   build the flow with the real arm withheld and the reason printed; revisit the moment the rehearsal
   is honest (fix 1) and the feed record is durable (fix 2), which are the two things that make a
   real send safe to offer at all.
2. **May step 1 offer the live Amazon validation?** It is a real production SP-API call on the live
   seller account and it writes `ListingIssue` rows. **REC: yes — operator-pressed only (never on
   mount), one alias at a time, re-permissioned off `products.view`, with the caveat printed.** It
   is the only authoritative answer available before a send, and 3.19n is otherwise unclosable.
3. **Should the typed confirm fire for the IMAGE arm now?** The images lane already submits real
   Amazon feeds. **REC: yes** — one flow, one confirm, and it gives the typed confirm a real
   exercise before the listing arm is ever unlocked.

## 10. Effort and dependencies

| piece | size | depends on |
|---|---|---|
| GDS `ActionFlow` shell (Drawer + Stepper + overlay confirm) + plan builder promoted from `publishPlan.ts` | **M** | DS Drawer/Stepper (exist); PES.2 |
| `publish-alias` + `publish-rows` verbs, preflight adapters onto MS.5, header `Publish ▾` wiring | **S–M** | registry (exists); the flow shell |
| Step 2 payload table with provenance | **M** | server fix 3; provenance renderers (exist) |
| Status column + pushed mark at rest | **S** | `ChannelPublishAttempt` (exists) on the sheet wire |
| H9 feed job rows in Errors & Sync | **S** | server fix 2; console (exists) |
| Server fixes 1 · 2 · 4 · 5 | **M** | PES.5; fix 1 needs a route test (none exists) |
| Live-validation arm | **S** | Q2 |
| Real send arm (dark) | **S** to build, **blocked** to enable | Q1 + fixes 1–2 + D4's `aliasId` |

**Cross-feature dependencies:** readiness (ONE definition, PES.5) · the action registry and the
confirm surface (PES.2) · Errors & Sync (PES.3) · snapshot/restore 3.47 — the undo for this action,
and the reason 3.47 is the highest-value missing row · images publish (PES.7) as both precedent and
the flow's second arm.
