import type { Decimal } from 'decimal.js'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { PlanInput, PlanOrderLine } from '@nexus/factory-domain/planning/explode'
import { lotRuleOf, type LotRule } from '@nexus/factory-domain/planning/lot-sizing/lots'
import { scrapYieldFactor, type PlanLevel } from '@nexus/factory-domain/planning/lot-sizing/parameters'
import { planLevelOf } from '@nexus/factory-domain/planning/lot-sizing/plan-level'
import type { ScrapYield } from '@nexus/factory-domain/planning/lot-sizing/scrap'
import { itemPlanningFor } from '@nexus/factory-domain/planning/settings/items'
import type { ItemPlanningRow } from '../inputs'
import type { Reader } from '../store'

/**
 * What the plan reads of the planning rules per item (B-W2b-318; PLN-006, PLN-008, PLN-081, PLN-088), for every reader of
 * the plan (a run, readiness and the shortage list, promise dates: ../inputs `readPlanInputs` calls it), one query after
 * another and only when a rule is set:
 *
 *   lot sizing     each material's row at the site (its colour's first; ORDERS rows only): factory-domain lot-sizing/lots
 *   scrap, yield   each material's (or part's) factor, and each finished garment's: its SKU's FINISHED item (Item.variantId
 *                  of the style, colourway and size) and that item's row
 *   plan level     each style-colourway's level from its SKUs' rows (the finest set one)
 *   backlog rank   each order's SalesOrder.backlogRank (PLN-177; office only), on its lines
 *
 * No rule set: the order lines as they are and no hook (the plan is the one before this step).
 */

type Rule = Pick<ItemPlanningRow, 'itemId' | 'itemColourId' | 'method' | 'lotSizing' | 'fixedLotQty' | 'lotPeriodDays' | 'minOrderQty' | 'orderMultiple' | 'maxOrderQty' | 'planLevel' | 'scrapPct' | 'yieldPct'>

const text = (value: { toString(): string } | null): string | null => (value === null ? null : value.toString())
const factorOfRow = (row: Rule | null): Decimal | null => (row ? scrapYieldFactor(text(row.scrapPct), text(row.yieldPct)) : null)

export interface ItemRules {
  readonly orderLines: PlanOrderLine[]
  readonly hooks: Pick<PlanInput, 'lotSizing' | 'scrapYield'>
}

export async function readItemRules(db: Reader, orderLines: readonly PlanOrderLine[], itemPlanning: readonly Rule[]): Promise<ItemRules> {
  const rowsOf = new Map<string, Rule[]>()
  for (const row of itemPlanning) rowsOf.set(row.itemId, [...(rowsOf.get(row.itemId) ?? []), row])
  const rowFor = (itemId: string, itemColourId: string | null): Rule | null => itemPlanningFor(rowsOf.get(itemId) ?? [], itemColourId)

  // ---- lot sizing -------------------------------------------------------------------------------------------------------
  const sized = itemPlanning.some((row) => row.method === 'ORDERS' && row.lotSizing !== 'LOT_FOR_LOT')
  const lotSizing = sized ? (itemId: string, itemColourId: string | null): LotRule | null => lotRuleOf(rowFor(itemId, itemColourId)) : undefined

  // ---- the finished garments of the demand's styles (only when one of them has a rule) -----------------------------------
  const candidates = [...new Set(itemPlanning.filter((row) => row.planLevel !== null || factorOfRow(row) !== null).map((row) => row.itemId))]
  const styleIds = [...new Set(orderLines.map((line) => line.styleId))]
  const finished =
    candidates.length === 0 || styleIds.length === 0
      ? []
      : await db.item.findMany({
          where: { id: { in: candidates }, kind: 'FINISHED', variant: { styleId: { in: styleIds } } },
          select: { id: true, variant: { select: { styleId: true, colourwayId: true, size: true } } },
          orderBy: { id: 'asc' },
        })
  const skuItem = new Map<string, string>()
  const levels = new Map<string, (PlanLevel | null)[]>()
  for (const item of finished) {
    if (!item.variant) continue
    skuItem.set(`${item.variant.styleId}|${item.variant.colourwayId}|${item.variant.size}`, item.id)
    const key = `${item.variant.styleId}|${item.variant.colourwayId}`
    levels.set(key, [...(levels.get(key) ?? []), (rowFor(item.id, null)?.planLevel as PlanLevel | null | undefined) ?? null])
  }
  const finishedIds = new Set(finished.map((item) => item.id))

  // ---- scrap and yield ----------------------------------------------------------------------------------------------------
  const factored = itemPlanning.some((row) => factorOfRow(row) !== null)
  const scrapYield: ScrapYield | undefined = factored
    ? {
        // A finished garment's own factor is its sizes' (garmentFactor), never a material's.
        itemFactor: (itemId, itemColourId) => (finishedIds.has(itemId) ? null : factorOfRow(rowFor(itemId, itemColourId))),
        garmentFactor: (line, size) => {
          const itemId = skuItem.get(`${line.styleId}|${line.colourwayId}|${size}`)
          return itemId ? factorOfRow(rowFor(itemId, null)) : null
        },
      }
    : undefined

  // ---- the order lines: their order's backlog rank and their style-colourway's plan level ---------------------------------
  const orderIds = [...new Set(orderLines.map((line) => line.orderId).filter(isUuid))]
  const ranked = orderIds.length === 0 ? [] : await db.salesOrder.findMany({ where: { id: { in: orderIds }, backlogRank: { not: null } }, select: { id: true, backlogRank: true } })
  const rankOf = new Map(ranked.map((order) => [order.id, order.backlogRank!]))
  const lines =
    rankOf.size === 0 && levels.size === 0
      ? [...orderLines]
      : orderLines.map((line) => {
          const rank = rankOf.get(line.orderId)
          const level = planLevelOf(levels.get(`${line.styleId}|${line.colourwayId}`) ?? [])
          return { ...line, ...(rank !== undefined ? { backlogRank: rank } : {}), ...(level !== null ? { planLevel: level } : {}) }
        })
  return { orderLines: lines, hooks: { ...(lotSizing ? { lotSizing } : {}), ...(scrapYield ? { scrapYield } : {}) } }
}
