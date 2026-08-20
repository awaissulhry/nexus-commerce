/**
 * AG.1 — AI Advertising "Product Goal" service (Helium 10-style). Persists goals
 * created in the AI Goal builder and lists them for the AI Advertising dashboard.
 * DB-only / sandbox: creating a goal does NOT push to Amazon (P8 write gate). The
 * goal config is the source of truth; campaign materialization is a later phase.
 */
import prisma from '../../db.js'

export type AiTarget = 'IMPRESSION' | 'SALES' | 'ROAS'
export type BudgetMode = 'STRICT' | 'SHARED'

export interface GoalProduct {
  productId?: string
  asin?: string
  sku?: string
  name?: string
  imageUrl?: string | null
  lqs?: number
  budgetCents?: number | null // per-product daily budget (Strict Control mode)
}
export interface ProductGoalInput {
  name: string
  aiTarget: AiTarget
  budgetMode: BudgetMode
  advancedAllocation?: boolean
  totalBudgetCents?: number | null
  products: GoalProduct[]
  seedKeywords?: string[]
  excludeKeywords?: string[]
  productTargets?: string[]
  excludeAsins?: string[]
  marketplace?: string | null
  portfolioId?: string | null
}

// Amazon's minimum daily budget is ~1 unit of the account currency.
const MIN_DAILY_BUDGET_CENTS = 100

const clean = (a?: string[]) => Array.from(new Set((a ?? []).map((s) => String(s).trim()).filter(Boolean)))

/** Validate + persist a product goal. Throws ValidationError (caller → 400). */
export async function createProductGoal(input: ProductGoalInput) {
  const name = (input?.name ?? '').trim()
  if (!name) throw new ValidationError('Goal name is required')

  const products = Array.isArray(input?.products) ? input.products : []
  if (products.length === 0) throw new ValidationError('Add at least one product')

  const aiTarget: AiTarget = (['IMPRESSION', 'SALES', 'ROAS'] as const).includes(input?.aiTarget) ? input.aiTarget : 'SALES'
  const budgetMode: BudgetMode = input?.budgetMode === 'SHARED' ? 'SHARED' : 'STRICT'

  let totalBudgetCents: number | null = null
  if (budgetMode === 'SHARED') {
    totalBudgetCents = Math.round(Number(input?.totalBudgetCents) || 0)
    if (totalBudgetCents < MIN_DAILY_BUDGET_CENTS) throw new ValidationError('Enter a total budget of at least €1.00')
  } else {
    for (const p of products) {
      const b = Math.round(Number(p?.budgetCents) || 0)
      if (b < MIN_DAILY_BUDGET_CENTS) throw new ValidationError('Each product needs a daily budget of at least €1.00')
    }
  }

  const normProducts: GoalProduct[] = products.map((p) => ({
    productId: p.productId, asin: p.asin, sku: p.sku, name: p.name, imageUrl: p.imageUrl ?? null,
    lqs: typeof p.lqs === 'number' ? p.lqs : undefined,
    budgetCents: budgetMode === 'STRICT' ? Math.round(Number(p.budgetCents) || 0) : null,
  }))

  return prisma.adProductGoal.create({
    data: {
      name, aiTarget, budgetMode,
      advancedAllocation: budgetMode === 'STRICT' ? !!input.advancedAllocation : false,
      totalBudgetCents,
      products: normProducts as never,
      seedKeywords: clean(input.seedKeywords),
      excludeKeywords: clean(input.excludeKeywords),
      productTargets: clean(input.productTargets),
      excludeAsins: clean(input.excludeAsins),
      status: 'ACTIVE',
      marketplace: input.marketplace ?? null,
      portfolioId: (input.portfolioId ?? '').trim() || null,
    },
  })
}

/** List goals for the dashboard "Goals" table (newest first, non-archived). */
export async function listProductGoals(opts?: { marketplace?: string | null }) {
  const where: { status: { not: string }; marketplace?: string } = { status: { not: 'ARCHIVED' } }
  if (opts?.marketplace) where.marketplace = opts.marketplace
  const goals = await prisma.adProductGoal.findMany({ where, orderBy: { createdAt: 'desc' }, take: 500 })
  // AIAD.2 — the "AI Control" column reads the linked AutopilotPlan's autonomy, not a copy.
  const planIds = goals.map((g) => g.planId).filter((x): x is string => !!x)
  const plans = planIds.length
    ? await prisma.autopilotPlan.findMany({ where: { id: { in: planIds } }, select: { id: true, autonomy: true, enabled: true, lastEvaluatedAt: true } })
    : []
  const planById = new Map(plans.map((p) => [p.id, p]))
  return goals.map((g) => {
    const products = Array.isArray(g.products) ? (g.products as unknown as GoalProduct[]) : []
    const dailyBudgetCents = g.budgetMode === 'SHARED'
      ? (g.totalBudgetCents ?? 0)
      : products.reduce((a, p) => a + (Number(p.budgetCents) || 0), 0)
    const plan = g.planId ? planById.get(g.planId) : undefined
    return {
      id: g.id, name: g.name, aiTarget: g.aiTarget, budgetMode: g.budgetMode,
      advancedAllocation: g.advancedAllocation, status: g.status, marketplace: g.marketplace,
      productCount: products.length, dailyBudgetCents,
      seedKeywords: g.seedKeywords, excludeKeywords: g.excludeKeywords,
      products, startDate: g.createdAt, createdAt: g.createdAt,
      materializedAt: g.materializedAt, planId: g.planId,
      campaignCount: Array.isArray(g.campaignIds) ? (g.campaignIds as unknown[]).length : 0,
      aiControl: plan ? (plan.enabled ? plan.autonomy : 'OFF') : null,
    }
  })
}

/**
 * AIAD.0 — per-goal + account-level performance rollup for the AI Advertising dashboard.
 * Aggregates AmazonAdsDailyPerformance (CAMPAIGN grain) over each goal's materialized
 * campaigns. Goals without campaigns simply don't appear in `goals` — the dashboard shows
 * them as "not launched" rather than faking zeros. Dates are UTC day keys (YYYY-MM-DD).
 */
export async function productGoalSummary(opts?: { start?: string; end?: string; marketplace?: string | null }) {
  const where: { status: { not: string }; marketplace?: string } = { status: { not: 'ARCHIVED' } }
  if (opts?.marketplace) where.marketplace = opts.marketplace
  const goals = await prisma.adProductGoal.findMany({ where, select: { id: true, budgetMode: true, totalBudgetCents: true, products: true, campaignIds: true } })
  const idsByGoal = new Map<string, string[]>()
  for (const g of goals) {
    const refs = Array.isArray(g.campaignIds) ? (g.campaignIds as Array<{ id?: string }>) : []
    const ids = refs.map((r) => String(r?.id ?? '')).filter(Boolean)
    if (ids.length) idsByGoal.set(g.id, ids)
  }
  const allIds = Array.from(new Set(Array.from(idsByGoal.values()).flat()))
  const parseDay = (s?: string) => {
    if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
    const d = new Date(`${s}T00:00:00Z`)
    return Number.isNaN(d.getTime()) ? null : d
  }
  const end = parseDay(opts?.end) ?? new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z')
  const start = parseDay(opts?.start) ?? new Date(end.getTime() - 29 * 86_400_000)
  if (!allIds.length) return { goals: [], series: [], totals: { spendCents: 0, salesCents: 0, orders: 0, acosPct: null } }

  const rows = await prisma.amazonAdsDailyPerformance.groupBy({
    by: ['localEntityId', 'date'],
    where: { entityType: 'CAMPAIGN', localEntityId: { in: allIds }, date: { gte: start, lte: end } },
    _sum: { costMicros: true, sales7dCents: true, clicks: true, orders7d: true, impressions: true },
  })
  type Acc = { spendCents: number; salesCents: number; orders: number; clicks: number; impressions: number }
  const blank = (): Acc => ({ spendCents: 0, salesCents: 0, orders: 0, clicks: 0, impressions: 0 })
  const goalOfCampaign = new Map<string, string>()
  for (const [gid, ids] of idsByGoal) for (const id of ids) goalOfCampaign.set(id, gid)

  const byGoal = new Map<string, Acc>()
  const byGoalDay = new Map<string, Map<string, number>>() // goalId → day → spendCents (utilization)
  const byDay = new Map<string, Acc>()
  for (const r of rows) {
    const gid = r.localEntityId ? goalOfCampaign.get(r.localEntityId) : undefined
    if (!gid) continue
    const day = r.date.toISOString().slice(0, 10)
    const spendCents = Math.round(Number(r._sum.costMicros ?? 0n) / 10_000)
    const add = (a: Acc) => {
      a.spendCents += spendCents
      a.salesCents += r._sum.sales7dCents ?? 0
      a.orders += r._sum.orders7d ?? 0
      a.clicks += r._sum.clicks ?? 0
      a.impressions += r._sum.impressions ?? 0
    }
    add(byGoal.get(gid) ?? byGoal.set(gid, blank()).get(gid)!)
    add(byDay.get(day) ?? byDay.set(day, blank()).get(day)!)
    const gd = byGoalDay.get(gid) ?? byGoalDay.set(gid, new Map()).get(gid)!
    gd.set(day, (gd.get(day) ?? 0) + spendCents)
  }

  const acos = (spend: number, sales: number) => (sales > 0 ? Math.round((spend / sales) * 10_000) / 100 : null)
  const goalRows = goals.filter((g) => idsByGoal.has(g.id)).map((g) => {
    const a = byGoal.get(g.id) ?? blank()
    const products = Array.isArray(g.products) ? (g.products as unknown as GoalProduct[]) : []
    const dailyBudgetCents = g.budgetMode === 'SHARED' ? (g.totalBudgetCents ?? 0) : products.reduce((n, p) => n + (Number(p.budgetCents) || 0), 0)
    // Utilization from the most recent day that has data (report ingest lags D-0/D-1).
    const days = byGoalDay.get(g.id)
    const utilizationDate = days ? Array.from(days.keys()).sort().pop() ?? null : null
    const utilSpend = utilizationDate ? days!.get(utilizationDate)! : null
    return {
      goalId: g.id, ...a, acosPct: acos(a.spendCents, a.salesCents),
      utilizationPct: utilSpend != null && dailyBudgetCents > 0 ? Math.round((utilSpend / dailyBudgetCents) * 1000) / 10 : null,
      utilizationDate,
    }
  })
  const series = Array.from(byDay.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([date, a]) => ({
    date, spendCents: a.spendCents, salesCents: a.salesCents, orders: a.orders, acosPct: acos(a.spendCents, a.salesCents),
  }))
  const t = blank()
  for (const a of byDay.values()) { t.spendCents += a.spendCents; t.salesCents += a.salesCents; t.orders += a.orders; t.clicks += a.clicks; t.impressions += a.impressions }
  return { goals: goalRows, series, totals: { spendCents: t.spendCents, salesCents: t.salesCents, orders: t.orders, acosPct: acos(t.spendCents, t.salesCents) } }
}

export async function archiveProductGoal(id: string) {
  return prisma.adProductGoal.update({ where: { id }, data: { status: 'ARCHIVED' } })
}

export class ValidationError extends Error {}
