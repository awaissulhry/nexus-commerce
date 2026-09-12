# 32 — Image publish machinery (schedule · approval · rollback · health · audit · history+retry · auto-publish · notifications)

## 1. What it is (operator terms)

Eight capabilities that sit *around* the act of pushing pictures to a channel. An operator who has
just re-ordered the Amazon slot matrix or the eBay bucket grid wants to answer four questions and
arm two habits: **did it go out** (unified publish history + retry), **is this channel healthy**
(per-channel health cards), **who pushed what, when** (publish audit log), **can I go back** (rollback
to the last successful publish); and: *fire it for me later* (schedule), *fire it for me every time I
save* (auto-publish per channel), *stop me firing it by accident* (approval gate), *tell me when the
Amazon feed finishes even if I've moved on* (browser notifications). The person is the catalogue
operator mid-session on one product; the timescale is minutes for eBay/Shopify (synchronous) and
5–30 minutes for an Amazon `JSON_LISTINGS_FEED` (asynchronous), which is the entire reason history,
health and notifications exist at all.

## 2. Old UI — inventory

Shell: `apps/web/src/app/products/[id]/edit/tabs/ImagesTab.tsx` (1,019 L). All eight hang off it.

| # | capability | entry point | round-trip? |
|---|---|---|---|
| 5.11 | **Schedule** | `ImageActionBar` Publish ▾ → `ImagesTab.tsx:891` → `images/SchedulePublishModal.tsx` (300 L) | **server** — `POST` `:116`, `GET ?status=PENDING` `:93`, `DELETE` `:144`; pending-count badge `ImagesTab.tsx:132-142` |
| 5.10 | **Approval gate** | `ImagesTab.tsx:904` → `images/ApprovalModal.tsx` (176 L); flag toggle *also* in `images/AutoPublishSettings.tsx:81` | **localStorage** — `images/approvalPrefs.ts` (105 L), two keys `nexus.images.approvalRequired.<id>` / `…pendingApprovals.<id>` |
| 5.13 | **Rollback** | per-channel `onOpenRollback` (`ImagesTab.tsx:752,778,821`) → `images/RollbackModal.tsx` (295 L) | **localStorage** — `images/publishSnapshotStorage.ts` (209 L); apply is staged as **pending upserts**, not a direct write (`RollbackModal` `addPendingUpsert`) |
| 5.14 | **Health cards** | rendered at the TOP of the tab, `ImagesTab.tsx:565` → `images/PublishHealthCards.tsx` (297 L) | server — `GET /api/products/:id/image-publish-jobs?limit=100` `:128`; `aggregate()` `:76` computes success **rate** + **avg duration** |
| 5.15 | **Audit log** | accordion at the BOTTOM, `ImagesTab.tsx:839` → `images/PublishAuditLog.tsx` (236 L) | server — `GET /api/audit-log/search` `:119` |
| 5.57 | **History + retry** | `images/ImagePublishHistory.tsx` (428 L) | server — `GET …/image-publish-jobs?limit=50` `:140`; `POST /api/image-publish-jobs/:id/retry` `:173` (+ `rejectedOnly` `:364`); "refresh from Amazon" `GET …/amazon-images/feed-status/:jobId` `:160` |
| 5.9 | **Auto-publish after save** | gear popover in the action bar, `ImagesTab.tsx:893` → `images/AutoPublishSettings.tsx` (174 L) | **localStorage** — `images/autoPublishPrefs.ts` (51 L). Wired: `ImagesTab.tsx:851-882` snapshots dirty channels **before** save, then fires `handlePublish` sequentially per armed channel |
| 5.17 | **Browser notifications** | `ImagesTab.tsx:45` → `@/lib/notifications/browser-notifications` | Notification API + localStorage config (`/settings/notifications`); classes `imagePublishComplete` (default OFF) / `imagePublishFailed` (default ON) |

Interactions worth carrying:
- **The approval gate pre-saves before queueing** (`ImagesTab.tsx:384-413`): every channel is flushed
  first so the approver sees a complete state, then `pushPendingApproval`, then a toast. Approve
  re-enters `handlePublish(target, bypassApproval=true)` (`:913`).
- **Snapshot capture is at the call site, per market** (`:465` Amazon, `:484` eBay, `:508` Shopify) —
  taken from the client's pre-reload `listing` array on a 2xx.
- **Notifications fire on two different events.** eBay/Shopify: synchronously on the publish response
  (`:486/:491`, `:510/:515`). Amazon: from a **30-second `setInterval` poll** per feed job, only on a
  genuine terminal transition (`images/amazon/useAmazonImages.ts:456-495`, fire at `:482/:487`).
  Amazon's *submission* fires nothing.
- **One snapshot per coordinate.** `publishSnapshotStorage.ts:36` keys on
  `productId.channel.marketplace|GLOBAL` and `setItem` overwrites — there is no history, only "last".

Nothing here is dead: every component has an importer in `ImagesTab.tsx`.

## 3. Backend that exists

**Routes**
- `POST /api/products/:productId/scheduled-image-publishes` — `routes/scheduled-image-publishes.routes.ts:36`. Validates channel/market, refuses `< now+30s` (`:63`), creates `PENDING`, writes audit `imagePublishScheduled` (`:83`).
- `GET  …/scheduled-image-publishes?status=` — `:101`; **returns `executionEnabled`** read at request time from the same env the cron checks (`:113-116`).
- `DELETE /api/scheduled-image-publishes/:id` — `:121`; only `PENDING` cancellable (409 otherwise). **Not product-scoped** — any id from any product.
- `GET  /api/products/:productId/image-publish-jobs?limit=` — `routes/images/channel-image-publish.routes.ts:146`. Unions `AmazonImageFeedJob` + `ChannelImagePublishJob`, newest first, exposing only `resultSummary.perSku` from Amazon (`:191-200`).
- `POST /api/image-publish-jobs/:jobId/retry` — `:233`. Amazon: refuses `CANCELLED`, refuses `DONE` unless `rejectedOnly`; resolves rejected SKUs → `variantIds`; cancels the old row then re-submits.
- `GET  /api/products/:productId/amazon-images/feed-status/:jobId` — `routes/images/amazon-images.routes.ts:349`.
- `GET  /api/audit-log/search` — `routes/audit-log.routes.ts:34`; cursor paging, `limit` capped at **200**, free-text `search` ORs over `entityId/entityType/action/userId`.

**Services / jobs**
- `jobs/scheduled-image-publish.job.ts` — `runScheduledImagePublishOnce()` `:33` takes 25 due rows; `fireOneSchedule` `:54` calls `submitAmazonImageFeed` per market (`:77`), `publishEbayImagesViaInventory` (`:89`), `publishShopifyImages` (`:92`); marks `FIRED` **after** the push (`:105-113`). Gated `NEXUS_ENABLE_SCHEDULED_IMAGE_PUBLISH === '1'` (`:142-148`); raw `setInterval`, 60 s.
- `jobs/image-publish-reconcile.job.ts` — 3-min status-only sweep, on by default (`index.ts:1736`).
- `services/images/amazon-image-feed.service.ts:296` `submitAmazonImageFeed({… dryRun = false})`; `dryRun` is forwarded for real since the 2026-09-01 fix (`:404-409`); a no-op skip returns `dryRun: true` honestly (`:370-376`).
- `services/channel-batch/amazon-batch-feed.service.ts:221` — rehearsal when `getAmazonPublishMode() !== 'live'`; `:256` the caller's own `dryRun`. Two-layer gate (`services/amazon-publish-gate.service.ts:34-53`, default `gated`).
- `services/images/ebay-inventory-image-publish.service.ts` / `shopify-image-publish.service.ts` — **no `dryRun`, no publish-mode gate of any kind**; `EBAY_API_BASE` defaults to `https://api.ebay.com` (`:48`).
- `services/cascade-image-republish.service.ts:102` — the *only* image path that enqueues an `OutboundSyncQueue` row (`syncType: 'IMAGE_REPUBLISH'`), and it is reached from `/api/channel-publish`, never from the images tab.

**Prisma**
- `ScheduledImagePublish` `schema.prisma:7412` — channel/marketplace/scheduledFor/status/firedAt/cancelledAt/`fireResult` Json/`fireError`/**`createdBy`** (present; the route never writes it).
- `AmazonImageFeedJob` `:8099` — feedId/status/skus/errorMessage/`resultSummary`. **No actor, no `activeAxis`, no `dryRun` column.**
- `ChannelImagePublishJob` `:8201` — **`requestPayload` + `response` Json** ("the exact payload that was sent"), `vendorEntityId`. No actor.
- `ChannelListingSnapshot` `:1800` — PES.5's publish-snapshot table: `reason` (`pre-publish|pre-restore|manual`), `publishEventId`, `payload` ("the payload that was actually SENT"), `label`, `capturedBy`, `restoredAt/By`, denormalised `channel/marketplace/aliasKey`.

**Permissions** (`lib/auth/permissions-manifest.ts`, first-match-wins)
- `/api/image-publish-jobs` → `marketingPublish` (`:164`).
- `/api/scheduled-image-publishes` → `RW(marketingView, marketingPublish)` (`:318`) — matches only the **DELETE**.
- `has('/images')` → `productsImagesEdit` (`:380`) does **not** match `…/amazon-images/publish` or `…/scheduled-image-publishes` (no literal `/images` segment), so both fall through to `pfx('/api/products')` → `RW(productsView, productsEdit)` (`:412`).
- `/api/audit-log` → `auditView` (`:106`).

## 4. Studio today

Everything lives as a **vertical stack of sections** at the bottom of the Images tab, all gated
`scope !== MASTER_SCOPE` (`_studio/images/ImagesTab.tsx:170-201`): planner → `PublishHistory` (`:182`)
→ `ScheduleSurface` (`:186`) → `LocalPublishSettings` (`:192`).

| capability | studio | parity row | verdict |
|---|---|---|---|
| Unified history | `publish/PublishHistory.tsx` + `publish/jobs.ts` (236 L, 7 job states, 10 tests) | 5.57 | ✅ **better than old** — `readJob` `:114` never renders `status` verbatim |
| **Retry** | **absent** — grep for `retry` in `_studio/images` hits only a load-error button and prose | 5.57 | 🕳 named in inventory §30.1 |
| **feed-status refresh** | **absent** | — | 🕳 §30.1 |
| Health cards | `publish/HealthCards.tsx` (76 L) + `publish/health.ts`; fed from the list's own jobs, no second fetch; **no `%` anywhere** (test asserts it) | 5.14 | 🔁 superseded — two of five old figures deliberately dropped as uncomputable |
| Audit log | `publish/auditEvents.ts` + the second list in `PublishHistory` (`:55-56`, `limit=200`) | 5.15 | ✅ with the honest caveat that it cannot be joined to the jobs |
| Schedule | `publish/ScheduleSurface.tsx` (140 L) + `publish/schedule.ts` (121 L) | 5.11 | ⚠ **read-only** — see defect 3 |
| Rollback | `local/LocalPublishSettings.tsx:164-255` + `local/publishPrefs.ts` + `local/restorePlan.ts` (132 L) | 5.13 | ⚠ **Amazon-only in fact** — defect 2 |
| Approval gate | toggle at `LocalPublishSettings.tsx:137-145` | 5.10 | 🔴 **inert** — defect 1 |
| Auto-publish | toggle at `LocalPublishSettings.tsx:128-135` | 5.9 | 🔴 **inert** — defect 1 |
| Notifications | **absent** | 5.17 | 🕳 §30.1 |

Parity-audit §5 rows are **blank in `docs/pes-parity-audit.md`** (lines 290-300, 355); PES.7 recorded
its audit in the inventory doc's §30 instead. §30.1 lists retry + browser notifications as *not
built*; §30.2 records the whole family (history · audit · jobs · schedule) as a **real gap, not a
judgement call** — "78 + 71 rows … newest-first only, no sort or filter".

**Hub rulings that bind this feature**
- **#4** — measured on the prod boot log: `scheduled-image-publish: disabled`, and
  `ScheduledImagePublish` has **zero rows ever**. "The rebuilt schedule surface must state that
  scheduling is currently disabled on prod (or the Owner enables the flag — an ops decision)."
- **#366** — `GET /products/:id/restore-points` exists (PES.5, additive) and **measured that a
  product with 23 audit rows yields 0 restore points because all 23 are image-publish events**: the
  `imagePublish*` lifecycle (191 rows) records *that* something happened, not which values changed.
- **#110** (via report 06) — the CMS doctrine: capture what was SENT, restore writes back as a draft,
  a restore snapshots the current state first.
- **#197 / Owner queue item 7** — PES.7's gap list, "sort/filter on publish history/audit/jobs/
  schedule", recommended as **PES.7-ii**.
- **#247 / Owner queue item 4** — "eBay and Shopify batch submits are LIVE by default (env dry-run
  flags set nowhere; no gate upstream)". Verified for images in §3 above.
- **#13** — no live AI generation. Not touched here.

## 5. Defects and slowness

1. **🔴 Two toggles that promise present-tense behaviour and are read by nothing.** CODE-READ.
   `queueApproval` (`local/publishPrefs.ts:80`) has **no caller outside its own module**; `readAutoPublish`
   (`:23`) is read only to paint the toggle (`LocalPublishSettings.tsx:59`). Neither of the studio's two
   publish fire paths — `channel/amazon/PublishPanel.tsx:62`, `plan/CrossChannelPlanner.tsx:98-100` —
   consults either. So "Publish to AMAZON automatically after a change" and "Require approval before
   publishing" are switches wired to a light bulb that does not exist, and the approval queue can
   never contain a row. The old tab wired both (`tabs/ImagesTab.tsx:384`, `:851-882`). This is the
   one place in this lane's work where the surface is **less honest than the tab it replaces**: the
   panel's disclosure says *"this browser only"*, which is true and irrelevant — the defect is that
   it does nothing in **any** browser.
2. **🔴 Restore points do not exist for eBay or Shopify, and the surface states that as a fact about
   the data.** CODE-READ. `publishPrefs.ts:222-236` `layerRows()` filters `&& r.amazonSlot`; eBay
   image upserts are `{scope:'PLATFORM', platform:'EBAY'}` with no slot (`channel/ebay/buckets.ts:94,133`).
   So on the eBay scope `rows` is always `[]` and the panel renders *"Nothing is pinned to EBAY … so
   there is nothing to record"* (`LocalPublishSettings.tsx:181`) over a grid full of eBay pictures,
   and the button reports *"Nothing to snapshot — this channel has no pictures placed"* (`:75`).
   Latent second half: `restorePlan.ts:100` hardcodes `platform: 'AMAZON'`, so if a non-Amazon
   snapshot ever did exist the restore would write **Amazon** rows. Unreachable today only because
   defect 2's first half keeps the snapshot empty.
3. **🔴 The schedule form has no write path at all.** CODE-READ. `ScheduleSurface.tsx:128` — the
   Schedule button carries no `onClick`; there is no `apiPost`/`apiSend` anywhere in the file, and no
   cancel control for a `PENDING` row even though `DELETE` exists. The module docstring claims *"the
   moment `NEXUS_ENABLE_SCHEDULED_IMAGE_PUBLISH=1` is set … this becomes a working form with no code
   change"* (`:9-11`) — that is false. The disabled-and-explained rendering is exactly right; the
   claim about what happens when the flag flips is a **banked rule that is already false**.
4. **🔴 The cron can double-publish, and is not cluster-safe.** CODE-READ. `fireOneSchedule` reads the
   row, pushes to the channel, *then* marks `FIRED` (`scheduled-image-publish.job.ts:56-113`) — no
   atomic claim (`updateMany where status:'PENDING'`). `setInterval` does not await, so a 5-market
   Amazon loop that outlives its 60 s tick is re-entered on a row still reading `PENDING`. And the
   job uses raw `setInterval`, not `lib/cron/clustered` (verified: no import), so a second API replica
   runs every due row a second time — the exact incident class `lib/cron/clustered.ts:5-10` was written
   for. Inert today (flag off, table empty), a live double-push the hour the flag is set.
5. **🔴 The audit log cannot answer the question it was built for.** CODE-READ. `utils/image-publish-audit.ts:37-39`
   — *"Routes today don't carry auth so we pass null"*; **0 of 10 call sites pass `userId`**
   (`bulk-image-publish.routes.ts:140`, `scheduled-image-publishes.routes.ts:83`,
   `amazon-images.routes.ts:123,147,177`, `channel-image-publish.routes.ts:73,86,116,129`). The helper's
   own header states its purpose as *"who pushed image X to Amazon IT at 14:32?"*. MEASURED-IN-DOC:
   `publish/auditEvents.ts:26` — `userId` null on all 71 entries. `ScheduledImagePublish.createdBy`
   exists in the schema and is never written either.
6. **🔴 Amazon never records an outcome; eBay outcomes carry no job id.** MEASURED-IN-DOC (inventory
   §23, full set of 78 jobs + 71 audit rows). Structural, not a data accident: `amazon-images.routes.ts`
   has no `imagePublishCompleted` call and says so at `:120-122`. Consequence: 43 of 78 job rows
   contradict themselves, and the two logs cannot be joined for eBay at all. **Both are for the
   service owner (PES.5), not PES.7.**
7. **Retry loses the axis and the receipt's provenance.** CODE-READ. `AmazonImageFeedJob` stores no
   `activeAxis`, so `POST /image-publish-jobs/:id/retry` re-submits via
   `submitAmazonImageFeed({productId, marketplace, variantIds})` (`channel-image-publish.routes.ts:299`)
   with the default axis — a retry can send a **different bucket resolution** than the attempt it
   claims to repeat. It also cancels the original row before the re-submit throws-or-succeeds, so a
   failed retry leaves the history with a `CANCELLED` row and no replacement.
8. **The unified list can truncate asymmetrically.** CODE-READ. `channel-image-publish.routes.ts:148-186`
   takes `limit` **per source**, merges, then slices to `limit`. At `limit=100` with 120 Amazon rows,
   the eBay rows that fall outside the newest 100 overall are gone with no marker. The studio requests
   `limit=100` for jobs (`PublishHistory.tsx:54`) and `limit=200` for audit — the audit route's cap is
   exactly 200 (`audit-log.routes.ts:37`), so "all 71 entries" is a **fixture-pinned** claim
   (`reference_a_fixture_pins_a_dimension`).
9. **Family verbs span three permissions.** CODE-READ (§3). Create-a-schedule = `productsEdit`;
   cancel-a-schedule = `marketingPublish`; retry = `marketingPublish`; read the job log =
   `productsView`; read the audit log = `auditView`. An operator who can create a schedule may be
   unable to cancel it, and the audit half of `PublishHistory` 403s independently of the job half —
   the surface has no branch for that. Exactly `reference_family_verbs_split_permissions`.
10. **Polling, and a notification bound to a page.** CODE-READ. Old `useAmazonImages.ts:461` polls
    `feed-status` every 30 s **per job** and fires the desktop notification from that poll — so the
    notification only arrives if the tab stays open, which is the one case where the operator does not
    need it. Any studio rebuild must not re-import this shape.
11. **No sort, no filter, on four lists.** MEASURED-IN-DOC §30.2, conceded by the hub (#197). 78 + 71
    rows, newest-first only, expand-all as the only affordance.
12. **`DELETE /api/scheduled-image-publishes/:id` is not product-scoped** (`:121-131`) — one of the
    five sub-resource routes on the Owner's `:id`-enforcement queue (item 10). CODE-READ.

## 6. Proposed home in the studio

### 6.1 Primary home + mirrors

**PRIMARY — H8, a "Publish" side rail on the Images tab.** The eight capabilities are not eight
sections; they are one column of *the state of publishing on this coordinate*. Today they are a
vertical stack the operator scrolls past the grid to reach (`_studio/images/ImagesTab.tsx:170-201`),
which puts "did it go out" **below** "what is in the slots" — the wrong order for a surface whose
whole job is to be glanced at while you edit. A 320 px right rail beside the matrix/bucket grid,
`position: sticky`, with four collapsible blocks — **Health · History · Schedule · Settings** — keeps
the record in the same viewport as the work that produces it, costs the grid nothing (the Amazon
matrix is slot-wide, not viewport-wide), and gives the Publish button a place to live that is not a
modal. It is the same three-leg reading as `docs/2026-09-01-channel-ops-research.md`: depth beside the
work, verbs in the registry, queues in the console.

**MIRROR — H9, the JOB view into Errors & Sync.** An image publish job *is* a sync job: it has a
target channel, a status, an error message, a retry, and it fails in causes that repeat. The console
already has the shape — grouped by cause, quiet-vs-needs-you, `jumpTargetOf` back to the row
(`channel-ops/ErrorsSyncConsole.tsx:254-357`, `syncQueue.ts:254`) — and it already carries image work
on **one** path (`syncType: 'IMAGE_REPUBLISH'`, `cascade-image-republish.service.ts:102`), just not the
images tab's own. So this is a *second source in one response*, not a second console: `GET
/api/products/:id/sync-queue` gains image-job rows behind a `source` discriminator, mapped into
`SyncQueueRow` with `reason` derived from `errorMessage` the way the existing rows are
(`sync-queue.service.ts:88-97`). The rail's History block then answers "this coordinate, newest
first"; the console answers "everything that is wrong, grouped, across coordinates" — and **retry**
is a registry verb rendered in both. A drawer cannot triage 13 `FATAL` eBay jobs; a rail cannot
either.

**RESTORE — H3/H5 verbs on a server-backed restore point, and localStorage is dropped.** `Restore
images to…` as `CONTEXT(alias-group)` (H5) plus a `SELECTION` variant (H4), declared once in the
registry (`design-system/grid/actions/registry.ts:33-42`, `contextOf('alias-group')`), rendered on the
row menu, the `⋯`, the selection bar and the drawer's action row — never drawer-only
(`channel-ops-research.md` §3.2). The **shapes are report 06 §6's, not new ones**: the same
`reason: 'pre-publish' | 'pre-restore' | 'manual'` vocabulary, the same `publishEventId` join, the same
"the marketplace is not touched" acknowledgement, the same field-level (here: coordinate-level) diff
with un-gradeable entries **listed with a reason and not selectable**. Ruling #366 is the argument
against the cheaper option: image-publish audit rows are *measured* to yield zero restorable moments,
so a restore point must be a **payload capture written by the sender**, exactly as
`ChannelListingSnapshot.payload`'s own comment says. `ChannelImagePublishJob.requestPayload` already
holds that for eBay/Shopify (`schema.prisma:8218`) — the capture is half-built and unread.

**APPROVAL — 🗳 to the Owner: replace with an honest server flag, or drop.** Recommendation: **drop**
the browser-side queue and keep nothing in its place *for now*. It is a self-gate that gates nothing
(defect 1), it is per-browser so it cannot be a control, and the honest server version is a real
feature — a `requiresApproval` flag on the product or channel connection, an approval row with an
actor, and a permission split so the approver is not the requester — which is scope the Owner has not
asked for. What survives is the *preflight*, which the studio already has and which is what an
operator reaching for "stop me" actually wants (`channel/amazon/usePublishGate.ts`). Auto-publish
stays as a per-operator browser preference **only if it is wired to the fire path this pass**;
otherwise it is dropped with the same reasoning. A toggle nobody reads must not ship in either case.

**SCHEDULE — H8 in the rail, disabled-and-explained, with the write path finished.** Keep exactly
`schedule.ts`'s honesty (`readSchedule:40` → "Will not run" / "Never ran"; `executionNotice:113` says
the same thing on an empty list) and add the two writes the surface pretends to have. Ruling #4 makes
the sentence mandatory, and `executionEnabled` (`scheduled-image-publishes.routes.ts:115`) makes it
server-sourced rather than a constant — do not regress that.

**MIRROR — H10, header `Publish ▾`.** One channel item per channel, each **opening the same rail
block scrolled to Publish**, sending nothing itself. Same discipline as report 06: the header is a
router, never a second send path.

### 6.2 What the sheet shows at rest

- **Master scope:** **nothing.** Master has no publish target; there is no image publish state to
  show and no restore point to offer. The rail does not render (matching `ImagesTab.tsx:182-201`
  today).
- **Channel scope, alias band:** the band already carries the family picture and a photo count
  (`sheet/channel/AliasBandCell.tsx:163-166`). It gains **one glyph and one word**: `⟲ n` when this
  coordinate has restore points (opening the History/Restore block on that alias — **never `⟲ 0`**),
  and a publish-state word derived from the job log, three states not two: `Images sent 2h ago` /
  `Never sent` / `Sent, outcome not recorded`. The third is not padding — it is 47% of GALE-JACKET's
  history (§23) and collapsing it into either neighbour is the dishonesty `jobs.ts` exists to prevent.
  The band's `bandTitle` (`AliasBandCell.tsx:64-83`) is where the count and the timestamp go.
- **Channel scope, variant rows:** **nothing new.** Amazon images are per-ASIN global (inventory §4
  finding A) so a per-row image-publish column would assert a per-variant fact the channel does not
  have.
- **A status column (H2), OFF by default:** one derived read-only `Images sent` column — timestamp +
  channel + the `readJob` label — filterable, so *"which coordinates have never actually had images
  pushed"* is answerable in the sheet. Off by default because it is one coordinate-wide fact painted
  on N rows; available in Customise and in a `Never sent` view preset. This is the column that closes
  the hub's sort/filter gap (#197) without turning four rail blocks into four grids.
- **Nothing about schedule, approval or auto-publish appears in the sheet.** A pending schedule is
  visible in the rail and, if it is stranded, as a `danger` pill on the rail header
  (`ScheduleSurface.tsx:70-72`) — not as a cell.

### 6.3 The interaction, step by step

**Publish (unchanged owner, mentioned for the seam).** Rail → Publish block → the existing
`PublishPanel` preflight. On a real send the rail's Health and History blocks repaint, and — new —
a `pre-publish` restore point is written **by the server, inside the publish path**, with
`publishEventId` = the job id.

**Retry** (`ROW` on a History row, `SELECTION` on N, mirrored in the console).
1. **COLLECT** — none for one row; for a selection, the verb drops rows the server refuses
   (`CANCELLED`, `DONE` without rejections) and **names them** rather than silently filtering.
2. **PREFLIGHT** — `ActionImpact.findings[]` from the job's own receipt: `18 SKUs, 4 rejected —
   "inventory_item PUT 400"`. `level` comes from the **publish mode**, not from a flag:
   `getAmazonPublishMode()` rehearsal → `confirm`; `live` → `type-to-confirm` with the SKU as the
   phrase. eBay/Shopify have **no rehearsal at all** (§3), so their `sideEffects[]` says so in the
   server's words.
3. **CONFIRM** — DS `ActionConfirm` (`design-system/grid/actions/ActionConfirm.tsx`), not a new modal.
   `Retry rejected only` is a **separate verb**, not a checkbox, because the two have different
   impacts and the registry's `payload` (`registry.ts:110`) must carry the SKU list the operator
   approved through to `run` (no re-fetch, no time-of-check gap).
4. **RUN** — `POST /api/image-publish-jobs/:id/retry`. `ActionInvalidation` = `page`.
5. **REPAINT** — the History block, the Health card for that channel (same data, no second fetch —
   keep `HealthCards.tsx:6-7`'s property), the console group, and the band's publish-state word.

**Restore images to a point** (`CONTEXT(alias-group)`; drawer's History pane is depth, not the verb).
Pick a point → the list expands into a **coordinate-level diff** (added / removed / moved — the shapes
`publishPrefs.ts:175` already computes, correctly keyed on the row's own `position` and not its array
index) → confirm with `acknowledge`, whose body states the three true things and nothing more: the
**ListingImage rows** change; the current state is captured first as `pre-restore`; **the marketplace
is not touched** until you publish again. `restorePlan`'s two hard-won honesty properties come with
it verbatim: a row that already matches is **not rewritten** (`restorePlan.ts:83-90`) and the number
of live rows a real change would demote is stated **on the control**, not after a Compare
(`:41-50`, `describePlan:128-131`).

**Schedule.** Form in the rail, disabled with the reason in visible text beside it while
`executionEnabled === false`, `undefined` claiming nothing until the server answers
(`ScheduleSurface.tsx:36-40,57` — keep all of this). Enabled: `POST`, optimistic row, `Cancel` per
`PENDING` row via `DELETE`. **A schedule is a deferred publish, so it takes the same confirm as one**
— the preflight runs at *schedule* time and the confirm says, in the server's words, that the mode may
have changed by the time it fires.

**Notifications.** One `Toggle` in the rail's Settings block that links out to
`/settings/notifications` and reflects the shared config (`lib/notifications/browser-notifications.ts`)
— not a second copy of the preference. The fire point moves off the client poll: the studio subscribes
to the existing live-refresh channel for `image-publish-job` terminal transitions, so closing the tab
does not silence it. **Do not re-import the 30 s per-job `setInterval`.**

**Keyboard.** All of it comes free from `useActionPress` + `menuAdapters`: context-menu key on the
band opens the verb list, `Enter` runs, `Esc` cancels. The rail's blocks are `<section>` + a DS
disclosure header, tabbable, no new global shortcut.

**With the drawer open.** The rail is 320 px on the right; the record drawer is a 520 px dock on the
same side. They must not stack: opening the drawer **collapses the rail to a 40 px edge strip**
carrying only the two counts (`n failed`, `n stranded`), and closing it restores the rail. The retry
confirm is a modal over both, and focus returns to the row the verb was pressed on.

### 6.4 Per-scope rules

- **Master:** no rail, no verbs, no restore points. Unchanged from today.
- **Amazon × market:** the rail is per `(AMAZON, market)`, and the restore point is **layer-scoped** —
  restoring IT touches neither DE nor the all-markets rows it inherits from, and the panel says so
  with the inherited count (`LocalPublishSettings.tsx:183-186`). 🔴 But images are **per-ASIN global**
  (inventory §4 finding A): the restore is honest about which *rows* it writes and must not imply the
  marketplace's pictures differ. The sentence to keep is "these are the rows pinned to AMAZON · IT",
  never "this is what Amazon IT shows".
- **eBay:** single-store today, `scope: 'PLATFORM'`, `marketplace: null` (`channel/ebay/buckets.ts:94`).
  So the restore-point coordinate for eBay is `(EBAY, null)` and the slot axis is **bucket × position**,
  not `amazonSlot` — which is precisely defect 2. `layerRows`/`restorePlan` must take a
  channel-supplied coordinate function, not an Amazon field.
- **Shopify:** scope not built at all (§30.1). The rail renders with the same "no rows yet" sentence
  the tab already shows (`_studio/images/ImagesTab.tsx:157-165`); no phantom controls.
- **Alias bands:** eBay image publish is product-level today, not per-alias. Until the publish path is
  alias-aware, the restore verb's subject is the **coordinate**, and a multi-alias eBay product must
  say that a restore is not per-listing rather than offering a precision it lacks — the same rule
  `syncQueue.ts:62-66` applies to `aliasResolved: false`.

### 6.5 Provenance / autosave / readiness / publish integration

- **Provenance.** A restore writes `ListingImage` rows through `bulk-save`, which is the same write
  the matrix cells use, so the cascade's inherited-vs-pinned marks re-derive on reload. Nothing new.
  🔴 `bulk-save` resets `publishStatus` to DRAFT on every upsert — the restore must keep
  `restorePlan.ts:83-90`'s skip-if-identical rule, or a restore silently demotes rows it did not change.
- **Autosave.** A restore is a server write followed by a refetch (`LocalPublishSettings.tsx:96`
  `await reload()`). It must land **after** any in-flight image write settles, or the pending write
  lands on top of the restore — the studio has been bitten by exactly this
  (`reference_autosave_still_needs_a_nav_guard`). The write goes through the lane's own reporter
  (`writeSubject.surface(...)`) so the header's save indicator speaks for it, as it does today.
- **Readiness.** Untouched. Publish state is **not** readiness: a coordinate can be 100% ready and
  never have had images pushed. The band shows both, side by side, and neither is derived from the
  other.
- **Publish integration.** 🔴 The one thing that must change server-side: **capture is the sender's
  job.** A restore point written by the UI from its own pre-publish array (`tabs/ImagesTab.tsx:465`) is
  a record of what the *browser* thought it was sending. `ChannelListingSnapshot`'s own comment says
  this in terms — "not a re-render of the listing, which could differ from what the channel received"
  — and `ChannelImagePublishJob.requestPayload` already stores the real thing for two channels.

### 6.6 ASCII mockup — the Images tab with the Publish rail

```
IMAGES · AMAZON · IT                                              [Publish ▾]  autosave ✓
┌──────────────────────────────────────────────────────┬─────────────────────────────────┐
│ SLOT MATRIX  (NexusGrid, media rows)                 │ PUBLISH                    ⟲ 3 │
│         MAIN   PT01   PT02   PT03   PT04   SAFETY    │ ─────────────────────────────── │
│ Giallo  [img]  [img]  [img]  [ + ]  [ + ]  [img]     │ ▾ HEALTH                        │
│ Nero    [img]  [img]  [ + ]  [ + ]  [ + ]  [img]     │  AMAZON · 43 attempts           │
│ Rosso   [🔗  ]  [🔗  ]  [ + ]  [ + ]  [ + ]  [🔗  ]     │  all 6 recorded outcomes ok —   │
│                                                      │  37 of 43 record no outcome     │
│  🔗 inherited from all-markets · ✎ pinned to IT       │  Typical time  Not recorded     │
│                                                      │ ─────────────────────────────── │
│  ┌ context menu on the band ────────────────┐        │ ▾ HISTORY            78 · 13 ✗  │
│  │ Publish images to Amazon · IT…       ⏎  │        │  Ended      IT  105489020614    │
│  │ Restore images to…                  ⟲  │        │  Failed     eBay 4× inventory…  │
│  │ Retry last failed attempt               │        │  Ended,no report  IT  1054890…  │
│  └──────────────────────────────────────────┘        │  [Retry]  [All 78]  → Errors ↗  │
│                                                      │ ─────────────────────────────── │
│                                                      │ ▾ SCHEDULE                      │
│                                                      │  Scheduled publishing is        │
│                                                      │  switched off on this           │
│                                                      │  deployment — a time set here   │
│                                                      │  would be stored and never      │
│                                                      │  fired. Publish above instead.  │
│                                                      │  [Amazon·IT ▾][──/──]  [Sched]  │
│                                                      │  ⛔ Disabled because nothing on  │
│                                                      │     this deployment would fire  │
│                                                      │ ─────────────────────────────── │
│                                                      │ ▸ SETTINGS   notifications ↗    │
└──────────────────────────────────────────────────────┴─────────────────────────────────┘
```

## 7. Contracts and data

**Reused unchanged**
- `GET /api/products/:id/image-publish-jobs` (`channel-image-publish.routes.ts:146`) → History + Health.
- `POST /api/image-publish-jobs/:id/retry` (`:233`) → the retry verb, both modes.
- `GET /api/products/:id/amazon-images/feed-status/:jobId` (`amazon-images.routes.ts:349`) → the
  per-row "ask Amazon now" affordance.
- `GET /api/audit-log/search` (`audit-log.routes.ts:34`) → the audit list.
- `GET/POST/DELETE …/scheduled-image-publishes` incl. `executionEnabled`.
- `design-system/grid/actions/registry.ts` + `useActionPress` + `ActionConfirm` — no new confirm machinery.

**Server changes (PES.5)**
1. **Capture a restore point inside the publish path**, `reason: 'pre-publish'`,
   `publishEventId` = the job id, `payload` = what was sent. eBay/Shopify already write
   `ChannelImagePublishJob.requestPayload`; Amazon needs the equivalent on `AmazonImageFeedJob`.
2. **One snapshot table, not a parallel one.** Additive on `ChannelListingSnapshot`: `subject String
   @default("listing")` and `productId String?`, so image points are `subject:'images'` and the H7
   Publish-history pane, the list route and the restore route are report 06's, reused. HYPOTHESIS to
   measure first: whether every image coordinate has a `ChannelListing` row to hang `channelListingId`
   on — if not, the fallback is `DROP NOT NULL` on that FK plus the denormalised coordinate the model
   already carries.
3. **A coordinate-level restore route** for images, accepting an optional subset, returning
   `rowsWritten` / `rowsDeleted` / `unpublished` as the source of truth for what happened — the
   consequence `restorePlan.ts:41-50` currently predicts client-side.
4. **Pass `userId` at all 10 audit call sites** and write `ScheduledImagePublish.createdBy`. Defect 5
   is one line per site and it is the difference between an audit log and a timestamped shrug.
5. **`imagePublishCompleted` on the Amazon route / reconcile sweep**, and `jobId` on eBay's two
   outcome writes (inventory §23's two service-owner defects). Until then the surface keeps saying
   so — do not let a rebuild quietly imply a joined log.
6. **Claim the schedule row atomically** (`updateMany where status:'PENDING'` → 1 row) **and move the
   cron to `lib/cron/clustered`** before the flag is ever set. Store `activeAxis` on the job rows so a
   retry repeats the attempt rather than re-deriving it.
7. **Image jobs as a second source in `GET /api/products/:id/sync-queue`**, behind a `source`
   discriminator, mapped to `SyncQueueRow` with `reason` derived from `errorMessage` — and the
   console's coverage note extended to say what the image half cannot see.
8. **Scope `DELETE /api/scheduled-image-publishes/:id` to the product**, and give the four verbs of
   this family **one** permission (recommend `productsImagesEdit`, which the manifest already has and
   which `has('/images')` currently fails to match).

**Schema — additive only:** items 2 and 6 above; nothing else. No new table.

**Lane ownership**
- **PES.7** — the rail (layout, four blocks, collapse-on-drawer), the retry verb's UI, the restore
  diff rendering, deleting `local/publishPrefs.ts`'s approval + auto-publish halves or wiring them,
  and finishing `ScheduleSurface`'s two writes.
- **PES.5** — items 1–8. The restore-point backend is theirs by ruling #110, and defects 4/5/6 are
  service-owner items already recorded read-only.
- **PES.3** — the alias band's `⟲ n` + publish-state marks, and the band's **`⋯` menu itself**:
  `channelActions.ts` declares three verbs (`offer-toggle` ROW `:162`, `broadcast-to-listings`
  SELECTION `:308`, `open-record` ROW `:380`) and **no `contextOf('alias-group')` verb at all**, so the
  band's menu does not render today. Report 06's publish verb and this feature's restore verb are
  both blocked on that one landing.
- **PES.2** — the `Images sent` status column renderer, and sort/filter on the rail's lists (the #197
  gap) if they become grids.
- **PES.1** — routing header `Publish ▾` items into the rail instead of `disabled: true`.

## 8. Risks and traps

- **🔴 eBay and Shopify image publishes have NO rehearsal.** Verified: no `dryRun`, no mode gate in
  `ebay-inventory-image-publish.service.ts` / `shopify-image-publish.service.ts`; `EBAY_API_BASE`
  defaults to production. Owner queue item 4 (#247) is open. Every eBay·IT listing in the fixture
  family is LIVE and a `DRAFT` row still carries a real ItemID
  (`reference_ebay_draft_still_live`). Nothing in this feature may be *exercised* against eBay; safe
  means **verified no push path**, not "the status says DRAFT".
- **🔴 Local dev writes the production database and hits the production API.** A retry pressed in a
  local studio is a real feed to Amazon. The retry verb must be built and confirmed but not run
  during development, and the `type-to-confirm` level must come from the server's mode, never a
  client constant.
- **🔴 The schedule cron is the one control here that would fire *unattended*.** It is off, the table
  has never held a row (#4), and it has defect 4's double-fire and no cluster lock. Finishing the
  form's write path without items 6 is arming a queue that pushes twice.
- **Amazon EU images are per-ASIN global** (inventory §4 finding A) and quantity is shared
  (`reference_amazon_shared_eu_quantity`). A restore point labelled per market is a claim about our
  *rows*, not about what Amazon serves. Word it that way or the operator will read a per-market
  rollback that does not exist.
- **A restore demotes live rows.** `bulk-save` resets `publishStatus` on every upsert; the skip-if-
  identical rule is load-bearing and must not be "simplified" (inventory §26 defect 1, §28's warning
  about the `dryRun` guard is the same class).
- **A duplicate-row rollback looks like success.** An upsert without `id` **creates**
  (`restorePlan.ts:4-8`); a coordinate-matched plan is the only safe shape, and the server-side
  version must keep that property, not re-derive it.
- **Untouchables:** the flat-file image modal calls `/ebay-images/publish` and
  `/products/bulk-image-publish` directly (inventory §4 finding F) — **route contracts must not change
  shape**, only gain additive fields. FBA quantity and the existing import flows are untouched here.
- **AI stays dark** (#13). Nothing in this feature generates.
- **Set claims.** "78 attempts", "71 audit entries", "all 37 receipts" are one product's numbers under
  a per-source `take` and a 200-row audit cap (defect 8). Any figure this rail prints must carry its
  denominator and say when it was truncated — the property `health.ts` already has (no `%` anywhere)
  and the one the list does not.

## 9. Open questions for the Owner (max 3)

1. **The approval gate: honest server flag, or drop it?** *(🗳 — parity row 5.10)*
   **Recommend: DROP the queue this pass, and do not replace it yet.** It gates nothing today
   (defect 1), it is per-browser so it can never be a control on anyone but yourself, and the real
   version is a scoped feature (a server flag, an approval row with an actor, a permission split so
   approver ≠ requester). The preflight already does the job an operator reaches for. If you want the
   habit preserved, the smallest honest version is a **per-product `requiresApproval` flag that makes
   the Publish button refuse with a reason** — one boolean, one refusal sentence, no queue.
2. **Auto-publish-after-save: wire it, or drop it?** *(parity row 5.9)*
   **Recommend: wire it, in the rail's Settings block, as a browser-local per-operator preference that
   says so.** It was real in the old tab (`ImagesTab.tsx:851-882`) and it is a genuine per-operator
   choice, not org config. But a toggle that is read by nothing must not ship: if it is not wired this
   pass, it comes out and goes on the gap list.
3. **Scheduling: finish the form, or leave it read-only?**
   **Recommend: finish it, but only together with the atomic claim and the cluster lock** (§7 item 6).
   Today the surface tells the truth and cannot act (defect 3); that is the safe half. Turning
   `NEXUS_ENABLE_SCHEDULED_IMAGE_PUBLISH=1` on the current cron is an unattended double-publish to
   live channels, so the ops decision and the two server fixes are one decision, not two.

## 10. Effort and dependencies

| piece | lane | effort |
|---|---|---|
| Publish rail shell (4 blocks, sticky, collapse-on-drawer) | PES.7 | **M** |
| Retry verb (registry + confirm + both modes) mirrored in console | PES.7 + PES.2 | **M** |
| Image rows as a `sync-queue` source + console coverage note | PES.5 + PES.3 | **M** |
| Server restore points: capture in the publish path + `subject` on `ChannelListingSnapshot` + restore route | PES.5 | **L** |
| Restore verb + coordinate diff UI (reusing report 06's pane shapes) | PES.7 + PES.4 | **M** |
| Delete the localStorage trio / wire auto-publish (per Q1–Q2) | PES.7 | **S** |
| Finish the schedule form (POST + cancel) | PES.7 | **S** |
| Atomic claim + `lib/cron/clustered` + `activeAxis` on job rows | PES.5 | **S** |
| `userId` at 10 audit sites + `createdBy` | PES.5 | **S** |
| `Images sent` status column + `Never sent` view preset | PES.2 | **S** |
| Notifications off the live channel instead of a poll | PES.7 + PES.1 | **M** |
| Permission unification + `:id` scoping on the DELETE | PES.5 | **S** |

**Dependencies**
- **Report 06 (eBay publish/snapshot/restore) is the parent contract.** Its H7 `Publish history` mode,
  its `reason`/`publishEventId`/`payload` vocabulary and its `pre-restore` undo are the shapes this
  feature reuses. If 06's snapshot pane does not land, image restore points have no drawer home and
  the rail block becomes the only surface — acceptable, but it re-splits a family the Owner asked to
  keep together.
- **PES.3 must land the alias band's `⋯` menu** (no `contextOf('alias-group')` verb exists yet). Both
  06's publish verb and this feature's restore verb wait on it.
- **Feature 16 (Amazon preflight/publish)** owns the fire path this rail reports on; the rail must not
  grow a second one.
- **Feature 17 (suppressions/issues)** and this feature both add sources to the Errors & Sync console —
  one `source` discriminator, agreed once, or the console gains two incompatible row shapes.
- **Owner queue items 4 (#247 eBay/Shopify gates) and 7 (#197 sort/filter)** are both upstream of
  "ship this live rather than dark".
