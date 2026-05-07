/**
 * O.16 — Shipping rules applier.
 *
 * applyShippingRules(orderContext) walks the active ShippingRule rows
 * in priority order ASC, runs each rule's conditions against the
 * order context, and returns the merged actions of the FIRST match.
 *
 * Why first-match (not all-match): operators reason about rules as
 * "use UPS for FR — but heavy goes DHL". That's two rules in priority
 * order. Aggregating actions across rules gets confusing fast and
 * Linnworks/Veeqo/ShipStation all use first-match semantics.
 *
 * Conditions schema (all optional; missing = "don't filter"):
 *   channel, marketplace, destinationCountry, weightGramsMin/Max,
 *   orderTotalCentsMin/Max, itemCountMin/Max, isPrime, hasHazmat,
 *   skuMatch
 *
 * Actions schema (all optional; missing = "don't override"):
 *   preferCarrierCode, preferServiceCode, requireSignature,
 *   requireInsurance, insuranceCents, packagingId, holdForReview,
 *   addLabel
 *
 * Caller: bulk-create-shipments. The context is built from
 * Order + items; the returned actions override the shipment defaults
 * (carrier, service) before the row is created.
 *
 * Bumps ShippingRule.lastFiredAt + triggerCount on a match — best-
 * effort, not in the same transaction as shipment-create (we don't
 * want a rule-counter write to fail a shipment).
 */

import prisma from '../../db.js'

export interface RuleOrderContext {
  channel: string
  marketplace: string | null
  destinationCountry: string | null
  weightGrams: number | null
  orderTotalCents: number | null
  itemCount: number
  isPrime: boolean | null
  hasHazmat: boolean
  skus: string[]
}

export interface RuleConditions {
  channel?: string[]
  marketplace?: string[]
  destinationCountry?: string[]
  weightGramsMin?: number
  weightGramsMax?: number
  orderTotalCentsMin?: number
  orderTotalCentsMax?: number
  itemCountMin?: number
  itemCountMax?: number
  isPrime?: boolean
  hasHazmat?: boolean
  skuMatch?: { mode: 'any' | 'all'; skus: string[] }
}

export interface RuleActions {
  preferCarrierCode?: string
  preferServiceCode?: string
  requireSignature?: boolean
  requireInsurance?: boolean
  insuranceCents?: number
  packagingId?: string
  holdForReview?: boolean
  addLabel?: string
}

export interface AppliedRule {
  ruleId: string
  ruleName: string
  actions: RuleActions
}

/** True if every condition in `c` matches `ctx`. Missing fields = pass. */
export function matchConditions(c: RuleConditions, ctx: RuleOrderContext): boolean {
  if (c.channel?.length && !c.channel.includes(ctx.channel)) return false
  if (c.marketplace?.length && (!ctx.marketplace || !c.marketplace.includes(ctx.marketplace))) return false
  if (c.destinationCountry?.length) {
    if (!ctx.destinationCountry || !c.destinationCountry.includes(ctx.destinationCountry)) return false
  }
  if (typeof c.weightGramsMin === 'number') {
    if (ctx.weightGrams == null || ctx.weightGrams < c.weightGramsMin) return false
  }
  if (typeof c.weightGramsMax === 'number') {
    if (ctx.weightGrams == null || ctx.weightGrams > c.weightGramsMax) return false
  }
  if (typeof c.orderTotalCentsMin === 'number') {
    if (ctx.orderTotalCents == null || ctx.orderTotalCents < c.orderTotalCentsMin) return false
  }
  if (typeof c.orderTotalCentsMax === 'number') {
    if (ctx.orderTotalCents == null || ctx.orderTotalCents > c.orderTotalCentsMax) return false
  }
  if (typeof c.itemCountMin === 'number' && ctx.itemCount < c.itemCountMin) return false
  if (typeof c.itemCountMax === 'number' && ctx.itemCount > c.itemCountMax) return false
  if (typeof c.isPrime === 'boolean' && ctx.isPrime !== c.isPrime) return false
  if (typeof c.hasHazmat === 'boolean' && ctx.hasHazmat !== c.hasHazmat) return false
  if (c.skuMatch?.skus?.length) {
    const ctxSet = new Set(ctx.skus.map((s) => s.toUpperCase()))
    const required = c.skuMatch.skus.map((s) => s.toUpperCase())
    if (c.skuMatch.mode === 'all') {
      if (!required.every((s) => ctxSet.has(s))) return false
    } else {
      if (!required.some((s) => ctxSet.has(s))) return false
    }
  }
  return true
}

/**
 * Walk active rules ASC by priority, return the first match's
 * actions. Bumps the matched rule's lastFiredAt + triggerCount in a
 * fire-and-forget update (we don't await — a counter write failing
 * shouldn't block shipment creation).
 */
export async function applyShippingRules(
  ctx: RuleOrderContext,
): Promise<AppliedRule | null> {
  const rules = await prisma.shippingRule.findMany({
    where: { isActive: true },
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    select: { id: true, name: true, conditions: true, actions: true },
  })

  for (const rule of rules) {
    const conditions = (rule.conditions ?? {}) as RuleConditions
    if (matchConditions(conditions, ctx)) {
      const actions = (rule.actions ?? {}) as RuleActions
      // Fire-and-forget counter bump.
      void prisma.shippingRule
        .update({
          where: { id: rule.id },
          data: { lastFiredAt: new Date(), triggerCount: { increment: 1 } },
        })
        .catch(() => {
          /* don't break shipment-create on a counter blip */
        })
      return { ruleId: rule.id, ruleName: rule.name, actions }
    }
  }
  return null
}

export const __test = { matchConditions }
