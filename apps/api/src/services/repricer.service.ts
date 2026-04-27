/**
 * Phase 28: Intelligent Repricer Service
 * 
 * Rules-based pricing engine that calculates optimal prices for marketplace listings
 * based on cost, margin requirements, and pricing strategies.
 */

import { Decimal } from '@prisma/client/runtime/library'
import { logger } from '../utils/logger.js'

export interface PricingInput {
  masterPrice: number | Decimal
  costPrice?: number | Decimal
  minMargin?: number | Decimal
  pricingRule: 'FIXED' | 'MATCH_AMAZON' | 'PERCENT_OF_MASTER'
  priceAdjustmentPercent?: number | Decimal
  amazonPrice?: number | Decimal
}

export interface PricingOutput {
  finalPrice: number
  rule: string
  floorPrice: number
  adjustmentApplied: boolean
  reason: string
}

/**
 * Calculate the target price for a marketplace listing
 * 
 * Logic:
 * 1. If rule is FIXED, use the master price as-is
 * 2. If rule is PERCENT_OF_MASTER, apply the adjustment percentage
 * 3. If rule is MATCH_AMAZON, use the Amazon price
 * 4. Apply margin guard: ensure price >= costPrice * (1 + minMargin)
 * 5. Return final price with metadata
 */
export function calculateTargetPrice(input: PricingInput): PricingOutput {
  const masterPrice = toNumber(input.masterPrice)
  const costPrice = toNumber(input.costPrice) || 0
  const minMargin = toNumber(input.minMargin) || 10 // Default 10% margin
  const adjustmentPercent = toNumber(input.priceAdjustmentPercent) || 0

  // Calculate floor price (minimum acceptable price based on cost + margin)
  const floorPrice = costPrice > 0 ? costPrice * (1 + minMargin / 100) : 0

  let calculatedPrice = masterPrice
  let rule = input.pricingRule
  let adjustmentApplied = false
  let reason = ''

  // Apply pricing rule
  switch (input.pricingRule) {
    case 'PERCENT_OF_MASTER':
      calculatedPrice = masterPrice * (1 + adjustmentPercent / 100)
      reason = `Master price $${masterPrice.toFixed(2)} × (1 + ${adjustmentPercent}%) = $${calculatedPrice.toFixed(2)}`
      break

    case 'MATCH_AMAZON':
      if (input.amazonPrice) {
        calculatedPrice = toNumber(input.amazonPrice)
        reason = `Matched Amazon price: $${calculatedPrice.toFixed(2)}`
      } else {
        reason = `MATCH_AMAZON rule but no Amazon price provided, using master: $${masterPrice.toFixed(2)}`
      }
      break

    case 'FIXED':
    default:
      reason = `Fixed price: $${masterPrice.toFixed(2)}`
      break
  }

  // Apply margin guard
  let finalPrice = calculatedPrice
  if (floorPrice > 0 && calculatedPrice < floorPrice) {
    finalPrice = floorPrice
    adjustmentApplied = true
    reason += ` → Margin guard applied: $${calculatedPrice.toFixed(2)} < floor $${floorPrice.toFixed(2)}, adjusted to $${finalPrice.toFixed(2)}`
  }

  return {
    finalPrice: Math.round(finalPrice * 100) / 100, // Round to 2 decimals
    rule,
    floorPrice: Math.round(floorPrice * 100) / 100,
    adjustmentApplied,
    reason,
  }
}

/**
 * Convert Decimal or number to number
 */
function toNumber(value?: number | Decimal): number {
  if (!value) return 0
  if (typeof value === 'number') return value
  return parseFloat(value.toString())
}

/**
 * Log repricer decision with structured format
 */
export function logRepricerDecision(
  sku: string,
  output: PricingOutput,
  listingId?: string
): void {
  logger.info('[REPRICER] Pricing decision', {
    sku,
    listingId,
    rule: output.rule,
    finalPrice: output.finalPrice,
    floorPrice: output.floorPrice,
    adjustmentApplied: output.adjustmentApplied,
    reason: output.reason,
  })
}

/**
 * Batch reprice multiple listings
 */
export function batchCalculateTargetPrices(
  inputs: Array<PricingInput & { sku: string; listingId?: string }>
): Array<PricingOutput & { sku: string; listingId?: string }> {
  return inputs.map((input) => {
    const output = calculateTargetPrice(input)
    logRepricerDecision(input.sku, output, input.listingId)
    return {
      ...output,
      sku: input.sku,
      listingId: input.listingId,
    }
  })
}
