/**
 * RT.3 — End-to-end push-notification latency dashboard.
 *
 * Measures (ingestedAt - providerTimestamp) per WebhookEvent row over
 * the requested window and returns p50/p95/p99 + histogram buckets
 * per source. Lets the operator see at a glance:
 *
 *   "Amazon push p95 = 38s   eBay p95 = 12s   Shopify p95 = 4s"
 *
 * vs. yesterday or week-over-week, to spot when a particular provider
 * starts dragging.
 *
 * GET /api/admin/push-latency?window=24h
 *   Returns:
 *     {
 *       window: '24h' | '7d',
 *       sources: [{
 *         source: 'AMAZON' | 'EBAY' | 'SHOPIFY',
 *         sampleCount: number,     // rows with a providerTimestamp
 *         missingTimestamp: number,// rows in window without one
 *         p50Ms: number | null,
 *         p95Ms: number | null,
 *         p99Ms: number | null,
 *         minMs: number | null,
 *         maxMs: number | null,
 *         histogram: Array<{ bucket: string; count: number }>,
 *       }],
 *       checkedAt: string,
 *     }
 *
 * Histogram buckets: 0-1s, 1-5s, 5-15s, 15-60s, 1-5min, 5-15min,
 * 15-60min, >1h. Chosen to make the common cases (sub-minute push)
 * legible while still surfacing pathological tail latency.
 */

import type { FastifyInstance } from 'fastify'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'

type Source = 'AMAZON' | 'EBAY' | 'SHOPIFY'
const SOURCES: Source[] = ['AMAZON', 'EBAY', 'SHOPIFY']

interface HistogramBucket {
  label: string
  maxMs: number
}

const BUCKETS: HistogramBucket[] = [
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
  // Nearest-rank — fine for ops dashboards; matches Datadog/Grafana
  // default behaviour, no interpolation surprises.
  const rank = Math.ceil((pct / 100) * sortedMs.length)
  return sortedMs[Math.max(0, Math.min(sortedMs.length - 1, rank - 1))] ?? null
}

function bucketIndex(ms: number): number {
  for (let i = 0; i < BUCKETS.length; i++) {
    if (ms <= BUCKETS[i]!.maxMs) return i
  }
  return BUCKETS.length - 1
}

export default async function pushLatencyRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/push-latency', async (req, reply) => {
    reply.header('Cache-Control', 'private, max-age=30')

    const q = req.query as { window?: string }
    const window = q.window === '7d' ? '7d' : '24h'
    const sinceMs = window === '7d' ? 7 * 24 * 60 * 60_000 : 24 * 60 * 60_000
    const since = new Date(Date.now() - sinceMs)

    try {
      const sources = await Promise.all(
        SOURCES.map(async (source) => {
          // We need the deltas for percentile + bucketing. Pulling the
          // raw rows is fine at Xavia's volume (~10k/day across all
          // sources). If this grows beyond ~100k/window, push the
          // percentile to a raw SQL query with PERCENTILE_CONT.
          const [rows, missing] = await Promise.all([
            prisma.webhookEvent.findMany({
              where: {
                channel: source,
                createdAt: { gte: since },
                providerTimestamp: { not: null },
              },
              select: { createdAt: true, providerTimestamp: true },
              take: 50_000, // hard ceiling — would surface as ?warn=truncated
            }),
            prisma.webhookEvent.count({
              where: {
                channel: source,
                createdAt: { gte: since },
                providerTimestamp: null,
              },
            }),
          ])

          const deltas: number[] = []
          const buckets = BUCKETS.map((b) => ({ bucket: b.label, count: 0 }))
          for (const r of rows) {
            if (!r.providerTimestamp) continue
            // Defensive clamp: if a clock is skewed and ingestedAt is
            // before providerTimestamp, treat as 0. Better than
            // surfacing negative latency in the dashboard.
            const delta = Math.max(0, r.createdAt.getTime() - r.providerTimestamp.getTime())
            deltas.push(delta)
            const bi = bucketIndex(delta)
            buckets[bi]!.count++
          }
          deltas.sort((a, b) => a - b)

          return {
            source,
            sampleCount: deltas.length,
            missingTimestamp: missing,
            p50Ms: percentile(deltas, 50),
            p95Ms: percentile(deltas, 95),
            p99Ms: percentile(deltas, 99),
            minMs: deltas[0] ?? null,
            maxMs: deltas[deltas.length - 1] ?? null,
            histogram: buckets,
          }
        }),
      )

      return reply.send({
        window,
        sources,
        checkedAt: new Date().toISOString(),
      })
    } catch (err: any) {
      logger.error('[push-latency] failed', { message: err?.message ?? String(err) })
      return reply.status(500).send({ error: err?.message ?? String(err) })
    }
  })
}
