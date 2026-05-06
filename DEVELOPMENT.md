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
