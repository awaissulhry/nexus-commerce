# Phase 1 Restoration Notes

Date: 2026-04-30

## Root cause of the route freeze

`apps/api/src/lib/queue.ts` exported five Redis-backed objects as
**module-level constants**:

```ts
export const outboundSyncQueue = new Queue(...)
export const channelSyncQueue  = new Queue(...)
export const stockUpdateQueue  = new Queue(...)
export const queueEvents             = new QueueEvents(...)
export const channelSyncQueueEvents  = new QueueEvents(...)
```

`new Queue(...)` opens a Redis connection synchronously at construction. Any
route file that imported `lib/queue.ts` — directly or transitively through a
service — therefore tried to connect to Redis the moment Node loaded the
module graph, before `app.listen` was reached. On Railway, `REDIS_URL` was
not yet on `process.env` at module-load time, so the boot crashed and routes
had to be commented out one-by-one as a stopgap.

## Fix: fully lazy queue.ts

`apps/api/src/lib/queue.ts` was rewritten so that **nothing** in the module
opens a Redis connection at load time. The Redis client, all three queues,
and both QueueEvents are created on first access via internal getters
(`getRedisConnection`, `getOutboundSyncQueue`, …). The named exports stay
the same — `outboundSyncQueue`, `channelSyncQueue`, `stockUpdateQueue`,
`queueEvents`, `channelSyncQueueEvents` — but they are now `Proxy` wrappers
that resolve to the real instance on the first method call. Existing call
sites (`outboundSyncQueue.add(...)`, `await stockUpdateQueue.close()`, etc.)
require no changes.

`initializeQueue()` and `closeQueue()` were updated to drive the getters
explicitly so workers/health checks still work when Phase 2 enables them.

## Files refactored

| File | Change |
|---|---|
| `apps/api/src/lib/queue.ts` | Full lazy rewrite; queues + QueueEvents now Proxy-backed singletons |
| `apps/api/src/routes/catalog-safe.routes.ts` | Trimmed to `/amazon/import` only — the rest collided with the now re-enabled `catalog.routes.ts` |
| `apps/api/src/index.ts` | Re-enabled all 20 disabled route imports + registrations |

## Routes re-enabled

All twenty previously commented-out routes are now registered:

- `listingsRoutes`
- `aiRoutes`
- `marketplaceRoutes`
- `adminRoutes`
- `monitoringRoutes`
- `shopifyRoutes`, `shopifyWebhookRoutes`
- `woocommerceRoutes`, `woocommerceWebhookRoutes`
- `estyRoutes`, `estyWebhookRoutes`
- `ebayAuthRoutes`, `ebayRoutes`, `ebayOrdersRoutes`
- `catalogRoutes` (under `/api/catalog`)
- `outboundRoutes`
- `matrixRoutes`
- `inboundRoutes`
- `webhookRoutes`
- `ordersRoutes`

Plus the routes that were already enabled: `inventoryRoutes`, `syncRoutes`,
`catalogSafeRoutes`, `healthRoutes`, `amazonRoutes`.

## Still disabled (intentional — Phase 2)

The HTTP layer is fully restored, but BullMQ infrastructure is still gated:

- `startJobs()` — node-cron job dispatch
- `initializeQueue()` — Redis ping + counts
- `initializeBullMQWorker()`
- `initializeChannelSyncWorker()`
- `initializeBulkListWorker()`
- `closeQueue()` on SIGTERM/SIGINT

These are commented out in `apps/api/src/index.ts`. Phase 2 will turn them
back on once `REDIS_URL` is verified on Railway.

## Breaking changes

**One.** `catalog-safe.routes.ts` lost three endpoints to avoid a Fastify
`FST_ERR_DUPLICATED_ROUTE` crash when both catalog files registered under
`/api/catalog`. The endpoints removed from the safe file were already
duplicates with the same behavior in the full `catalog.routes.ts`:

| Endpoint | Now served by |
|---|---|
| `POST /api/catalog/ebay/import` | `catalog.routes.ts:1503` |
| `GET  /api/catalog/ebay/stats`  | `catalog.routes.ts:1539` |
| `DELETE /api/catalog/products/:id` | `catalog.routes.ts:797` (cascading delete) |

`POST /api/catalog/amazon/import` stays in `catalog-safe.routes.ts` — it has
no equivalent in the full file.

## Verification

Local boot test (`apps/api`, `REDIS_PORT=1` to make Redis unreachable):

- `tsc --noEmit` clean
- All 20 disabled route files import without opening a Redis connection
- Server boots in ~150ms with all routes registered
- No `FST_ERR_DUPLICATED_ROUTE`
- No module-load Redis errors

The `/api/health` endpoint returns 503 when the database is unreachable —
that is the existing behavior (it does a `SELECT 1` round-trip), unrelated
to the queue refactor.

## Next steps

1. Deploy `main` to Railway and tail logs for any module-load Redis errors.
2. Hit `/api/health`, `/api/inventory`, `/api/catalog/...` to confirm 200s.
3. Phase 2: re-enable workers and `initializeQueue()` once Railway env is
   confirmed.

---

## Phase 2: Parent/Child Hierarchy (2026-04-30)

### What was attempted, what worked
- **Catalog Items API path** — abandoned. The SP-API app is missing the
  Catalog Items API role, which is a Restricted Role on the Italian
  Seller Central account and not visible to grant. Re-authorizing did not
  unlock it. `/api/amazon/products/test-catalog-api` confirms:
  `CATALOG_ITEMS_API_BLOCKED: even summaries failed`.
- **Reports API path** — partial. `GET_MERCHANT_LISTINGS_DATA` works (no
  scope issue) but its 30 columns do not include parent SKU or parent
  ASIN. `asin2` and `asin3` columns exist but are entirely empty (0/247
  rows). 18 listings share an `asin1` value, but those are just
  duplicate FBA/FBM listings of the same product, not parent groupings.
- **Title-based grouping** — works. Amazon listings for variation
  children are titled identically to the parent + `" (Size, Color)"`
  appended at the end (and the parent record exists in the DB with the
  full description, no parenthetical). This is the actual signal.

### Solution shipped
A new endpoint `POST /api/amazon/products/auto-group` parses each
product's name with `/^(.+?)\s*\(([^()]+)\)\s*$/`. Children are products
whose name had a trailing parenthetical with short variation attrs
(<60 chars, comma-separated). Parents are products whose full name
matches a child's stripped baseTitle. The `?dryRun=1` flag previews
the plan; `?reset=1` clears the prior (incorrect) SKU-prefix groupings
first. Stock is rolled up child→parent automatically.

### Results — first run on production data
| Metric | Value |
|---|---|
| Total Amazon products | 278 |
| Children with variation parens | 235 |
| Parents found | 12 |
| Children linked | 199 |
| Standalone (no parens or no match) | 67 |
| Orphan children (no parent record) | 36 |

Top groupings (the previously-failing cases now correct):

| Parent SKU | Children | Theme | Notes |
|---|---|---|---|
| `xracing` | 49 | Size/Color | X-Tuta racing suit |
| `GALE-JACKET` | 38 | Size/Color | Black + Yellow merged ✓ |
| `IT-MOSS-JACKET` | 21 | Size/Color | Black + Yellow + Green merged ✓ |
| `3K-HP05-BH9I` | 15 | Size/Color | MISANO leather jacket |
| `VENTRA-JACKET` | 12 | Size/Color | Red + Yellow merged ✓ |
| `REGAL-JACKET` | 12 | Size/Color | Black + Grey merged ✓ |
| `AIRMESH-JACKET` | 12 | Size/Color | Black + Yellow merged ✓ |
| `AIREON` | 12 | Size/Color | Crema + Nero Neo merged ✓ |
| `xavia-knee-slider` | 8 | Size | 8 colors |
| `normal-knee-slider` | 8 | Size | 8 colors |
| `AIR-MESH-JACKET-MEN` | 6 | Size/Color | |
| `WATERPROOF-OVERJACKET-BLACK-MEN` | 6 | Size/Color | |

### 36 orphan children to follow up on
Mostly women's variants (`REGAL-JACKET-*-WOMEN`, `VENTRA-JACKET-*-WOMEN`)
whose parent record (`Da Donna` description) does not exist in the DB —
only the men's parent is imported. Two ways to fix:
1. Import the women's parent records from Amazon Seller Central, then
   re-run `/products/auto-group?reset=1`.
2. Manually merge them via `POST /api/amazon/products/merge` with body
   `{ parentSku, childSkus[], variationTheme }`. (`/products/unmerge` is
   also available to undo a merge.)

### Frontend
- `/api/inventory/top-level` now exposes `childCount` (computed from
  inline children) and `variationTheme` on each parent row. The
  `apps/web/src/components/inventory/columns.tsx` chevron rendering is
  gated on `item.childCount > 0` and was already wired up correctly.
- `apps/web/src/components/inventory/InventoryTable.tsx` lazy-loads
  children via `/api/inventory/{id}/children` (Next.js proxy →
  backend `/api/amazon/products/{id}/children`). Verified: returns the
  expected count for each parent (8, 12, 21, 38 children, etc.).

### Why we did not migrate to a proper hierarchy at the SP-API level
The Catalog Items API role is gated by Amazon's Restricted Role process
in the Italian marketplace. Title-based matching is the pragmatic path.
If the role becomes available later, `/api/amazon/products/reindex-hierarchy`
(already built, blocked on auth right now) will use the real Amazon
parent ASINs and supersede this title heuristic — the existing
parent/child records can be cleared with `?reset=1` on auto-group, then
the reindex re-builds from authoritative data.

