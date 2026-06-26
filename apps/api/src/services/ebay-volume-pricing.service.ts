/**
 * VP.1 — eBay Volume Pricing: pure tier validation + price/margin computation.
 *
 * eBay volume pricing = 2-4 quantity tiers with strictly-increasing percentage
 * discounts (buy 2 → 5%, 3 → 10%, 4+ → 15%). This module validates that shape
 * against eBay's rules and computes the buyer-facing effective price + the
 * seller's margin at each tier (for the preview/simulator + the VP.4 margin
 * guard). Pure — no DB — so it's fully unit-testable and reused from the
 * publisher, the routes, and the UI preview.
 */

export interface VolumeTier {
  /** Minimum quantity that unlocks this tier (≥2). */
  minQty: number
  /** Percentage off at this tier (0 < x < 100). */
  percentOff: number
}

export interface TierComputation {
  minQty: number
  percentOff: number
  /** Effective per-unit price at this tier. */
  unitPrice: number
  /** Seller margin % at this tier, or null when cost is unknown. */
  marginPercent: number | null
}

export interface TierValidation {
  ok: boolean
  errors: string[]
  warnings: string[]
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/**
 * Validate eBay's volume-pricing rules: 2-4 tiers, ascending minQty (each ≥2),
 * strictly-increasing percentOff (deeper discount at higher qty), 0 < % < 100.
 * eBay also recommends ≥5% on the first (buy-2) tier — surfaced as a warning.
 */
export function validateVolumeTiers(tiers: VolumeTier[]): TierValidation {
  const errors: string[] = []
  const warnings: string[] = []

  if (!Array.isArray(tiers) || tiers.length < 2) errors.push('At least 2 quantity tiers are required.')
  if (Array.isArray(tiers) && tiers.length > 4) errors.push('At most 4 quantity tiers are allowed.')

  const sorted = [...(tiers ?? [])].sort((a, b) => a.minQty - b.minQty)
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i]
    const n = i + 1
    if (!Number.isInteger(t.minQty) || t.minQty < 2) errors.push(`Tier ${n}: minimum quantity must be a whole number ≥ 2.`)
    if (!(t.percentOff > 0) || !(t.percentOff < 100)) errors.push(`Tier ${n}: discount must be between 0% and 100%.`)
    if (i > 0) {
      if (t.minQty <= sorted[i - 1].minQty) errors.push(`Tier ${n}: quantity must be greater than the previous tier.`)
      if (t.percentOff <= sorted[i - 1].percentOff) errors.push(`Tier ${n}: discount must increase — eBay requires deeper discounts at higher quantities.`)
    }
  }
  if (sorted.length > 0 && sorted[0].percentOff > 0 && sorted[0].percentOff < 5) {
    warnings.push('eBay recommends starting at 5% or more for the buy-2 tier.')
  }
  return { ok: errors.length === 0, errors, warnings }
}

/** Buyer-facing effective per-unit price + seller margin at each tier. */
export function computeTiers(tiers: VolumeTier[], basePrice: number, cost?: number | null): TierComputation[] {
  return [...tiers]
    .sort((a, b) => a.minQty - b.minQty)
    .map((t) => {
      const unitPrice = round2(basePrice * (1 - t.percentOff / 100))
      const marginPercent =
        cost != null && cost > 0 && unitPrice > 0 ? round2(((unitPrice - cost) / unitPrice) * 100) : null
      return { minQty: t.minQty, percentOff: t.percentOff, unitPrice, marginPercent }
    })
}

/** Tiers whose margin falls below a floor (for the VP.4 margin guard). */
export function findMarginViolations(
  tiers: VolumeTier[],
  basePrice: number,
  cost: number,
  floorMarginPercent: number,
): TierComputation[] {
  return computeTiers(tiers, basePrice, cost).filter(
    (t) => t.marginPercent != null && t.marginPercent < floorMarginPercent,
  )
}
