/**
 * Order routing — resolves the warehouseId for a new shipment based
 * on operator-defined OrderRoutingRule rows. Falls back to the
 * default Warehouse (isDefault=true) when no rule matches.
 *
 * Rule evaluation:
 *   - Active rules only (isActive=true)
 *   - Sorted by priority ascending; first match wins
 *   - All match criteria are AND-ed; null criteria are wildcards
 *   - All match criteria all-null = unconditional fallback (use
 *     priority to control ordering vs. more specific rules)
 *
 * The function is intentionally pure-async: it takes the order data
 * it needs as inputs (channel, marketplace, shippingCountry) rather
 * than a full Order object so callers in different contexts (live
 * order ingestion, manual shipment creation, bulk-create) can use
 * the same logic.
 */

import prisma from '../db.js'
import { logger } from '../utils/logger.js'

export interface RouteOrderInput {
  channel: string | null
  marketplace: string | null
  shippingCountry: string | null
  /** Override the default-warehouse fallback. Useful for tests or
   *  when the caller already knows the desired fallback. */
  fallbackWarehouseId?: string | null
}

export interface RouteOrderResult {
  warehouseId: string | null
  ruleId: string | null
  ruleName: string | null
  source: 'RULE_MATCH' | 'DEFAULT_WAREHOUSE' | 'FALLBACK_OVERRIDE' | 'SCORED' | 'NONE'
  /** CE.4 — cost/proximity score breakdown (only set when source='SCORED') */
  scoreSummary?: Record<string, { proximityScore: number; stockScore: number; total: number }>
}

export async function resolveWarehouseForOrder(
  input: RouteOrderInput,
): Promise<RouteOrderResult> {
  // Try rules first.
  const rules = await prisma.orderRoutingRule.findMany({
    where: { isActive: true },
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
  })
  for (const rule of rules) {
    if (rule.channel && rule.channel !== input.channel) continue
    if (rule.marketplace && rule.marketplace !== input.marketplace) continue
    if (
      rule.shippingCountry &&
      rule.shippingCountry !== input.shippingCountry
    ) {
      continue
    }
    return {
      warehouseId: rule.warehouseId,
      ruleId: rule.id,
      ruleName: rule.name,
      source: 'RULE_MATCH',
    }
  }

  // CE.4 — scored fallback: no rule matched; score all active warehouses
  // by proximity (country match) + available stock and route to highest.
  try {
    const warehouses = await prisma.warehouse.findMany({
      where: { isActive: true },
      select: {
        id: true,
        country: true,
        isDefault: true,
      },
    })

    if (warehouses.length > 0) {
      const scores: Record<string, { proximityScore: number; stockScore: number; total: number }> = {}
      for (const wh of warehouses) {
        // Proximity: +10 if warehouse country matches shippingCountry
        const proximityScore = wh.country === input.shippingCountry ? 10 : 0
        // Default warehouse: +1 tiebreaker (stock scoring deferred to future
        // enhancement when StockLocation→Warehouse link is available)
        const defaultBonus = wh.isDefault ? 1 : 0
        scores[wh.id] = {
          proximityScore,
          stockScore: defaultBonus,
          total: proximityScore + defaultBonus,
        }
      }

      const best = warehouses
        .map((wh) => ({ id: wh.id, total: scores[wh.id]?.total ?? 0 }))
        .sort((a, b) => b.total - a.total)[0]

      if (best) {
        return {
          warehouseId: best.id,
          ruleId: null,
          ruleName: null,
          source: 'SCORED',
          scoreSummary: scores,
        }
      }
    }
  } catch (err) {
    logger.warn(
      '[order-routing] scored fallback failed',
      { err: err instanceof Error ? err.message : String(err) },
    )
  }

  // Final fallback: caller-supplied override.
  if (input.fallbackWarehouseId) {
    return {
      warehouseId: input.fallbackWarehouseId,
      ruleId: null,
      ruleName: null,
      source: 'FALLBACK_OVERRIDE',
    }
  }

  return { warehouseId: null, ruleId: null, ruleName: null, source: 'NONE' }
}

/**
 * CE.4 — Write a RoutingDecision audit row after routing resolves.
 * Non-throwing: if the write fails, the original routing result is unchanged.
 */
export async function recordRoutingDecision(
  orderId: string,
  result: RouteOrderResult,
): Promise<void> {
  try {
    await prisma.routingDecision.create({
      data: {
        orderId,
        warehouseId: result.warehouseId,
        method: result.source === 'RULE_MATCH' ? 'rule'
          : result.source === 'SCORED' ? 'scored'
            : result.source === 'FALLBACK_OVERRIDE' ? 'fallback'
              : 'none',
        ruleId: result.ruleId,
        scoreSummary: (result.scoreSummary as never) ?? null,
      },
    })
  } catch {
    // Non-fatal: audit failure doesn't affect fulfillment
  }
}

/**
 * Helper used by the routing rules CRUD UI: dry-run a candidate
 * order against the active rule set so the operator can see which
 * rule will match (or that nothing will, falling back to default).
 */
export async function previewRouting(input: RouteOrderInput) {
  return resolveWarehouseForOrder(input)
}
