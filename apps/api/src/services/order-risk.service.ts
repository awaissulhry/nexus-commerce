/**
 * O.22 — Order risk-scoring engine.
 *
 * Realistic Xavia threat model (Italian motorcycle gear, primary
 * market Amazon IT, EU + worldwide shipping):
 *
 *   1. First-order high-value (+30) — stolen card pattern. Most
 *      common signal across small-merchant fraud.
 *   2. Velocity (+20) — same customer placing >=3 orders in 24h
 *      is rare for legitimate buyers, common for card-testing.
 *   3. International high-value (+15) — €300+ shipping outside
 *      EU-27 + IT. Doesn't always = fraud (legit motorcycle-gear
 *      buyers exist worldwide) but worth a second look.
 *   4. Anomalous LTV jump (+10) — order >3× the customer's avg.
 *      Stolen-card cleanup pattern: thief uses a low-value card
 *      to test, then large purchase.
 *   5. Prior cancellations (+10) — customer with >=2 prior
 *      CANCELLED orders is a yellow flag.
 *
 * Scoring is additive; max realistic score ~85. Buckets:
 *   0–19  → LOW   (no badge in UI)
 *   20–39 → MEDIUM (amber)
 *   40+   → HIGH (red, auto-promotes Customer.manualReviewState='PENDING')
 *
 * Per-order recompute = upsert on OrderRiskScore.orderId. Customer-
 * level rollup picks the worst flag across the customer's orders
 * (HIGH > MEDIUM > LOW > null).
 *
 * Address-mismatch (billing vs shipping country) is INTENTIONALLY
 * deferred — Order schema today only carries shippingAddress JSON;
 * billing comes from per-channel metadata blobs (amazonMetadata /
 * shopifyMetadata) with different shapes. A follow-up commit can
 * canonicalise billingAddress on Order and the signal lights up
 * here without touching the bucket math.
 */

import prisma from '../db.js'
import { logger } from '../utils/logger.js'

// EU-27 country codes. Used to gate the international-high-value
// signal: shipping inside the EU is "domestic enough" for fraud
// scoring purposes.
const EU27 = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE',
  'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT',
  'RO', 'SK', 'SI', 'ES', 'SE',
])

const HIGH_VALUE_FIRST_ORDER_EUR = 500
const INTERNATIONAL_HIGH_VALUE_EUR = 300
const VELOCITY_24H_THRESHOLD = 3
const PRIOR_CANCELLATIONS_THRESHOLD = 2

const FLAG_THRESHOLD_MEDIUM = 20
const FLAG_THRESHOLD_HIGH = 40

const FLAG_RANK: Record<string, number> = { LOW: 1, MEDIUM: 2, HIGH: 3 }

interface RiskComputation {
  score: number
  flag: 'LOW' | 'MEDIUM' | 'HIGH'
  signals: Record<string, number | boolean>
  reasons: string[]
}

function bucketFlag(score: number): 'LOW' | 'MEDIUM' | 'HIGH' {
  if (score >= FLAG_THRESHOLD_HIGH) return 'HIGH'
  if (score >= FLAG_THRESHOLD_MEDIUM) return 'MEDIUM'
  return 'LOW'
}

/**
 * Extract the shipping country from Order.shippingAddress JSON.
 * Channel ingestion writes this with varying capitalisations:
 *   Amazon: { CountryCode: 'IT' }
 *   eBay:   { countryCode: 'IT' }
 *   Shopify: { country_code: 'IT' } (or country: 'Italy' — fallback)
 * Returns null when no usable code is present (e.g. legacy rows).
 */
function shippingCountry(addr: any): string | null {
  if (!addr || typeof addr !== 'object') return null
  const code =
    addr.CountryCode ??
    addr.countryCode ??
    addr.country_code ??
    addr.country ??
    null
  if (!code || typeof code !== 'string') return null
  // 'Italy' / 'Italia' fallback — cheap mapping for the common cases
  // we see in test data; full ISO-3166 mapping is overkill here.
  if (code.length !== 2) {
    const lookup: Record<string, string> = {
      Italy: 'IT',
      Italia: 'IT',
      Germany: 'DE',
      France: 'FR',
      Spain: 'ES',
      'United Kingdom': 'GB',
      UK: 'GB',
      'United States': 'US',
      USA: 'US',
    }
    return lookup[code] ?? null
  }
  return code.toUpperCase()
}

/**
 * Compute the per-order risk score. Pure read; doesn't write to the
 * DB. Caller (applyOrderRiskScore) handles the upsert.
 */
async function computeRiskFor(orderId: string): Promise<RiskComputation | null> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      customerId: true,
      customerEmail: true,
      totalPrice: true,
      currencyCode: true,
      shippingAddress: true,
      createdAt: true,
      purchaseDate: true,
    },
  })
  if (!order) return null

  let score = 0
  const signals: Record<string, number | boolean> = {}
  const reasons: string[] = []

  // Convert order total to EUR. We don't have FX rates yet; assume
  // currency-symbol is EUR equivalent for non-EUR orders. Cheap
  // approximation; real FX lands when /reports gets a proper
  // multi-currency rollup.
  const totalEur = Number(order.totalPrice)

  // Resolve customer aggregates if the FK is set. New orders may
  // not have customerId yet (race against linkAndRefresh in the
  // ingest pipeline) — treat as "first order ever" in that case.
  let priorOrders = 0
  let priorTotalCents = 0
  let priorCancellations = 0
  if (order.customerId) {
    const [agg, cancelCount] = await Promise.all([
      prisma.order.aggregate({
        where: {
          customerId: order.customerId,
          id: { not: orderId },
          status: { notIn: ['CANCELLED', 'REFUNDED'] },
        },
        _count: { id: true },
        _sum: { totalPrice: true },
      }),
      prisma.order.count({
        where: {
          customerId: order.customerId,
          id: { not: orderId },
          status: 'CANCELLED',
        },
      }),
    ])
    priorOrders = agg._count.id
    priorTotalCents = Math.round(Number(agg._sum.totalPrice ?? 0) * 100)
    priorCancellations = cancelCount
  }

  // ── Signal 1: first-order high-value ───────────────────────────────
  if (priorOrders === 0 && totalEur >= HIGH_VALUE_FIRST_ORDER_EUR) {
    score += 30
    signals.highValueFirstOrder = true
    reasons.push(`First order €${totalEur.toFixed(2)} from new customer`)
  }

  // ── Signal 2: velocity (24h window) ────────────────────────────────
  if (order.customerId) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const recent = await prisma.order.count({
      where: {
        customerId: order.customerId,
        createdAt: { gte: since },
      },
    })
    signals.velocity24h = recent
    if (recent >= VELOCITY_24H_THRESHOLD) {
      score += 20
      reasons.push(`${recent} orders in last 24h`)
    }
  }

  // ── Signal 3: international high-value ─────────────────────────────
  const country = shippingCountry(order.shippingAddress)
  signals.shippingCountry = country ? 1 : 0 // boolean-as-number for JSON simplicity
  if (
    country &&
    !EU27.has(country) &&
    totalEur >= INTERNATIONAL_HIGH_VALUE_EUR
  ) {
    score += 15
    signals.internationalHighValue = true
    reasons.push(`€${totalEur.toFixed(2)} shipping to ${country} (non-EU)`)
  }

  // ── Signal 4: anomalous LTV jump ───────────────────────────────────
  if (priorOrders >= 3) {
    const avgEur = priorTotalCents / 100 / priorOrders
    if (avgEur > 0 && totalEur > avgEur * 3) {
      score += 10
      signals.anomalousLtvJump = true
      reasons.push(
        `Order €${totalEur.toFixed(2)} is 3× customer's avg of €${avgEur.toFixed(2)}`,
      )
    }
  }

  // ── Signal 5: prior cancellations ──────────────────────────────────
  if (priorCancellations >= PRIOR_CANCELLATIONS_THRESHOLD) {
    score += 10
    signals.priorCancellations = priorCancellations
    reasons.push(`${priorCancellations} prior cancelled orders`)
  }

  return {
    score: Math.min(100, score),
    flag: bucketFlag(score),
    signals,
    reasons,
  }
}

/**
 * Compute + persist + roll up. Idempotent: re-running on the same
 * order upserts the row, recomputes Customer.riskFlag from the
 * worst flag across the customer's orders, and stamps
 * lastRiskComputedAt.
 *
 * HIGH flag auto-promotes Customer.manualReviewState='PENDING'
 * unless the operator already set a final state (APPROVED / REJECTED).
 *
 * Fire-and-forget at ingest sites: a risk-engine failure must
 * never abort the underlying order write.
 */
export async function applyOrderRiskScore(orderId: string): Promise<void> {
  try {
    const result = await computeRiskFor(orderId)
    if (!result) return

    await prisma.orderRiskScore.upsert({
      where: { orderId },
      create: {
        orderId,
        score: result.score,
        flag: result.flag,
        signals: result.signals as object,
        reasons: result.reasons,
      },
      update: {
        score: result.score,
        flag: result.flag,
        signals: result.signals as object,
        reasons: result.reasons,
        computedAt: new Date(),
      },
    })

    // Roll up to Customer.riskFlag — pick the worst flag across the
    // customer's recent orders. Skip when the order isn't linked yet.
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { customerId: true },
    })
    if (!order?.customerId) return

    const allFlags = await prisma.orderRiskScore.findMany({
      where: { order: { customerId: order.customerId } },
      select: { flag: true },
    })
    const worst = allFlags.reduce<string | null>((acc, r) => {
      const rank = FLAG_RANK[r.flag] ?? 0
      const accRank = acc ? (FLAG_RANK[acc] ?? 0) : 0
      return rank > accRank ? r.flag : acc
    }, null)

    const customer = await prisma.customer.findUnique({
      where: { id: order.customerId },
      select: { manualReviewState: true },
    })
    // Promote to PENDING when this order pushes the rollup to HIGH —
    // unless an operator has already adjudicated (APPROVED / REJECTED).
    const promoteToPending =
      worst === 'HIGH' &&
      customer?.manualReviewState !== 'APPROVED' &&
      customer?.manualReviewState !== 'REJECTED'

    await prisma.customer.update({
      where: { id: order.customerId },
      data: {
        riskFlag: worst,
        manualReviewState: promoteToPending
          ? 'PENDING'
          : customer?.manualReviewState ?? null,
        lastRiskComputedAt: new Date(),
      },
    })
  } catch (err) {
    logger.warn('applyOrderRiskScore failed', {
      orderId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Recompute every order's risk for a given customer + roll up the
 * customer's flag. Used by the manual /api/customers/:id/recompute-
 * risk endpoint and the optional cron-driven sweep.
 */
export async function recomputeCustomerRisk(customerId: string): Promise<void> {
  const orders = await prisma.order.findMany({
    where: { customerId },
    select: { id: true },
  })
  for (const o of orders) {
    await applyOrderRiskScore(o.id)
  }
}
