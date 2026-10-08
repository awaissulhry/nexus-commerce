/**
 * ONE BRAIN AB-14 — the ads-brain view `report`: the day's product report the product cycle stored (brain/cycle-run.ts,
 * AdsBrainCycle). Read only — it changes nothing, in Nexus or at Amazon, and decides nothing now: a report exists only for
 * a cycle that ran. Every amount, and every sentence naming one, sits under a `money` key (ad-spend money).
 *
 *   product  market + productId (a variation names its parent): the newest cycle (or the one of `day`) — its status, its
 *            change set, each step's outcome and why, the report and its plain-words summary — and the days before it
 *   market   market alone: each product's newest report there, in one line each (headline, waiting, clashes)
 *   none     no cycle stored: why (the cycle is off; the product is not enrolled; it has not run yet)
 */
import prisma from '../../../db.js'
import { strategyMarket } from '../ads-strategy/bids.js'
import { cycleMode, cycleOn } from './cycle-switch.js'
import { CYCLE_DAYS_KEPT, CYCLE_STEPS, readSteps, STEP_WORDS, type ProductReport } from './cycle.js'
import { productFamily } from './ownership.js'

/** How many earlier days a product's report lists beside the newest. */
export const REPORT_DAYS_LISTED = 14
const DAY = /^\d{4}-\d{2}-\d{2}$/

const switchWords = () => cycleOn()
  ? 'the product cycle is on (NEXUS_ADS_BRAIN_CYCLE=on): each enrolled product\'s levers run in order once per new settled data day, its stops every hour'
  : 'the product cycle is off (NEXUS_ADS_BRAIN_CYCLE): each lever runs on its own cron and no daily product report is written'

export async function brainReport(args: { market?: string; productId?: string; day?: string }): Promise<{ data: unknown } | { error: string }> {
  const market = args.market ? strategyMarket(args.market) : null
  if (args.market && (!market || !/^[A-Z]{2}$/.test(market))) return { error: `${args.market} is not a market code` }
  if (!market) return { error: 'name the market (market), and optionally a productId: view report reads one market' }
  if (args.day && !DAY.test(args.day)) return { error: `day is a data day written YYYY-MM-DD, not ${args.day}` }
  const head = { view: 'report', switch: cycleMode(), switchWhy: switchWords(), keptDays: CYCLE_DAYS_KEPT }
  if (args.productId) {
    if (!(await prisma.product.count({ where: { id: args.productId, deletedAt: null } }))) return { error: 'Product not found' }
    const family = await productFamily(args.productId)
    const productId = family?.root ?? args.productId
    const [enrolled, rows] = await Promise.all([
      prisma.adsBrainEnrollment.count({ where: { productId, marketplace: market } }),
      prisma.adsBrainCycle.findMany({
        where: { productId, marketplace: market, ...(args.day ? { dataDay: { lte: new Date(`${args.day}T00:00:00Z`) } } : {}) },
        orderBy: { dataDay: 'desc' }, take: REPORT_DAYS_LISTED + 1,
        select: { dataDay: true, changeSetId: true, status: true, attempts: true, steps: true, report: true, summary: true, finishedAt: true, updatedAt: true },
      }),
    ])
    const scope = { productId, market, ...(productId !== args.productId ? { askedFor: args.productId } : {}) }
    const shown = args.day ? rows.find((r) => r.dataDay.toISOString().slice(0, 10) === args.day) ?? null : rows[0] ?? null
    if (!shown) {
      const why = !enrolled ? 'the product is not enrolled in the brain in this market: no cycle runs for it'
        : !cycleOn() ? switchWords()
          : args.day ? `no cycle ran for data day ${args.day}`
            : 'no cycle has run for it yet: it runs at the first tick from 05:55 UTC on a new settled data day (at once for a product that never had one)'
      return { data: { ...head, scope, enrolled: !!enrolled, report: null, why, earlier: rows.slice(0, REPORT_DAYS_LISTED).map(dayLine) } }
    }
    const steps = readSteps(shown.steps)
    return {
      data: {
        ...head, scope, enrolled: !!enrolled,
        dataDay: shown.dataDay.toISOString().slice(0, 10), status: shown.status, attempts: shown.attempts, changeSetId: shown.changeSetId,
        finishedAt: shown.finishedAt?.toISOString() ?? null, updatedAt: shown.updatedAt.toISOString(),
        note: 'stored by the product cycle when its run ended (the hourly state passes add to "later"); every write of the cycle carries its change set in its evidence',
        steps: CYCLE_STEPS.map((s) => ({ step: s, title: STEP_WORDS[s], status: steps[s]?.status ?? 'not run', acts: !!steps[s]?.acts, why: steps[s]?.why ?? 'not run yet', runId: steps[s]?.runId ?? null })),
        summary: shown.summary,
        report: shown.report as unknown as ProductReport | null,
        earlier: rows.filter((r) => r !== shown).slice(0, REPORT_DAYS_LISTED).map(dayLine),
      },
    }
  }
  const rows = await prisma.adsBrainCycle.findMany({
    where: { marketplace: market, ...(args.day ? { dataDay: new Date(`${args.day}T00:00:00Z`) } : {}) },
    orderBy: [{ dataDay: 'desc' }, { productId: 'asc' }], take: 500,
    select: { productId: true, dataDay: true, changeSetId: true, status: true, report: true },
  })
  const newest = new Map<string, (typeof rows)[number]>()
  for (const r of rows) if (!newest.has(r.productId)) newest.set(r.productId, r)
  const products = [...newest.values()].map((r) => {
    const rep = r.report as unknown as ProductReport | null
    return {
      productId: r.productId, name: rep?.name ?? null, dataDay: r.dataDay.toISOString().slice(0, 10), status: r.status, changeSetId: r.changeSetId,
      headline: rep?.headline ?? null, waiting: rep?.waitsForOwner?.length ?? 0, clashes: rep?.clashes?.length ?? 0, problems: rep?.problems?.length ?? 0,
    }
  })
  return { data: { ...head, scope: { market }, products, ...(products.length ? {} : { why: cycleOn() ? 'no product cycle has run in this market yet' : switchWords() }) } }
}

function dayLine(r: { dataDay: Date; status: string; report: unknown }) {
  const rep = r.report as unknown as ProductReport | null
  return { dataDay: r.dataDay.toISOString().slice(0, 10), status: r.status, headline: rep?.headline ?? null }
}
