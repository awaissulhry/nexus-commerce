/**
 * CI.1 — Customer RFM Scoring service.
 *
 * Assigns each Customer a Recency / Frequency / Monetary quintile score
 * (1–5, where 5 = best) and derives a composite label. Computed from
 * existing Customer aggregate fields — no new DB reads beyond the
 * Customer table itself.
 *
 * Quintile computation:
 *   For each dimension, sort all customer values and split into 5 equal
 *   buckets. Recency is inverted (fewer days since last order = higher score).
 *
 * Label derivation (priority order — first match wins):
 *   CHAMPION  : R≥4 AND F≥4 AND M≥4
 *   LOYAL     : R≥3 AND F≥4
 *   POTENTIAL : R≥3 AND F≤2 AND M≥3
 *   AT_RISK   : R≤2 AND F≥3
 *   LOST      : R=1 AND F≥2
 *   NEW       : F=1 AND R≥4
 *   ONE_TIME  : F=1 (catch-all for single-purchase, inactive)
 */

import type { PrismaClient } from '@nexus/database'
import { logger } from '../utils/logger.js'

export type RFMLabel =
  | 'CHAMPION'
  | 'LOYAL'
  | 'POTENTIAL'
  | 'AT_RISK'
  | 'LOST'
  | 'NEW'
  | 'ONE_TIME'

interface RFMCustomer {
  id: string
  totalOrders: number
  totalSpentCents: bigint
  lastOrderAt: Date | null
  firstOrderAt: Date | null
}

// ── Quintile helpers ───────────────────────────────────────────────────────

function quintile(values: number[], value: number): number {
  if (values.length === 0) return 3
  const sorted = [...values].sort((a, b) => a - b)
  const idx = sorted.findIndex((v) => value <= v)
  if (idx === -1) return 5
  const pct = idx / sorted.length
  if (pct < 0.2) return 1
  if (pct < 0.4) return 2
  if (pct < 0.6) return 3
  if (pct < 0.8) return 4
  return 5
}

function deriveLabel(r: number, f: number, m: number): RFMLabel {
  if (r >= 4 && f >= 4 && m >= 4) return 'CHAMPION'
  if (r >= 3 && f >= 4) return 'LOYAL'
  if (r >= 3 && f <= 2 && m >= 3) return 'POTENTIAL'
  if (r <= 2 && f >= 3) return 'AT_RISK'
  if (r === 1 && f >= 2) return 'LOST'
  if (f === 1 && r >= 4) return 'NEW'
  return 'ONE_TIME'
}

// ── Main scorer ────────────────────────────────────────────────────────────

export async function computeRFMForAll(
  prisma: PrismaClient,
): Promise<{ processed: number; errors: number }> {
  const now = new Date()

  // Load all customers with needed fields
  const customers = await prisma.customer.findMany({
    select: {
      id: true,
      totalOrders: true,
      totalSpentCents: true,
      lastOrderAt: true,
      firstOrderAt: true,
    },
  }) as RFMCustomer[]

  if (customers.length === 0) return { processed: 0, errors: 0 }

  // Compute dimension arrays for quintile thresholds
  const recencyDays = customers.map((c) =>
    c.lastOrderAt ? Math.floor((now.getTime() - c.lastOrderAt.getTime()) / 86400000) : 9999,
  )
  const frequencies = customers.map((c) => c.totalOrders)
  const monetaries = customers.map((c) => Number(c.totalSpentCents))

  // Build sorted arrays for quintile boundaries
  const sortedRecency = [...recencyDays].sort((a, b) => a - b)  // fewer days = better
  const sortedFrequency = [...frequencies].sort((a, b) => a - b)
  const sortedMonetary = [...monetaries].sort((a, b) => a - b)

  // For recency, lower days = better (invert quintile)
  function recencyQuintile(days: number): number {
    // Invert: most-recent customers get score 5
    return 6 - quintile(sortedRecency, days)
  }

  // Batch update customers in groups of 100
  const BATCH = 100
  let processed = 0
  let errors = 0

  for (let i = 0; i < customers.length; i += BATCH) {
    const batch = customers.slice(i, i + BATCH)
    await Promise.allSettled(
      batch.map(async (c) => {
        const daysSinceOrder = c.lastOrderAt
          ? Math.floor((now.getTime() - c.lastOrderAt.getTime()) / 86400000)
          : 9999

        const r = recencyQuintile(daysSinceOrder)
        const f = quintile(sortedFrequency, c.totalOrders)
        const m = quintile(sortedMonetary, Number(c.totalSpentCents))
        const label = deriveLabel(r, f, m)
        const score = `${r}${f}${m}`

        try {
          await prisma.customer.update({
            where: { id: c.id },
            data: { rfmScore: score, rfmLabel: label, rfmComputedAt: now },
          })
          processed++
        } catch {
          errors++
        }
      }),
    )
  }

  logger.info('rfm-scoring: completed', { processed, errors, total: customers.length })
  return { processed, errors }
}

// ── Distribution query ─────────────────────────────────────────────────────

export async function getRFMDistribution(
  prisma: PrismaClient,
): Promise<{
  byLabel: Record<string, number>
  byRScore: number[]
  lastComputedAt: string | null
}> {
  const rows = await prisma.customer.groupBy({
    by: ['rfmLabel'],
    _count: { _all: true },
    where: { rfmLabel: { not: null } },
  })

  const byLabel: Record<string, number> = {}
  for (const r of rows) {
    if (r.rfmLabel) byLabel[r.rfmLabel] = r._count._all
  }

  // R-score distribution (how many customers at each recency quintile)
  const byRScore: number[] = [0, 0, 0, 0, 0]
  const rRows = await prisma.customer.groupBy({
    by: ['rfmScore'],
    _count: { _all: true },
    where: { rfmScore: { not: null } },
  })
  for (const r of rRows) {
    if (r.rfmScore) {
      const rIdx = parseInt(r.rfmScore[0], 10) - 1
      if (rIdx >= 0 && rIdx < 5) byRScore[rIdx] += r._count._all
    }
  }

  const latest = await prisma.customer.findFirst({
    where: { rfmComputedAt: { not: null } },
    orderBy: { rfmComputedAt: 'desc' },
    select: { rfmComputedAt: true },
  })

  return {
    byLabel,
    byRScore,
    lastComputedAt: latest?.rfmComputedAt?.toISOString() ?? null,
  }
}
