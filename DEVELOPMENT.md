# Development setup

Short notes for contributing to Nexus. See `RESTORATION_NOTES.md` for the historical phase log and `TECH_DEBT.md` for the prioritised backlog.

## First-time setup

```bash
npm install
# Sets up workspaces (apps/web, apps/api, packages/database, …).
# Postinstall runs `prisma generate` in packages/database.
```

Point `DATABASE_URL` at a Postgres instance (Neon / Railway / local Docker). Then:

```bash
cd packages/database
npx prisma migrate deploy   # apply existing migrations
```

## Pre-push gate (recommended)

A pre-push hook runs the schema-drift check then builds both `apps/web` and `apps/api`. To install:

```bash
git config core.hooksPath .githooks
```

(Once per clone. There is no CI yet — this hook is the only barrier between a broken commit and `origin/main`. CI is on the backlog.)

The canonical hook lives at `.githooks/pre-push`. If you edit it, the change is version-controlled and benefits everyone running `core.hooksPath`.

## Schema changes

When modifying `packages/database/prisma/schema.prisma`, you **must** create a corresponding migration. The pre-push hook (and `npm run check:drift`) will reject pushes that have schema models without a `CREATE TABLE` in any migration.

```bash
cd packages/database
# Edit schema.prisma — add a model, add a column, etc.
npx prisma migrate dev --name describe_what_changed
# Commit BOTH schema.prisma AND the new migrations/<timestamp>_*/ folder
```

Why this matters: TypeScript via `prisma generate` is happy as long as the schema declares the model — but `findMany()` will throw at runtime if Postgres has no matching table. `/products` was empty for a day on 2026-05-02 because of exactly this. See TECH_DEBT entry **#0**.

### Running the drift check manually

```bash
npm run check:drift
```

Exits 0 on clean, 1 on drift, with a report listing the offending model(s). The script:

- Parses `prisma/schema.prisma` for every `model X` block (and any `@@map("y")`).
- Scans every `prisma/migrations/*/migration.sql` for `CREATE TABLE [IF NOT EXISTS] "X"`.
- Reports any model whose table never appears.

Limitations (consciously out of scope):

- **Column-level drift** — adding a field to a model without a migration that adds the column. Catching this needs a real shadow database; today it would be a CI step with a Postgres service container, not a fast pre-push hook.
- **Renames** — `ALTER TABLE … RENAME TO` after the original `CREATE TABLE`. Rare; if it bites, extend the script.

### Drift allow-list

`packages/database/scripts/check-schema-drift.mjs` has a small `ALLOW_LIST` near the top for pre-existing drift that's tracked in `TECH_DEBT.md` (entries #31, #32 as of 2026-05-02). Each entry must reference a ticket. Removing an entry: ship the missing migration, then delete the line. Adding new entries silently to bypass the gate is a footgun — don't.

## Health endpoint conventions

The /listings surface and /products surface both have "health" features but
they are **NOT the same endpoint**:

- `GET /api/listings/health` — overview rollup for the syndication
  workspace. Returns errorCount, suppressedCount, draftCount,
  pendingSyncCount, top error reasons, and recent failed listings.
  Defined in `apps/api/src/routes/listings-syndication.routes.ts`.
  Used by `ListingsWorkspace`'s Health lens.

- `GET /api/catalog/:productId/listing-health` — per-product readiness
  scores across all channels (title length OK, price > 0, has images,
  has variations, etc.). Defined in
  `apps/api/src/routes/listing-health.routes.ts`. Used by
  `ListingHealth.tsx` inside the product editor.

Don't conflate them. The first answers "are my live listings healthy?";
the second answers "is this product ready to be listed?". The route
file `listing-health.routes.ts` declares full `/api/catalog/...` paths
internally, so it is registered without a prefix in `apps/api/src/index.ts`.

## Useful commands

```bash
# Build everything (turbo)
npm run build

# Drift gate only
npm run check:drift

# Database tooling
cd packages/database
npx prisma studio          # browse the DB
npx prisma migrate dev     # create + apply migration locally
npx prisma migrate deploy  # apply migrations (CI / production)
npx prisma generate        # regenerate client types
```

## Deploys

- **API** — Railway. The `start` npm script runs `prisma migrate deploy` before `node apps/api/dist/index.js`, so migrations land before the server boots.
- **Web** — Vercel. Standard Next.js build.

## Test Data Lifecycle

### `importSource` markers

The `Product.importSource` field distinguishes data origin. The cleanup script and the audit doc both rely on these values being honest.

| Value | Meaning | Action |
|---|---|---|
| `NULL` | Real products from early imports (pre-tracking) | KEEP |
| `MANUAL` | Real products manually entered via UI | KEEP |
| `AMAZON_AUTO_IMPORT` | Real products from Amazon SP-API sync | KEEP |
| `XAVIA_REALISTIC_TEST` | Test seed data with realistic shape | DELETE |
| `PERFORMANCE_TEST` | Legacy stress-test data | DELETE |

### Rules

1. Test data **must** have a non-NULL, non-MANUAL `importSource` value.
2. Real data **must not** have a test `importSource` value.
3. The cleanup script is idempotent — re-running it is always safe.
4. Variations cascade — deleting a Product cascades to its `ProductVariation` rows.

### Cleanup script

Location: `packages/database/scripts/cleanup-test-data.sql`

```bash
# Preferred: run via Neon SQL Editor.
# Alternative: from a shell with the production DATABASE_URL:
psql "$DATABASE_URL" -f packages/database/scripts/cleanup-test-data.sql
```

Verify counts before AND after running. The verification SELECT at the end of the script prints the post-state.

### Adding test data

Always set `importSource` when seeding:

```ts
await prisma.product.create({
  data: {
    sku: 'TEST-XYZ',
    name: 'Test Product',
    importSource: 'XAVIA_REALISTIC_TEST', // ← required for test data
    // ...
  },
})
```

A test fixture written without `importSource` is invisible to the cleanup script and ends up surviving as fake "real" data — exactly the mess the 2026-05-05 cleanup undid.

See `packages/database/AUDIT.md` for the post-cleanup state of record.

## Stock — multi-location architecture (H.1–H.10)

`/fulfillment/stock` is backed by a per-location ledger introduced in
the H.1–H.9 series. The model + flow:

```
   Product.totalStock  ←  cached SUM(StockLevel.quantity)  (recomputed
                                                            on every write)
        │
        └─► StockLevel  (locationId, productId, variationId)
                │           quantity / reserved / available
                │           CHECK: available = quantity - reserved
                │
                ├─► StockMovement  (audit trail; every change writes one)
                ├─► StockReservation (24h TTL on PENDING_ORDER)
                └─► OutboundSyncQueue (Phase 13 cascade fan-out per
                                       ChannelListing → BullMQ worker
                                       → channel API)
```

**Source of truth**: `StockLevel`. `Product.totalStock` is a cached sum
maintained in the same transaction as every write. **All stock writes
go through `applyStockMovement`** (`apps/api/src/services/stock-movement.service.ts`),
which resolves a location for every call: explicit `locationId` →
`warehouseId` → IT-MAIN fallback.

### Locations seeded

- `IT-MAIN` (Riccione, type=WAREHOUSE) — physical inventory, links to
  legacy `Warehouse` row for shipping/Sendcloud sender mapping.
- `AMAZON-EU-FBA` (type=AMAZON_FBA) — Amazon's pool. Written by the
  FBA inventory cron (`amazonInventoryService.applyRows`).

### Endpoints

| Endpoint                              | Purpose                                                    |
| ------------------------------------- | ---------------------------------------------------------- |
| `GET /api/stock`                      | per-StockLevel rows, paginated (table view)                |
| `GET /api/stock/by-product`           | per-product with stockLevels nested (matrix + cards views) |
| `GET /api/stock/locations`            | all locations + roll-up totals                             |
| `GET /api/stock/kpis`                 | total value, stockouts, critical, available                |
| `GET /api/stock/insights`             | stockout risk + allocation gaps + sync conflicts (24h)     |
| `GET /api/stock/sync-status`          | derived health for the SyncIndicator badge                 |
| `GET /api/stock/movements`            | audit log with filters                                     |
| `GET /api/stock/product/:productId`   | drawer bundle (levels + listings + velocity + ATP + …)     |
| `PATCH /api/stock/:id`                | adjust quantity (signed `change`) OR set `reorderThreshold`|
| `POST /api/stock/transfer`            | atomic OUT + IN between locations                          |
| `POST /api/stock/reserve`             | hold N units against a StockLevel                          |
| `POST /api/stock/release/:rid`        | release a reservation (also expires via 5-min sweep)       |
| `POST /api/stock/sync`                | manually trigger FBA cron sweep                            |

The legacy `/api/fulfillment/stock` endpoints stay live alongside —
they aggregate across locations and are still consumed by other pages.

### Crons

| Cron                          | Cadence  | Default | Env flag                                  |
| ----------------------------- | -------- | ------- | ----------------------------------------- |
| Amazon FBA inventory sweep    | 15 min   | OFF     | `NEXUS_ENABLE_AMAZON_INVENTORY_CRON=1`    |
| Amazon orders polling         | 15 min   | OFF     | `NEXUS_ENABLE_AMAZON_ORDERS_CRON=1`       |
| Reservation TTL sweep         | 5 min    | ON      | `NEXUS_ENABLE_RESERVATION_SWEEP_CRON=0` to opt out |
| eBay token refresh            | hourly   | ON      | `NEXUS_ENABLE_EBAY_TOKEN_REFRESH_CRON=0` to opt out|

Override schedules via the `*_SCHEDULE` env vars (cron syntax).

### Operational scripts

```bash
# Pre-flight + post-migration verification (read-only)
node scripts/h1-preflight.mjs
node scripts/h1-postcheck.mjs

# Drift repair (run if SUM(StockLevel) != Product.totalStock)
node packages/database/scripts/reconcile-stocklevel.mjs --dry-run
node packages/database/scripts/reconcile-stocklevel.mjs

# End-to-end smoke (idempotent — uses MANUAL_HOLD reservations + reverses)
node scripts/verify-stock.mjs
```

### Coordination playbook (next migration)

If a future stock migration needs a window like H.1 did:

1. Disable FBA cron: `NEXUS_ENABLE_AMAZON_INVENTORY_CRON=0` on Railway, redeploy.
2. Wait for any running `prisma migrate deploy` lock to release. The
   Neon pooler endpoint doesn't reliably support `pg_advisory_lock` —
   strip `-pooler` from `DATABASE_URL` for migrate-deploy commands.
   If the lock is stuck, see `scripts/h1-lock-diag.mjs` and
   `h1-lock-release.mjs`.
3. Apply migration via `prisma migrate deploy`.
4. Run any data backfill (with `--dry-run` first).
5. Verify drift = 0 with the postcheck script.
6. Push code with the new schema.
7. Re-enable cron.

See `packages/database/prisma/migrations/20260506_h1_stock_locations/`
for the H.1 migration + rollback as a reference pattern.

---

## Master-data cascade — Product → ChannelListing (Phase 13)

Every mutation of `Product.basePrice` or `Product.totalStock` cascades
atomically to every `ChannelListing` tied to that product, then
enqueues a marketplace push with a 5-minute undo grace window. There
is **one entrypoint per direction** so the cascade can never be
forgotten by a new caller:

```
Product.basePrice change ─► MasterPriceService.update(productId, newPrice, ctx)
                              one Prisma $transaction:
                                Product.update(basePrice)
                                ChannelListing fan-out:
                                  masterPrice := newPrice          (always)
                                  if followMasterPrice = true:
                                    FIXED              → price := newPrice
                                    MATCH_AMAZON       → price untouched
                                    PERCENT_OF_MASTER  → newPrice * (1 + adj/100)
                                    lastSyncStatus := PENDING
                                OutboundSyncQueue.createMany(
                                  syncType='PRICE_UPDATE',
                                  holdUntil = NOW + 5min)
                                AuditLog.create(slim diff + propagation summary)

Product.totalStock change ─► applyStockMovement(input)
                              one Prisma $transaction:
                                StockLevel.update / .create
                                Product.totalStock = SUM(StockLevel)
                                ChannelListing fan-out:
                                  masterQuantity := newTotal       (always)
                                  if followMasterQuantity = true:
                                    quantity := max(0, newTotal - stockBuffer)
                                    lastSyncStatus := PENDING
                                OutboundSyncQueue.createMany(
                                  syncType='QUANTITY_UPDATE',
                                  holdUntil = NOW + 5min)
                                StockMovement.create (audit row)
```

**Properties**:
- Atomic — master + listings + queue + audit either all commit or none do
- Idempotent on no-op — `MasterPriceService` short-circuits when the
  new value matches the existing one (no audit / queue noise)
- Crash-safe BullMQ enqueue — the DB row is the source of truth; if
  Redis is down the row stays PENDING for the next drain pass
- Symmetric for stock — extending `applyStockMovement` rather than
  building a parallel `MasterStockService` keeps H.2's "single
  entrypoint" invariant
- `followMasterPrice = false` listings get only their `masterPrice`
  snapshot updated; their `price` column stays as the seller's
  per-marketplace override (drift signal preserved)

**Wired callers** (`apps/api/src/routes/`):
| Route | Field | Service |
| --- | --- | --- |
| `PATCH /api/products/:id`  | basePrice  | `MasterPriceService.update` |
| `PATCH /api/products/:id`  | totalStock | `applyStockMovement` (delta = newTotal - current) |
| `PATCH /api/products/bulk` | basePrice  | post-commit per-product `MasterPriceService.update` |
| `PATCH /api/products/bulk` | totalStock | post-commit per-product `applyStockMovement` |
| every other stock writer (orders, returns, inbound, manual adjust, transfers, reservations) | totalStock | `applyStockMovement` (already routed via H.2) |

The bulk handler keeps the cascade out of its main `$transaction`
because `applyStockMovement` opens its own transaction internally;
both can run in their own transactions per-product without nesting.
Failures are surfaced via the response `errors[]` array — the
caller's other field updates still commit.

**Backfill**: existing ChannelListings get their `masterPrice` /
`masterQuantity` baseline populated by:

```bash
node scripts/backfill-channel-listing-master-snapshot.mjs --apply
```

Idempotent. Leaves listings whose product's `basePrice = 0` alone
(snapshotting 0 would mark every override as "drift" forever; the next
real basePrice edit populates the snapshot correctly).

---

## Bulk operations — two-table data model

Two separate tables share the "Bulk*" prefix for historical reasons.
They serve **different surfaces** with no overlap; do not consolidate.

| Table | Surface | Wired by | Lifecycle |
| --- | --- | --- | --- |
| `BulkActionJob` | `/bulk-operations` modal-driven jobs (PRICING_UPDATE, INVENTORY_UPDATE, STATUS_UPDATE, ATTRIBUTE_UPDATE, MARKETPLACE_OVERRIDE_UPDATE) | `apps/api/src/services/bulk-action.service.ts` + `apps/api/src/routes/bulk-operations.routes.ts` | Created → IN_PROGRESS → COMPLETED / PARTIALLY_COMPLETED / FAILED / CANCELLED |
| `BulkOperation` | `/products` CSV/XLSX bulk-upload import flow (preview → confirm → apply) | `apps/api/src/services/products/bulk-upload.service.ts` + `apps/api/src/routes/products.routes.ts` (writes the row) + `apps/api/src/routes/dashboard.routes.ts` (reads for activity feed) + `apps/web/src/app/dashboard/overview/OverviewClient.tsx` | Preview row written with parsed plan in `changes` JSON; confirmed by user → applied; expires via `expiresAt` |

**When to write to which:**

- New job initiated from the **/bulk-operations modal** → `BulkActionJob`
  via `BulkActionService.createJob()`.
- New job initiated from a **/products CSV/XLSX upload** → `BulkOperation`
  via `bulk-upload.service.ts`.

**Do not:**
- Write `BulkOperation` rows from the `/bulk-operations` flow — the
  dashboard activity feed parses its `changes` payload assuming the
  CSV/XLSX schema and will mis-render.
- Drop `BulkOperation` (it has live data and active callers — see grep
  for `BulkOperation\b`).
- Rename either table without coordinating the migration with all
  callers listed above.

**Future consideration:** the names are confusing. A future engagement
could rename `BulkOperation` → `BulkUploadJob` to disambiguate, but
that is a deliberate rename, not a side-effect of bulk-operations
work.

### Master-cascade routing per actionType

Every `BulkActionJob` runs through `BulkActionService.processItem`,
which dispatches to a per-actionType handler. The handlers route
through master-cascade entrypoints (where applicable) so a bulk
write triggers the same atomic Product → ChannelListing →
OutboundSyncQueue → AuditLog cascade as a single-product edit.

| actionType | Targets | Cascade entrypoint |
| --- | --- | --- |
| `PRICING_UPDATE` | `Product` | `MasterPriceService.update` (full cascade, `skipBullMQEnqueue: true`) |
| `INVENTORY_UPDATE` | `Product` | `applyStockMovement` with `reason='MANUAL_ADJUSTMENT'`, `referenceType='BulkActionJob'`, `skipBullMQEnqueue: true` |
| `STATUS_UPDATE` | `Product` | None — direct `product.update` (no master-cascade entrypoint exists yet for status; tracked in `TECH_DEBT.md`) |
| `ATTRIBUTE_UPDATE` | `ProductVariation` | None — direct `productVariation.update`; PV is currently empty in production (variants live as Product children); retargeting tracked in `TECH_DEBT.md` |
| `LISTING_SYNC` | `ProductVariation` | Throws "deferred to v2" |
| `MARKETPLACE_OVERRIDE_UPDATE` | `ChannelListing` | Direct `channelListing.update` (per-listing override is the lowest-level write — no further cascade) |

**`skipBullMQEnqueue: true`** — bulk-action runs detached from the
HTTP request (fire-and-forget `processJob`). The post-commit
`outboundSyncQueue.add()` awaited from this context was observed to
hang indefinitely (root cause TBD; tracked in `TECH_DEBT.md` #54).
The OutboundSyncQueue *DB rows* still land inside the master-cascade
transaction; the per-minute cron worker (`apps/api/src/workers/sync.worker.ts`
→ `OutboundSyncService.processPendingSyncs`) drains PENDING rows
within ~60s and respects the `holdUntil` grace window. So the
cascade is correct and eventually-consistent; the BullMQ enqueue is
an optimization (immediate worker pickup) we deliberately skip in
this caller until the hang is diagnosed.

**Implication:** bulk PRICING_UPDATE / INVENTORY_UPDATE jobs honor
the followMaster* contract and the `version` increment that the rest
of the cascade machinery relies on, with marketplace push delayed
by up to 60s relative to inline edits (which use the BullMQ path).
Re-running the same job is a no-op via the `MasterPriceService`
short-circuit (no audit / queue noise).

---

## Cross-page sync infrastructure (Phase 10)

Five pages — `/products`, `/listings`, `/catalog/organize`,
`/bulk-operations`, `/products/drafts` — share one polling /
invalidation / freshness contract so an edit on any of them
propagates to the others within ~200ms. The infrastructure is in
place across every Phase-10 page; new pages adopt it via four
shared building blocks.

### 1. Filter contract (`apps/web/src/lib/filters/`)

The `CommonFilters` type defines the canonical filter shape every
page accepts:

```ts
interface CommonFilters {
  search?: string
  channel: string[]      // ['AMAZON', 'EBAY', …] — empty = no filter
  marketplace: string[]
  status: string[]       // page-specific values
}
```

URL convention is **repeated keys**, not CSV:

```
?channel=AMAZON&channel=EBAY&marketplace=IT&status=ACTIVE&search=jacket
```

`parseFilters(searchParams)` accepts both forms — legacy CSV (e.g.
`?channels=AMAZON,EBAY` from pre-Phase-10 /products bookmarks,
`?listingStatus=ACTIVE` from /listings) auto-translates to the
canonical shape with a one-line dev-mode console warning. Pages with
extra filters intersect `CommonFilters` with their own type.

### 2. ETag / 304 (`apps/api/src/utils/list-etag.ts`)

Every list endpoint returns an ETag derived from one aggregate query:

```
ETag = W/"<count>.<maxUpdatedAtMs>.<filterHash>"
```

Frontend sends `If-None-Match` on subsequent fetches; server returns
304 with a 50-byte body when nothing changed. Idle polling at 5–10s
intervals collapses to 304s, cutting bandwidth ~10x at scale.

Adopted on `/api/products`, `/api/products/bulk-fetch`,
`/api/listings`, `/api/listing-wizard/drafts`, `/api/pim/standalones`,
`/api/pim/parents-overview`. New list endpoints adopt it in 4 lines:

```ts
const { etag, count } = await listEtag(prisma, { model: 'product', where, filterContext: { … } })
reply.header('ETag', etag)
if (matches(request, etag)) return reply.code(304).send()
```

### 3. usePolledList (`apps/web/src/lib/sync/use-polled-list.ts`)

The fetch primitive every Phase-10 page consumes. Centralises:

1. Initial fetch on mount + URL-change refetch (with abort of prior)
2. 30s background interval while `document.visibilityState === 'visible'`
3. `visibilitychange` + `window.focus` refresh
4. ETag round-trip (send `If-None-Match`, keep data on 304)
5. Cross-page invalidation subscription (debounced 200ms)

```tsx
const { data, loading, error, lastFetchedAt, refetch } = usePolledList<MyResponse>({
  url: useMemo(() => `/api/things?${qs}`, [qs]),
  intervalMs: 30_000,
  invalidationTypes: ['product.updated', 'listing.updated', 'wizard.submitted'],
})
```

### 4. Invalidation channel (`apps/web/src/lib/sync/invalidation-channel.ts`)

Browser-native `BroadcastChannel('nexus:invalidations')`. Pages emit
events after their mutations and listen for the events that affect
their data:

```ts
// After a successful mutation:
emitInvalidation({ type: 'product.updated', id, fields: ['basePrice'] })

// On a page that renders products:
useInvalidationChannel(['product.updated', 'bulk-job.completed'], () => refetch())
```

Event vocabulary is type-safe (see `InvalidationType` union). Same-tab
listeners also fire — `BroadcastChannel` skips the sender by spec, so
`emitInvalidation` re-dispatches via a `window` `CustomEvent` for
in-tab subscribers.

### Freshness indicator

`<FreshnessIndicator lastFetchedAt onRefresh loading error />`
mounted in the page header. Ticks every 10s, shifts amber after 60s
of staleness, red on error. Click to refresh.

### Adopting on a new page

1. Build URL via `useMemo` from your filter state
2. `usePolledList<ResponseShape>({ url, intervalMs: 30_000, invalidationTypes })`
3. Mount `<FreshnessIndicator>` in the page header
4. Call `emitInvalidation` after every mutation handler with the
   right event type (see existing pages for examples)

The five migrated pages provide working references covering every
shape: read-only list (`/products/drafts`), tabbed read-write
(`/catalog/organize`), heavy grid + bulk (`/bulk-operations`),
multi-lens (`/listings`), and complex filter + multi-mutation
(`/products`).

---

## /products foundation rebuild (P.0–P.21, 2026-05-06 → 2026-05-07)

Twenty-two-commit engagement that hardened the /products surface
end-to-end after a full audit. Each commit was scope-calibrated
against the audit's claims — most audit findings were either
already-shipped or wrong about the data, so commit bodies document
the calibration along with what landed.

### Verifier

```sh
node scripts/verify-products-rebuild.mjs            # against Railway
node scripts/verify-products-rebuild.mjs --local    # against localhost:4000
```

Walks every commit's contract: bulk-status validation, drift cron,
saved-views alert summary, extended /health, list returns version,
bulk-fetch productIds filter, missingChannels filter, per-listing
resync route, AI provider registry. Exits non-zero on any failure.
Designed for post-deploy gates and tagging releases.

### Backend surface added

- `POST /api/products/bulk-status` — routes through MasterStatusService
  (Commit 0); cascades to ChannelListing + enqueues OutboundSyncQueue
- `PATCH /api/products/:id` — supports `If-Match: <version>` for
  optimistic concurrency (Commit 0 server, P.7 client integration)
- `GET /api/products/:id/health` — extended with full master fields +
  `_count.{translations,relationsFrom,children}` so the drawer no
  longer renders empty cards (P.6, P.8)
- `GET /api/saved-views?surface=…` — items now include
  `alertSummary: { active, total, firedRecently }` (P.3)
- `GET /api/products` — list returns `Product.version` per row (P.7);
  accepts `?missingChannels=<csv>` for coverage-gap filtering (P.10)
- `GET /api/products/bulk-fetch` — accepts `?productIds=<csv>` for
  scoped /bulk-operations deep-link (P.9)
- `POST /api/sync/detect-drift` + `GET /api/sync/detect-drift/status` —
  manual trigger + status for the drift detector cron (P.2)
- `POST /api/products/:id/ai/suggest-fields` — LLM brand/productType
  suggestion (P.14)
- `apps/api/src/jobs/sync-drift-detection.job.ts` — 30-min cron,
  default-ON, gated by `NEXUS_ENABLE_SYNC_DRIFT_DETECTION_CRON`

### Frontend surface added

- `apps/web/src/lib/products/theme.ts` — design tokens (Density,
  CHANNEL_TONE, STATUS_VARIANT) extracted from the workspace (P.4)
- `apps/web/src/app/products/_modals/{AiBulkGenerateModal,
  ManageAlertsModal,BundleEditor,CompareProductsModal}.tsx` — modal
  extractions (P.4, P.17). `ProductsWorkspace.tsx` shrank from 4806
  to ~3700 lines through these
- Drawer: `Variations` tab for parents, `Health` card surfacing
  server-side score + issues, per-listing Sync now / Snap to master,
  inline AI suggest for empty brand/productType (P.8, P.18, P.11,
  P.12, P.14)
- `PricingLens` (P.5) and "Missing on…" filter + CoverageLens header
  stats (P.10) on the workspace
- Cross-tab invalidation for saved-view + saved-view-alert events
  with badge in the dropdown (P.3)
- Per-cell `If-Match` PATCH + 409 inline error + `brand` /
  `productType` inline edit (P.7)
- Page-level shortcuts (`n` / `f` / `r`) + ShortcutHelp `On /products`
  section (P.15)
- CSV export of the loaded grid view (P.19)
- a11y wins: aria-sort, aria-pressed, live region, named icon
  buttons (P.20a)

### Schema unchanged

The rebuild touched zero migrations. ProductVariation deprecation
(P.1) reduced to disabling the dormant write in
stock-movement.service.ts; the active write paths are load-bearing
for the listing wizard's variations.service / submission.service /
schema-parser.service which read children via the PV relation. Full
removal is sequenced in `TECH_DEBT.md` entry #43.

### What's deferred (future commits)

- P.4b: extract `BulkImageUploadModal` (671 lines incl. FS walker)
- Toast service to replace `alert()` / `confirm()` calls
- ErrorBoundary at workspace root
- Lazy-load (dynamic import) for the heavy modals
- Trash lens — needs `Product.deletedAt` + `MasterStatusService`
  support + restore UX (~3 days)
- Marketplace-side post-push verification (re-fetch from Amazon
  SP-API after push) — needs SP-API client extension
- AI result caching, per-feature spend caps, per-feature provider
  override policy
- Schedule changes (`ScheduledMutation` + cron worker + UI)
- Multi-cursor edit, formula columns, advanced filter rule builder
- Compare 5+ products (current modal scales to 4)
- Excel / JSON / XML / PDF export, custom export templates,
  scheduled / email reports, full-set export across pages
- P.20b mobile polish, P.20c dark mode, P.20d i18n (next-intl
  install + key extraction + Italian locale)
- Per-issue quick-fix buttons in the drawer's HealthCard
- Health score as sortable grid column

### Outstanding data correctness

- `AIRMESH-JACKET-YELLOW-MEN`: `Product.basePrice = 0` and
  `Product.totalStock = 0` while AMAZON IT/DE listings have valid
  `42.50/44.95` prices and `50/30` stock. The 2026-05-06 reconcile
  unfollowed master on those 2 listings to preserve live
  marketplace values; restoring the master values + re-enabling
  follow flags is a manual operator decision (see
  `scripts/reconcile-master-drift.mjs` dry-run for current state).

---

## Design tokens (U.1, 2026-05-07)

The whole catalog management workflow is data-dense operator UI. Tailwind's
default scale (12-72px) doesn't fit. `apps/web/tailwind.config.ts` overrides
the defaults with a 10-32px scale tuned to the codebase's actual usage.
JS-side constants live in `apps/web/src/lib/theme/index.ts`.

### Typography

Override of Tailwind defaults. Use named classes; never `text-[Npx]`.

| Class | px | line-height | Use |
|---|---|---|---|
| `text-xs`   | 10 | 14 | Captions, badges, metadata |
| `text-sm`   | 11 | 15 | Compact-density rows, sidebar items |
| `text-base` | 12 | 16 | Default body / grid chrome |
| `text-md`   | 13 | 18 | Cell content, primary body |
| `text-lg`   | 14 | 20 | Modal headers, list items |
| `text-xl`   | 16 | 22 | Card titles, drawer headers |
| `text-2xl`  | 18 | 24 | Page titles, section headings |
| `text-3xl`  | 24 | 30 | Hero / dashboard numbers |
| `text-4xl`  | 32 | 38 | Marketing only |

### Border radius

| Class | px | Use |
|---|---|---|
| `rounded-sm`  | 2 | Tight chips, status pills |
| `rounded-md`  | 4 | Buttons, inputs (default) |
| `rounded-lg`  | 6 | Cards, surfaces |
| `rounded-xl`  | 8 | Modals |
| `rounded-2xl` | 12 | Hero / large overlays |
| `rounded-full` | 9999 | Avatars, full pills |

Bare `rounded` (1095 uses today) maps to `rounded-md` (4px) — same as
Tailwind default. Migration of existing `rounded-*` deferred to U.17.

### Shadows

Semantic. Use intent, not numeric scale.

| Class | Use |
|---|---|
| `shadow-subtle`   | Inline chips, raised inline elements |
| `shadow-default`  | Cards |
| `shadow-elevated` | Hover/raised state |
| `shadow-modal`    | Centered dialogs |
| `shadow-drawer`   | Slide-in panels (asymmetric) |

### Animation

| Token | ms | Use |
|---|---|---|
| `duration-fast` | 150 | Hover, press, micro-state |
| `duration-base` | 200 | Cell/menu/transition default |
| `duration-slow` | 300 | Drawer, modal slide-ins |
| `ease-out`      | —   | App-wide cubic-bezier(0.16,1,0.3,1) |

JS sync via `import { DURATION_MS } from '@/lib/theme'`.

### Z-index

Semantic, not magic numbers. Migration mapping (U.17 sweep):

| Token | Numeric | Replaces |
|---|---|---|
| `z-dropdown` | 10 | `z-10` |
| `z-sticky`   | 20 | `z-20` |
| `z-drawer`   | 30 | `z-30` |
| `z-modal`    | 40 | `z-40` |
| `z-toast`    | 50 | `z-50`, `z-[100]` |
| `z-popover`  | 60 | `z-[60]` |

### Semantic colors

Each maps to a Tailwind family chosen by the codebase's actual usage:

| Token | Maps to | Rationale |
|---|---|---|
| `success` | `emerald` | 433 uses, conventional |
| `warning` | `amber`   | 518 uses, conventional |
| `danger`  | `rose`    | 554 uses, preferred over red for tone |
| `info`    | `blue`    | 1434 uses, primary action color |
| `neutral` | `slate`   | 5213 uses, dominant |

Use as `bg-success-50`, `text-warning-700`, `border-danger-200` etc.
JS-side via `import { STATUS_PALETTE } from '@/lib/theme'`.

### Surface tokens

For dark-mode pivoting in U.14. Use these for bg/border decisions
that should flip with the theme.

| Token | Light value |
|---|---|
| `bg-surface-background` | `#ffffff` |
| `bg-surface-card`       | `#ffffff` |
| `bg-surface-elevated`   | `#fafbfc` |
| `bg-surface-overlay`    | rgb(15 23 42 / 0.4) |
| `border-surface-border` | `#e2e8f0` (slate-200) |
| `border-surface-border-strong` | `#cbd5e1` (slate-300) |

### Channel tones

Per-channel chip styling — not Tailwind utilities, JS constant in
`@/lib/theme` because the bg+text+border triple is needed at the
call site:

```ts
import { CHANNEL_TONE } from '@/lib/theme'
<span className={CHANNEL_TONE['AMAZON']}>AMAZON</span>
// → 'bg-orange-50 text-orange-700 border-orange-200'
```

Adding a channel propagates to every chip across the app.

### Migration history

- 2026-05-07 (U.1): all 2,816 arbitrary `text-[Npx]` classes across
  115 files replaced with the named scale. 16 sites consolidated
  15px → 14px (`text-lg`); per-site review documented in commit
  `<sha>`.
- Color/radius/shadow/z-index migration deferred to U.17 (component
  adoption sweep) where context-aware judgment is needed per site.

---

## Component primitives (U.2, 2026-05-07)

Adds 7 new primitives to the `apps/web/src/components/ui/` library on
top of the existing 10 (Button, Modal, Input, Toast, Badge, Card,
Spinner, Skeleton, Tabs, EmptyState).

### IconButton

Standardises 42 hand-rolled `h-N w-N inline-flex justify-center` icon-only
button patterns. Always pass `aria-label` (TS-required).

```tsx
<IconButton aria-label="Delete view" onClick={onDelete}>
  <Trash2 className="w-3 h-3" />
</IconButton>
```

Props: `variant: 'solid' | 'ghost' | 'outline'`, `size: 'xs' | 'sm' | 'md' | 'lg'`,
`tone: 'neutral' | 'info' | 'danger' | 'warning'`. Defaults `ghost / md / neutral`.

### StatusBadge

Wrapper over `<Badge>` that maps a status string to the right tone via
`STATUS_VARIANT` (lib/theme). Lets row renderers write
`<StatusBadge status={p.status} />` instead of recomputing the variant.

```tsx
<StatusBadge status="ACTIVE" />          // emerald
<StatusBadge status="DRAFT" />           // slate
<StatusBadge status="ACTIVE" label="Live" />  // override display
```

### ConfirmDialog

Replaces `confirm()` calls with a focus-trapped modal. Default-focuses
the cancel button so accidental Enter doesn't delete.

```tsx
<ConfirmDialog
  open={open}
  title="Delete view?"
  description={`"${name}" will be removed permanently.`}
  confirmLabel="Delete"
  tone="danger"
  onConfirm={() => doDelete()}
  onClose={() => setOpen(false)}
/>
```

Props: `tone: 'danger' | 'warning' | 'info'`, `busy: boolean` (disables
during async confirm).

### ProgressBar

Determinate (`value` + `max`) or indeterminate (omit `value`).

```tsx
<ProgressBar value={succeeded} max={total} label="Bulk publish" />
<ProgressBar indeterminate label="Polling Amazon…" />
```

Props: `tone: 'info' | 'success' | 'warning' | 'danger'`, `size: 'xs' | 'sm' | 'md'`,
`showCount`, `showPercent`. Tone defaults to info.

### KeyboardShortcut

Renders shortcut keys as kbd-chips. Auto-translates platform modifiers
(`Cmd` → ⌘ on Mac, Ctrl elsewhere).

```tsx
<KeyboardShortcut keys={['Cmd', 'K']} />     // ⌘ + K  on Mac
<KeyboardShortcut chord="g p" />             // g  then  p  (Linear style)
<KeyboardShortcut>Esc</KeyboardShortcut>     // single chip
```

### Tooltip

Hand-rolled (no Radix/Floating UI deps). 500ms hover delay, smart
auto-flip placement, portal-mounted, keyboard-accessible.

```tsx
<Tooltip content="Open in new tab" placement="top">
  <IconButton aria-label="Open"><ExternalLink /></IconButton>
</Tooltip>
```

Props: `placement: 'top' | 'bottom' | 'left' | 'right'`, `delay: number` (ms),
`disableOnTouch: boolean` (default true; stops native long-press from
firing tooltips on tap).

### TableCell type-aware

Per-type cell renderers. Locale-aware via Intl APIs (it-IT default for
Xavia operator). All right-align numerics, use tabular-nums, em-dash on
nullish.

```tsx
<CurrencyCell value={p.basePrice} currency="EUR" />
<DateCell value={p.updatedAt} format="short" />        // "7 May"
<DateCell value={p.updatedAt} format="relative" />     // "2h ago"
<ImageCell src={p.imageUrl} alt={p.name} size="sm" />
<LinkCell href={`/products/${p.id}`} mono>{p.sku}</LinkCell>
<StatusCell status={p.status} />  // alias for StatusBadge
```

### Adoption

These primitives ship in U.2 ready to use. Adoption sweeps follow:
- U.3 — useToast() / ConfirmDialog adoption (89 alert/confirm sites)
- U.5 — TableCell adoption in /products + /bulk-operations
- U.6 — Tooltip adoption (replace 247 native title="..." attributes)
- U.11 — KeyboardShortcut adoption in CommandPalette + menus
- U.17 — IconButton adoption sweep (42 sites) + remaining Button/Input
