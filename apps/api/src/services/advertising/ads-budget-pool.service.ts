/**
 * ADS AUTONOMY W4-7 — the budget pool routes (AD.5, advertising.routes.ts), moved unchanged into a service so Claude's
 * set-budget-pool does what the Budget Manager's pool drawer does, through the same code. Each route parses its input,
 * calls one function here and maps the answer to its status code, byte for byte as before the move
 * (budget-pool-route-parity.vitest.test.ts). A pool's edit (PATCH) moved earlier, to ads-engine-settings.service.ts
 * `patchBudgetPool` (R14, tune-ad-engine).
 *
 *   listBudgetPools       GET    /advertising/budget-pools
 *   getBudgetPool         GET    /advertising/budget-pools/:id                   null = 404
 *   createBudgetPool      POST   /advertising/budget-pools                       born switched off and in dry run
 *   deleteBudgetPool      DELETE /advertising/budget-pools/:id                   false = 404 (its allocations go with it)
 *   addPoolAllocation     POST   /advertising/budget-pools/:id/allocations       a campaign joins the pool (one pool per campaign)
 *   removePoolAllocation  DELETE /advertising/budget-pools/:id/allocations/:a    false = 404
 *   rebalanceBudgetPool   POST   /advertising/budget-pools/:id/rebalance         a preview, or a run that honours the pool's dry run
 *   budgetPoolHistory     GET    /advertising/budget-pools/:id/history
 */
import prisma from '../../db.js'
import type { AdsActor } from './ads-mutation.service.js'
import { computeRebalance, rebalanceAndAudit, type RebalanceWriteOptions } from './budget-pool-rebalancer.service.js'

export type PoolStrategy = 'STATIC' | 'PROFIT_WEIGHTED' | 'URGENCY_WEIGHTED'

/** GET /advertising/budget-pools — every pool, switched-on first, with its allocations and counts. */
export async function listBudgetPools() {
  const items = await prisma.budgetPool.findMany({
    orderBy: [{ enabled: 'desc' }, { name: 'asc' }],
    include: {
      allocations: {
        select: {
          id: true,
          marketplace: true,
          campaignId: true,
          targetSharePct: true,
          minDailyBudgetCents: true,
          maxDailyBudgetCents: true,
        },
      },
      _count: { select: { allocations: true, rebalances: true } },
    },
  })
  return { items, count: items.length }
}

/** GET /advertising/budget-pools/:id — one pool, its allocations and last 50 rebalances, and its campaigns now. Null: not found. */
export async function getBudgetPool(id: string) {
  const pool = await prisma.budgetPool.findUnique({
    where: { id },
    include: {
      allocations: {
        orderBy: [{ marketplace: 'asc' }],
      },
      rebalances: { orderBy: { createdAt: 'desc' }, take: 50 },
    },
  })
  if (!pool) return null
  // Hydrate per-allocation current campaign budget so the visualizer
  // can render "current vs target" without a second round-trip.
  const campaignIds = pool.allocations
    .map((a) => a.campaignId)
    .filter((id): id is string => !!id)
  const campaigns = await prisma.campaign.findMany({
    where: { id: { in: campaignIds } },
    select: { id: true, name: true, dailyBudget: true, status: true, marketplace: true },
  })
  return { pool, campaigns }
}

export interface NewBudgetPool {
  name: string
  description?: string
  currency?: string
  totalDailyBudgetCents: number
  strategy?: PoolStrategy
  coolDownMinutes?: number
  maxShiftPerRebalancePct?: number
}

/** POST /advertising/budget-pools — a pool, born switched off and in dry run. `invalid`: the route's 400. */
export async function createBudgetPool(body: NewBudgetPool, opts: { createdBy?: string } = {}) {
  if (!body?.name || !body.totalDailyBudgetCents) {
    return { invalid: 'name + totalDailyBudgetCents required' as const }
  }
  const pool = await prisma.budgetPool.create({
    data: {
      name: body.name,
      description: body.description ?? null,
      currency: body.currency ?? 'EUR',
      totalDailyBudgetCents: body.totalDailyBudgetCents,
      strategy: body.strategy ?? 'STATIC',
      coolDownMinutes: body.coolDownMinutes ?? 60,
      maxShiftPerRebalancePct: body.maxShiftPerRebalancePct ?? 20,
      enabled: false,
      dryRun: true,
      // W4-7 — Claude's create names the person who approved it; the screen's stays 'user'.
      createdBy: opts.createdBy ?? 'user',
    },
  })
  return { pool }
}

/** DELETE /advertising/budget-pools/:id — false: not found (the route's 404). */
export async function deleteBudgetPool(id: string): Promise<boolean> {
  const existing = await prisma.budgetPool.findUnique({ where: { id } })
  if (!existing) return false
  await prisma.budgetPool.delete({ where: { id } })
  return true
}

export interface NewPoolAllocation {
  campaignId: string
  targetSharePct?: number
  minDailyBudgetCents?: number
  maxDailyBudgetCents?: number
}

/**
 * POST /advertising/budget-pools/:id/allocations — a campaign joins the pool, its market copied from the campaign. A
 * refusal carries the route's status: 400 (no such campaign, or one with no market), 409 (already in a pool), 500.
 */
export async function addPoolAllocation(poolId: string, body: NewPoolAllocation) {
  const campaign = await prisma.campaign.findUnique({
    where: { id: body.campaignId },
    select: { id: true, marketplace: true },
  })
  if (!campaign?.marketplace) {
    return { error: 'campaign_not_found_or_no_marketplace', status: 400 as const }
  }
  try {
    const allocation = await prisma.budgetPoolAllocation.create({
      data: {
        budgetPoolId: poolId,
        marketplace: campaign.marketplace,
        campaignId: campaign.id,
        targetSharePct: body.targetSharePct ?? 0,
        minDailyBudgetCents: body.minDailyBudgetCents ?? 100,
        maxDailyBudgetCents: body.maxDailyBudgetCents ?? null,
      },
    })
    return { allocation }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('Unique constraint')) {
      return { error: 'campaign_already_in_a_pool', status: 409 as const }
    }
    return { error: msg, status: 500 as const }
  }
}

/** DELETE /advertising/budget-pools/:id/allocations/:allocationId — false: not found in this pool (the route's 404). */
export async function removePoolAllocation(poolId: string, allocationId: string): Promise<boolean> {
  const existing = await prisma.budgetPoolAllocation.findUnique({
    where: { id: allocationId },
  })
  if (!existing || existing.budgetPoolId !== poolId) return false
  await prisma.budgetPoolAllocation.delete({ where: { id: allocationId } })
  return true
}

/**
 * POST /advertising/budget-pools/:id/rebalance — `preview`: what a rebalance would propose now (cool-down ignored),
 * nothing written; otherwise a run through rebalanceAndAudit, honouring the pool's dry run. `skipped`: the route's 409.
 */
export async function rebalanceBudgetPool(id: string, opts: { preview: boolean; actor: AdsActor } & RebalanceWriteOptions) {
  if (opts.preview) {
    const outcome = await computeRebalance({
      poolId: id,
      triggeredBy: `user:${opts.actor.slice(5)}`,
      ignoreCoolDown: true,
    })
    return { mode: 'preview' as const, outcome }
  }
  const outcome = await rebalanceAndAudit({
    poolId: id,
    triggeredBy: `user:${opts.actor.slice(5)}`,
    ignoreCoolDown: true,
    actor: opts.actor,
    // W4-7 — Claude's rebalance-now (set-budget-pool): its approval and, a person's approval, his click. None from the route.
    changeSetId: opts.changeSetId,
    manual: opts.manual,
    confirmOwnLimits: opts.confirmOwnLimits,
  })
  if (outcome.skipped) return { skipped: outcome.skipped }
  return { mode: 'committed' as const, outcome }
}

/** GET /advertising/budget-pools/:id/history — its rebalances, newest first (at most 200). */
export async function budgetPoolHistory(id: string, limit: number) {
  const items = await prisma.budgetPoolRebalance.findMany({
    where: { budgetPoolId: id },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })
  return { items, count: items.length }
}

// ── W4-7 — reads for Claude's set-budget-pool and ad-budgets (nothing here writes) ──────────────────────────

/** The pool each of these campaigns is in now (a campaign is in one pool at most), by campaign id. */
export async function poolsOfCampaigns(campaignIds: readonly string[]): Promise<Map<string, { poolId: string; poolName: string; allocationId: string }>> {
  if (!campaignIds.length) return new Map()
  const rows = await prisma.budgetPoolAllocation.findMany({
    where: { campaignId: { in: [...campaignIds] } },
    select: { id: true, campaignId: true, budgetPoolId: true, budgetPool: { select: { name: true } } },
  })
  return new Map(rows.filter((r) => r.campaignId).map((r) => [r.campaignId!, { poolId: r.budgetPoolId, poolName: r.budgetPool.name, allocationId: r.id }]))
}

/** A pool by its exact name (a name is how a person finds one), or null. */
export async function budgetPoolNamed(name: string) {
  return prisma.budgetPool.findFirst({ where: { name }, select: { id: true } })
}
