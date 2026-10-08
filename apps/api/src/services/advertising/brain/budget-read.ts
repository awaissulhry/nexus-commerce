/**
 * ONE BRAIN AB-7 — the `ads-brain` tool's view `money` (design 2026-10-08-ads-one-brain/DESIGN.md §2.6, §6 "caps — used /
 * left"; §10: the Owner builds every screen, so this is the read API his page and Claude share). Read only: it changes
 * nothing, in Nexus or at Amazon, and stores nothing.
 *
 *   product × market  the money plan decided NOW (a dry run: it works for any product, enrolled or not —
 *                     and is never stored), beside the newest plan the shadow logged: the envelope and where it comes
 *                     from, the pace (projected month-end spend, % of the envelope, the curve), the brake and what it does,
 *                     the portfolio-cap plan, each campaign's budget target against today's, the ladder, and the why of each
 *   market            the market's split: its monthly budget, each product's envelope, the reserve for campaigns no
 *                     product's brain owns, and the newest logged plan of each product the shadow watches
 *
 * Money: every amount, percent of spend and sentence that names one sits under a `money` key, which the tool hides from a
 * person without the ad-spend permission (ads-brain.tools.ts restrictedFields); what stays visible names no amount.
 *
 * AB-8 — a logged plan carries what the money writer did with it (`actions`: written, asked, held — each with its why);
 * who set each portfolio's cap and Amazon's usage of it (a run reads it; a dry run reads no Amazon, and says so).
 */
import prisma from '../../../db.js'
import { strategyMarket } from '../ads-strategy/bids.js'
import { budgetDayMoveBounds } from '../ads-write-gate.js'
import { productFamily } from './ownership.js'
import { MONEY_BRAKES } from './budget-pace.js'
import { loadMarketMoney } from './budget-load.js'
import { planProductMoney, type ProductMoneyPlan } from './budget-plan.js'
import { MONEY_DECISION_DAYS_KEPT, newestMoneyDecisions } from './budget-shadow.js'

/** MCP.12 — the words every tool uses for a product that is deleted or not in this business (read-map.ts). */
const PRODUCT_NOT_FOUND = 'Product not found'

/** The visible plan with its money under `money` keys. Pure. */
export function moneyView(p: ProductMoneyPlan) {
  const label = p.name ?? p.productId
  return {
    productId: p.productId, name: p.name, market: p.market, month: p.month, day: p.day, at: p.at, enrolled: p.enrolled,
    levers: p.levers,
    envelope: {
      source: p.envelope.source,
      money: { envelopeCents: p.envelope.cents, ...(p.envelope.scaledPct != null ? { scaledPct: p.envelope.scaledPct } : {}), ...(p.envelope.sharePct != null ? { sharePct: p.envelope.sharePct } : {}), ...(p.envelope.boundBy ? { boundBy: p.envelope.boundBy } : {}), why: p.envelope.why },
    },
    split: { money: { budgetCents: p.split.budgetCents, from: p.split.budgetFrom, fixedCents: p.split.fixedCents, sharedCents: p.split.sharedCents, reserveCents: p.split.reserveCents, totalCents: p.split.totalCents, why: p.split.why } },
    pace: {
      aimPct: p.pace.aimPct, projection: p.pace.projection, dayCurve: p.pace.dayWeightsFrom, hourCurve: p.pace.hourCurveFrom, dataThrough: p.pace.dataThrough,
      money: {
        spentCents: p.pace.spentNowCents, projectedCents: p.pace.projectedCents, pacePct: p.pace.pacePct, vsCurvePct: p.pace.vsCurvePct,
        aimCents: p.pace.aimCents, allowanceCents: p.pace.allowanceCents, runRateCents: p.pace.runRateCents, expectedNowCents: p.pace.expectedNowCents,
        expectedThroughReportedCents: p.pace.expectedThroughReportedCents, daysAhead: p.pace.daysAhead, curve: p.pace.curve, why: p.pace.why,
      },
    },
    brake: {
      level: p.brake.level, abovePct: p.brake.abovePct, does: p.brake.does,
      stop: p.brake.stop?.map((s) => ({ campaignId: s.campaignId, name: s.name })) ?? null,
      money: { bidStepPct: p.brake.bidStepPct, stop: p.brake.stop, why: p.brake.why },
    },
    brakes: MONEY_BRAKES,
    portfolioCap: {
      on: p.portfolioCap.on, source: p.portfolioCap.source, pct: p.portfolioCap.pct,
      portfolios: p.portfolioCap.portfolios.map((x) => ({
        portfolioId: x.portfolioId, name: x.name, campaigns: x.campaigns, action: x.action, ...(x.todaySetBy !== undefined ? { todaySetBy: x.todaySetBy } : {}),
        money: { capCents: x.capCents, todayPolicy: x.todayPolicy, todayCapCents: x.todayCapCents, sharePct: x.sharePct, ...(x.belowSpend ? { belowSpend: true } : {}), ...(x.usagePct !== undefined ? { usagePct: x.usagePct } : {}), why: x.why },
      })),
      money: { totalCents: p.portfolioCap.totalCents, why: p.portfolioCap.why },
    },
    campaigns: p.campaigns.map((c) => ({
      campaignId: c.campaignId, name: c.name, status: c.status, owner: c.owner, action: c.action, onLadder: !!c.ladder, needsException: !!c.ladder?.exception,
      money: {
        todayCents: c.todayCents, targetCents: c.targetCents, stepCents: c.stepCents, expectedSpendCents: c.expectedSpendCents,
        band: c.band, bandFrom: c.bandFrom, acosPct: c.acosPct, usagePct: c.usagePct,
        ladder: c.ladder, ladderWhy: c.ladderWhy, dayMove: c.dayMove, why: c.why,
      },
    })),
    counts: p.counts,
    ...(p.actions ? {
      actions: {
        mode: p.actions.mode, counts: p.actions.counts,
        campaigns: p.actions.campaigns.map((a) => ({ campaignId: a.campaignId, name: a.name, level: a.level, layer: a.layer, sent: a.sent, money: { fromCents: a.fromCents, toCents: a.toCents, why: a.why, ...(a.reason ? { reason: a.reason } : {}) } })),
        portfolios: p.actions.portfolios.map((a) => ({ portfolioId: a.portfolioId, name: a.name, level: a.level, sent: a.sent, money: { fromCents: a.fromCents, toCents: a.toCents, why: a.why, ...(a.reason ? { reason: a.reason } : {}) } })),
        proposals: p.actions.proposals.map((x) => ({ kind: x.kind, approvalId: x.approvalId, status: x.status, fresh: x.fresh, money: { why: x.why } })),
        money: { why: p.actions.why },
      },
    } : {}),
    why: `${label} (${p.market}) ${p.month} day ${Number(p.day.slice(8, 10))}: envelope from ${p.envelope.source === 'own' ? 'its own monthly budget' : p.envelope.source === 'playbook' ? 'its playbook' : p.envelope.source === 'share' ? 'its share of the market budget' : 'nowhere (none)'} · ${p.brake.level === 'none' ? 'no brake' : `brake ${p.brake.level}: ${p.brake.does}`} · portfolio cap ${p.portfolioCap.source} · ${p.campaigns.length} campaigns: ${p.counts.lower} lower, ${p.counts.raise} raise, ${p.counts.keep} keep, ${p.counts.hold} hold${p.counts.skip ? `, ${p.counts.skip} not the brain's` : ''}`,
    money: { fit: p.fit, warnings: p.warnings, why: p.why },
  }
}

/**
 * View money. With productId and market: the plan now (dry run) and the newest logged one. With market alone: the
 * market's split and the newest logged plan of each product the shadow watches there.
 */
export async function brainMoney(args: { productId?: string; market?: string; now?: Date }): Promise<{ data: unknown } | { error: string }> {
  // The database clock, as the shadow's runs read it (rank-defend's dbNow: a container clock once ran two hours late).
  const now = args.now ?? await (await import('../../../jobs/ad-rank-defend.job.js')).dbNow()
  const market = args.market ? strategyMarket(args.market) : null
  if (args.market && !market) return { error: `${args.market} is not a market code` }
  if (!market) return { error: 'name the market (market), and optionally a productId: view money reads one market' }
  if (args.productId) {
    if (!(await prisma.product.count({ where: { id: args.productId, deletedAt: null } }))) return { error: PRODUCT_NOT_FOUND }
    const family = await productFamily(args.productId)
    if (!family) return { error: `product ${args.productId} has no single family (a parentless product whose ASIN variations of several families carry): fix its family first` }
    const [stored, kept] = await Promise.all([
      newestMoneyDecisions(market, [family.root]),
      prisma.adsBrainBudgetDecision.count({ where: { productId: family.root, marketplace: market } }),
    ])
    const last = stored.get(family.root)
    const mm = await loadMarketMoney(market, { now, plan: [family.root], previous: last ? new Map([[family.root, last.plan]]) : undefined })
    const facts = mm?.facts.get(family.root)
    if (!mm || !facts) return { error: `${market} is not a market code` }
    const plan = planProductMoney(facts, budgetDayMoveBounds)
    return {
      data: {
        view: 'money', scope: { productId: family.root, market }, dryRun: true,
        note: 'decided now from what Nexus holds — not stored and nothing sent, and Amazon\'s usage of the portfolio caps is not read in a dry run; the run logs a plan for a product whose budgets lever is OBSERVE or higher, and at PROPOSE / AUTO (server switch live) asks or writes it (AB-8)',
        plan: moneyView(plan),
        logged: last ? { at: last.createdAt.toISOString(), kind: last.kind, mode: last.mode, runId: last.runId, rowsKept: kept, keptDays: MONEY_DECISION_DAYS_KEPT, plan: moneyView(last.plan) } : null,
      },
    }
  }
  const mm = await loadMarketMoney(market, { now, plan: [] })
  if (!mm) return { error: `${market} is not a market code` }
  const ids = [...mm.split.envelopes.keys()]
  const stored = await newestMoneyDecisions(market, ids)
  return {
    data: {
      view: 'money', scope: { market }, month: mm.clock.month, day: mm.clock.day, dataThrough: mm.dataThrough,
      market: { money: { budgetCents: mm.split.budgetCents, from: mm.split.budgetFrom, fixedCents: mm.split.fixedCents, sharedCents: mm.split.sharedCents, reserveCents: mm.split.reserveCents, totalCents: mm.split.totalCents, why: mm.split.why, warnings: mm.split.warnings } },
      products: ids.map((id) => {
        const e = mm.split.envelopes.get(id)!
        const p = mm.products.get(id)
        const last = stored.get(id)
        return {
          productId: id, name: p?.name ?? null, sku: p?.sku ?? null, envelopeSource: e.source,
          logged: last ? { at: last.createdAt.toISOString(), kind: last.kind, brake: last.plan.brake.level } : null,
          money: { envelopeCents: e.cents, why: e.why, ...(last ? { logged: { pacePct: last.plan.pace.pacePct, projectedCents: last.plan.pace.projectedCents } } : {}) },
        }
      }),
      next: 'Read one product with productId and market: its plan now (dry run) and the newest the shadow logged.',
    },
  }
}
