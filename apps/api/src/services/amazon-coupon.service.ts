/**
 * E.2 — Amazon Coupon prep.
 *
 * Honest scope note: Amazon SP-API does not expose a `createCoupon`
 * endpoint for self-service. Coupons / Lightning Deals / 7-Day Deals /
 * Best Deals are managed through Seller Central or partner-tier
 * integrations (Vendor Central API, paid partner programs). Building
 * a "createCoupon" stub against SP-API would silently fail in
 * production.
 *
 * What this service does instead — the best-available scope:
 *
 *   prepareAmazonCoupon(args) takes the operator's draft spec, validates
 *   it against Amazon's published Coupon constraints (5–80% off,
 *   percentage or fixed-amount, eligible-product list, start/end dates,
 *   max-redemption budget cap), and returns:
 *
 *     - a normalized payload the operator can copy into Seller Central
 *     - a deep-link URL that opens the Coupon-creation page on the
 *       correct marketplace's Seller Central with the parameters
 *       pre-filled where Amazon supports query params
 *     - a list of validation warnings (over-budget, missing ASINs, etc)
 *
 * Future drop-in: when Amazon exposes the Coupons API (or when the
 * operator adopts a partner integration), swap the deep-link block
 * for the real POST. The spec validation + payload shape stay the same.
 *
 * Safety model:
 *   No DB writes. No outbound HTTP. Pure spec-builder. The
 *   NEXUS_AMAZON_COUPON_LIVE env flag exists for future use but has
 *   no effect today.
 */

import { logger } from '../utils/logger.js'

export type AmazonCouponDiscountType = 'PERCENTAGE' | 'AMOUNT'

export interface AmazonCouponDraft {
  /** Operator-facing label. Shown in Seller Central. */
  name: string
  /** Marketplace code: 'IT' | 'DE' | 'FR' | ... */
  marketplace: string
  /** ASINs the coupon applies to. Must be live + Buy-Box-eligible. */
  asins: string[]
  /** Discount shape. */
  discountType: AmazonCouponDiscountType
  /** PERCENTAGE: 5..80. AMOUNT: must be > 0 and < listing price. */
  discountValue: number
  /** Coupon goes live at this UTC timestamp. */
  startsAt: Date
  /** Coupon ends at this UTC timestamp. Amazon caps at 90 days. */
  endsAt: Date
  /** Optional spend cap in marketplace currency. Coupon stops awarding
   *  once this budget is exhausted. */
  budgetCap?: number
  /** Customer eligibility. 'ALL' is the default; 'PRIME' restricts to
   *  Prime members. */
  customerEligibility?: 'ALL' | 'PRIME'
}

export interface AmazonCouponPrepResult {
  ok: boolean
  warnings: string[]
  errors: string[]
  payload?: AmazonCouponDraft & {
    durationDays: number
    estimatedCostPerRedemption: number | null
  }
  /** Deep-link to Seller Central's Coupon-create page for the
   *  marketplace. Operator clicks → lands on Amazon with most fields
   *  ready to fill. */
  sellerCentralUrl?: string
}

const SELLER_CENTRAL_DOMAIN: Record<string, string> = {
  IT: 'sellercentral.amazon.it',
  DE: 'sellercentral.amazon.de',
  FR: 'sellercentral.amazon.fr',
  ES: 'sellercentral.amazon.es',
  UK: 'sellercentral.amazon.co.uk',
  NL: 'sellercentral.amazon.nl',
  PL: 'sellercentral.amazon.pl',
  SE: 'sellercentral.amazon.se',
  US: 'sellercentral.amazon.com',
}

const MAX_DURATION_DAYS = 90
const MIN_PERCENT_OFF = 5
const MAX_PERCENT_OFF = 80

export function prepareAmazonCoupon(
  draft: AmazonCouponDraft,
): AmazonCouponPrepResult {
  const warnings: string[] = []
  const errors: string[] = []

  // Validate basics.
  if (!draft.name?.trim()) errors.push('name is required')
  if (!SELLER_CENTRAL_DOMAIN[draft.marketplace]) {
    errors.push(
      `marketplace "${draft.marketplace}" not in supported set (IT/DE/FR/ES/UK/NL/PL/SE/US)`,
    )
  }
  if (!draft.asins || draft.asins.length === 0) {
    errors.push('at least one ASIN required')
  } else if (draft.asins.length > 200) {
    warnings.push(
      `${draft.asins.length} ASINs — Amazon recommends ≤200 per coupon for redemption performance`,
    )
  }

  // Discount validation.
  if (draft.discountType === 'PERCENTAGE') {
    if (
      !Number.isFinite(draft.discountValue) ||
      draft.discountValue < MIN_PERCENT_OFF ||
      draft.discountValue > MAX_PERCENT_OFF
    ) {
      errors.push(
        `PERCENTAGE discount must be ${MIN_PERCENT_OFF}..${MAX_PERCENT_OFF}; got ${draft.discountValue}`,
      )
    }
  } else if (draft.discountType === 'AMOUNT') {
    if (!Number.isFinite(draft.discountValue) || draft.discountValue <= 0) {
      errors.push(`AMOUNT discount must be > 0; got ${draft.discountValue}`)
    }
  } else {
    errors.push(
      `discountType must be PERCENTAGE or AMOUNT; got "${draft.discountType}"`,
    )
  }

  // Date validation.
  if (!(draft.startsAt instanceof Date) || Number.isNaN(draft.startsAt.getTime())) {
    errors.push('startsAt must be a valid Date')
  }
  if (!(draft.endsAt instanceof Date) || Number.isNaN(draft.endsAt.getTime())) {
    errors.push('endsAt must be a valid Date')
  }
  let durationDays = 0
  if (errors.length === 0) {
    if (draft.endsAt <= draft.startsAt) {
      errors.push('endsAt must be after startsAt')
    } else {
      durationDays = Math.ceil(
        (draft.endsAt.getTime() - draft.startsAt.getTime()) /
          (24 * 60 * 60 * 1000),
      )
      if (durationDays > MAX_DURATION_DAYS) {
        errors.push(
          `coupon duration ${durationDays}d exceeds Amazon max ${MAX_DURATION_DAYS}d`,
        )
      }
    }
  }

  // Budget cap soft-check.
  if (draft.budgetCap != null && draft.budgetCap <= 0) {
    errors.push('budgetCap must be > 0 when provided')
  }
  if (
    draft.budgetCap != null &&
    draft.discountType === 'AMOUNT' &&
    draft.budgetCap < draft.discountValue
  ) {
    warnings.push(
      `budgetCap ${draft.budgetCap} is smaller than per-redemption discount ${draft.discountValue} — coupon will exhaust on first claim`,
    )
  }

  if (errors.length > 0) {
    return { ok: false, warnings, errors }
  }

  // Estimate cost-per-redemption (only meaningful for AMOUNT type;
  // PERCENTAGE depends on listing price which varies).
  const estimatedCostPerRedemption =
    draft.discountType === 'AMOUNT' ? draft.discountValue : null

  // Build the Seller Central deep-link. Amazon's Coupon-create page
  // accepts a few query params (the rest are filled by hand). We
  // include marketplaceId and prefilled name + dates in ISO; the
  // operator confirms in the UI.
  const domain = SELLER_CENTRAL_DOMAIN[draft.marketplace]
  const params = new URLSearchParams({
    title: draft.name,
    startDate: draft.startsAt.toISOString().slice(0, 10),
    endDate: draft.endsAt.toISOString().slice(0, 10),
    discountType: draft.discountType,
    discountValue: draft.discountValue.toString(),
  })
  const sellerCentralUrl = `https://${domain}/promotion/coupons/create?${params.toString()}`

  logger.info('E.2 Amazon coupon spec prepared', {
    name: draft.name,
    marketplace: draft.marketplace,
    asinsCount: draft.asins.length,
    durationDays,
    discountType: draft.discountType,
    discountValue: draft.discountValue,
    sellerCentralUrl,
  })

  return {
    ok: true,
    warnings,
    errors,
    payload: {
      ...draft,
      durationDays,
      estimatedCostPerRedemption,
    },
    sellerCentralUrl,
  }
}
