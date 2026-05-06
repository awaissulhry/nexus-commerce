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
  source: 'RULE_MATCH' | 'DEFAULT_WAREHOUSE' | 'FALLBACK_OVERRIDE' | 'NONE'
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

  // Caller-supplied fallback wins over the implicit default.
  if (input.fallbackWarehouseId) {
    return {
      warehouseId: input.fallbackWarehouseId,
      ruleId: null,
      ruleName: null,
      source: 'FALLBACK_OVERRIDE',
    }
  }

  // Implicit fallback: default warehouse.
  try {
    const defaultWh = await prisma.warehouse.findFirst({
      where: { isDefault: true, isActive: true },
      select: { id: true },
    })
    if (defaultWh) {
      return {
        warehouseId: defaultWh.id,
        ruleId: null,
        ruleName: null,
        source: 'DEFAULT_WAREHOUSE',
      }
    }
  } catch (err) {
    logger.warn(
      '[order-routing] failed to resolve default warehouse',
      { err: err instanceof Error ? err.message : String(err) },
    )
  }

  return { warehouseId: null, ruleId: null, ruleName: null, source: 'NONE' }
}

/**
 * Helper used by the routing rules CRUD UI: dry-run a candidate
 * order against the active rule set so the operator can see which
 * rule will match (or that nothing will, falling back to default).
 */
export async function previewRouting(input: RouteOrderInput) {
  return resolveWarehouseForOrder(input)
}
