/**
 * R6.1 — return-policy resolver.
 *
 * Picks the most-specific active ReturnPolicy that applies to a
 * given (channel, marketplace, productType) tuple. Resolution
 * order, in decreasing specificity:
 *
 *   1. (channel, marketplace, productType)
 *   2. (channel, marketplace, NULL)
 *   3. (channel, NULL, productType)
 *   4. (channel, NULL, NULL)
 *   5. EU baseline fallback (windowDays=14, refundDeadlineDays=14)
 *
 * The R0.1 seed populates step 4 for AMAZON / EBAY / SHOPIFY so a
 * resolution always succeeds. The fallback at step 5 is a safety
 * net for channels not in the seed set (Etsy/Woo) or pre-seed
 * environments.
 *
 * The resolver is pure-read; window enforcement (warn / reject) is
 * the caller's responsibility.
 */

import prisma from '../../db.js'

export interface ResolvedPolicy {
  id: string | null
  channel: string
  marketplace: string | null
  productType: string | null
  windowDays: number
  refundDeadlineDays: number
  buyerPaysReturn: boolean
  restockingFeePct: number | null
  autoApprove: boolean
  highValueThresholdCents: number | null
  source: 'most_specific' | 'channel_marketplace' | 'channel_only' | 'fallback'
  notes: string | null
}

const EU_BASELINE: Omit<ResolvedPolicy, 'channel' | 'marketplace' | 'productType'> = {
  id: null,
  windowDays: 14,
  refundDeadlineDays: 14,
  buyerPaysReturn: false,
  restockingFeePct: null,
  autoApprove: false,
  highValueThresholdCents: null,
  source: 'fallback',
  notes: 'EU Consumer Rights Directive baseline (no policy row matched)',
}

export async function resolveReturnPolicy(input: {
  channel: string
  marketplace?: string | null
  productType?: string | null
}): Promise<ResolvedPolicy> {
  const channel = input.channel.toUpperCase()
  const marketplace = input.marketplace ?? null
  const productType = input.productType ?? null

  // Pull all active policies for the channel in one query, then
  // pick the best match in JS. Active-channel scope means the
  // candidate set is small (single-digit rows per channel).
  const rows = await prisma.returnPolicy.findMany({
    where: { channel, isActive: true },
    select: {
      id: true,
      channel: true,
      marketplace: true,
      productType: true,
      windowDays: true,
      refundDeadlineDays: true,
      buyerPaysReturn: true,
      restockingFeePct: true,
      autoApprove: true,
      highValueThresholdCents: true,
      notes: true,
    },
  })

  type Score = { score: number; src: ResolvedPolicy['source']; row: typeof rows[number] }
  const scored: Score[] = []
  for (const row of rows) {
    let score = 0
    let src: ResolvedPolicy['source'] = 'channel_only'
    if (row.marketplace !== null) {
      if (row.marketplace !== marketplace) continue // mismatched specific marketplace
      score += 4
      src = 'channel_marketplace'
    }
    if (row.productType !== null) {
      if (row.productType !== productType) continue
      score += 2
      src = 'most_specific'
    }
    scored.push({ score, src, row })
  }

  if (scored.length === 0) {
    return {
      ...EU_BASELINE,
      channel,
      marketplace,
      productType,
    }
  }
  scored.sort((a, b) => b.score - a.score)
  const best = scored[0]
  return {
    id: best.row.id,
    channel: best.row.channel,
    marketplace: best.row.marketplace,
    productType: best.row.productType,
    windowDays: best.row.windowDays,
    refundDeadlineDays: best.row.refundDeadlineDays,
    buyerPaysReturn: best.row.buyerPaysReturn,
    restockingFeePct: best.row.restockingFeePct ? Number(best.row.restockingFeePct) : null,
    autoApprove: best.row.autoApprove,
    highValueThresholdCents: best.row.highValueThresholdCents,
    source: best.src,
    notes: best.row.notes,
  }
}

/**
 * Window-eligibility check.
 *
 *   inWindow=true   → request landed inside the return window;
 *                     operator may proceed normally.
 *   inWindow=false  → request landed outside the window; operator
 *                     sees an "outside policy window" banner and
 *                     can override (we never auto-reject — Italian
 *                     law lets the operator extend goodwill).
 */
export interface WindowCheck {
  inWindow: boolean
  daysSinceDelivery: number | null
  windowDays: number
  policy: ResolvedPolicy
  reason?: 'no_delivery_date' | 'outside_window' | 'inside_window'
}

export async function checkReturnWindow(input: {
  channel: string
  marketplace?: string | null
  productType?: string | null
  /** Order delivery date (or purchase date as fallback). Null if
   *  we don't know yet — caller treats as "in window" but with
   *  reason='no_delivery_date' so the UI can prompt. */
  deliveredAt?: Date | null
  /** Optional: when the customer requested the return. Defaults to now. */
  requestedAt?: Date
}): Promise<WindowCheck> {
  const policy = await resolveReturnPolicy(input)
  if (!input.deliveredAt) {
    return {
      inWindow: true,
      daysSinceDelivery: null,
      windowDays: policy.windowDays,
      policy,
      reason: 'no_delivery_date',
    }
  }
  const at = input.requestedAt ?? new Date()
  const ms = at.getTime() - input.deliveredAt.getTime()
  const days = Math.floor(ms / 86_400_000)
  const inWindow = days <= policy.windowDays
  return {
    inWindow,
    daysSinceDelivery: days,
    windowDays: policy.windowDays,
    policy,
    reason: inWindow ? 'inside_window' : 'outside_window',
  }
}

/**
 * Refund-deadline-eligibility check. Used by the deadline-tracker
 * in R6.2 to flag refunds approaching the 14-day post-receipt
 * legal limit.
 */
export interface DeadlineCheck {
  daysUntilDeadline: number | null
  refundDeadlineDays: number
  policy: ResolvedPolicy
  status: 'no_receive_date' | 'safe' | 'approaching' | 'overdue'
}

export async function checkRefundDeadline(input: {
  channel: string
  marketplace?: string | null
  productType?: string | null
  receivedAt: Date | null
}): Promise<DeadlineCheck> {
  const policy = await resolveReturnPolicy(input)
  if (!input.receivedAt) {
    return {
      daysUntilDeadline: null,
      refundDeadlineDays: policy.refundDeadlineDays,
      policy,
      status: 'no_receive_date',
    }
  }
  const ms = Date.now() - input.receivedAt.getTime()
  const daysSinceReceived = Math.floor(ms / 86_400_000)
  const daysUntilDeadline = policy.refundDeadlineDays - daysSinceReceived
  let status: DeadlineCheck['status'] = 'safe'
  if (daysUntilDeadline < 0) status = 'overdue'
  else if (daysUntilDeadline <= 3) status = 'approaching'
  return {
    daysUntilDeadline,
    refundDeadlineDays: policy.refundDeadlineDays,
    policy,
    status,
  }
}
