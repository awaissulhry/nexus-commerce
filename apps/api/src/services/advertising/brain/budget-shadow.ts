/**
 * ONE BRAIN AB-7 — the money shadow (design 2026-10-08-ads-one-brain/DESIGN.md §2.5, §2.6, §4, §8 row AB-7): for every
 * product whose `budgets` lever is OBSERVE or higher (enrolled, not excluded, not locked), plan its money in its market
 * (brain/budget-plan.ts) and log the plan (AdsBrainBudgetDecision). At OBSERVE it writes NOTHING else: no budget, no
 * portfolio cap, no bid, no queue, no gate, no Amazon.
 *
 * AB-8 — at PROPOSE and AUTO, under a live server switch, the money writer (brain/budget-live.ts) carries the plan out:
 * PROPOSE asks a person, AUTO writes the campaign budgets and the portfolio caps through the gate and the gateway. What
 * it did rides on the logged plan (`actions`, the row's mode SHADOW / PROPOSE / LIVE), and a run in which it acted
 * stores its plan even when the decisions did not change. The run reads Amazon's usage of the product's portfolio caps
 * (the brakes use it). Production today: no product is enrolled — nothing is planned, asked or written.
 *
 *   stored    a plan whose decisions differ from the product's last one (moneyPlanHash), plus the budget day's first as a
 *             snapshot — so a run on unchanged facts writes nothing (BidBrainDecision's pattern)
 *   kept      30 days: older rows are deleted at every full slot, also when no product is watched any more (Neon cost)
 *   cadence   the bid brain's full slots (jobs/ads-bid-brain.job.ts: :45 of 00, 06, 12 and 18 UTC) — the design's daily
 *             cycle; AB-8 — and every 15 minutes for the products whose budgets lever is AUTO under a live switch (the
 *             intraday ladder and the next day's give-back land on time)
 *   no-op     no enrolled product with the lever at OBSERVE or higher (production today): one read and the 30-day prune
 *             (nothing to delete there), nothing planned, no run recorded
 * Each market is planned on its own; a market that fails is named in the run and the others still run.
 */
import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { budgetDayMoveBounds } from '../ads-write-gate.js'
import { isLevel, type BrainLevel } from './levers.js'
import { resolveBrainSettings, type OverrideRow } from './settings.js'
import { loadMarketMoney } from './budget-load.js'
import { moneyPlanHash, planProductMoney, type ProductMoneyPlan } from './budget-plan.js'
import { moneyActionsWords, moneyLeversOwned, runMoneyActions, type MoneyActions, type MoneyMode } from './budget-live.js'
import { brainLiveCeiling } from '../bid-brain/live.js'
import { openEngineGuard, type EngineGuard } from '../ads-engine-guard.js'

export const MONEY_DECISION_DAYS_KEPT = 30
/** The largest pace the log's column (DECIMAL(10,2)) stores; above it the column holds this and the plan the exact one. */
export const MAX_STORED_PACE_PCT = 99_999_999.99
const DAY_MS = 86_400_000
const WATCHING: readonly BrainLevel[] = ['OBSERVE', 'PROPOSE', 'AUTO']

export interface MoneyShadowProduct { productId: string; market: string; level: BrainLevel }

export interface MoneyShadowRun {
  runId: string
  ran: boolean
  why: string
  products: Array<{ productId: string; market: string; stored: 'change' | 'snapshot' | null; brake: string; pacePct: number | null; why: string; /** AB-8 */ mode?: MoneyMode; actions?: string }>
  failed: Array<{ market: string; error: string }>
  pruned: number
}

/** The enrolled products whose budgets lever is OBSERVE or higher (two reads, nothing else). */
export async function moneyShadowProducts(): Promise<MoneyShadowProduct[]> {
  const enrollments = await prisma.adsBrainEnrollment.findMany({ select: { productId: true, marketplace: true } })
  if (!enrollments.length) return []
  const overrides = await prisma.adsBrainOverride.findMany({
    where: { endedAt: null, scope: 'PRODUCT', productId: { in: [...new Set(enrollments.map((e) => e.productId))] } },
    select: { id: true, productId: true, marketplace: true, scope: true, campaignId: true, kind: true, key: true, ref: true, value: true, by: true, reason: true, createdAt: true, endedAt: true },
  }) as OverrideRow[]
  return enrollments.flatMap((e) => {
    const s = resolveBrainSettings({ productId: e.productId, market: e.marketplace, enrolled: true, overrides })
    const level = s.levers.budgets.effective
    return isLevel(level) && WATCHING.includes(level) ? [{ productId: e.productId, market: e.marketplace, level }] : []
  }).sort((a, b) => a.market.localeCompare(b.market) || a.productId.localeCompare(b.productId))
}

/** Whether a plan is worth a row: its decisions changed since the product's last one, or it is the budget day's first. */
export function moneyRowKind(plan: Pick<ProductMoneyPlan, 'day'>, hash: string, prev: { planHash: string; day: string } | undefined): 'change' | 'snapshot' | null {
  if (!prev || prev.planHash !== hash) return 'change'
  return prev.day !== plan.day ? 'snapshot' : null
}

/** Each product's newest stored plan in one market (one statement). */
export async function newestMoneyDecisions(market: string, productIds: readonly string[]): Promise<Map<string, { planHash: string; day: string; plan: ProductMoneyPlan; createdAt: Date; kind: string; mode: string; runId: string }>> {
  if (!productIds.length) return new Map()
  // The day as text: a DATE read as a Date lands on the reader's local midnight (this Mac runs on CEST).
  const rows = await prisma.$queryRaw<Array<{ productId: string; planHash: string; day: string; plan: ProductMoneyPlan; createdAt: Date; kind: string; mode: string; runId: string }>>(Prisma.sql`
    SELECT DISTINCT ON ("productId") "productId", "planHash", to_char("day", 'YYYY-MM-DD') AS "day", "plan", "createdAt", "kind", "mode", "runId"
      FROM "AdsBrainBudgetDecision"
     WHERE "marketplace" = ${market} AND "productId" = ANY(${[...productIds]}::text[])
     ORDER BY "productId", "createdAt" DESC`)
  return new Map(rows.map((r) => [r.productId, { ...r, createdAt: new Date(r.createdAt) }]))
}

/** Delete the logged plans older than MONEY_DECISION_DAYS_KEPT days; how many went. */
export async function pruneMoneyDecisions(now: Date): Promise<number> {
  return (await prisma.adsBrainBudgetDecision.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - MONEY_DECISION_DAYS_KEPT * DAY_MS) } } })).count
}

/** AB-8 — the writer acted this run (queued, wrote or asked something new): its plan is worth a row. */
const acted = (a: MoneyActions | undefined) => !!a && a.counts.queued + a.counts.written + a.counts.asked > 0

/**
 * One run: the 30-day prune (also when nothing is watched any more), then every watching product, market by market.
 * AB-8 — `live`: the server switch (default: NEXUS_BID_BRAIN_MODE); the money writer acts on PROPOSE / AUTO levers only then.
 */
export async function runMoneyShadowOnce(opts: { now?: Date; products?: readonly MoneyShadowProduct[]; live?: boolean; /** AB-8 — a 15-minute tick: campaign budgets only (caps and requests wait for a full slot). */ between?: boolean } = {}): Promise<MoneyShadowRun> {
  const now = opts.now ?? new Date()
  const runId = `bm-${now.toISOString().slice(0, 16)}-${randomUUID().slice(0, 8)}`
  const products = opts.products ?? await moneyShadowProducts()
  const out: MoneyShadowRun = { runId, ran: false, why: '', products: [], failed: [], pruned: await pruneMoneyDecisions(now) }
  if (!products.length) { out.why = 'no enrolled product has its budgets lever at OBSERVE or higher: nothing planned, nothing written'; return out }
  out.ran = true
  out.why = `${products.length} product${products.length === 1 ? '' : 's'} with the budgets lever at OBSERVE or higher`
  const live = opts.live ?? brainLiveCeiling()
  // The brain's engine guard (the dial, its caps), opened once per run on the first write it asks.
  let guard: Promise<EngineGuard> | null = null
  const openGuard = () => (guard ??= openEngineGuard('brain-money', { now }))
  const markets = [...new Set(products.map((p) => p.market))]
  for (const market of markets) {
    const mine = products.filter((p) => p.market === market)
    try {
      const prev = await newestMoneyDecisions(market, mine.map((p) => p.productId))
      const mm = await loadMarketMoney(market, { now, plan: mine.map((p) => p.productId), previous: new Map([...prev].map(([k, v]) => [k, v.plan])), readPortfolioUsage: true })
      if (!mm) throw new Error(`${market} is not a market code`)
      const data: Prisma.AdsBrainBudgetDecisionCreateManyInput[] = []
      for (const p of mine) {
        const f = mm.facts.get(p.productId)
        if (!f) { out.products.push({ productId: p.productId, market, stored: null, brake: 'none', pacePct: null, why: 'the product has no family root here: nothing planned' }); continue }
        const plan = planProductMoney(f, budgetDayMoveBounds)
        const hash = moneyPlanHash(plan)
        // AB-8 — the money writer, at the levels the Owner set (a failure of one product is its own, never the market's).
        let actions: MoneyActions | undefined
        try {
          actions = await runMoneyActions(plan, f, { runId, live, guard: openGuard, budgetsOnly: opts.between === true })
          // Attached where a money lever is PROPOSE or AUTO (with the switch not live: each move held, the reason said).
          if (moneyLeversOwned(f)) plan.actions = actions
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err)
          logger.error('[brain-money] the money writer failed for a product', { market, productId: p.productId, error })
          out.failed.push({ market, error: `${p.productId}: ${error}` })
        }
        const kind = moneyRowKind(plan, hash, prev.get(p.productId)) ?? (acted(actions) ? 'change' : null)
        const mode: MoneyMode = actions?.mode ?? 'SHADOW'
        out.products.push({ productId: p.productId, market, stored: kind, brake: plan.brake.level, pacePct: plan.pace.pacePct, why: plan.why, mode, actions: moneyActionsWords(actions) })
        if (!kind) continue
        data.push({
          runId, mode, kind, productId: p.productId, marketplace: market, day: new Date(`${plan.day}T00:00:00Z`), month: plan.month, level: p.level,
          envelopeCents: plan.envelope.cents, envelopeSource: plan.envelope.source, spentCents: plan.pace.spentNowCents, projectedCents: plan.pace.projectedCents,
          pacePct: plan.pace.pacePct == null ? null : Math.min(plan.pace.pacePct, MAX_STORED_PACE_PCT), brake: plan.brake.level, portfolioCapCents: plan.portfolioCap.totalCents, planHash: hash,
          plan: plan as unknown as Prisma.InputJsonObject, why: plan.why, createdAt: now,
        })
      }
      if (data.length) await prisma.adsBrainBudgetDecision.createMany({ data })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      logger.error('[brain-money] market plan failed', { market, error })
      out.failed.push({ market, error })
    }
  }
  return out
}

/**
 * The run's summary line: "SHADOW IT <product>: <brake> <pace> % (change | snapshot | unchanged) · pruned=<n>"; AB-8 — a
 * product the writer acted on says its mode and what it did, and the line starts MONEY: "MONEY LIVE IT <product>: … queued=2".
 */
export function moneySummaryLine(r: MoneyShadowRun): string {
  if (!r.ran) return r.why
  const parts = r.products.map((p) => `${p.mode && p.mode !== 'SHADOW' ? `${p.mode} ` : ''}${p.market} ${p.productId}: ${p.brake}${p.pacePct != null ? ` ${p.pacePct} %` : ''} (${p.stored ?? 'unchanged'})${p.actions ? ` ${p.actions}` : ''}`)
  const failed = r.failed.map((f) => `${f.market} failed: ${f.error}`)
  return `${r.products.some((p) => p.mode && p.mode !== 'SHADOW') ? 'MONEY' : 'SHADOW'} ${[...parts, ...failed].join(' · ')} · pruned=${r.pruned}`
}

/**
 * AB-8 — the products the 15-minute ticks carry between the full slots: the watched ones whose budgets lever is AUTO,
 * under a live server switch (none otherwise: no query beyond the enrollment read).
 */
export async function moneyLiveProducts(): Promise<MoneyShadowProduct[]> {
  if (!brainLiveCeiling()) return []
  return (await moneyShadowProducts()).filter((p) => p.level === 'AUTO')
}
