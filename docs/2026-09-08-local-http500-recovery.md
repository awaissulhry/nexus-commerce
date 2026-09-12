# Local HTTP 500 recovery — 8 September 2026

The local frontend and API are running again on ports 3000 and 8091. They now use
an isolated local database and Redis. Development edits stay in that local copy;
they do not update the production catalog.

## Cause and production boundary

The uncommitted workspace database runtime requires `nexus_workspace_runtime`
and workspace ownership columns. The configured Neon database had neither, so
even session validation failed. Frontend `/` returned 200, while API health
returned 503 and authenticated requests returned 500.

A read-only comparison with Railway confirmed that the local configuration
pointed at the production database. The deployed API still used the August 31
code, with workers and scheduled jobs running. Its health endpoint returned 200.
Applying the workspace migration there without deploying compatible consumers
would break existing writes. No remote schema, data, deployment, or configuration
was changed during recovery.

## Migration repairs

- Accepted the historical names of 27 indexes, including constraint-backed
  unique keys, alongside Prisma-created baseline definitions.
- Preserved conditional uniqueness for stock levels, default pricing, return
  policies, advertising idempotency, external stock locations, and default
  notification preferences. Removed the stale global notification preference
  key that conflicted with the existing per-user design.
- Changed 407 ownership backfills to constant column defaults, followed by
  context-dependent defaults for future inserts. This preserves existing data
  without firing UPDATE triggers. The initial full-data rehearsal exposed the
  AuditLog immutability trigger; that protection stays enabled throughout.
- Added `20260908c_sync_log_result_columns` for two older missing Prisma fields:
  `SyncLog.itemsSuccessful` and `SyncLog.details`.
- Corrected the sync-log in-flight endpoint to query `IN_PROGRESS` and `SUCCESS`
  instead of nonexistent enum values. Its query arguments remain typed so this
  error is caught by TypeScript.

## Evidence

- A consistent PostgreSQL 17 custom archive was created through the direct Neon
  endpoint using a read-only connection. Archive size: 229,642,680 bytes.
- SHA-256: `936124f81b8af0c525657724595dba8395a4e351d857d7966743e062bfd14abd`.
- The archive restored successfully into local PostgreSQL 17 with pgvector.
- Reconciliation passed for all 423 original tables, with the expected new
  account-settings row and migration metadata accounted for separately.
- Full content fingerprints matched for 17 critical tables, including products,
  listings, formulas, orders, stock movements, purchase orders, and user access.
- Order totals by currency and inventory quantities/reservations/availability
  matched before and after migration.
- All 409 scoped tables enforce row-level security and retain legacy ownership.
  Runtime visibility matches the preserved counts; another workspace cannot read
  the migrated products, connections, or orders.
- Reads through the actual application runtime passed for all 427 Prisma models.
- Both baseline and historical-index rehearsal modes passed, including immutable
  audit history, NULL uniqueness, same-SKU business isolation, and SyncLog columns.
- API typecheck passed.
- Browser checks rendered the catalog, shared/Amazon product editor, and sync logs.
  Frontend requests for the mapping page also returned 200. The repaired in-flight
  monitor returned 200 on repeated polling.
- Local API health returned 200 with database and Redis connected. Background
  workers and scheduled jobs remain disabled for local development.

These checks establish recovery of the observed outage. They are not a full
functional or accessibility audit of every page in the uncommitted workspace.

## Local operation and recovery files

Docker must be running. The containers restart with Docker unless explicitly
stopped:

- `nexus-development-postgres-20260908`: `127.0.0.1:55439`, database `nexus_development`.
- `nexus-development-redis-20260908`: `127.0.0.1:6389`.

The local API settings are in ignored `apps/api/.env`; frontend settings are in
ignored `apps/web/.env.local`. The original frontend environment was backed up
before changing it. The root `.env` was left intact.

Start the applications normally with `npm run dev --workspace=@nexus/api` and
`npm run dev --workspace=@nexus/web -- --port 3000`. Server logs for this recovery
are `/tmp/nexus-http500-api.log` and `/tmp/nexus-http500-web.log`.

The ignored, private `.analysis/http500-recovery-20260908/` directory contains the
database archive, checksum, local connection configuration, original environment
backup, migration revisions, and reconciliation receipts. Keep these files
private; the archive contains real business data. Do not delete the development
database container or its volume while retaining local edits.

The migration files continue to be edited in the shared working tree. The pinned
plan records the exact revisions rehearsed and applied locally. A subsequent
change to the channel-routing trigger is separate from this outage recovery;
production rollout still needs a coordinated release of code and migrations.

Do not point the uncommitted workspace runtime back at the unmigrated production
database: that would reintroduce the outage. No changes were committed or pushed.
