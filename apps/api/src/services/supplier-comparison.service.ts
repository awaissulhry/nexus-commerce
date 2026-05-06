/**
 * R.9 — Multi-supplier comparison service.
 *
 * Today every product has one preferredSupplierId on its
 * ReplenishmentRule and the engine treats it as authoritative. In
 * reality most apparel SKUs have 2-3 viable suppliers and the right
 * choice depends on the situation (urgent restock favors speed;
 * normal seasonal cycle favors cost). This service ranks every
 * SupplierProduct row for a given product on a weighted composite
 * score so the drawer can show alternatives + one-click switch.
 *
 * Pure functions:
 *   rankSuppliers({candidates, urgency, productServiceLevel}) →
 *     ranked list with score breakdown
 *
 * I/O helpers:
 *   loadCandidatesForProduct(productId)
 *   setPreferredSupplier(productId, supplierId, userId)
 *
 * Scoring weights (default, tunable per-call):
 *   cost  40 % — normalized to the cheapest in the set
 *   speed 30 % — normalized to the fastest lead time
 *   flex  20 % — favors low MOQ + small case pack
 *   reliability 10 % — favors low observed σ_LT with high sample count
 *
 * For CRITICAL urgency the weights re-balance to (cost 25 / speed 50 /
 * flex 15 / reliability 10) — when the warehouse is empty, speed
 * matters more than penny-saving.
 */

export type Urgency = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'

export interface SupplierCandidate {
  supplierId: string
  supplierName: string
  /** EUR cents per unit after FX (caller normalizes). */
  unitCostCentsEur: number | null
  leadTimeDays: number
  moq: number
  casePack: number | null
  /** SupplierProduct.currencyCode echoed for display. */
  currencyCode: string
  /** Supplier.leadTimeStdDevDays — null/0 = unknown reliability. */
  leadTimeStdDevDays: number | null
  /** PO sample count behind σ_LT — higher = more confidence. */
  leadTimeSampleCount: number
  /** Supplier.paymentTerms text (used as-is in the response; engine elsewhere parses it). */
  paymentTerms: string | null
  /** Whether this candidate is the current preferredSupplierId. */
  isCurrentlyPreferred: boolean
}

export interface ScoredSupplier extends SupplierCandidate {
  costScore: number // 0..1
  speedScore: number // 0..1
  flexScore: number // 0..1
  reliabilityScore: number // 0..1
  compositeScore: number // 0..1
  rank: number
  /** human-readable explanation: "cheapest, +5d slower than X" etc. */
  notes: string[]
}

const DEFAULT_WEIGHTS = { cost: 0.4, speed: 0.3, flex: 0.2, reliability: 0.1 }
const URGENT_WEIGHTS = { cost: 0.25, speed: 0.5, flex: 0.15, reliability: 0.1 }

export function rankSuppliers(args: {
  candidates: SupplierCandidate[]
  urgency?: Urgency
  /** Caller-supplied weight override (must sum to 1; not validated). */
  weights?: { cost: number; speed: number; flex: number; reliability: number }
}): ScoredSupplier[] {
  const { candidates } = args
  if (candidates.length === 0) return []
  const weights =
    args.weights ?? (args.urgency === 'CRITICAL' ? URGENT_WEIGHTS : DEFAULT_WEIGHTS)

  // Normalization anchors. Skip null costs from the cost min calc.
  const validCosts = candidates
    .map((c) => c.unitCostCentsEur)
    .filter((c): c is number => c != null && c > 0)
  const minCost = validCosts.length > 0 ? Math.min(...validCosts) : null
  const minLeadTime = Math.min(...candidates.map((c) => c.leadTimeDays))
  const maxMoq = Math.max(...candidates.map((c) => c.moq), 1)

  const scored: ScoredSupplier[] = candidates.map((c) => {
    // Cost score: min/this. Null cost → 0 (forces user to fix data).
    const costScore =
      c.unitCostCentsEur == null || c.unitCostCentsEur <= 0 || minCost == null
        ? 0
        : minCost / c.unitCostCentsEur

    // Speed score: minLT/this. Strictly positive — anything non-positive treats as 1d.
    const speedScore = c.leadTimeDays > 0 ? minLeadTime / c.leadTimeDays : 1

    // Flex score: 1 - moq/maxMoq, clamped, plus a small bonus for small case packs.
    const moqPenalty = c.moq / maxMoq
    const casePackPenalty = c.casePack != null && c.casePack > 12 ? 0.1 : 0
    const flexScore = Math.max(0, 1 - moqPenalty - casePackPenalty)

    // Reliability score: high σ → low score; few samples → discount.
    let reliabilityScore = 0.5 // unknown default
    if (c.leadTimeStdDevDays != null && c.leadTimeDays > 0) {
      const cv = Math.min(1, c.leadTimeStdDevDays / c.leadTimeDays)
      const sampleConfidence = Math.min(1, c.leadTimeSampleCount / 10)
      const baseScore = 1 - cv
      reliabilityScore = 0.5 + (baseScore - 0.5) * sampleConfidence
      reliabilityScore = Math.max(0, Math.min(1, reliabilityScore))
    }

    const composite =
      weights.cost * costScore +
      weights.speed * speedScore +
      weights.flex * flexScore +
      weights.reliability * reliabilityScore

    return {
      ...c,
      costScore: Number(costScore.toFixed(4)),
      speedScore: Number(speedScore.toFixed(4)),
      flexScore: Number(flexScore.toFixed(4)),
      reliabilityScore: Number(reliabilityScore.toFixed(4)),
      compositeScore: Number(composite.toFixed(4)),
      rank: 0,
      notes: [],
    }
  })

  scored.sort((a, b) => b.compositeScore - a.compositeScore)
  scored.forEach((s, i) => { s.rank = i + 1 })

  // Generate human notes per row by comparing to the rank-1 winner.
  const winner = scored[0]
  for (const s of scored) {
    const notes: string[] = []
    if (s.rank === 1) {
      notes.push('best overall match')
      if (s.isCurrentlyPreferred) notes.push('currently preferred')
    } else {
      if (winner.unitCostCentsEur != null && s.unitCostCentsEur != null) {
        const diffCents = s.unitCostCentsEur - winner.unitCostCentsEur
        if (diffCents > 0) notes.push(`+€${(diffCents / 100).toFixed(2)}/unit vs ${winner.supplierName}`)
        else if (diffCents < 0) notes.push(`-€${(-diffCents / 100).toFixed(2)}/unit vs ${winner.supplierName}`)
      }
      const ltDiff = s.leadTimeDays - winner.leadTimeDays
      if (ltDiff > 0) notes.push(`${ltDiff}d slower`)
      else if (ltDiff < 0) notes.push(`${-ltDiff}d faster`)
      if (s.moq < winner.moq) notes.push(`lower MOQ (${s.moq})`)
      if (s.isCurrentlyPreferred) notes.push('currently preferred')
    }
    s.notes = notes
  }

  return scored
}

// ─── DB I/O ────────────────────────────────────────────────────────

import prisma from '../db.js'

/**
 * Load every SupplierProduct row for a product, joined with Supplier
 * meta + the current ReplenishmentRule.preferredSupplierId so the
 * caller knows which row is the active default.
 *
 * fxRates: Map of currency → rate (EUR-base). Null means EUR; SUP
 * rows in unknown currencies pass through with null cost so they
 * still show up in the comparison but rank low.
 */
export async function loadCandidatesForProduct(args: {
  productId: string
  fxRates?: Map<string, number>
}): Promise<SupplierCandidate[]> {
  const [supProducts, rule] = await Promise.all([
    prisma.supplierProduct.findMany({
      where: { productId: args.productId },
      include: {
        supplier: {
          select: {
            id: true,
            name: true,
            leadTimeDays: true,
            leadTimeStdDevDays: true,
            leadTimeSampleCount: true,
            paymentTerms: true,
            isActive: true,
          },
        },
      },
    }),
    prisma.replenishmentRule.findUnique({
      where: { productId: args.productId },
      select: { preferredSupplierId: true },
    }),
  ])

  const candidates: SupplierCandidate[] = []
  for (const sp of supProducts) {
    if (!sp.supplier?.isActive) continue
    const ccy = (sp.currencyCode ?? 'EUR').toUpperCase()
    const fx = ccy === 'EUR' ? 1 : args.fxRates?.get(ccy) ?? null
    const unitCostCentsEur =
      sp.costCents != null && fx != null ? Math.round(sp.costCents / fx) : null
    candidates.push({
      supplierId: sp.supplierId,
      supplierName: sp.supplier.name,
      unitCostCentsEur,
      leadTimeDays: sp.leadTimeDaysOverride ?? sp.supplier.leadTimeDays ?? 14,
      moq: sp.moq,
      casePack: sp.casePack,
      currencyCode: ccy,
      leadTimeStdDevDays:
        sp.supplier.leadTimeStdDevDays != null ? Number(sp.supplier.leadTimeStdDevDays) : null,
      leadTimeSampleCount: sp.supplier.leadTimeSampleCount ?? 0,
      paymentTerms: sp.supplier.paymentTerms ?? null,
      isCurrentlyPreferred: rule?.preferredSupplierId === sp.supplierId,
    })
  }
  return candidates
}

/**
 * Switch the preferred supplier for a product. Updates
 * ReplenishmentRule.preferredSupplierId atomically. Validates that
 * the new supplier has a SupplierProduct row for this product (i.e.
 * we know what to order from them).
 */
export async function setPreferredSupplier(args: {
  productId: string
  supplierId: string
}): Promise<{ ok: true }> {
  const sp = await prisma.supplierProduct.findUnique({
    where: { supplierId_productId: { supplierId: args.supplierId, productId: args.productId } },
    select: { id: true },
  })
  if (!sp) {
    throw new Error(`No SupplierProduct row for supplier ${args.supplierId} + product ${args.productId}`)
  }
  await prisma.replenishmentRule.upsert({
    where: { productId: args.productId },
    create: {
      productId: args.productId,
      preferredSupplierId: args.supplierId,
    },
    update: {
      preferredSupplierId: args.supplierId,
    },
  })
  return { ok: true }
}
