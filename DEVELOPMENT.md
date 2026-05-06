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
