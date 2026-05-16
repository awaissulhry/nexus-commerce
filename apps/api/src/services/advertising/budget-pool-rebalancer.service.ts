/**
 * AD.5 — Cross-marketplace budget pool rebalancer.
 *
 * Pure-ish compute: reads ProductProfitDaily + FbaStorageAge + the
 * pool's allocations, returns proposed per-allocation budgets. Side
 * effects (DB writes, OutboundSyncQueue enqueues) happen in the
 * caller (cron job / route).
 *
 * Strategies:
 *   STATIC            enforce each allocation's targetSharePct
 *   PROFIT_WEIGHTED   weight by 30d sum(trueProfitCents) per marketplace
 *   URGENCY_WEIGHTED  weight by aged-stock units × projectedLtsFee30d
 *                     (more aged stock → bigger share to liquidate it)
 *
 * Guardrails enforced inside this service (callers don't need to
 * re-check):
 *   - per-allocation min/max floors/ceilings
 *   - pool.maxShiftPerRebalancePct (sum of |new - old| ≤ pct × total)
 *   - €1 hard floor per campaign (matches the rest of the system)
 *   - cooldown check is the caller's responsibility (job/route gates)
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'

const HARD_FLOOR_CENTS = 100 // €1 minimum per campaign

export interface RebalanceInput {
  poolId: string
  triggeredBy: string // 'cron' | `rule:${id}` | `user:${id}`
  /** When true, ignore the cooldown gate. Use sparingly. */
  ignoreCoolDown?: boolean
}

export interface ProposedAllocation {
  allocationId: string
  campaignId: string | null
  marketplace: string
  oldBudgetCents: number
  proposedBudgetCents: number
  shiftCents: number // signed (negative = decrease)
  clampedReason?: 'floor' | 'ceiling' | 'hard_floor' | 'max_shift_pct'
}

export interface RebalanceOutcome {
  ok: boolean
  poolId: string
  poolName: string
  strategy: string
  proposed: ProposedAllocation[]
  totalShiftCents: number // sum of |shift|
  warnings: string[]
  skipped?: 'cooldown' | 'disabled' | 'pool_not_found' | 'no_allocations'
  inputs: Record<string, unknown>
}

interface InternalAllocation {
  id: string
  campaignId: string | null
  marketplace: string
  targetSharePct: number
  minDailyBudgetCents: number
  maxDailyBudgetCents: number | null
  oldBudgetCents: number
}

/**
 * Compute proposed budgets. Does NOT write to the DB. Caller decides
 * whether to apply (pool.dryRun=false) or just persist the audit row.
 */
export async function computeRebalance(input: RebalanceInput): Promise<RebalanceOutcome> {
  const pool = await prisma.budgetPool.findUnique({
    where: { id: input.poolId },
    include: {
      allocations: {
        include: {
          // budget pool allocations have a unique campaignId — pull
          // the linked campaign so we know the current dailyBudget.
          // (campaignId is String? at the schema level so this can be
          // null for "marketplace-level" allocations a future refactor
          // might add; today every allocation must have a campaign.)
        },
      },
    },
  })
  if (!pool) {
    return mkSkipped(input.poolId, 'pool_not_found')
  }
  if (!pool.enabled) {
    return mkSkipped(pool.id, 'disabled', pool.name, pool.strategy)
  }
  if (
    !input.ignoreCoolDown &&
    pool.lastRebalancedAt &&
    Date.now() - pool.lastRebalancedAt.getTime() < pool.coolDownMinutes * 60 * 1000
  ) {
    return mkSkipped(pool.id, 'cooldown', pool.name, pool.strategy)
  }

  if (pool.allocations.length === 0) {
    return mkSkipped(pool.id, 'no_allocations', pool.name, pool.strategy)
  }

  // Hydrate current campaign budgets.
  const campaignIds = pool.allocations
    .map((a) => a.campaignId)
    .filter((id): id is string => !!id)
  const campaigns = await prisma.campaign.findMany({
    where: { id: { in: campaignIds } },
    select: { id: true, dailyBudget: true, marketplace: true },
  })
  const currentByCampaign = new Map(
    campaigns.map((c) => [c.id, Math.round(Number(c.dailyBudget) * 100)]),
  )
  const allocs: InternalAllocation[] = pool.allocations.map((a) => ({
    id: a.id,
    campaignId: a.campaignId,
    marketplace: a.marketplace,
    targetSharePct: Number(a.targetSharePct),
    minDailyBudgetCents: a.minDailyBudgetCents,
    maxDailyBudgetCents: a.maxDailyBudgetCents,
    oldBudgetCents: a.campaignId ? currentByCampaign.get(a.campaignId) ?? 0 : 0,
  }))

  // Compute raw weights per strategy.
  let weights: Map<string, number>
  let inputs: Record<string, unknown> = {}
  if (pool.strategy === 'STATIC') {
    weights = new Map(allocs.map((a) => [a.id, a.targetSharePct]))
    // If targetSharePct sums to 0 (operator forgot to set them), fall
    // back to equal weighting so we always produce a sane proposal.
    const sum = Array.from(weights.values()).reduce((a, b) => a + b, 0)
    if (sum === 0) {
      weights = new Map(allocs.map((a) => [a.id, 1]))
    }
    inputs.strategy = 'STATIC'
  } else if (pool.strategy === 'PROFIT_WEIGHTED') {
    const result = await computeProfitWeights(allocs)
    weights = result.weights
    inputs = { strategy: 'PROFIT_WEIGHTED', ...result.inputs }
  } else if (pool.strategy === 'URGENCY_WEIGHTED') {
    const result = await computeUrgencyWeights(allocs)
    weights = result.weights
    inputs = { strategy: 'URGENCY_WEIGHTED', ...result.inputs }
  } else {
    return {
      ok: false,
      poolId: pool.id,
      poolName: pool.name,
      strategy: pool.strategy,
      proposed: [],
      totalShiftCents: 0,
      warnings: [`unknown strategy ${pool.strategy} — falling back to no-op`],
      inputs,
    }
  }

  // Normalize weights so they sum to 1.
  const weightSum = Array.from(weights.values()).reduce((a, b) => a + b, 0)
  if (weightSum <= 0) {
    return {
      ok: true,
      poolId: pool.id,
      poolName: pool.name,
      strategy: pool.strategy,
      proposed: allocs.map((a) => ({
        allocationId: a.id,
        campaignId: a.campaignId,
        marketplace: a.marketplace,
        oldBudgetCents: a.oldBudgetCents,
        proposedBudgetCents: a.oldBudgetCents,
        shiftCents: 0,
      })),
      totalShiftCents: 0,
      warnings: ['weight sum is 0 — no rebalance possible, keeping current budgets'],
      inputs,
    }
  }

  // Initial proposal: pool total × normalized weight per allocation.
  const proposed: ProposedAllocation[] = []
  for (const a of allocs) {
    const w = weights.get(a.id) ?? 0
    let target = Math.round(pool.totalDailyBudgetCents * (w / weightSum))
    let clampedReason: ProposedAllocation['clampedReason']
    // Apply per-allocation floor + ceiling.
    if (target < a.minDailyBudgetCents) {
      target = a.minDailyBudgetCents
      clampedReason = 'floor'
    }
    if (a.maxDailyBudgetCents != null && target > a.maxDailyBudgetCents) {
      target = a.maxDailyBudgetCents
      clampedReason = 'ceiling'
    }
    if (target < HARD_FLOOR_CENTS) {
      target = HARD_FLOOR_CENTS
      clampedReason = 'hard_floor'
    }
    proposed.push({
      allocationId: a.id,
      campaignId: a.campaignId,
      marketplace: a.marketplace,
      oldBudgetCents: a.oldBudgetCents,
      proposedBudgetCents: target,
      shiftCents: target - a.oldBudgetCents,
      ...(clampedReason ? { clampedReason } : {}),
    })
  }

  // Apply maxShiftPerRebalancePct guardrail. If the proposed sum-of-
  // absolute-shifts exceeds the cap, scale every shift proportionally
  // so the total stays within bounds.
  let totalShiftCents = proposed.reduce((acc, p) => acc + Math.abs(p.shiftCents), 0)
  const maxShiftCents =
    (pool.totalDailyBudgetCents * pool.maxShiftPerRebalancePct) / 100
  const warnings: string[] = []
  if (totalShiftCents > maxShiftCents && maxShiftCents > 0) {
    const scale = maxShiftCents / totalShiftCents
    for (const p of proposed) {
      const scaledShift = Math.round(p.shiftCents * scale)
      p.proposedBudgetCents = Math.max(HARD_FLOOR_CENTS, p.oldBudgetCents + scaledShift)
      p.shiftCents = p.proposedBudgetCents - p.oldBudgetCents
      p.clampedReason = 'max_shift_pct'
    }
    totalShiftCents = proposed.reduce((acc, p) => acc + Math.abs(p.shiftCents), 0)
    warnings.push(
      `maxShiftPerRebalancePct=${pool.maxShiftPerRebalancePct}% cap engaged — scaled shifts by ${scale.toFixed(3)}`,
    )
  }

  return {
    ok: true,
    poolId: pool.id,
    poolName: pool.name,
    strategy: pool.strategy,
    proposed,
    totalShiftCents,
    warnings,
    inputs: {
      ...inputs,
      poolTotalDailyBudgetCents: pool.totalDailyBudgetCents,
      maxShiftPerRebalancePct: pool.maxShiftPerRebalancePct,
      coolDownMinutes: pool.coolDownMinutes,
      allocations: allocs.length,
    },
  }
}

function mkSkipped(
  poolId: string,
  skipped: NonNullable<RebalanceOutcome['skipped']>,
  poolName = '',
  strategy = '',
): RebalanceOutcome {
  return {
    ok: false,
    poolId,
    poolName,
    strategy,
    proposed: [],
    totalShiftCents: 0,
    warnings: [`skipped: ${skipped}`],
    skipped,
    inputs: {},
  }
}

// ── Strategy: PROFIT_WEIGHTED ─────────────────────────────────────────

async function computeProfitWeights(
  allocs: InternalAllocation[],
): Promise<{ weights: Map<string, number>; inputs: Record<string, unknown> }> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  // Per-marketplace profit. The advertised products lookup goes through
  // AdProductAd → Product → ProductProfitDaily so we measure the actual
  // profit of products this pool's campaigns advertise (not all products
  // in the marketplace).
  const perAllocProfit = new Map<string, number>()
  const perMarketplaceProfit = new Map<string, number>()
  for (const a of allocs) {
    if (!a.campaignId) {
      perAllocProfit.set(a.id, 0)
      continue
    }
    const productAds = await prisma.adProductAd.findMany({
      where: { adGroup: { campaignId: a.campaignId } },
      select: { productId: true },
    })
    const productIds = Array.from(
      new Set(productAds.map((p) => p.productId).filter((id): id is string => !!id)),
    )
    if (productIds.length === 0) {
      perAllocProfit.set(a.id, 0)
      continue
    }
    const agg = await prisma.productProfitDaily.aggregate({
      where: {
        productId: { in: productIds },
        marketplace: a.marketplace,
        date: { gte: since },
      },
      _sum: { trueProfitCents: true },
    })
    // Floor at 0 — losing money shouldn't pull MORE budget toward you.
    const profit = Math.max(0, agg._sum.trueProfitCents ?? 0)
    perAllocProfit.set(a.id, profit)
    perMarketplaceProfit.set(
      a.marketplace,
      (perMarketplaceProfit.get(a.marketplace) ?? 0) + profit,
    )
  }
  return {
    weights: perAllocProfit,
    inputs: {
      windowDays: 30,
      perMarketplaceTrueProfitCents: Object.fromEntries(perMarketplaceProfit),
    },
  }
}

// ── Strategy: URGENCY_WEIGHTED ────────────────────────────────────────

async function computeUrgencyWeights(
  allocs: InternalAllocation[],
): Promise<{ weights: Map<string, number>; inputs: Record<string, unknown> }> {
  // For each allocation's marketplace, sum aged-stock units (181+)
  // weighted by projected LTS fee. Higher urgency → bigger share.
  const perMarketplaceUrgency = new Map<string, number>()
  // Latest snapshot per (sku, marketplace) — pull recent rows + dedupe.
  const rows = await prisma.fbaStorageAge.findMany({
    where: {
      OR: [
        { quantityInAge181_270: { gt: 0 } },
        { quantityInAge271_365: { gt: 0 } },
        { quantityInAge365Plus: { gt: 0 } },
      ],
    },
    orderBy: { polledAt: 'desc' },
    take: 5000,
  })
  const seen = new Set<string>()
  for (const r of rows) {
    const key = `${r.sku}::${r.marketplace}`
    if (seen.has(key)) continue
    seen.add(key)
    const agedUnits =
      r.quantityInAge181_270 + r.quantityInAge271_365 + r.quantityInAge365Plus
    const urgency = agedUnits * r.projectedLtsFee30dCents
    perMarketplaceUrgency.set(
      r.marketplace,
      (perMarketplaceUrgency.get(r.marketplace) ?? 0) + urgency,
    )
  }
  // Spread per-marketplace urgency across the allocations of that marketplace
  // proportionally. If one marketplace has 3 allocations (3 campaigns) and
  // urgency=900, each gets weight 300.
  const allocsPerMarketplace = new Map<string, InternalAllocation[]>()
  for (const a of allocs) {
    const list = allocsPerMarketplace.get(a.marketplace) ?? []
    list.push(a)
    allocsPerMarketplace.set(a.marketplace, list)
  }
  const weights = new Map<string, number>()
  for (const [mkt, list] of allocsPerMarketplace.entries()) {
    const urgency = perMarketplaceUrgency.get(mkt) ?? 0
    const per = list.length > 0 ? urgency / list.length : 0
    for (const a of list) weights.set(a.id, per)
  }
  return {
    weights,
    inputs: {
      perMarketplaceUrgencyScore: Object.fromEntries(perMarketplaceUrgency),
      ageThresholdDaysFloor: 181,
    },
  }
}

// ── Apply ──────────────────────────────────────────────────────────────

import { updateCampaignWithSync, type AdsActor } from './ads-mutation.service.js'

export interface ApplyOutcome {
  applied: number
  skipped: number
  failed: number
  perAllocation: Array<{
    allocationId: string
    campaignId: string | null
    status: 'APPLIED' | 'SKIPPED' | 'FAILED'
    error?: string
  }>
}

/**
 * Apply a computed rebalance by enqueuing per-campaign mutations through
 * ads-mutation.service. Returns per-allocation outcomes. Idempotent if
 * called twice on the same proposal (the second call will mostly produce
 * no_changes shorts because the budgets already match).
 */
export async function applyRebalance(args: {
  proposed: ProposedAllocation[]
  actor: AdsActor
  reason: string
}): Promise<ApplyOutcome> {
  const out: ApplyOutcome = { applied: 0, skipped: 0, failed: 0, perAllocation: [] }
  for (const p of args.proposed) {
    if (!p.campaignId) {
      out.skipped += 1
      out.perAllocation.push({
        allocationId: p.allocationId,
        campaignId: null,
        status: 'SKIPPED',
        error: 'no campaignId',
      })
      continue
    }
    if (p.shiftCents === 0) {
      out.skipped += 1
      out.perAllocation.push({
        allocationId: p.allocationId,
        campaignId: p.campaignId,
        status: 'SKIPPED',
        error: 'no_change',
      })
      continue
    }
    const newBudgetEur = Math.round(p.proposedBudgetCents) / 100
    const result = await updateCampaignWithSync({
      campaignId: p.campaignId,
      patch: { dailyBudget: newBudgetEur },
      actor: args.actor,
      reason: args.reason,
    })
    if (result.ok && (result.outboundQueueId || result.error === 'no_changes')) {
      out.applied += 1
      out.perAllocation.push({
        allocationId: p.allocationId,
        campaignId: p.campaignId,
        status: 'APPLIED',
      })
    } else {
      out.failed += 1
      out.perAllocation.push({
        allocationId: p.allocationId,
        campaignId: p.campaignId,
        status: 'FAILED',
        error: result.error ?? 'unknown',
      })
      logger.warn('[budget-pool] applyRebalance: campaign update failed', {
        allocationId: p.allocationId,
        campaignId: p.campaignId,
        error: result.error,
      })
    }
  }
  return out
}

/**
 * Convenience wrapper: compute + (optionally) apply + write the
 * BudgetPoolRebalance audit row + bump lastRebalancedAt. Returns the
 * full outcome.
 */
export async function rebalanceAndAudit(args: {
  poolId: string
  triggeredBy: string
  ignoreCoolDown?: boolean
  /** Force a specific dryRun decision regardless of pool.dryRun. */
  forceDryRun?: boolean
  actor: AdsActor
}): Promise<RebalanceOutcome & { applied?: ApplyOutcome; auditId: string | null }> {
  const outcome = await computeRebalance({
    poolId: args.poolId,
    triggeredBy: args.triggeredBy,
    ignoreCoolDown: args.ignoreCoolDown,
  })
  if (!outcome.ok || outcome.skipped) {
    return { ...outcome, auditId: null }
  }
  const pool = await prisma.budgetPool.findUnique({
    where: { id: args.poolId },
    select: { dryRun: true },
  })
  if (!pool) return { ...outcome, auditId: null }
  const dryRun = args.forceDryRun ?? pool.dryRun

  let applied: ApplyOutcome | undefined
  let appliedAt: Date | null = null
  if (!dryRun) {
    applied = await applyRebalance({
      proposed: outcome.proposed,
      actor: args.actor,
      reason: `BudgetPool rebalance — ${args.triggeredBy}`,
    })
    appliedAt = new Date()
  }
  // Write audit row.
  const audit = await prisma.budgetPoolRebalance.create({
    data: {
      budgetPoolId: args.poolId,
      triggeredBy: args.triggeredBy,
      inputs: outcome.inputs as object,
      outputs: { proposed: outcome.proposed, warnings: outcome.warnings } as object,
      dryRun,
      appliedAt,
      totalShiftCents: outcome.totalShiftCents,
    },
    select: { id: true },
  })
  await prisma.budgetPool.update({
    where: { id: args.poolId },
    data: { lastRebalancedAt: new Date() },
  })
  return { ...outcome, applied, auditId: audit.id }
}
