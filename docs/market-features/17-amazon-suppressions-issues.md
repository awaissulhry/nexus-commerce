# 17 — Amazon SUPPRESSIONS + listing ISSUES + recovery

## 1. What it is (operator terms)

Amazon can keep a listing in the catalogue while refusing to *sell* it: a defect (missing safety
warning, GTIN problem, image quality, price anomaly, hazmat/GPSR gap) makes the ASIN
SEARCH_SUPPRESSED, BLOCKED or INCOMPLETE. The listing looks alive in our records and sells nothing.
Three related jobs sit on top of that: (a) **suppressions** — episode-shaped, "this SKU has been
suppressed 3× this quarter for the same reason", with a per-episode dismiss; (b) **listing issues** —
the per-attribute validation issues Amazon's Listings-Items API names (code + severity + the failing
attribute names), which is what actually tells the operator *which cell to edit*; (c) **recovery** —
when a listing is unfixably stuck, the five delete-and-relist scenarios (republish in place / same
ASIN same SKU / same ASIN new SKU / new ASIN same SKU / full reset), each trading reviews against
Amazon's ~30-day SKU cooldown. The operator is a channel operator triaging "why is this not selling",
usually across many SKUs at once, and only occasionally on the one record in front of them.

## 2. Old UI — inventory

**Entry points.** Amazon cockpit tab (`AmazonCockpit.tsx:56` import, `:791` render) →
`SuppressionCard`. Product header link + drawer link → `/products/:id/recover`
(`ProductEditClient.tsx:1200`, `_shared/ProductDrawer.tsx:1534`). Catalogue-wide surfaces:
`/products/stranded`, `/products/resolve`, and a "Log suppression" modal in
`/listings/amazon` (`AmazonListingsClient.tsx:440-480`).

**`tabs/amazon-cockpit/suppression/SuppressionCard.tsx` (608 lines).**
- `:150` component. `:173` a `useEffect` fetch of `GET /api/products/:id/suppressions?marketplace=`
  keyed on a local `tick` counter — the only refresh mechanism is a manual ↻ button (`:322`).
  No SSE, no polling. Server round-trip on mount and on every ↻.
- `:100` `SEVERITY_TONE` — hand-rolled ERROR/WARNING/INFO → BLOCKER/WARN/INFO with raw Tailwind
  rose/amber/blue.
- `:113` `jumpTargetForReason()` — a **regex list over the reason TEXT** mapping to a cockpit card
  (`/image|photo|swatch/` → images, `/gtin|upc|ean/` → identifiers, …), falling through to
  `'classic'`. Renders a "Fix in <card>" button (`:436`). Browser-local; no server involvement.
- `:196` `handleDiagnose()` → `POST /api/listings/:id/diagnose-suppression`, a **live LLM call**,
  rendered by `DiagnosisPanel` (`:545`) with provider/model/USD cost.
- `:235` `handleResolve()` → `PATCH /api/listings/amazon/suppressions/:id {resolved:true}`, then
  `tick++` to refetch. Fires a cockpit telemetry event.
- `:141`/`:286` per-market Seller Central deep-link (the always-on escape hatch).
- `:349` "Listing quality: N/100" line, fed by the AC.4 `healthReport` **prop** — a second, separate
  scoring system passed in from the cockpit, not from readiness.
- `:501` collapsed "Recently resolved" list (server sends `take: 10`).
- ALL state is component-local; nothing in localStorage.

**`/products/:id/recover` (page.tsx 169 + RecoverClient.tsx 572).** `page.tsx:55-63` fetches
`/health` and `/recover/events` in parallel **through `getBackendUrl()`**. `RecoverClient` is a linear
picker: listing radio-rows → five action cards → optional new-SKU input → a debounced (200 ms)
`/recover/preview` on every (listing, action, newSku) change (`:152`) → consequence panel (4 preserve
pills, before/after ASIN+SKU, blockers, warnings, ETA) → Confirm `POST /recover` (`:198`) → redirect to
`wizardUrl`. `:395` history strip of the last 20 `ListingRecoveryEvent` rows.
🔴 **Both write calls use a RELATIVE `/api/...` URL**, unlike the page shell — see §5.1.

**`/products/stranded/page.tsx` (135).** Server component, `prisma.product.findMany({ where: {
listings: { none: {} } } })` capped at 500, oldest first, `dynamic = 'force-dynamic'`. A raw
`<table>`. Actions are two links (Edit / Create Listing). No suppression content at all — "stranded"
here means *no listing anywhere*, not FBA-stranded inventory.

**`/products/resolve/page.tsx` (157).** DEAD. Queries `VariantChannelListing` — ruled dead at 0 rows
(pes-claims ruling #1) — and instantiates **`new PrismaClient()` twice per request** (`:28`, `:79`).

**What is dead / superseded.** `SuppressionCard` has exactly one importer, the old cockpit.
`/products/resolve` reads a dead table. `/inventory/stranded` and `/inventory/resolve` are redirect
stubs. The recover link is DROPPED by hub D9 (parity rows 8.4 / 8.6) with the Owner's reasoning
recorded as *"History is Recover"* — a claim about the drawer's version history, which is **not** the
same capability as delete-and-relist (see §9 Q2).

## 3. Backend that exists

**Routes** (all under `/api`):
| method + path | file:line |
|---|---|
| `GET /products/:id/suppressions?marketplace=` | `routes/listings-syndication.routes.ts:2384` |
| `POST /listings/amazon/suppressions` (manual open) | `:2293` |
| `PATCH /listings/amazon/suppressions/:id {resolved,restoreStatus}` | `:2338` |
| `GET /products/:id/listing-issues?marketplace=` | `:2440` |
| `POST /listings/:id/diagnose-suppression` (AI, no writes) | `:2510` |
| `GET /products/:id/preflight?marketplace=&live=1` | `routes/amazon-preflight.routes.ts:20` |
| `POST /amazon/suppression/backfill {daysBack,marketplaceCodes}` | `routes/amazon.routes.ts:1857` |
| `POST /products/:id/recover/preview` | `routes/listing-recovery.routes.ts:39` |
| `POST /products/:id/recover` | `:69` |
| `GET /products/:id/recover/events` | `:97` |

**Services.** `services/amazon-suppression-ingest.service.ts` (331) — parses
`GET_MERCHANT_LISTINGS_DEFECT_DATA` TSV, joins by (channel=AMAZON, marketplace, product.sku), upserts
`AmazonSuppression`, then a resolution sweep scoped to `source:'sp-api-poll'`.
`services/listing-issues.service.ts` (101) — `mirrorListingIssues()` at `:41`, fingerprint =
`code + sorted(attributeNames)`, open/resolved lifecycle scoped by `source`.
`services/listings/recovery.service.ts` (432) — `previewRecovery()` `:86` (pure, no side effects),
`executeRecovery()` `:218`: creates the audit row, SP-API `deleteListingsItem` `:318`, marks the
`ChannelListing` ENDED (`isPublished:false`, ASIN cleared for NEW_ASIN_* actions), renames
`Product.sku`, `setTimeout(3000)` propagation courtesy, hands off to the list-wizard.
eBay throws `'eBay recovery not yet implemented'` (`:352`); Shopify/Woo/Etsy blocked to
REPUBLISH_IN_PLACE only. `services/listings/health.service.ts:114` scores
`listingStatus === 'SUPPRESSED'`.

**Prisma** (`packages/database/prisma/schema.prisma`):
- `AmazonSuppression` `:2102` — `listingId`, `suppressedAt`, `resolvedAt?`, `reasonCode?`,
  `reasonText`, `severity` (ERROR|WARNING|INFO), `source` (manual|sp-api-poll|webhook).
  `resolvedAt: null` = currently suppressed. **No composite unique index** → the ingest does
  `findFirst` + branch instead of an upsert (`:176`).
- `ListingIssue` `:2131` — `code`, `severity`, `message`, `attributeNames[]`, `categories[]`,
  `source` (listings-api|validation-preview), `fingerprint`, `firstSeenAt`/`lastSeenAt`/`resolvedAt?`,
  `@@unique([listingId, fingerprint])`. **This is the model that names the failing cell.**
- `ListingRecoveryEvent` `:2212` — `productId`, `channel`, `marketplace`, `action`, old/new ASIN+SKU,
  `status` (PENDING|IN_FLIGHT|SUCCEEDED|FAILED), `completedSteps[]`, `error?`,
  `amazonSubmissionIds[]`, `initiatedBy?`, `startedAt`/`completedAt`/`durationMs`.
- Relations on `ChannelListing` (`:1630`, `:1634`) and `Product` (`:361`).

**External calls + safety gates.**
- `deleteListingsItem` (`clients/amazon-sp-api.client.ts:1175`) — real SP-API DELETE; SKU enters
  Amazon's ~30-day cooldown. 🔴 **Its gate is broken — see §5.2.**
- `validateListing` (VALIDATION_PREVIEW, `:1052`) — **deliberately NOT gated** because it is
  non-mutating (`:1067`), and it must hit the **production** host even in sandbox (`:1110`). This is
  the one live Amazon read available while publishing is `gated`.
- `fetchSpApiReport('GET_MERCHANT_LISTINGS_DEFECT_DATA')` — 30-120 s per market; the service fans out
  serially and warns that 8 markets exceed Railway's gateway (`:295`).

**Jobs/crons.** 🔴 **NONE ingests suppressions or issues.** `grep -oE 'start[A-Za-z]+Cron'
apps/api/src/index.ts` has no suppression entry; `/amazon/suppression/backfill` is a manual route.
`startAmazonSqsPollCron` DOES run and handles `LISTINGS_ITEM_STATUS_CHANGE` (RT.14,
`services/amazon-sqs.service.ts:275-308`, treating SUPPRESSED / NONBUYABLE / DISCOVERABLE as
suppressed) — but the consumer at `jobs/amazon-sqs-poll.job.ts:197-215` only publishes an **ephemeral
SSE `listing.suppressed` event and persists nothing.** That is why the tables are empty (§5.3).

**Permissions** (`lib/auth/permissions-manifest.ts`, first-match-wins on the route PATTERN):
`/api/products/*` → `RW(productsView, productsEdit)` at `:412`; `/api/listings/*` →
`RW(listingsView, listingsEdit)` at `:163`. 🔴 `F.listingsRecover` is mapped to
`pfx('/api/listing-recovery')` at `:347` — **a prefix no route uses** (§5.2).

## 4. Studio today

- **`_studio/channel-ops/`** — `ErrorsSyncTab.tsx` (69, reads `useStudioScope`, jumps via
  `setTab('sheet')` + `record.open(rowId)`), `ErrorsSyncConsole.tsx` (372), `syncQueue.ts` (447,
  pure, 291 lines of tests). Facets Dead/Retrying/Stuck/All as DS `FilterChip`; cause groups as DS
  `PressableRow` disclosures; per-row "Go to row"/"Open sheet"; a `gateNote()` banner; a
  `coverageNote` footer. **It reads ONE source: `GET /api/products/:id/sync-queue`**
  (`routes/product-studio.routes.ts:679`), i.e. `OutboundSyncQueue`.
- **Suppressions are already NAMED as absent**: `syncQueue.ts:296` `DORMANT_SOURCES` lists
  `{key:'suppressions', label:'Suppressions', table:'AmazonSuppression'}` alongside `ListingIssue`
  and `ChannelListing.validationStatus`, rendered unconditionally at `ErrorsSyncConsole.tsx:367`
  ("Not shown here: … — nothing recorded on this coordinate yet").
- **Drawer**: `drawer/panes/ListingsPane.tsx` renders `listing.listingStatus` verbatim (`:103`),
  Pushed/Offer/Price/Quantity/Channel-reference/Last-synced, then readiness errors and warnings
  (`:186-206`), then registry verbs (`:213`). Read-only by design (`:8`).
- **Alias band**: `sheet/channel/AliasBandCell.tsx:131` reads `alias.listingStatus ?? 'NOT LISTED'`;
  per the 2026-09-05 Owner note in that file the status **left the band** and now lives only in the
  `CompletenessPill` tooltip.
- **Server projection**: `services/pim/studio-sheet.service.ts:251` already ships
  `listing.listingStatus` on the wire (selected at `:416`). No suppression/issue field.
- **Registry**: `design-system/grid/actions/registry.ts` — ROW / SELECTION / CONTEXT(axis), `available`
  returning available|hidden|disabled(reason), async `preflight()` → `ActionImpact` whose
  `level` ('none'|'confirm'|'type-to-confirm') comes from the fetched facts, `findings[]` carrying
  `rowId`. `sheet/channel/channelActions.ts` declares `offer-toggle`, `broadcast-to-listings`,
  `open-record`; `CHANNEL_VERB_PERMISSION = 'products.edit'` (`:52`).

**Parity audit.** Row **3.25**: *"🕳 — no suppression surface. `AmazonSuppression` rows exist in the
schema and nothing reads them here."* Rows **8.4 / 8.6**: the Recover link + its prefetch are
🗳 DROPPED by D9. No parity row exists for `ListingIssue` or the preflight report.

**Hub rulings that bind this feature.**
- **#127** — the Errors & Sync console is APPROVED as proposed, **Retry ships preview-first**.
- **#126** — the console is a channel-scope TAB, one live pane, grouped **by cause**, rows JUMP to
  the row/drawer, and a footer must NAME the dormant sources so silence is not read as "none".
- **#116** — 🔴 *"three of the four queue sources are PERMANENTLY EMPTY on prod — ListingIssue 0 ·
  AmazonSuppression 0 · validation≠VALID 0; only OutboundSyncQueue is live at 37,846 rows / 2,553
  dead."* MEASURED-IN-DOC 2026-09-01.
- **#110 / #113 / #114 / #118** — one action registry; verbs declared by the lane, rendered by every
  surface; severity from the preflight; the preflight's payload carried into `run`.
- **#13** — NO live AI generation. The old card's Diagnose button cannot be re-enabled.
- **#125.2 / #235** — never invent a state the server did not report.
- Wave-2 backlog (#110 dispatch note, ledger `:20452`) lists **"suppressions dismiss"** as queued,
  not built.

## 5. Defects and slowness

1. 🔴 **The recover page's ACTION HALF cannot work in production.** CODE-READ.
   `RecoverClient.tsx:152` and `:198` fetch relative `/api/products/...`. `install-fetch.ts:40` only
   rewrites requests whose **resolved origin === the API origin**; a relative URL resolves to the WEB
   origin, so it passes through untouched. `next.config.js:29-33` adds an `/api/:path*` rewrite ONLY
   when `NEXT_DEV_STUB_PROXY` is set, and its own comment says *"Unset everywhere real (prod, Vercel,
   the pre-push build) → zero rewrites."* So preview and execute hit the Next server, which has no
   such route. The page shell loads (it uses `getBackendUrl()`), which is exactly why this looks
   healthy: the operator sees listings and action cards, and the consequence panel never fills in.
2. 🔴 **`deleteListingsItem` bypasses the master publish flag.** CODE-READ.
   `amazon-sp-api.client.ts:1183` reads `process.env.AMAZON_PUBLISH_MODE` **directly**; every other
   write method calls `getAmazonPublishMode()` (`:568`, `:718`, `:841`, `:933`), which returns
   `'gated'` whenever `NEXUS_ENABLE_AMAZON_PUBLISH` is unset
   (`amazon-publish-gate.service.ts:38-45`). With `AMAZON_PUBLISH_MODE=live` and the master flag off
   — the state ruling #127 measured on prod, *"all three channels report GATED … despite sellerId and
   LWA creds both present"* — every publish is refused and **a recovery DELETE would still go out for
   real**. Two claims assert the opposite: the method's own JSDoc (`:1172` "respects
   AMAZON_PUBLISH_MODE for parity with putListingsItem") and the A1.1 test file header
   (`amazon-sp-api.client.vitest.test.ts:2` "gates EVERY write method through getAmazonPublishMode()")
   — whose four cases cover `submitListingPayload`, `patchListingPrice`, `putListingsItem` and never
   `deleteListingsItem`. A set claim with a missing member.
3. 🔴 **`F.listingsRecover` gates nothing.** CODE-READ. `listingRecoveryRoutes` registers at
   `prefix: '/api'` (`index.ts:727`) with paths `/products/:id/recover*`, so the live pattern is
   `/api/products/:id/recover`. The manifest's `pfx('/api/listing-recovery')` (`:347`) matches no
   route in the repo (`grep -rn "listing-recovery" apps/api/src` returns only the import, the comment
   and that manifest line). First-match-wins therefore lands the destructive POST on `:412`
   `RW(productsView, productsEdit, pfx('/api/products'))` — **anyone who can edit a product can
   delete a live Amazon listing and rename its SKU.** Same family as the memory pointer "family verbs
   span TWO permissions": the route decides, not the subject matter (#126).
4. 🔴 **A suppressed listing reads "live" on every studio surface.** CODE-READ.
   `services/pim/sheet-rows.service.ts:264` returns `state:'live'` on `externalListingId &&
   isPublished`, evaluated **before** anything could consider a suppression, and readiness issues come
   only from our own schema validators (`readiness.service.ts` header). The manual open route does set
   `listingStatus:'SUPPRESSED'` (`listings-syndication.routes.ts:2325`) but leaves `isPublished` true;
   the SP-API ingest never touches `listingStatus` at all. So the scope chip, the alias band's
   `CompletenessPill` and the drawer's readiness pill all say **live** for a listing that sells
   nothing. This is the 100%-honest-UI rule failing on the exact fact the operator needs.
5. 🔴 **Dismissing ONE suppression declares the whole listing ACTIVE.** CODE-READ.
   `:2338-2360`: resolving suppression *i* sets `listingStatus = body.restoreStatus ?? 'ACTIVE'`
   unconditionally — it does not check whether other `resolvedAt: null` rows remain on that listing,
   and it overwrites whatever the real status was (ENDED, INACTIVE, DRAFT). Three open blockers, one
   dismiss, and the record claims ACTIVE.
6. 🔴 **The real-time detector persists nothing.** CODE-READ. `amazon-sqs-poll.job.ts:199-215` fires
   an SSE `listing.suppressed` event and deletes the SQS message. No `AmazonSuppression` row, no
   status write. The event is ephemeral (memory pointer: durable vs ephemeral lanes) — miss the
   moment and the fact is gone. Combined with the absent cron, this is the mechanism behind #116's
   measured `AmazonSuppression 0`.
7. **`ListingIssue` is written only downstream of a publish.** CODE-READ. The two callers of
   `mirrorListingIssues` are `amazon-cockpit-publish.routes.ts:420` (after a real submit) and
   `preflight-report.service.ts:223` (`live=1`). Publishing is gated on prod, so the richer of the two
   models has never been populated — although the second path is reachable **today** as a pure read
   (§6.1).
8. **N+1 in the ingest.** CODE-READ. `amazon-suppression-ingest.service.ts:154` runs a
   `channelListing.findFirst` per TSV row, then `:176` a `findFirst` and `:186`/`:196` a write per
   row. A defect report is thousands of rows per market.
9. **The ingest's resolution key is malformed and saved only by a fallback.** CODE-READ. `:225`
   builds `` `${s.listingId}|${s.reasonCode}|${s.reasonCode}` `` while `observedKeys` holds
   `listingId|reasonCode|defectType` (`:174`), so the direct `has()` is essentially always false; only
   the O(n·m) prefix scan at `:231` produces the right answer. A future edit that trusts the key
   silently resolves every open suppression.
10. **Two competing quality scores.** CODE-READ. `SuppressionCard:349` prints the cockpit's
    `computeHealthScore` number; `readiness.service.ts` is the studio's single definition
    (layout doc §"Readiness"). Its own comment admits the pre-PES.5 split *"the sheet's readiness pill
    and the publish path could — and did — disagree about the same product."* Do not re-import the
    cockpit score.
11. **Reason→destination by regex over free text.** CODE-READ. `SuppressionCard:113` classifies
    Amazon's prose with eight regexes. `ListingIssue.attributeNames[]` is the *structured* answer to
    the same question and is what the studio should route on.
12. **The dormant-sources footer states a fact it never checked.** CODE-READ.
    `ErrorsSyncConsole.tsx:367` prints "nothing recorded on this coordinate yet" unconditionally; the
    console queries only `sync-queue`. True today by #116, and it would keep saying so on the day the
    first suppression lands.
13. **`/products/resolve` is dead and leaks connections.** CODE-READ. Dead table (#1) plus
    `new PrismaClient()` at `:28` and `:79` — two clients per request.
14. **No tests.** `SuppressionCard`, `RecoverClient`, `recovery.service.ts` and
    `amazon-suppression-ingest.service.ts` have no test files; `listing-issues.service.ts` has none
    either. The only tests in the family are `syncQueue.vitest.test.ts` (the console) and the A1.1
    client gate suite that misses `deleteListingsItem`.

## 6. Proposed home in the studio

### 6.1 Primary home + mirrors

**PRIMARY: H9 — the Errors & Sync console gains a SOURCE axis, with "Suppressions" and "Listing
issues" as two of its sources.** This is where the shape already is and where the evidence points.
The console's own header calls itself *"sync-queue-first"* because a four-pane console *"would have
been three empty panes"* — the correct call at #127, and it left the extension point behind:
`DORMANT_SOURCES` (`syncQueue.ts:296`) names these two tables by name. Channel-ops research pattern A
is unambiguous — *"queue-shaped work (errors, suppressions, sync drift — triaged by error TYPE across
many SKUs) … a channel-scoped CONSOLE in all eleven platforms, never inline-only"* — and the
suppression set is genuinely cause-shaped: one missing GPSR attestation suppresses twenty SKUs, and
`groupByCause` is the machinery that says so. The console already owns the two hard parts (cause
grouping with both-direction tests, and jump-to-row via `jumpTargetOf`). The change is a **source
selector above the existing facet row**, each source with its own facets, so the existing Dead /
Retrying / Stuck chips stay bound to the sync queue where they mean something and a suppression is not
forced into a retry vocabulary it does not have.

**MIRROR A: H2 — an "Amazon status" status column on the Amazon channel scope.** Read-only, derived,
filterable: `ACTIVE` · `⚠ Suppressed — <reasonCode or first reason>` · `Blocked` · `Not listed`, with
the full reason text, severity, `suppressedAt` and source in the tooltip. It exists because §5.4 is
the worst defect in this feature: the sheet currently says **live**. A mark on a column the operator
can filter is the smallest honest fix, and `listingStatus` is already on the wire
(`studio-sheet.service.ts:251`) — only the reason needs adding.

**MIRROR B: H3 — one ROW verb, `suppression-dismiss`.** Declared in `channelActions.ts` beside
`offer-toggle`, so it renders on the row context menu, the `⋯` column, the selection bar (H4, N rows
at once — a whole GPSR wave is dismissed together after one fix) and the drawer. A verb must never
live only in the drawer (research §3.2, ruling #110). Its `preflight()` names each episode it is about
to close and, critically, **warns when other episodes remain open on the same listing** — the
`ActionImpact` shape exists precisely so the confirm is built from fetched facts rather than a flag.

**MIRROR C: H7 — the drawer's Listings pane gains a "Channel says" section.** Below the existing
facts: open suppression episodes (reason · severity · since · source), then open `ListingIssue` rows
with their `attributeNames` rendered as **links that reveal the cell** (`drawer/revealCell.ts` already
does this), then the recovery timeline from `GET /products/:id/recover/events`. This is the depth leg —
episode history, "3 times this quarter", who dismissed what — and decision-log #5 already assigns
*"listing status + channel errors"* to the drawer.

**MIRROR D: H6 — a SheetToolbar `trailing` verb, "Check with Amazon".** The one lever that makes half
this feature LIVE rather than dark: `GET /api/products/:id/preflight?marketplace=&live=1` runs
VALIDATION_PREVIEW, which is **non-mutating and deliberately ungated**
(`amazon-sp-api.client.ts:1067`), and `preflight-report.service.ts:223` already mirrors the result into
`ListingIssue`. So the studio can populate the issues source on demand, today, with a read — no cron,
no flag change, no write to a live listing.

**MIRROR E: H7 + H10 for recovery — fold the recover page in, do not rebuild it.** The recovery
*picker* is a five-way decision about one listing with a consequence panel: that is a drawer flow, and
the registry's `type-to-confirm` level plus `ActionImpact.consequences`/`sideEffects` already express
exactly what `PreviewPanel` renders (reviews/ASIN/SKU preserved, cooldown risk, blockers, warnings).
So: **`recover-listing` as a CONTEXT(alias-group) verb (H5)** — the alias band is the listing, which is
what recovery acts on — whose preflight calls the existing `POST /recover/preview` and whose confirm is
the consequence panel; the `ListingRecoveryEvent` timeline lives in the drawer's Listings pane; a
`Recover…` entry on the header `⋯`/`Publish ▾` grouping (H10) is the discoverable entry for someone
who arrived to do exactly that. `/products/:id/recover` is then **H12 dropped** — consistent with D9,
and honestly so, because the flow survives rather than being deleted with the link.

**Explicitly NOT recommended.** *H1 (a cell)* — a suppression is not a value the operator authors.
*A "Suppressions" tab of its own* — tabs are for non-tabular surfaces and the console is the approved
home for queues. *Re-enabling AI Diagnose* — ruling #13; build the button dark or not at all.
*`/products/stranded`* — it is a catalogue-wide report about products with no listings anywhere,
which is H11 (a page outside the studio) and not this feature; leave it where it is.

### 6.2 What the sheet shows at rest, per scope

| scope | column | mark | tooltip | chip |
|---|---|---|---|---|
| **master** | none | none | — | none |
| **Amazon × market** | `Amazon status` (read-only, pinned right of `Completeness`, filterable) | `⚠` in the cell for a suppressed/blocked listing; on the **alias band** a `⚠` beside the `CompletenessPill` | full reason text · severity · `suppressedAt` · source · "N open" when >1 | `Suppressed (N)` and `Listing issues (N)` on the View bar, `hideWhenZero`, `count: null` when unqueried |
| **eBay / Shopify × market** | the column exists but renders `—` with "Amazon-only" in the tooltip | none | — | chips absent |

Both chips go through `useRegisterViewChip` and MUST obey the honest-count rule in
`sheet/channel/viewChips.ts:8-16`: `count: null` (uncounted, chip visible, no number) is not
`count: 0` (counted, none, hidden). A suppression chip's `cells.byRow` maps the row to the
`Amazon status` column; an issue chip maps the row to the columns its `attributeNames` resolve to,
and any attribute that is **not** a column on this scope is excluded from the count and reported in
`note` — the rule that file already enforces, for the same reason (an uncountable cell is an
unreachable destination).

### 6.3 The interaction, step by step

**Console path (H9).**
1. Channel scope → `Errors & Sync` tab. A DS `SegmentedControl` of sources above the facet row:
   `Sync queue (2,553) · Suppressions (—) · Listing issues (—)`. An un-queried source shows `—`,
   never `(0)`.
2. Pick `Suppressions`. Facets become DS `FilterChip`s `Open · Resolved · All` (the sync queue's
   Dead/Retrying/Stuck do not apply and are not shown). One fetch:
   `GET /api/products/:id/suppressions?marketplace=`.
3. Rows group by `reasonCode ?? normaliseMessage(reasonText)` through the **existing** `groupByCause`
   — the normaliser is already tested in both directions (#128) and needs no second copy. Group
   header is a DS `PressableRow` with the reason, the episode count, `since`, and severity tone.
4. Expand a group → rows: SKU · severity · `suppressedAt` · source · reason (verbatim, `title` for
   the untruncated text) · a DS `Button variant="link"` `Go to row` (or `Open sheet` when the alias
   is unresolved — the two-label honesty already in `ErrorsSyncConsole.tsx:334`).
5. A **selection checkbox per row + a group-level "Dismiss all in this group"** feeding the H4
   selection verb.
6. **Dismiss** → registry sequence COLLECT (the episode ids) → PREFLIGHT (`GET
   /products/:id/suppressions` re-read: how many episodes, do any remain open on each listing, is the
   listing's real status something other than ACTIVE) → CONFIRM (DS `ActionConfirm`, level
   `'confirm'`, escalating to `'type-to-confirm'` when the dismiss would flip a listing's status while
   other blockers stay open) → RUN (`PATCH /listings/amazon/suppressions/:id` per episode, `restoreStatus`
   passed explicitly from the preflight's reading, never defaulted).
7. Repaint: the console's source refetches; the sheet's `Amazon status` column and the two View chips
   invalidate at `'page'` scope (the registry's honest declaration — a dismiss can change the alias
   band's mark, not just one cell). Sheet scroll and selection are preserved; the sheet stays live.
8. **Keyboard.** Source selector `←/→`; facets `Tab` then `Space`; group header `Enter`/`Space` (the
   `PressableRow` carries `aria-expanded`); `Enter` on a row = Go to row; the verb inherits the
   registry's `useActionPress`. `Esc` closes the confirm only.
9. **With the drawer open** (non-modal, 520 px, layout-v2 §5): the console is a tab, so the drawer's
   record is a different surface — jumping to a row with the drawer already open re-targets the drawer
   to that row (`ErrorsSyncTab.tsx:39` `setTab('sheet')` + `record.open(rowId)` already does exactly
   this, and PES.1 coalesces both URL writes into one navigation).

**Recovery path (H5/H7).** Alias band `⋯` → `Recover this listing…`. `available()` returns
`disabled('eBay recovery is not implemented on the server')` for eBay, `disabled('<channel> loses
app-tied reviews on delete — only Republish in place is available')` for Shopify-like, and
`disabled('No ASIN on this listing yet — publish it instead')` when `externalListingId` is null (all
three refusals are already computed server-side in `previewRecovery`, so the verb reads them rather
than re-deriving). `preflight()` opens a **DS `Modal` with a DS `Stepper`**: pick action (5 cards) →
new SKU where required → the consequence panel built from `POST /recover/preview`. Blockers make the
confirm unrunnable; `skuCooldownRisk` forces `'type-to-confirm'`. RUN posts `/recover` **through
`getBackendUrl()`** and, on success, opens the wizard URL in a new tab rather than navigating away
from the studio.

### 6.4 Per-scope rules

- **Master**: nothing. Master is the stored truth; a suppression is a channel's verdict. The
  `Errors & Sync` tab is already hidden on master (`scopes.ts:222`) and the console's own empty state
  says why (`ErrorsSyncTab.tsx:50`).
- **Amazon × market**: the full feature. Suppressions are **per marketplace** — the ingest joins on
  `marketplace: args.marketplaceCode` — so IT and DE are independent episodes even where the ASIN and
  the EU quantity are shared. Never roll a market up into a single "Amazon" figure.
- **eBay × market**: no suppression model exists. The column renders `—` / "Amazon-only"; the console
  source selector shows `Suppressions` **disabled with a reason**, not hidden — an absent source and
  an empty source must not look the same. Recovery is disabled with the server's own sentence.
- **Shopify (single store, GLOBAL)**: same as eBay, plus recovery is limited to REPUBLISH_IN_PLACE.
- **Alias bands**: an episode belongs to a `ChannelListing`, i.e. to ONE alias. On a product with two
  aliases the `⚠` sits on the band that owns it and never on its sibling.

### 6.5 Provenance / autosave / readiness / publish

- **Provenance**: none. `🔗 / ✎ / ⚠ / ✦` describe where a *value* came from; a channel-reported status
  is not a value in any layer. The `Amazon status` column is `editable: false`, `writable: false`,
  `writeField`/`writeTarget` absent — it is not part of the write contract.
- **Autosave**: uninvolved. A dismiss is an explicit verb through the registry, never a cell write, so
  it does not touch `sheetWriter`/`expectedVersion` and cannot be undone by ⌘Z. It must also be
  serialised against an in-flight autosave (memory: *an in-flight autosave UNDID an API revert*) —
  the verb's `run` should wait for the save reporter to settle before its re-read.
- **Readiness**: 🔴 **the percentage must NOT change.** Readiness measures our data against the
  channel's schema (`readiness.service.ts` header); folding a channel verdict into it would make the
  number mean two things and break the ONE-definition rule. What must change is the **state**:
  `sheet-rows.service.ts:264` should not return `'live'` for a listing with an open ERROR-severity
  suppression. The honest minimum is to keep the five-member union and reorder the test so a
  suppressed listing falls to `'errors'` — a state the pill, the band and the drawer already render —
  and to carry `suppression: {count, severity, reasonCode, since} | null` on the wire so the tooltip
  can say *why*. Widening the union to a sixth member `'suppressed'` is the cleaner answer and is an
  Owner call (§9 Q1) because every consumer of `ReadinessState` (`readinessMeta.ts`,
  `viewChips.ts`, `listingRisk.ts`, master + channel `types.ts`) must degrade safely first.
- **Publish**: a suppression is a **preflight finding, never a block.** `AliasPublishControl`'s
  publish-preview should list open suppressions and issues under `findings[]` with `severity:'error'`
  so the operator sees them before submitting, while the mode still comes from the server
  (`getAmazonPublishMode()`, never env). Republishing IS frequently the fix for a suppression, so
  refusing publish on a suppression would block the remedy.

### 6.6 ASCII mockup — Errors & Sync, Suppressions source

```
┌ Amazon · IT ─────────────────────── 3 open suppressions across 2 causes · 3 need you ┐
│ Source  [ Sync queue (2,553) ][ Suppressions (3) ][ Listing issues (—) ]              │
│ [ Open (3) ][ Resolved (10) ][ All ]                                 [Check with Amazon]│
│ ⓘ Amazon publishing is gated on the server. Dismiss records OUR verdict; it does not   │
│   ask Amazon to re-review. Amazon clears a defect on its own next report.             │
├───────────────────────────────────────────────────────────────────────────────────────┤
│ ▾ MISSING_SAFETY_WARNING            2 episodes   since 12 Aug   BLOCKER    needs you  │
│   Gave up: no GPSR safety attestation on this listing — Amazon suppresses search.     │
│   ┌─────────────────────────────────────────────────────────────────────────────────┐ │
│   │☐ GALE-KAN-PRO-M   ERROR  24d  sp-api-poll  "Missing safety warning…"  [Go to row]│ │
│   │☐ GALE-KAN-PRO-L   ERROR  24d  sp-api-poll  "Missing safety warning…"  [Go to row]│ │
│   └─────────────────────────────────────────────────────────────────────────────────┘ │
│   [Dismiss 2 episodes…]                                                               │
│ ▸ IMAGE_MIN_PIXELS                  1 episode    since 2 Sep    WARN       needs you  │
├───────────────────────────────────────────────────────────────────────────────────────┤
│ 86% of the sync queue is attached to no product, so this view cannot show it.         │
│ Listing issues: never populated on this coordinate — run "Check with Amazon" to ask.  │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

## 7. Contracts and data

**Reused unchanged (no server work):** `GET /products/:id/suppressions?marketplace=` ·
`PATCH /listings/amazon/suppressions/:id` · `GET /products/:id/listing-issues?marketplace=` ·
`GET /products/:id/preflight?marketplace=&live=1` · `POST /products/:id/recover/preview` ·
`POST /products/:id/recover` · `GET /products/:id/recover/events`.

**Server changes (PES.5):**
1. `studio-sheet.service.ts` — add to the `listing` projection:
   `suppression: { openCount, severity, reasonCode, reasonText, since } | null` and
   `issueCount: { errors, warnings } | null`. **`null` = not queried; `openCount: 0` = queried and
   none.** One grouped query per coordinate, never per row.
2. `sheet-rows.service.ts:264` — an open ERROR suppression must not resolve to `'live'` (§6.5).
3. **FIX `amazon-sp-api.client.ts:1183`** — call `getAmazonPublishMode()`, and extend
   `amazon-sp-api.client.vitest.test.ts` with a `deleteListingsItem` case (mutation-test it: removing
   the gate must fail).
4. **FIX `permissions-manifest.ts:347`** — map `F.listingsRecover` to the pattern the route actually
   serves, ordered **before** the `/api/products` catch-all at `:412`, with an rbac-coverage assertion.
5. **FIX `listings-syndication.routes.ts:2338`** — do not restore a listing's status while other
   `resolvedAt: null` episodes remain; return the remaining open count so the UI can say so.
6. **Additive schema (pre-approved class):** `@@unique([listingId, reasonCode])` on
   `AmazonSuppression` for open rows would let the ingest upsert instead of `findFirst`+branch — worth
   proposing but it needs a partial index on `resolvedAt IS NULL`, so treat it as a PES.5 call, not a
   drive-by. No new tables: `AmazonSuppression`, `ListingIssue`, `ListingRecoveryEvent` are all
   sufficient.
7. Persist the RT.14 SQS notification (`amazon-sqs-poll.job.ts:199`) as an `AmazonSuppression` row
   with `source:'webhook'` — the schema already reserves that vocabulary (`:2100`). Alternatively, cron
   the existing backfill per market. Either makes the source live; **both are out of this feature's
   scope and belong to the Owner's queue-hygiene call.**

**Lane ownership.** PES.3 (channel sheet): the console's source axis, the `Amazon status` column, the
two View chips, `suppression-dismiss` in `channelActions.ts`, the `recover-listing` CONTEXT verb.
PES.4 (drawer): the "Channel says" section in `ListingsPane` + the recovery timeline + reveal-cell
from `attributeNames`. PES.5 (backend): items 1-7 above. PES.2 (grid substrate): nothing new — the
registry, `ActionConfirm`, `PressableRow`, `FilterChip` and `revealCell` all already exist.
PES.1 (frame): nothing — the `'errors'` tab id already exists (`types.ts:39`).
PES.6/7/8: nothing.

**DS components used:** `SegmentedControl` (source axis) · `FilterChip` (facets) · `PressableRow`
(cause disclosure) · `Button variant="link"` (jump) · `Checkbox` (row selection) · `BulkActionBar`
(selection verb) · `Banner` (the gate/dismiss-semantics note) · `EmptyState` · `Pill`/`Badge`
(severity) · `Tooltip` · `Modal` + `Stepper` (recovery) · `ActionConfirm`. **No new DS component is
needed.**

## 8. Risks and traps

- **Live listings.** `POST /products/:id/recover` really deletes an Amazon offer and renames
  `Product.sku`. Combined with §5.2 and §5.3 it is currently reachable by anyone with `products.edit`
  and not covered by the master flag. **Fix the gate and the permission before building any studio
  surface that calls it** — the verb would otherwise make an unguarded destructive endpoint one
  right-click away instead of two navigations.
- **Local dev writes PROD.** `PATCH /listings/amazon/suppressions/:id` and the recover POST both hit
  the production database from a local session. A dismiss is not a probe.
- **"Check with Amazon" hits the production SP-API host even in sandbox** (`:1110`) and is
  deliberately ungated (`:1067`). It is read-only, but it consumes real quota, and per-market defect
  reports take 30-120 s (`amazon-suppression-ingest.service.ts:295`) — never fan it out across markets
  from one click.
- **Dismiss is OUR verdict, not Amazon's.** The button records `resolvedAt` locally; Amazon clears a
  defect on its own next report. The surface must say so, or the operator will believe they fixed
  something. The old card's tooltip half-said it (`SuppressionCard:463` "e.g. after the next report
  ingest"); the studio should say it in the confirm.
- **AI dark (#13).** `POST /listings/:id/diagnose-suppression` spends money on a live LLM call and
  logs to `AiUsageLog`. Do not wire it. If a `✦ Diagnose` affordance is built at all it must be
  visibly dark.
- **Amazon EU shared quantity / per-ASIN images** — not touched by this feature, but a suppression on
  IT does **not** imply one on DE even though the quantity and the images are shared. Never roll up.
- **Per-channel oversell** — untouched; no quantity is written.
- **Untouchables** — the flat-file editors also read suppression state
  (`services/amazon/flat-file.service.ts:2216`); leave them alone.
- **Publish gates** — all three channels report `gated` on prod (#127). A console that offers a
  remedy must state that, which the existing `gateNote()` already does; reuse it rather than writing a
  second sentence.
- **A vacuous PASS.** With `AmazonSuppression` at 0 rows (#116), a suppressions pane will render
  green and empty on every coordinate, and **that is the dangerous shape** — the exact reading the
  console's `coverageNote` and `DORMANT_SOURCES` footer were built to prevent (#126, ledger `:19842`).
  Any verification of this feature needs a writer-produced fixture (the real backfill route or a real
  SQS notification), not a hand-seeded row: a hand-seeded row proves the read path and nothing else.

## 9. Open questions for the Owner (3)

**Q1. Does `ReadinessState` gain a sixth member `'suppressed'`, or does a suppressed listing fall
into the existing `'errors'`?**
*Recommendation: fall into `'errors'` for the swap, and revisit.* It is one server line
(`sheet-rows.service.ts:264`), every consumer already renders `'errors'`, and it immediately stops the
sheet calling a suppressed listing live. A sixth member is more honest and more work — five files
declare the union and each must degrade safely first — so it should be a deliberate follow-up, not
smuggled in with this feature.

**Q2. D9 dropped the Recover LINK on the reasoning "History is Recover". Does the delete-and-relist
FLOW survive as a studio verb, or is the capability itself retired?**
*Recommendation: it survives as a CONTEXT(alias-group) verb with the drawer holding its timeline.*
The drawer's History pane restores *our* record; recovery deletes an *Amazon offer* and trades reviews
against a cooldown. They are different capabilities that happen to share the word "recover", and
retiring the second by accident would leave the operator with Seller Central as the only path.

**Q3. Suppressions and issues are both at 0 rows because nothing persists them (§5.6, §5.7). Do we
build the console source DARK-but-honest now, or first make one source live?**
*Recommendation: build it now, and ship "Check with Amazon" with it.* That single reused read
(`preflight?live=1`) populates `ListingIssue` on demand with no cron, no flag change and no write to a
live listing — so the issues source has real data on the day it ships, and the suppressions source
stays honestly named-and-empty until the Owner decides between cronning the backfill and persisting
the SQS notification. That decision is queue hygiene, not this feature.

## 10. Effort and dependencies

| piece | lane | effort | depends on |
|---|---|---|---|
| Console source axis + Suppressions source (reuses `groupByCause`, `jumpTargetOf`) | PES.3 | **M** | nothing |
| Listing-issues source + "Check with Amazon" (H6) | PES.3 | **S** | existing preflight route |
| `Amazon status` column + `⚠` on the alias band + 2 View chips | PES.3 | **S** | PES.5 item 1 |
| `suppression-dismiss` ROW+SELECTION verb (preflight → confirm → run) | PES.3 | **S** | PES.5 item 5 |
| Drawer "Channel says" section + recovery timeline + reveal-cell from `attributeNames` | PES.4 | **M** | PES.5 item 1 |
| `recover-listing` CONTEXT verb + Modal/Stepper consequence flow | PES.3 | **L** | 🔴 the §5.2 gate fix and the §5.3 permission fix must land FIRST |
| Wire projection (`suppression`, `issueCount`) + readiness state | PES.5 | **S** | Q1 |
| Gate fix + permission fix + one-of-many dismiss fix + `deleteListingsItem` test | PES.5 | **S** | none — do these first, they are safety, not features |
| Persist RT.14 / cron the backfill | PES.5 | **M** | Q3; out of this feature's scope |

**Cross-feature dependencies.** Shares the console with the sync-queue feature (one source axis, not
two consoles) and the `⚠` real-estate on the alias band with the readiness/publish work; shares
`revealCell` and the Listings pane with the drawer lane; the `Amazon status` column shares the
right-pinned status band with any other H2 feature (buy-box, A+ state), so the pin order needs one
owner. Nothing here blocks another feature.
