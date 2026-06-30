# Phase 0 — Inventory Sync Baseline & Truth — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add read-only instrumentation that tells us the *actual* state of real-time inventory sync — outbound push latency per channel, a consolidated config/health diagnostic, a one-time drift baseline, and a reusable (gated) synthetic canary — so every later phase has before/after evidence.

**Architecture:** Pure, unit-tested metric functions in one module (`sync-metrics.ts`), consumed by two thin read-only admin endpoints and two operational scripts. Mirrors the existing `push-latency.routes.ts` (RT.3) inbound-latency pattern, extended to the outbound `OutboundSyncQueue` (`createdAt → syncedAt`). No behavior change to any sync path; the only writes are in the canary script, which defaults to dry-run and is net-zero + manually invoked.

**Tech Stack:** Fastify (API routes), Prisma (`OutboundSyncQueue`, `CronRun`, `ChannelListing`), Vitest (unit tests), tsx (scripts), `pg`/`dotenv` (script DB access), TypeScript.

## Global Constraints

- **Read-only / no behavior change.** No edits to `stock-movement.service.ts`, `outbound-sync.service.ts`, `bullmq-sync.worker.ts`, `sync.worker.ts`, the inbound webhooks, or any cron. Phase 0 only *observes*.
- **FBA guard is never weakened or touched.** No changes to `isFbaListing`, `amazon-sp-api.client.ts`, or the FBA flip-guard/restore.
- **Live channels = Amazon + eBay** (Shopify connected, not transacting) — reports must still include Shopify columns but treat empty Shopify data as expected, not an error.
- **Verify on prod, not Docker** — endpoints verified against the deployed API; scripts run against `DATABASE_URL`. Local is for `vitest` + `tsc` only.
- **Commit + push after each task** (standing rule). Pre-push hook builds `apps/api`; a task isn't done until it builds clean.
- **Untouchable flat-file pages** and the FBA guard are out of scope by definition.
- Branch: `worktree-inventory-col`.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `apps/api/src/services/sync-metrics.ts` (create) | Pure, tested metric helpers: latency percentiles/histogram, outbound row→delta, outbound-latency response builder, diagnostics summarizer. The single home for Phase 0 logic. |
| `apps/api/src/services/sync-metrics.vitest.test.ts` (create) | Unit tests for every pure function above. |
| `apps/api/src/routes/outbound-latency.routes.ts` (create) | `GET /api/admin/outbound-latency` — thin route: query `OutboundSyncQueue`, call `sync-metrics`, return. |
| `apps/api/src/routes/inventory-sync-diagnostics.routes.ts` (create) | `GET /api/admin/inventory-sync/diagnostics` — gather config + queue/DLQ/cron facts, call `summarizeDiagnostics`, return. |
| `apps/api/src/index.ts` (modify) | Register the two new route plugins (mirrors `pushLatencyRoutes`). |
| `scripts/inventory-drift-baseline.ts` (create) | One-time: Amazon reconcile (existing service) + eBay DB-drift (ChannelListing.quantity vs ATP) → printed drift report. |
| `scripts/inventory-canary.ts` (create) | Gated, dry-run-default, net-zero synthetic canary measuring stock-change → channel `syncedAt` round-trip per channel. Reused as the regression harness in later phases. |

---

### Task 1: `sync-metrics` pure module + tests

**Files:**
- Create: `apps/api/src/services/sync-metrics.ts`
- Test: `apps/api/src/services/sync-metrics.vitest.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces (later tasks rely on these exact names/types):
  - `LATENCY_BUCKETS: Array<{ label: string; maxMs: number }>`
  - `interface HistogramBucket { bucket: string; count: number }`
  - `interface LatencyStats { sampleCount: number; p50Ms: number|null; p95Ms: number|null; p99Ms: number|null; minMs: number|null; maxMs: number|null; histogram: HistogramBucket[] }`
  - `computeLatencyStats(deltasMs: number[]): LatencyStats`
  - `outboundDeltaMs(row: { createdAt: Date; syncedAt: Date | null }): number | null`
  - `interface OutboundLatencyRow { targetChannel: string; createdAt: Date; syncedAt: Date | null }`
  - `interface ChannelLatency extends LatencyStats { channel: string; pendingCount: number }`
  - `buildOutboundLatencyResponse(rows: OutboundLatencyRow[], window: string, checkedAtIso: string): { window: string; channels: ChannelLatency[]; checkedAt: string }`
  - `interface DiagnosticsInput { queueWorkersEnabled: boolean; redisConfigured: boolean; ebayNotificationsActive: boolean | null; shopifyPublishLive: boolean; amazonPublishLive: boolean; outboundPending: number; outboundOldestPendingAgeMs: number | null; dlqDepth: number; crons: Array<{ name: string; lastRunAt: string | null; lastStatus: string | null; ageMs: number | null }> }`
  - `interface DiagnosticsReport { checkedAt: string; dispatchPath: 'immediate-bullmq' | 'cron-60s-only'; realtimeReady: boolean; warnings: string[]; config: { queueWorkersEnabled: boolean; redisConfigured: boolean; amazonPublishLive: boolean; ebayNotificationsActive: boolean | null; shopifyPublishLive: boolean }; queue: { pending: number; oldestPendingAgeMs: number | null; dlqDepth: number }; crons: DiagnosticsInput['crons'] }`
  - `summarizeDiagnostics(input: DiagnosticsInput, checkedAtIso: string): DiagnosticsReport`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/sync-metrics.vitest.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  computeLatencyStats,
  outboundDeltaMs,
  buildOutboundLatencyResponse,
  summarizeDiagnostics,
} from './sync-metrics.js'

describe('computeLatencyStats', () => {
  it('returns nulls and zero count for empty input', () => {
    expect(computeLatencyStats([])).toEqual({
      sampleCount: 0,
      p50Ms: null, p95Ms: null, p99Ms: null, minMs: null, maxMs: null,
      histogram: [
        { bucket: '0-1s', count: 0 }, { bucket: '1-5s', count: 0 },
        { bucket: '5-15s', count: 0 }, { bucket: '15-60s', count: 0 },
        { bucket: '1-5min', count: 0 }, { bucket: '5-15min', count: 0 },
        { bucket: '15-60min', count: 0 }, { bucket: '>1h', count: 0 },
      ],
    })
  })

  it('computes nearest-rank percentiles and min/max', () => {
    const s = computeLatencyStats([500, 1500, 8000, 40000])
    expect(s.sampleCount).toBe(4)
    expect(s.minMs).toBe(500)
    expect(s.maxMs).toBe(40000)
    expect(s.p50Ms).toBe(1500) // ceil(0.5*4)=2 -> index 1
    expect(s.p95Ms).toBe(40000)
  })

  it('buckets each delta into the right histogram band', () => {
    const s = computeLatencyStats([500, 3000, 40000])
    const get = (b: string) => s.histogram.find((h) => h.bucket === b)!.count
    expect(get('0-1s')).toBe(1)
    expect(get('1-5s')).toBe(1)
    expect(get('15-60s')).toBe(1)
  })
})

describe('outboundDeltaMs', () => {
  it('returns null when not yet synced', () => {
    expect(outboundDeltaMs({ createdAt: new Date(), syncedAt: null })).toBeNull()
  })
  it('returns syncedAt - createdAt in ms', () => {
    const created = new Date('2026-06-30T10:00:00.000Z')
    const synced = new Date('2026-06-30T10:00:03.500Z')
    expect(outboundDeltaMs({ createdAt: created, syncedAt: synced })).toBe(3500)
  })
  it('clamps negative (clock skew) to 0', () => {
    const created = new Date('2026-06-30T10:00:05.000Z')
    const synced = new Date('2026-06-30T10:00:00.000Z')
    expect(outboundDeltaMs({ createdAt: created, syncedAt: synced })).toBe(0)
  })
})

describe('buildOutboundLatencyResponse', () => {
  it('groups by channel, counts pending separately, and stats only synced rows', () => {
    const c = new Date('2026-06-30T10:00:00.000Z')
    const s2 = new Date('2026-06-30T10:00:02.000Z')
    const res = buildOutboundLatencyResponse(
      [
        { targetChannel: 'AMAZON', createdAt: c, syncedAt: s2 },
        { targetChannel: 'AMAZON', createdAt: c, syncedAt: null },
        { targetChannel: 'EBAY', createdAt: c, syncedAt: s2 },
      ],
      '24h',
      '2026-06-30T10:01:00.000Z',
    )
    expect(res.window).toBe('24h')
    expect(res.checkedAt).toBe('2026-06-30T10:01:00.000Z')
    const amazon = res.channels.find((x) => x.channel === 'AMAZON')!
    expect(amazon.sampleCount).toBe(1)
    expect(amazon.pendingCount).toBe(1)
    expect(amazon.p50Ms).toBe(2000)
    const ebay = res.channels.find((x) => x.channel === 'EBAY')!
    expect(ebay.pendingCount).toBe(0)
  })
})

describe('summarizeDiagnostics', () => {
  const base = {
    queueWorkersEnabled: true, redisConfigured: true,
    ebayNotificationsActive: true, shopifyPublishLive: false, amazonPublishLive: true,
    outboundPending: 0, outboundOldestPendingAgeMs: null, dlqDepth: 0, crons: [],
  }
  it('reports immediate path + realtime-ready with no warnings when healthy', () => {
    const r = summarizeDiagnostics(base, '2026-06-30T10:00:00.000Z')
    expect(r.dispatchPath).toBe('immediate-bullmq')
    expect(r.realtimeReady).toBe(true)
    expect(r.warnings).toEqual([])
  })
  it('warns and downgrades when queue workers are off', () => {
    const r = summarizeDiagnostics({ ...base, queueWorkersEnabled: false }, 'now')
    expect(r.dispatchPath).toBe('cron-60s-only')
    expect(r.realtimeReady).toBe(false)
    expect(r.warnings.some((w) => w.includes('queue workers'))).toBe(true)
  })
  it('warns when eBay notifications inactive, DLQ non-empty, and backlog is old', () => {
    const r = summarizeDiagnostics(
      { ...base, ebayNotificationsActive: false, dlqDepth: 3, outboundOldestPendingAgeMs: 10 * 60_000 },
      'now',
    )
    expect(r.warnings.some((w) => w.toLowerCase().includes('ebay'))).toBe(true)
    expect(r.warnings.some((w) => w.includes('dead-letter') || w.includes('DLQ'))).toBe(true)
    expect(r.warnings.some((w) => w.toLowerCase().includes('backlog'))).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/sync-metrics.vitest.test.ts`
Expected: FAIL — `Cannot find module './sync-metrics.js'`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/services/sync-metrics.ts`:

```ts
/**
 * Phase 0 — pure metric helpers for inventory-sync instrumentation.
 *
 * Outbound latency = OutboundSyncQueue.syncedAt - createdAt, grouped by
 * targetChannel. Mirrors the inbound RT.3 push-latency math so the two
 * dashboards read the same way. No DB or IO here — all pure + tested.
 */

export interface HistogramBucket {
  bucket: string
  count: number
}

export interface LatencyStats {
  sampleCount: number
  p50Ms: number | null
  p95Ms: number | null
  p99Ms: number | null
  minMs: number | null
  maxMs: number | null
  histogram: HistogramBucket[]
}

export const LATENCY_BUCKETS: Array<{ label: string; maxMs: number }> = [
  { label: '0-1s', maxMs: 1_000 },
  { label: '1-5s', maxMs: 5_000 },
  { label: '5-15s', maxMs: 15_000 },
  { label: '15-60s', maxMs: 60_000 },
  { label: '1-5min', maxMs: 5 * 60_000 },
  { label: '5-15min', maxMs: 15 * 60_000 },
  { label: '15-60min', maxMs: 60 * 60_000 },
  { label: '>1h', maxMs: Number.POSITIVE_INFINITY },
]

function percentile(sortedMs: number[], pct: number): number | null {
  if (sortedMs.length === 0) return null
  const rank = Math.ceil((pct / 100) * sortedMs.length)
  return sortedMs[Math.max(0, Math.min(sortedMs.length - 1, rank - 1))] ?? null
}

function bucketIndex(ms: number): number {
  for (let i = 0; i < LATENCY_BUCKETS.length; i++) {
    if (ms <= LATENCY_BUCKETS[i]!.maxMs) return i
  }
  return LATENCY_BUCKETS.length - 1
}

export function computeLatencyStats(deltasMs: number[]): LatencyStats {
  const sorted = [...deltasMs].sort((a, b) => a - b)
  const histogram = LATENCY_BUCKETS.map((b) => ({ bucket: b.label, count: 0 }))
  for (const d of sorted) histogram[bucketIndex(d)]!.count++
  return {
    sampleCount: sorted.length,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    minMs: sorted[0] ?? null,
    maxMs: sorted[sorted.length - 1] ?? null,
    histogram,
  }
}

export function outboundDeltaMs(row: { createdAt: Date; syncedAt: Date | null }): number | null {
  if (!row.syncedAt) return null
  return Math.max(0, row.syncedAt.getTime() - row.createdAt.getTime())
}

export interface OutboundLatencyRow {
  targetChannel: string
  createdAt: Date
  syncedAt: Date | null
}

export interface ChannelLatency extends LatencyStats {
  channel: string
  pendingCount: number
}

export function buildOutboundLatencyResponse(
  rows: OutboundLatencyRow[],
  window: string,
  checkedAtIso: string,
): { window: string; channels: ChannelLatency[]; checkedAt: string } {
  const byChannel = new Map<string, { deltas: number[]; pending: number }>()
  for (const r of rows) {
    const entry = byChannel.get(r.targetChannel) ?? { deltas: [], pending: 0 }
    const d = outboundDeltaMs(r)
    if (d === null) entry.pending++
    else entry.deltas.push(d)
    byChannel.set(r.targetChannel, entry)
  }
  const channels: ChannelLatency[] = [...byChannel.entries()]
    .map(([channel, { deltas, pending }]) => ({
      channel,
      pendingCount: pending,
      ...computeLatencyStats(deltas),
    }))
    .sort((a, b) => a.channel.localeCompare(b.channel))
  return { window, channels, checkedAt: checkedAtIso }
}

export interface DiagnosticsInput {
  queueWorkersEnabled: boolean
  redisConfigured: boolean
  ebayNotificationsActive: boolean | null
  shopifyPublishLive: boolean
  amazonPublishLive: boolean
  outboundPending: number
  outboundOldestPendingAgeMs: number | null
  dlqDepth: number
  crons: Array<{ name: string; lastRunAt: string | null; lastStatus: string | null; ageMs: number | null }>
}

export interface DiagnosticsReport {
  checkedAt: string
  dispatchPath: 'immediate-bullmq' | 'cron-60s-only'
  realtimeReady: boolean
  warnings: string[]
  config: {
    queueWorkersEnabled: boolean
    redisConfigured: boolean
    amazonPublishLive: boolean
    ebayNotificationsActive: boolean | null
    shopifyPublishLive: boolean
  }
  queue: { pending: number; oldestPendingAgeMs: number | null; dlqDepth: number }
  crons: DiagnosticsInput['crons']
}

const BACKLOG_WARN_MS = 5 * 60_000

export function summarizeDiagnostics(input: DiagnosticsInput, checkedAtIso: string): DiagnosticsReport {
  const immediate = input.queueWorkersEnabled && input.redisConfigured
  const dispatchPath = immediate ? 'immediate-bullmq' : 'cron-60s-only'
  const warnings: string[] = []

  if (!immediate) {
    warnings.push(
      'Outbound queue workers are OFF — cross-channel push is bounded by the 60s cron, not real-time.',
    )
  }
  if (input.ebayNotificationsActive === false) {
    warnings.push(
      'eBay Platform Notifications inactive — eBay sales may lag up to 15min (poll backstop).',
    )
  }
  if (input.dlqDepth > 0) {
    warnings.push(`${input.dlqDepth} dead-letter (DLQ) row(s) need manual retry.`)
  }
  if (input.outboundOldestPendingAgeMs !== null && input.outboundOldestPendingAgeMs > BACKLOG_WARN_MS) {
    warnings.push(
      `Outbound backlog: oldest pending sync is ${Math.round(input.outboundOldestPendingAgeMs / 1000)}s old.`,
    )
  }

  const realtimeReady = immediate && input.ebayNotificationsActive !== false

  return {
    checkedAt: checkedAtIso,
    dispatchPath,
    realtimeReady,
    warnings,
    config: {
      queueWorkersEnabled: input.queueWorkersEnabled,
      redisConfigured: input.redisConfigured,
      amazonPublishLive: input.amazonPublishLive,
      ebayNotificationsActive: input.ebayNotificationsActive,
      shopifyPublishLive: input.shopifyPublishLive,
    },
    queue: {
      pending: input.outboundPending,
      oldestPendingAgeMs: input.outboundOldestPendingAgeMs,
      dlqDepth: input.dlqDepth,
    },
    crons: input.crons,
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/sync-metrics.vitest.test.ts`
Expected: PASS (4 describe blocks, all green).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/sync-metrics.ts apps/api/src/services/sync-metrics.vitest.test.ts
git commit -m "feat(inventory-sync): P0.1 pure sync-metrics helpers (latency + diagnostics)"
```

---

### Task 2: `GET /api/admin/outbound-latency` endpoint

**Files:**
- Create: `apps/api/src/routes/outbound-latency.routes.ts`
- Modify: `apps/api/src/index.ts` (import + register, next to `pushLatencyRoutes` at ~line 166 / 635)

**Interfaces:**
- Consumes: `buildOutboundLatencyResponse`, `OutboundLatencyRow` from `sync-metrics.js` (Task 1).
- Produces: route `GET /api/admin/outbound-latency?window=24h|7d&syncType=QUANTITY_UPDATE` returning `{ window, channels: ChannelLatency[], checkedAt }`.

- [ ] **Step 1: Write the route**

Create `apps/api/src/routes/outbound-latency.routes.ts`:

```ts
/**
 * Phase 0 — outbound push-latency dashboard (complement to RT.3 inbound).
 *
 * Measures OutboundSyncQueue.syncedAt - createdAt per targetChannel over
 * the window. For order-driven QUANTITY_UPDATE rows, createdAt is the
 * cascade time (~the stock movement), so this is the stock-change →
 * channel-confirmed latency. Read-only.
 *
 * GET /api/admin/outbound-latency?window=24h|7d&syncType=QUANTITY_UPDATE
 */
import type { FastifyInstance } from 'fastify'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { buildOutboundLatencyResponse, type OutboundLatencyRow } from '../services/sync-metrics.js'

export default async function outboundLatencyRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/outbound-latency', async (req, reply) => {
    reply.header('Cache-Control', 'private, max-age=30')
    const q = req.query as { window?: string; syncType?: string }
    const window = q.window === '7d' ? '7d' : '24h'
    const sinceMs = window === '7d' ? 7 * 24 * 60 * 60_000 : 24 * 60 * 60_000
    const since = new Date(Date.now() - sinceMs)

    try {
      const rows = (await prisma.outboundSyncQueue.findMany({
        where: {
          createdAt: { gte: since },
          ...(q.syncType ? { syncType: q.syncType } : {}),
        },
        select: { targetChannel: true, createdAt: true, syncedAt: true },
        take: 50_000,
      })) as OutboundLatencyRow[]

      return reply.send(buildOutboundLatencyResponse(rows, window, new Date().toISOString()))
    } catch (err: any) {
      logger.error('[outbound-latency] failed', { message: err?.message ?? String(err) })
      return reply.status(500).send({ error: err?.message ?? String(err) })
    }
  })
}
```

- [ ] **Step 2: Register the route in `index.ts`**

Add the import next to the other route imports (near line 166):

```ts
import outboundLatencyRoutes from "./routes/outbound-latency.routes.js";
```

Add the registration next to `pushLatencyRoutes` (near line 635):

```ts
// Phase 0 — outbound push-latency dashboard (complement to RT.3).
app.register(outboundLatencyRoutes, { prefix: '/api' });
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/api && npx tsc --noEmit`
Expected: no errors (the route is wiring over the Task-1 tested helpers).

- [ ] **Step 4: Commit + push (prod verify)**

```bash
git add apps/api/src/routes/outbound-latency.routes.ts apps/api/src/index.ts
git commit -m "feat(inventory-sync): P0.2 outbound push-latency endpoint"
git push
```

Then verify against the deployed API (replace `<API>` with the Railway URL from `reference_deployed_urls`):

Run: `curl -s "<API>/api/admin/outbound-latency?window=24h&syncType=QUANTITY_UPDATE" | jq '.channels[] | {channel, sampleCount, p50Ms, p95Ms, pendingCount}'`
Expected: one object per channel (AMAZON, EBAY at minimum) with numeric `p50Ms`/`p95Ms`. **Record these numbers — this is the outbound latency baseline.**

---

### Task 3: `GET /api/admin/inventory-sync/diagnostics` endpoint

**Files:**
- Create: `apps/api/src/routes/inventory-sync-diagnostics.routes.ts`
- Modify: `apps/api/src/index.ts` (import + register)

**Interfaces:**
- Consumes: `summarizeDiagnostics`, `DiagnosticsInput` from `sync-metrics.js` (Task 1).
- Produces: route `GET /api/admin/inventory-sync/diagnostics` returning a `DiagnosticsReport`.

Notes for the implementer:
- `ebayNotificationsActive`: best-effort. Query whether any active eBay `ChannelConnection` exists AND the env `EBAY_NOTIFICATION_VERIFICATION_TOKEN` is set (the webhook can't validate without it). If you can't determine it, return `null` (the summarizer treats `null` as "unknown", not a warning).
- Cron names to surface (verified against real `recordCronRun(...)` callsites 2026-06-30): `'sync-drift-detection'`, `'fba-flip-guard'`, `'reservation-sweep'`, `'amazon-inventory-sync'`, `'ebay-orders-sync'`. (`dlq-monitor` deliberately excluded — that job writes no `CronRun` row; DLQ depth is already surfaced via `queue.dlqDepth`.) Pull the latest `CronRun` per name. `CronRun` fields confirmed: `jobName`, `startedAt`, `status`.
- DLQ depth = `OutboundSyncQueue` rows with `isDead: true`.

- [ ] **Step 1: Write the route**

Create `apps/api/src/routes/inventory-sync-diagnostics.routes.ts`:

```ts
/**
 * Phase 0 — consolidated inventory-sync diagnostics. One call answers
 * "is real-time sync actually wired right now?": dispatch path (immediate
 * BullMQ vs 60s cron), eBay notification readiness, queue backlog, DLQ
 * depth, and the last run of the key inventory crons. Read-only.
 *
 * GET /api/admin/inventory-sync/diagnostics
 */
import type { FastifyInstance } from 'fastify'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { summarizeDiagnostics, type DiagnosticsInput } from '../services/sync-metrics.js'

const CRON_NAMES = [
  'sync-drift-detection',
  'fba-flip-guard',
  'reservation-sweep',
  'amazon-inventory-sync',
  'ebay-orders-sync',
]

export default async function inventorySyncDiagnosticsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/inventory-sync/diagnostics', async (_req, reply) => {
    reply.header('Cache-Control', 'private, max-age=15')
    try {
      const now = Date.now()

      const queueWorkersEnabled = process.env.ENABLE_QUEUE_WORKERS === '1'
      const redisConfigured = Boolean(process.env.REDIS_URL || process.env.REDIS_HOST)
      const amazonPublishLive =
        process.env.NEXUS_ENABLE_AMAZON_PUBLISH === 'true' && process.env.AMAZON_PUBLISH_MODE === 'live'
      const shopifyPublishLive =
        process.env.NEXUS_ENABLE_SHOPIFY_PUBLISH === 'true' && process.env.SHOPIFY_PUBLISH_MODE === 'live'

      const [activeEbay, oldestPending, outboundPending, dlqDepth, cronRows] = await Promise.all([
        (prisma as any).channelConnection.count({ where: { channelType: 'EBAY', isActive: true } }),
        prisma.outboundSyncQueue.findFirst({
          where: { syncStatus: 'PENDING' },
          orderBy: { createdAt: 'asc' },
          select: { createdAt: true },
        }),
        prisma.outboundSyncQueue.count({ where: { syncStatus: 'PENDING' } }),
        prisma.outboundSyncQueue.count({ where: { isDead: true } }),
        Promise.all(
          CRON_NAMES.map(async (name) => {
            const row = await prisma.cronRun.findFirst({
              where: { jobName: name },
              orderBy: { startedAt: 'desc' },
              select: { startedAt: true, status: true },
            })
            return {
              name,
              lastRunAt: row?.startedAt ? row.startedAt.toISOString() : null,
              lastStatus: row?.status ?? null,
              ageMs: row?.startedAt ? now - row.startedAt.getTime() : null,
            }
          }),
        ),
      ])

      const ebayNotificationsActive: boolean | null =
        activeEbay > 0 ? Boolean(process.env.EBAY_NOTIFICATION_VERIFICATION_TOKEN) : null

      const input: DiagnosticsInput = {
        queueWorkersEnabled,
        redisConfigured,
        ebayNotificationsActive,
        shopifyPublishLive,
        amazonPublishLive,
        outboundPending,
        outboundOldestPendingAgeMs: oldestPending ? now - oldestPending.createdAt.getTime() : null,
        dlqDepth,
        crons: cronRows,
      }

      return reply.send(summarizeDiagnostics(input, new Date().toISOString()))
    } catch (err: any) {
      logger.error('[inventory-sync diagnostics] failed', { message: err?.message ?? String(err) })
      return reply.status(500).send({ error: err?.message ?? String(err) })
    }
  })
}
```

> **Implementer note (resolved 2026-06-30):** `CronRun` fields `jobName`/`startedAt`/`status` are confirmed present, and the `CRON_NAMES` list above is the verified-correct set. No further schema investigation needed for Task 3.

- [ ] **Step 2: Register the route in `index.ts`**

Add the import near line 166:

```ts
import inventorySyncDiagnosticsRoutes from "./routes/inventory-sync-diagnostics.routes.js";
```

Add the registration near line 635:

```ts
// Phase 0 — consolidated inventory-sync diagnostics.
app.register(inventorySyncDiagnosticsRoutes, { prefix: '/api' });
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/api && npx tsc --noEmit`
Expected: no errors. (If `CronRun` field names differ, fix per the implementer note until clean.)

- [ ] **Step 4: Commit + push (prod verify)**

```bash
git add apps/api/src/routes/inventory-sync-diagnostics.routes.ts apps/api/src/index.ts
git commit -m "feat(inventory-sync): P0.3 consolidated sync diagnostics endpoint"
git push
```

Then verify against the deployed API:

Run: `curl -s "<API>/api/admin/inventory-sync/diagnostics" | jq '{dispatchPath, realtimeReady, warnings, config, queue}'`
Expected: a report. **This answers the open Phase 0 questions:** `dispatchPath` (`immediate-bullmq` vs `cron-60s-only`), `config.ebayNotificationsActive`, `queue.dlqDepth`. **Record this — it sets whether Phase 4 must enable the immediate path and whether eBay is truly real-time.**

---

### Task 4: One-time drift baseline script

**Files:**
- Create: `scripts/inventory-drift-baseline.ts`

**Interfaces:**
- Consumes: `reconcileAllAmazonMarketplaces({ daysBack? })` from `apps/api/src/services/channel-reconciliation.service.ts`; Prisma `ChannelListing` (+ its `product` relation).
- Produces: console report only (no writes).

Notes (verified against the codebase 2026-06-30):
- Amazon side: call `reconcileAllAmazonMarketplaces({ daysBack: 30 })` (reporting-only per the service) and print its per-marketplace FBA-unit + order drift.
- eBay side — **coarse DB-side baseline that mirrors the production `sync-drift-detection` job** (`apps/api/src/jobs/sync-drift-detection.job.ts`): for each `followMasterQuantity` ACTIVE eBay `ChannelListing`, compute `expected = max(0, Product.totalStock − stockBuffer)` and `drift = quantity − expected`. Print rows where `drift ≠ 0`, worst-first, with a SKU-count + absolute-unit total. This is intentionally coarse (ignores reservations / per-location ATP); the full ATP-accurate, channel-API read-back is Phase 5. Field facts: `ChannelListing.channel` is a `String` (`'EBAY'`), `listingStatus` is a `String` (`'ACTIVE'`), `Product.totalStock` is an `Int`. Do NOT use `resolveAtpAcrossChannels` here — it requires a pre-assembled `byLocation` array that only the stock-detail route builds.

- [ ] **Step 1: Write the script**

Create `scripts/inventory-drift-baseline.ts`:

```ts
#!/usr/bin/env tsx
/**
 * Phase 0 — one-time inventory drift baseline (READ-ONLY).
 *
 *   Amazon: existing reconcile service (orders + FBA units vs our DB).
 *   eBay:   DB-side drift — ChannelListing.quantity (last pushed) vs ATP
 *           (what it should be now). Channel API read-back is Phase 5.
 *
 * Run: npx tsx scripts/inventory-drift-baseline.ts
 */
import { reconcileAllAmazonMarketplaces } from '../apps/api/src/services/channel-reconciliation.service.js'
import prisma from '../apps/api/src/db.js'

async function main() {
  console.log('\n=== Phase 0 drift baseline ===\n')

  // ── Amazon ───────────────────────────────────────────────
  console.log('--- Amazon reconcile (last 30d) ---')
  try {
    const amazon = await reconcileAllAmazonMarketplaces({ daysBack: 30 })
    console.log(JSON.stringify(amazon, null, 2))
  } catch (err) {
    console.error('Amazon reconcile failed:', err instanceof Error ? err.message : err)
  }

  // ── eBay (coarse DB-side; mirrors sync-drift-detection job) ──
  // expected = max(0, totalStock - stockBuffer); drift = pushed qty - expected.
  // Coarse on purpose (ignores reservations / per-location ATP) — Phase 5 adds
  // the ATP-accurate channel-API read-back.
  console.log('\n--- eBay DB-side drift (pushed qty vs max(0, totalStock - buffer)) ---')
  const ebayListings = await prisma.channelListing.findMany({
    where: { channel: 'EBAY', listingStatus: 'ACTIVE', followMasterQuantity: true },
    select: {
      id: true,
      marketplace: true,
      quantity: true,
      stockBuffer: true,
      product: { select: { sku: true, totalStock: true } },
    },
  })

  const drifted = ebayListings
    .map((l) => {
      const expected = Math.max(0, (l.product.totalStock ?? 0) - (l.stockBuffer ?? 0))
      const pushed = l.quantity ?? 0
      return { sku: l.product.sku, marketplace: l.marketplace, pushed, expected, drift: pushed - expected }
    })
    .filter((r) => r.drift !== 0)
    .sort((a, b) => Math.abs(b.drift) - Math.abs(a.drift))

  console.log(`eBay followMaster ACTIVE listings checked: ${ebayListings.length}, drifted: ${drifted.length}`)
  for (const r of drifted.slice(0, 50)) {
    console.log(`  ${r.sku} [${r.marketplace}] pushed=${r.pushed} expected=${r.expected} drift=${r.drift > 0 ? '+' : ''}${r.drift}`)
  }
  const totalUnits = drifted.reduce((s, r) => s + Math.abs(r.drift), 0)
  console.log(`\neBay drift totals: ${drifted.length} SKUs, ${totalUnits} units of absolute drift.`)

  await prisma.$disconnect()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
```

> **Implementer note (resolved 2026-06-30):** all field names + the `reconcileAllAmazonMarketplaces({ daysBack })` signature above are verified against the codebase — transcribe the script as written. It is operational tooling (runs against `DATABASE_URL`, not in the test sandbox); verification for this task is that it **typechecks / imports resolve**, since the live run is the separate baseline-capture step.

- [ ] **Step 2: Verify by faithful transcription + self-review**

`scripts/` is not covered by a tsconfig and the script connects to the DB on run, so there is no meaningful in-sandbox execution check. Verify by: (a) the file matches the brief code exactly; (b) the imports (`reconcileAllAmazonMarketplaces`, `prisma`) and the field names (`channel`, `listingStatus`, `followMasterQuantity`, `stockBuffer`, `product.totalStock`) match the confirmed signatures in this brief. **The live run against `DATABASE_URL` is the separate baseline-capture step (the controller runs it); its totals decide whether Phase 5 starts detect-only or auto-heal.**

- [ ] **Step 3: Commit**

```bash
git add scripts/inventory-drift-baseline.ts
git commit -m "feat(inventory-sync): P0.4 one-time drift baseline script"
```

---

### Task 5: Gated synthetic canary script

**Files:**
- Create: `scripts/inventory-canary.ts`

**Interfaces:**
- Consumes: `applyStockMovement` from `apps/api/src/services/stock-movement.service.ts`; Prisma `OutboundSyncQueue`.
- Produces: console report of round-trip (movement → `syncedAt`) per channel. **Net-zero** (+delta then −delta) and **dry-run by default**.

Behavior:
- Args: `--sku <SKU>` (required), `--confirm` (without it, dry-run: print what it would do and exit), `--delta <n>` (default 1), `--wait <seconds>` (default 90).
- With `--confirm`: read the SKU's current stock, apply `+delta` via `applyStockMovement` (reason `'MANUAL_ADJUSTMENT'` — a valid `MovementReason`), capture timestamp T0, poll `OutboundSyncQueue` for rows with this product created ≥ T0 until each channel's row has `syncedAt` (or `--wait` elapses), then apply `−delta` to restore. Print per-channel `syncedAt - createdAt`.
- **Grace-window caveat:** `MANUAL_ADJUSTMENT` is NOT an order-driven reason, so its outbound rows carry the ~30s manual undo-grace (`DEFAULT_HOLD_MS`) before dispatch — the measured round-trip *includes* that 30s. Order-driven pushes (real sales) skip the grace (delay 0). Print this caveat in the output so the number isn't misread; the default `--wait 90` comfortably covers grace + push. (A Phase 4 latency variant can exercise the order-driven path.)
- **Safety:** intended for a SKU the operator designates as safe (ideally not on live channels, or accept the ±1 round-trip). The net change is zero. Never runs from a cron.

- [ ] **Step 1: Write the script**

Create `scripts/inventory-canary.ts`:

```ts
#!/usr/bin/env tsx
/**
 * Phase 0 — synthetic inventory canary. Perturbs ONE designated SKU by
 * ±delta (net zero) and measures stock-change → channel syncedAt per
 * channel. Reused as the regression harness in later phases.
 *
 * Dry-run by default. Writes only with --confirm.
 *
 *   npx tsx scripts/inventory-canary.ts --sku CANARY-001            # dry-run
 *   npx tsx scripts/inventory-canary.ts --sku CANARY-001 --confirm  # live ±1
 */
import { applyStockMovement } from '../apps/api/src/services/stock-movement.service.js'
import prisma from '../apps/api/src/db.js'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const has = (name: string) => process.argv.includes(`--${name}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const sku = arg('sku')
  if (!sku) { console.error('Missing --sku <SKU>'); process.exit(1) }
  const delta = Number(arg('delta') ?? '1')
  const waitS = Number(arg('wait') ?? '90')
  const confirm = has('confirm')

  const product = await prisma.product.findUnique({ where: { sku }, select: { id: true, sku: true, totalStock: true } })
  if (!product) { console.error(`No product with sku ${sku}`); process.exit(1) }

  if (!confirm) {
    console.log(`[dry-run] would +${delta} then -${delta} on ${product.sku} (current totalStock=${product.totalStock}) and measure round-trip. Re-run with --confirm.`)
    await prisma.$disconnect()
    return
  }

  const t0 = new Date()
  console.log(`Canary: +${delta} on ${product.sku} at ${t0.toISOString()}`)
  console.log('NOTE: round-trip includes the ~30s manual undo-grace (MANUAL_ADJUSTMENT is not order-driven). Real sales skip it.')
  await applyStockMovement({ productId: product.id, change: delta, reason: 'MANUAL_ADJUSTMENT' })

  const deadline = Date.now() + waitS * 1000
  const seen = new Map<string, number>()
  while (Date.now() < deadline) {
    const rows = await prisma.outboundSyncQueue.findMany({
      where: { productId: product.id, createdAt: { gte: t0 }, syncType: 'QUANTITY_UPDATE' },
      select: { targetChannel: true, createdAt: true, syncedAt: true },
    })
    for (const r of rows) {
      if (r.syncedAt && !seen.has(r.targetChannel)) {
        seen.set(r.targetChannel, r.syncedAt.getTime() - r.createdAt.getTime())
        console.log(`  ${r.targetChannel}: round-trip ${seen.get(r.targetChannel)}ms`)
      }
    }
    if (rows.length > 0 && rows.every((r) => r.syncedAt)) break
    await sleep(2000)
  }

  console.log(`Canary: restoring -${delta} on ${product.sku}`)
  await applyStockMovement({ productId: product.id, change: -delta, reason: 'MANUAL_ADJUSTMENT' })

  console.log('\nRound-trip summary:', Object.fromEntries(seen))
  await prisma.$disconnect()
}

main().catch((e) => { console.error(e); process.exit(1) })
```

> **Implementer note (resolved 2026-06-30):** `applyStockMovement(input: StockMovementInput)` takes `{ productId, change, reason, ... }`; `reason: 'MANUAL_ADJUSTMENT'` is a valid `MovementReason` (no `as any` cast needed — the inline object is contextually typed). Transcribe as written.

- [ ] **Step 2: Verify by faithful transcription + self-review**

`scripts/` isn't covered by a tsconfig and even `--dry-run` reads the DB, so there's no in-sandbox execution check. Verify by: (a) the file matches the brief code exactly; (b) the `applyStockMovement({ productId, change, reason: 'MANUAL_ADJUSTMENT' })` call and the `prisma.outboundSyncQueue.findMany` select (`targetChannel`, `createdAt`, `syncedAt`) match the confirmed signatures. The `--sku` dry-run + `--confirm` live run happen in the controller's baseline-capture step against the real DB.

- [ ] **Step 3: Commit**

```bash
git add scripts/inventory-canary.ts
git commit -m "feat(inventory-sync): P0.5 gated synthetic canary harness"
git push
```

---

## Self-Review

**1. Spec coverage** — Phase 0 of the spec asks for: (a) confirm prod config (`ENABLE_QUEUE_WORKERS`, eBay notifications, Shopify) → Task 3 diagnostics; (b) latency instrumentation + canary → Task 2 (outbound latency) + Task 5 (canary); (c) one-time reconciliation/drift baseline → Task 4. All three covered. The spec's "open items to resolve in Phase 0" map to the Task 3 + Task 4 recorded outputs.

**2. Placeholder scan** — No "TBD/handle errors/similar to". The three "implementer note" callouts are deliberate schema-confirmation steps (CronRun fields, ATP return shape, StockMovementInput), not vague hand-waves — each names the exact file to check and what to adjust. Acceptable for operational tasks touching unverified schema.

**3. Type consistency** — `LatencyStats`, `ChannelLatency`, `DiagnosticsInput`, `DiagnosticsReport`, `outboundDeltaMs`, `buildOutboundLatencyResponse`, `summarizeDiagnostics` are defined once in Task 1 and consumed by name in Tasks 2–3. `OutboundLatencyRow` field names (`targetChannel`, `createdAt`, `syncedAt`) match the `OutboundSyncQueue` select in Task 2.

**Risk note carried forward:** Tasks 3–5 each have exactly one schema/signature touch-point flagged for confirmation against the live Prisma schema / service before running — these are the only places the plan can drift from the codebase, and each is isolated to a single, called-out edit.
