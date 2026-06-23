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
  return goals.map((g) => {
    const products = Array.isArray(g.products) ? (g.products as unknown as GoalProduct[]) : []
    const dailyBudgetCents = g.budgetMode === 'SHARED'
      ? (g.totalBudgetCents ?? 0)
      : products.reduce((a, p) => a + (Number(p.budgetCents) || 0), 0)
    return {
      id: g.id, name: g.name, aiTarget: g.aiTarget, budgetMode: g.budgetMode,
      advancedAllocation: g.advancedAllocation, status: g.status, marketplace: g.marketplace,
      productCount: products.length, dailyBudgetCents,
      seedKeywords: g.seedKeywords, excludeKeywords: g.excludeKeywords,
      products, startDate: g.createdAt, createdAt: g.createdAt,
    }
  })
}

export async function archiveProductGoal(id: string) {
  return prisma.adProductGoal.update({ where: { id }, data: { status: 'ARCHIVED' } })
}

export class ValidationError extends Error {}
