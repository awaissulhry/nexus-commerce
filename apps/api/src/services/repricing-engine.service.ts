/**
 * W4.7 — RepricingEngineService.
 *
 * Strategy engine for the W4.6 RepricingRule schema. Distinct from
 * the legacy `repricing.service.ts` (in-memory MATCH_LOW /
 * PERCENTAGE_BELOW shapes) — this one drives the DB-backed rule
 * model with W4.6's strategy enum.
 *
 * Pure resolver (`pickPrice`) is exported separately from the DB-
 * bound evaluator so the strategy logic is unit-testable without a
 * database.
 *
 * Strategies (dispatched on rule.strategy):
 *
 *   match_buy_box
 *     If marketContext.buyBoxPrice is known, target it.
 *     If not, hold the current price (reason: 'hold-no-buy-box-data').
 *
 *   beat_lowest_by_pct
 *     Undercut the lowest competitor price by `beatPct` percent.
 *     Hold if lowestCompPrice is unknown.
 *
 *   beat_lowest_by_amount
 *     Undercut by absolute beatAmount. Hold if lowestCompPrice is
 *     unknown.
 *
 *   fixed_to_buy_box_minus
 *     Buy-box price minus beatAmount. Hold if buyBoxPrice is
 *     unknown.
 *
 *   manual
 *     Engine never moves the price; the rule still acts as a
 *     guard rail (the floor/ceiling clamp doesn't kick in because
 *     the resolver never proposes a new price). Useful when the
 *     operator wants the rule row to exist (so min/max are
 *     visible / future-engine-toggle is one click) without engine
 *     pushes today.
 *
 * Floor/ceiling clamp:
 *   Every strategy that proposes a new price runs through the
 *   clamp-to-[minPrice, maxPrice] step. Clamps record `capped`
 *   ('floor' | 'ceiling') so the operator sees why the engine
 *   didn't go all the way to its strategy target.
 *
 * Schedule:
 *   `isWithinSchedule(rule, now)` returns true when the rule's
 *   activeFromHour/activeToHour/activeDays allow execution at
 *   `now` (UTC). null/empty schedule fields = always on.
 *   Out-of-schedule returns hold with reason='outside-schedule'.
 */

import type { PrismaClient } from '@prisma/client'
import { Prisma } from '@prisma/client'
import prisma from '../db.js'

export type RepricingStrategyV2 =
  | 'match_buy_box'
  | 'beat_lowest_by_pct'
  | 'beat_lowest_by_amount'
  | 'fixed_to_buy_box_minus'
  | 'manual'

export interface RuleConfig {
  strategy: RepricingStrategyV2
  minPrice: number
  maxPrice: number
  beatPct?: number | null
  beatAmount?: number | null
  // Schedule (UTC). null/empty = always on.
  activeFromHour?: number | null
  activeToHour?: number | null
  activeDays?: number[]
}

export interface MarketContext {
  /** Current store price for this product on this channel. */
  currentPrice: number
  /** Current marketplace buy-box price (Amazon mostly). */
  buyBoxPrice?: number | null
  /** Lowest active competitor price. */
  lowestCompPrice?: number | null
  /** Number of active competitor offers. */
  competitorCount?: number | null
}

export interface PickResult {
  /** The price the engine proposes (after clamp). */
  price: number
  /** True when the proposed price differs from currentPrice. */
  changed: boolean
  /** Free-form reason. Stored on RepricingDecision.reason. */
  reason: string
  /** Floor/ceiling marker when the clamp held back a more
   *  aggressive target. */
  capped: 'floor' | 'ceiling' | null
}

/** Pure schedule check. Inclusive on both ends.
 *
 *  - Both null + activeDays empty/missing → always-on
 *  - activeDays present but doesn't include now's day → out
 *  - hour range present and now's hour out of range → out
 *  - hour range crosses midnight (from > to) handled correctly
 */
export function isWithinSchedule(
  rule: Pick<RuleConfig, 'activeFromHour' | 'activeToHour' | 'activeDays'>,
  now: Date,
): boolean {
  const day = now.getUTCDay() // 0-6
  const hour = now.getUTCHours() // 0-23

  if (rule.activeDays && rule.activeDays.length > 0) {
    if (!rule.activeDays.includes(day)) return false
  }

  const from = rule.activeFromHour
  const to = rule.activeToHour
  if (from == null && to == null) return true
  if (from == null || to == null) {
    // Half-specified — treat as always-on. Operator UI should
    // prevent partial entry; runtime is forgiving.
    return true
  }
  if (from <= to) {
    return hour >= from && hour <= to
  }
  // Crosses midnight: e.g. 22 → 6.
  return hour >= from || hour <= to
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Pure pricing resolver. Tested without DB.
 *
 * Returns the proposed price + change flag + reason + capped flag.
 * Caller decides whether to push to the marketplace + persist a
 * decision row.
 */
export function pickPrice(
  rule: RuleConfig,
  market: MarketContext,
  now: Date = new Date(),
): PickResult {
  // Schedule gate.
  if (!isWithinSchedule(rule, now)) {
    return {
      price: market.currentPrice,
      changed: false,
      reason: 'outside-schedule',
      capped: null,
    }
  }

  // Strategy dispatch. Each branch returns a target price + reason
  // BEFORE the floor/ceiling clamp. If the strategy can't compute
  // a target (missing market data), it returns currentPrice with a
  // 'hold-*' reason.
  let target: number = market.currentPrice
  let reason: string = ''

  switch (rule.strategy) {
    case 'manual':
      return {
        price: market.currentPrice,
        changed: false,
        reason: 'manual-strategy',
        capped: null,
      }

    case 'match_buy_box':
      if (market.buyBoxPrice != null) {
        target = market.buyBoxPrice
        reason = `match-buy-box at ${market.buyBoxPrice}`
      } else {
        return {
          price: market.currentPrice,
          changed: false,
          reason: 'hold-no-buy-box-data',
          capped: null,
        }
      }
      break

    case 'beat_lowest_by_pct':
      if (market.lowestCompPrice != null && rule.beatPct != null) {
        target = round2(market.lowestCompPrice * (1 - rule.beatPct / 100))
        reason = `beat-lowest-by-${rule.beatPct}% (lowest ${market.lowestCompPrice})`
      } else {
        return {
          price: market.currentPrice,
          changed: false,
          reason: 'hold-no-competitor-data',
          capped: null,
        }
      }
      break

    case 'beat_lowest_by_amount':
      if (market.lowestCompPrice != null && rule.beatAmount != null) {
        target = round2(market.lowestCompPrice - rule.beatAmount)
        reason = `beat-lowest-by-${rule.beatAmount} (lowest ${market.lowestCompPrice})`
      } else {
        return {
          price: market.currentPrice,
          changed: false,
          reason: 'hold-no-competitor-data',
          capped: null,
        }
      }
      break

    case 'fixed_to_buy_box_minus':
      if (market.buyBoxPrice != null && rule.beatAmount != null) {
        target = round2(market.buyBoxPrice - rule.beatAmount)
        reason = `buy-box-minus-${rule.beatAmount} (buy box ${market.buyBoxPrice})`
      } else {
        return {
          price: market.currentPrice,
          changed: false,
          reason: 'hold-no-buy-box-data',
          capped: null,
        }
      }
      break

    default:
      return {
        price: market.currentPrice,
        changed: false,
        reason: `hold-unknown-strategy:${rule.strategy}`,
        capped: null,
      }
  }

  // Clamp to floor / ceiling.
  let capped: 'floor' | 'ceiling' | null = null
  let clamped = target
  if (clamped < rule.minPrice) {
    clamped = rule.minPrice
    capped = 'floor'
  } else if (clamped > rule.maxPrice) {
    clamped = rule.maxPrice
    capped = 'ceiling'
  }

  const finalPrice = round2(clamped)
  const changed = finalPrice !== round2(market.currentPrice)
  return {
    price: finalPrice,
    changed,
    reason: capped ? `${reason} → capped at ${capped} ${clamped}` : reason,
    capped,
  }
}

/**
 * DB-bound evaluator. Reads the rule, runs pickPrice, writes a
 * RepricingDecision row, updates the rule's last* fields.
 *
 * The actual marketplace push (master-price.service.ts cascade) is
 * the caller's responsibility — this service writes the audit
 * row + sets `applied` = true when (changed && opts.applyToProduct),
 * but doesn't touch Product.basePrice or ChannelListing.price
 * directly. Keeps repricing observability cleanly separated from
 * the price-cascade infrastructure.
 */
export class RepricingEngineService {
  constructor(private readonly client: PrismaClient = prisma) {}

  async evaluate(
    ruleId: string,
    market: MarketContext,
    opts: { applyToProduct?: boolean } = {},
  ): Promise<PickResult & { ruleId: string; decisionId: string }> {
    const rule = await this.client.repricingRule.findUnique({
      where: { id: ruleId },
    })
    if (!rule) {
      throw new Error(
        `RepricingEngineService: rule ${ruleId} not found`,
      )
    }
    if (!rule.enabled) {
      return {
        ruleId,
        decisionId: '',
        price: market.currentPrice,
        changed: false,
        reason: 'rule-disabled',
        capped: null,
      }
    }

    const result = pickPrice(
      {
        strategy: rule.strategy as RepricingStrategyV2,
        minPrice: Number(rule.minPrice as unknown as Prisma.Decimal),
        maxPrice: Number(rule.maxPrice as unknown as Prisma.Decimal),
        beatPct:
          rule.beatPct == null
            ? null
            : Number(rule.beatPct as unknown as Prisma.Decimal),
        beatAmount:
          rule.beatAmount == null
            ? null
            : Number(rule.beatAmount as unknown as Prisma.Decimal),
        activeFromHour: rule.activeFromHour,
        activeToHour: rule.activeToHour,
        activeDays: rule.activeDays,
      },
      market,
    )

    const decision = await this.client.repricingDecision.create({
      data: {
        ruleId,
        oldPrice: market.currentPrice,
        newPrice: result.price,
        reason: result.reason,
        buyBoxPrice: market.buyBoxPrice ?? null,
        lowestCompPrice: market.lowestCompPrice ?? null,
        competitorCount: market.competitorCount ?? null,
        applied: !!(result.changed && opts.applyToProduct),
        capped: result.capped,
      },
      select: { id: true },
    })

    await this.client.repricingRule.update({
      where: { id: ruleId },
      data: {
        lastEvaluatedAt: new Date(),
        lastDecisionPrice: result.price,
        lastDecisionReason: result.reason,
      },
    })

    return { ...result, ruleId, decisionId: decision.id }
  }
}

export const repricingEngineService = new RepricingEngineService()
