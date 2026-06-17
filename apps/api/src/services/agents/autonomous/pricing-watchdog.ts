/**
 * ACP.4b — Pricing Watchdog (autonomous agent v2).
 *
 * Watches for margin-destroying pricing and PROPOSES a correction. It
 * only ever flags products priced BELOW their floor or BELOW cost, and it
 * only ever proposes RAISING the price to a sane level — it never
 * proposes a price cut (no race-to-the-bottom risk). Each proposal is a
 * `set-price` queued into the approval inbox (high-risk / always-ask), so
 * a human approves every change. Reuses the 4a autonomous runtime and the
 * 3b set-price execute path.
 *
 * Anomaly (conservative, low false-positive):
 *   - basePrice < minPrice (the operator's explicit floor)        → raise to minPrice
 *   - basePrice < cost      (selling at a guaranteed loss)         → raise to cost × (1 + margin%)
 * Cost = costPrice, falling back to weighted-average cost. Products with
 * no price (€0) or no known cost are skipped — those are a different
 * problem, not a Watchdog one. Proposed price is capped at maxPrice and
 * must strictly exceed the current price (else skipped).
 */

import prisma from '../../../db.js'
import { runOrQueueTool } from '../approval-gate.service.js'
import { logger } from '../../../utils/logger.js'
import type {
  AutonomousAgent,
  AutonomousAgentResult,
} from '../autonomous-agent.service.js'

const DEFAULT_MARKUP_PCT = 10 // when minMargin isn't set.

export interface PriceRow {
  id: string
  sku: string
  basePrice: unknown
  costPrice: unknown
  minMargin: unknown
  minPrice: unknown
  maxPrice: unknown
  weightedAvgCostCents: number | null
}

const num = (v: unknown): number | null =>
  v == null ? null : Number(v as never)

const round2 = (v: number) => Math.round(v * 100) / 100

function effectiveCost(p: PriceRow): number | null {
  const c = num(p.costPrice)
  if (c != null && c > 0) return c
  if (p.weightedAvgCostCents != null && p.weightedAvgCostCents > 0)
    return p.weightedAvgCostCents / 100
  return null
}

export interface Anomaly {
  proposed: number
  reason: string
}

export function detectAnomaly(p: PriceRow): Anomaly | null {
  const base = num(p.basePrice)
  if (base == null || base <= 0) return null // unpriced — not our problem
  const minP = num(p.minPrice)
  const maxP = num(p.maxPrice)
  const cost = effectiveCost(p)
  const margin = num(p.minMargin)

  let proposed: number | null = null
  let reason = ''

  if (minP != null && base < minP) {
    proposed = minP
    reason = `below floor: €${base.toFixed(2)} < minPrice €${minP.toFixed(2)}`
  } else if (cost != null && base < cost) {
    const markup = margin != null && margin > 0 ? margin : DEFAULT_MARKUP_PCT
    proposed = cost * (1 + markup / 100)
    reason = `below cost: €${base.toFixed(2)} < cost €${cost.toFixed(2)} → raise to ${markup}% markup`
  }
  if (proposed == null) return null

  if (maxP != null && proposed > maxP) proposed = maxP
  proposed = round2(proposed)
  // Only ever propose a raise; if rounding/cap makes it ≤ current, drop it.
  if (proposed <= base) return null
  return { proposed, reason }
}

export const pricingWatchdog: AutonomousAgent = {
  key: 'pricing-watchdog',
  name: 'Pricing Watchdog',
  description:
    'Scans active products priced below their floor or below cost and queues set-price proposals that raise them to a sane margin (always-ask).',

  async run({ runId, maxItems }): Promise<AutonomousAgentResult> {
    const result: AutonomousAgentResult = {
      scanned: 0,
      flagged: 0,
      proposed: 0,
      skippedExisting: 0,
      errors: 0,
      proposals: [],
    }

    // Products already awaiting a set-price decision — don't double-propose.
    const pending = await prisma.agentApproval.findMany({
      where: { status: 'pending', toolName: 'set-price' },
      select: { args: true },
    })
    const pendingIds = new Set(
      pending
        .map((p) => (p.args as { productId?: string } | null)?.productId)
        .filter((x): x is string => typeof x === 'string'),
    )

    // Candidates: active master products that have SOME price floor signal
    // (a minPrice, a costPrice, or a WAC) to compare against.
    const candidates = (await prisma.product.findMany({
      where: {
        deletedAt: null,
        status: 'ACTIVE',
        parentId: null,
        OR: [
          { minPrice: { not: null } },
          { costPrice: { not: null } },
          { weightedAvgCostCents: { not: null } },
        ],
      },
      select: {
        id: true,
        sku: true,
        basePrice: true,
        costPrice: true,
        minMargin: true,
        minPrice: true,
        maxPrice: true,
        weightedAvgCostCents: true,
      },
      orderBy: { updatedAt: 'asc' },
      take: 500,
    })) as PriceRow[]
    result.scanned = candidates.length

    for (const p of candidates) {
      if (result.proposed >= maxItems) break
      const anomaly = detectAnomaly(p)
      if (!anomaly) continue
      result.flagged++
      if (pendingIds.has(p.id)) {
        result.skippedExisting++
        continue
      }
      try {
        const out = await runOrQueueTool(
          'set-price',
          { productId: p.id, price: anomaly.proposed },
          { userId: null },
          runId,
        )
        if (out.mode === 'queued' && out.approvalId) {
          result.proposed++
          result.proposals.push({
            productId: p.id,
            sku: p.sku,
            approvalId: out.approvalId,
            summary: anomaly.reason,
          })
        } else {
          result.errors++
        }
      } catch (err) {
        result.errors++
        logger.warn('pricing-watchdog: product failed', {
          productId: p.id,
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }

    return result
  },
}
