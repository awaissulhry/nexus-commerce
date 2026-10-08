/**
 * BID BRAIN BB-22 — the bid-brain read tool's `hour-factors` view: per product and market, the learned hour factor of each
 * hour of the week against the factor the approved plan paints there, with its 90 % interval and confidence, what the
 * learned factor would apply inside each cell's limits now (the Owner's locks and hourCellMovePct read now), the
 * top-of-search cap, and the findings in words. Nothing here writes: a product with no stored learning is learned now
 * (stored nowhere) when it is asked for by id.
 */
import prisma from '../../../db.js'
import { strategyMarket } from '../ads-strategy/bids.js'
import { cellRef, hourKey } from '../brain/hours-research.js'
import { productFamily } from '../brain/ownership.js'
import {
  cellMove, hourFactorMode, HIGH_CONFIDENCE_RATIO, LOW_CONFIDENCE_RATIO, MIN_FACTOR_MOVE, planTargets, type LearnedHourFactors,
} from './hour-factors.js'
import { goalSchedules, learnProduct, scheduleBasis, storedHourFactors, LEARN_EVERY_HOURS, type StoredHourFactors } from './hour-factors-store.js'
import { SHADOW_MARKETS } from './load.js'
import type { LaneName } from './recipe.js'

/** Monday first, as a person reads a week. */
const WEEK = [1, 2, 3, 4, 5, 6, 0] as const
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const r2 = (x: number | null | undefined) => (x == null ? null : Math.round(x * 100) / 100)

/** H (high), M (medium), L (low: too uncertain to move) from an interval's ratio. Pure. */
export function confidenceLetter(lo: number | null | undefined, hi: number | null | undefined): 'H' | 'M' | 'L' | '.' {
  if (lo == null || hi == null || !(lo > 0)) return '.'
  const ratio = hi / lo
  return ratio <= HIGH_CONFIDENCE_RATIO ? 'H' : ratio <= LOW_CONFIDENCE_RATIO ? 'M' : 'L'
}

interface Args { market?: string; productId?: string; campaignId?: string; limit?: number }

async function planView(f: LearnedHourFactors, market: string, now: Date) {
  const ids = f.plans.map((p) => p.campaignId)
  const [schedules, names, library] = await Promise.all([
    goalSchedules(ids),
    prisma.campaign.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }).then((rows) => new Map(rows.map((r) => [r.id, r.name]))),
    (async () => {
      const [{ toSpec, applyTargetOverrides }, { paintTargetOf, loadSettings, hoursSettingsOf }] = await Promise.all([import('../../../jobs/ad-rank-defend.job.js'), import('../brain/hours-proposal.js')])
      const rows = await prisma.rankTarget.findMany({ orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }] })
      const settings = await loadSettings(f.productId, market, ids.map((campaignId) => ({ campaignId, name: campaignId })))
      return { rows, toSpec, applyTargetOverrides, paintTargetOf, hours: hoursSettingsOf(settings.product, settings.members) }
    })(),
  ])
  const movePct = library.hours.hourCellMovePct
  return f.plans.map((p) => {
    const s = schedules.get(p.campaignId)
    const stale = !s ? 'its plan no longer runs (no goal-mode schedule)' : s.id !== p.scheduleId || scheduleBasis(s) !== p.basis ? 'its plan changed since the factors were learned: they are learned again at the next full run' : null
    const targets = new Map(library.rows.map((r) => {
      const spec = library.applyTargetOverrides(library.toSpec(r as never), (s?.targetOverrides ?? {}) as never)
      return [spec.key, library.paintTargetOf(spec as never, r.name)]
    }))
    const week = s ? planTargets(s, targets) : null
    const days = WEEK.map((d) => {
      const painted: Array<number | null> = []
      const asks: Array<number | null> = []
      const applied: Array<number | null> = []
      let marks = ''
      for (let h = 0; h < 24; h++) {
        const k = hourKey(d, h)
        const t = week?.[d][h] ?? null
        const lanes = t && !t.floor ? (Object.entries(t.lanes) as Array<[LaneName, number]>).map(([lane, pct]) => ({ lane, pct })) : []
        const move = cellMove({
          d, h, lanes, floor: !!t?.floor, noTarget: !t, locked: library.hours.level === 'LOCKED' || library.hours.cells.has(cellRef(d, h)), stale,
          rho: p.rho[k], rhoLo: p.rhoLo[k], rhoHi: p.rhoHi[k], learned: f.curves.f[k], painted: p.painted[k], movePct, tosCapPct: f.tos?.capPct ?? null, tosRatio: f.tos?.ratio ?? null,
        })
        painted.push(r2(p.painted[k]))
        asks.push(r2(p.rho[k]))
        applied.push(move.status === 'moved' ? r2(move.scale) : move.status === 'min_bid' || move.status === 'no_target' ? null : 1)
        marks += move.status === 'moved' ? '^' : move.status === 'locked' ? '#' : move.status === 'min_bid' ? 'm' : move.status === 'no_target' ? '.' : move.status === 'uncertain' ? '?' : ' '
      }
      return { day: DAYS[d], painted, asks, applied, marks }
    })
    const moved = days.reduce((n, x) => n + [...x.marks].filter((c) => c === '^').length, 0)
    return { campaignId: p.campaignId, name: names.get(p.campaignId) ?? null, scheduleId: p.scheduleId, ...(stale ? { stale } : {}), hoursMoved: moved, days }
  })
}

function curvesView(f: LearnedHourFactors) {
  return WEEK.map((d) => ({
    day: DAYS[d],
    learned: Array.from({ length: 24 }, (_, h) => r2(f.curves.f[hourKey(d, h)])),
    lo: Array.from({ length: 24 }, (_, h) => r2(f.curves.lo[hourKey(d, h)])),
    hi: Array.from({ length: 24 }, (_, h) => r2(f.curves.hi[hourKey(d, h)])),
    conversion: Array.from({ length: 24 }, (_, h) => r2(f.curves.cr[hourKey(d, h)])),
    costPerBid: Array.from({ length: 24 }, (_, h) => r2(f.curves.r[hourKey(d, h)])),
    confidence: Array.from({ length: 24 }, (_, h) => confidenceLetter(f.curves.lo[hourKey(d, h)], f.curves.hi[hourKey(d, h)])).join(''),
  }))
}

async function rowView(row: StoredHourFactors | (StoredHourFactors & { decidedNow: true }), now: Date) {
  const f = row.factors
  return {
    productId: row.productId, market: row.market, learnedAt: row.learnedAt.toISOString(), decidedNow: 'decidedNow' in row,
    timeZone: f.timeZone, window: f.window, leftOut: f.leftOut, confidence: f.confidence, evidence: f.evidence, summary: f.summary,
    laneShares: f.shares,
    topOfSearch: f.tos ? { ratio: f.tos.ratio, lo: f.tos.lo, hi: f.tos.hi, ownOrders: f.tos.orders, marketRatio: f.tos.marketRatio, capPct: f.tos.capPct } : null,
    week: curvesView(f),
    plans: await planView(f, row.market, now),
  }
}

/** The `hour-factors` view of the bid-brain read tool. */
export async function hourFactorsView(args: Args, now: Date = new Date()): Promise<{ data: unknown } | { error: string }> {
  const limit = Math.min(20, Math.max(1, args.limit ?? 5))
  let markets: string[]
  let productId: string | null = null
  let campaignId: string | null = null
  if (args.campaignId) {
    const c = await prisma.campaign.findUnique({ where: { id: args.campaignId }, select: { marketplace: true } })
    if (!c) return { error: `No campaign ${args.campaignId} in this business.` }
    const m = strategyMarket(c.marketplace)
    if (!m) return { error: `Campaign ${args.campaignId} has no known market.` }
    markets = [m]
    campaignId = args.campaignId
  } else markets = args.market ? [strategyMarket(args.market) ?? args.market] : [...SHADOW_MARKETS]
  if (args.productId) {
    const fam = await productFamily(args.productId)
    if (!fam) return { error: `No product ${args.productId} in this business.` }
    productId = fam.root
  }
  const rows: Array<Awaited<ReturnType<typeof rowView>>> = []
  const notLearned: Array<{ market: string; why: string }> = []
  for (const market of markets) {
    const stored = await storedHourFactors(market, { ...(campaignId ? { campaignIds: [campaignId] } : {}), ...(productId ? { productId } : {}) })
    for (const s of stored.slice(0, limit - rows.length)) rows.push(await rowView(s, now))
    // A product asked for by id with nothing stored: learned now, stored nowhere (a dry run of the next full run).
    if (productId && !stored.length && !campaignId) {
      const out = await learnProduct(productId, market, now)
      if ('held' in out) notLearned.push({ market, why: out.held })
      else rows.push(await rowView({ productId: out.learned.productId, market, campaignIds: out.campaignIds, learnedAt: now, factors: out.learned, decidedNow: true }, now))
    }
    if (rows.length >= limit) break
  }
  const mode = hourFactorMode()
  return {
    data: {
      view: 'hour-factors', mode, markets, products: rows, ...(notLearned.length ? { notLearned } : {}),
      note: `Per hour of the week (Monday first, the plan's time zone): learned = the bid that keeps the ACoS aim in that hour relative to the week `
        + '(the product\'s pooled conversion ÷ what a click costs per unit of bid there; mean 1), lo / hi its 90 % interval, confidence H / M / L '
        + `(L: too uncertain to move); painted = the approved plan's own factor there (1 + placement %, lanes weighted by spend, mean 1 over its serving hours); `
        + 'asks = learned ÷ painted, the move the learned factor asks of the cell; applied = what it does inside the cell\'s limits: never above the approved '
        + `cell, at most hourCellMovePct below it, a move under ${Math.round(MIN_FACTOR_MOVE * 100)} % is none; marks: ^ moved, # locked by the Owner, m Min-bid hour (stays), . no target, ? too uncertain. `
        + 'The keyword bids stay the goal\'s day level; the move lands on the placement lanes the cell declares, and top of search is held under its conversion cap. '
        + `Learned once a day in the bid brain's full run (again after a plan changes; ${LEARN_EVERY_HOURS} h), from the hourly feed's 1-day conversions for the shape, `
        + `the days a dated event replaced the week and the days the feed was capped left out. NEXUS_BID_BRAIN_HOUR_FACTORS is ${mode}: `
        + (mode === 'off' ? 'nothing is learned or applied.'
          : mode === 'shadow' ? 'the moves are only said in the why of the brain\'s decisions; the plan runs exactly as approved.'
            : 'the moves run where the product\'s brain owns the hours lever (PROPOSE) and its kill switch is off; elsewhere they are said in the why.'),
    },
  }
}
