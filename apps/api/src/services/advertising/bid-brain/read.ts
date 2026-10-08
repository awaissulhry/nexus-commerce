/**
 * BID BRAIN BB-4 — what the brain says, for the `bid-brain` read tool. Nothing here writes.
 * BB-6 — a decision on a campaign the brain owns is LIVE (it was sent: `sent` says what became of it); the rest are
 * SHADOW. `owned` lists the campaigns the brain owns now; the diff counts the brain's own bid writes per day.
 *
 *   why      each keyword's newest decision with its one-line why (a keyword, a campaign, a product or a market)
 *   what-if  the same keywords decided again NOW with another target ACoS (and band): what the brain would set — not
 *            stored, not sent
 *   diff     per day: the brain against what today's writers set (agree, higher, lower, held by an override, braked)
 *            and, from the action log, conflicts (two automatic writers on one keyword within 24 hours) and churn
 *            (bid writes per keyword per day)
 *   calibration  BB-15 — the attribution lag curve per market (and per product with a curve of its own): the share of a
 *            day's final orders and sales a copy pulled at each age holds, what it rests on, and how well a curve fitted
 *            without the newest settled days nowcast them (mean absolute error per age, against no nowcast)
 *   hour-factors  BB-22 — per product and market, the learned hour factor of each hour of the week against the approved
 *            plan's, with its interval and confidence, what it would apply inside each cell's limits now, the top-of-search
 *            cap (hour-factors-read.ts)
 *   probes   BB-21 — the switchback probes of a scope (probe-store.ts readProbes): arms, days, what each measured, and ε
 *            per product from their readings
 */
import { Prisma } from '@prisma/client'
import prisma from '../../../db.js'
import { parseActor } from '../ads-changes.service.js'
import { strategyMarket } from '../ads-strategy/bids.js'
import { decide, type Decision } from './decide.js'
import { buildFacts } from './facts.js'
import { loadMarket, loadRun, SHADOW_MARKETS } from './load.js'
import { BRAIN_ACTOR, brainOwnedCampaignIds } from './live.js'
import { bidBrainMode } from './shadow.js'
import { CALIBRATION_DAYS, CURVE_MAX_AGE_DAYS, curveWords, MARKET_SCOPE, storedCurves, type StoredCurve } from './lag-curve-store.js'
import { LAG_AGES, MIN_MATURITY, NOWCAST_MAX_FACTOR } from './lag-curve.js'
import { YOUNG_SHARE_MAX } from './estimator.js'
import { nowcastMode, runForRows } from './nowcast.js'
import { readProbes } from './probe-store.js'

export const BRAIN_VIEWS = ['why', 'what-if', 'diff', 'calibration', 'hour-factors', 'probes'] as const
export type BrainView = (typeof BRAIN_VIEWS)[number]

export interface BrainReadArgs {
  view?: BrainView
  market?: string
  campaignId?: string
  targetId?: string
  productId?: string
  targetAcosPct?: number
  bandLoPct?: number
  bandHiPct?: number
  days?: number
  limit?: number
}

const pct = (x: unknown) => (x == null ? null : Math.round(Number(x) * 1000) / 10)
const DAY = 86_400_000
const SCHEDULE_WORDS = 'the shadow decides every 6 hours (at :50 UTC) for the allowlisted Sponsored Products campaigns of IT and DE'

/** The keywords of a scope (null: the whole market or every shadow market). */
async function scopeTargets(args: BrainReadArgs): Promise<{ ids: string[] | null; markets: string[]; error?: string }> {
  const marketsOf = (list: Array<string | null>) => [...new Set(list.map((m) => strategyMarket(m)).filter((m): m is string => !!m))]
  if (args.targetId) {
    const t = await prisma.adTarget.findUnique({ where: { id: args.targetId }, select: { id: true, adGroup: { select: { campaign: { select: { marketplace: true } } } } } })
    if (!t) return { ids: [], markets: [], error: `No keyword or target ${args.targetId} in this business.` }
    return { ids: [t.id], markets: marketsOf([t.adGroup.campaign.marketplace]) }
  }
  if (args.campaignId) {
    const c = await prisma.campaign.findUnique({ where: { id: args.campaignId }, select: { marketplace: true, adGroups: { select: { targets: { where: { isNegative: false }, select: { id: true } } } } } })
    if (!c) return { ids: [], markets: [], error: `No campaign ${args.campaignId} in this business.` }
    return { ids: c.adGroups.flatMap((g) => g.targets.map((t) => t.id)), markets: marketsOf([c.marketplace]) }
  }
  if (args.productId) {
    const ads = await prisma.adProductAd.findMany({
      where: { OR: [{ productId: args.productId }, { product: { parentId: args.productId } }] },
      select: { adGroup: { select: { campaign: { select: { marketplace: true } }, targets: { where: { isNegative: false }, select: { id: true } } } } },
    })
    return { ids: [...new Set(ads.flatMap((a) => a.adGroup.targets.map((t) => t.id)))], markets: marketsOf(ads.map((a) => a.adGroup.campaign.marketplace)) }
  }
  const market = args.market ? strategyMarket(args.market) : null
  return { ids: null, markets: market ? [market] : [...SHADOW_MARKETS] }
}

/** The keyword words for a list of ids: "race jacket (EXACT)". */
async function keywordWords(ids: readonly string[]): Promise<Map<string, { keyword: string; campaignId: string }>> {
  if (!ids.length) return new Map()
  const rows = await prisma.adTarget.findMany({ where: { id: { in: [...ids] } }, select: { id: true, expressionValue: true, expressionType: true, adGroup: { select: { campaignId: true } } } })
  return new Map(rows.map((r) => [r.id, { keyword: `${r.expressionValue} (${r.expressionType})`, campaignId: r.adGroup.campaignId }]))
}

async function whyView(args: BrainReadArgs) {
  const scope = await scopeTargets(args)
  if (scope.error) return { error: scope.error }
  const limit = Math.min(200, Math.max(1, args.limit ?? 50))
  const since = new Date(Date.now() - 30 * DAY)
  const marketFilter = scope.ids ? Prisma.empty : Prisma.sql`AND d.marketplace = ANY(${scope.markets}::text[])`
  const idFilter = scope.ids ? Prisma.sql`AND d."targetId" = ANY(${scope.ids}::text[])` : Prisma.empty
  const rows = scope.ids && !scope.ids.length ? [] : await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    SELECT * FROM (
      SELECT DISTINCT ON (d."targetId") d."targetId", d."campaignId", d.marketplace, d.action, d.layer, d."currentCents", d."decidedCents",
             d."goalBidCents", d.aim, d."bandLo", d."bandHi", d."expectedAcos", d.confidence, d."dataDay", d."createdAt", d."lastWriter", d.why,
             d.mode, d.evidence -> 'sent' AS sent
        FROM "BidBrainDecision" d
       WHERE d."createdAt" >= ${since} ${idFilter} ${marketFilter}
       ORDER BY d."targetId", d."createdAt" DESC) latest
     ORDER BY abs(latest."decidedCents" - latest."currentCents") DESC, latest."targetId"
     LIMIT ${limit}`)
  const words = await keywordWords(rows.map((r) => r.targetId as string))
  const decisions = rows.map((r) => ({
    targetId: r.targetId, keyword: words.get(r.targetId as string)?.keyword ?? null, campaignId: r.campaignId, market: r.marketplace,
    action: r.action, layer: r.layer, currentCents: r.currentCents, decidedCents: r.decidedCents, goalBidCents: r.goalBidCents,
    aimPct: pct(r.aim), bandLoPct: pct(r.bandLo), bandHiPct: pct(r.bandHi), expectedAcosPct: pct(r.expectedAcos),
    confidence: r.confidence == null ? null : Number(r.confidence), dataDay: (r.dataDay as Date).toISOString().slice(0, 10),
    decidedAt: (r.createdAt as Date).toISOString(), lastWriter: r.lastWriter, why: r.why,
    mode: r.mode, ...(r.sent ? { sent: r.sent } : {}),
  }))
  const owned = await ownedNow()
  const live = decisions.some((d) => d.mode === 'LIVE')
  return {
    data: {
      view: 'why', mode: bidBrainMode(), markets: scope.markets, owned, decisions,
      note: !decisions.length
        ? `No decision for this scope yet: ${SCHEDULE_WORDS}.`
        : live
          ? 'LIVE decisions were sent through the bid write path (sent says what became of each: queued, refused, deferred by the caps, would-apply under SUGGEST); SHADOW decisions are what the brain WOULD set, next to the bid today\'s writers set (currentCents).'
          : 'Shadow decisions: what the bid brain WOULD set, next to the bid today\'s writers set (currentCents). Nothing was sent.',
    },
  }
}

async function whatIfView(args: BrainReadArgs) {
  if (args.targetAcosPct == null && args.bandLoPct == null && args.bandHiPct == null) return { error: 'what-if needs targetAcosPct (and optionally bandLoPct / bandHiPct).' }
  const scope = await scopeTargets(args)
  if (scope.error) return { error: scope.error }
  const limit = Math.min(200, Math.max(1, args.limit ?? 50))
  const now = new Date()
  const wanted = scope.ids ? new Set(scope.ids) : null
  const out: Array<{ before: Decision; after: Decision; market: string }> = []
  for (const market of scope.markets.slice(0, 5)) {
    const rows = await loadMarket(market, { now })
    if (!rows.targets.length) continue
    // BB-15 follow-up — with the nowcast on, the step anchors as the run reads them (re-keyed to its data day).
    const run = runForRows(rows, (await loadRun(rows, now)).run)
    for (const f of buildFacts(rows, run)) {
      if (wanted && !wanted.has(f.targetId)) continue
      const goal = {
        ...f.goal,
        target: args.targetAcosPct != null ? { kind: 'ACOS' as const, pct: args.targetAcosPct } : f.goal.target,
        band: args.bandLoPct != null || args.bandHiPct != null ? { loPct: args.bandLoPct ?? null, hiPct: args.bandHiPct ?? null } : f.goal.band,
      }
      out.push({ market, before: decide(f), after: decide({ ...f, goal }) })
    }
  }
  out.sort((a, b) => Math.abs(b.after.bidCents - b.after.currentCents) - Math.abs(a.after.bidCents - a.after.currentCents))
  const shown = out.slice(0, limit)
  const words = await keywordWords(shown.map((o) => o.after.targetId))
  return {
    data: {
      view: 'what-if', mode: bidBrainMode(), markets: scope.markets,
      asked: { targetAcosPct: args.targetAcosPct ?? null, bandLoPct: args.bandLoPct ?? null, bandHiPct: args.bandHiPct ?? null },
      totals: { keywords: out.length, wouldRaise: out.filter((o) => o.after.bidCents > o.after.currentCents).length, wouldLower: out.filter((o) => o.after.bidCents < o.after.currentCents).length },
      decisions: shown.map(({ market, before, after }) => ({
        targetId: after.targetId, keyword: words.get(after.targetId)?.keyword ?? null, campaignId: words.get(after.targetId)?.campaignId ?? null, market,
        currentCents: after.currentCents, decidedCents: before.bidCents, whatIfCents: after.bidCents, whatIfAction: after.action, whatIfLayer: after.layer, why: after.why,
      })),
      note: 'A what-if: decided now with the target asked, from the same facts as the shadow. Not stored, nothing sent; the ads strategy is unchanged (set-ads-strategy changes it).',
    },
  }
}

/** Conflicts and churn per UTC day from the bid writes of these keywords. Pure. */
export function writeStats(writes: ReadonlyArray<{ entityId: string; userId: string | null; createdAt: Date }>): Map<string, { conflicts: number; writes: number; targetsWritten: number; maxWritesPerTarget: number }> {
  const byTarget = new Map<string, Array<{ actor: string | null; at: number }>>()
  for (const w of writes) byTarget.set(w.entityId, [...(byTarget.get(w.entityId) ?? []), { actor: w.userId, at: w.createdAt.getTime() }])
  const days = new Map<string, { conflicts: Set<string>; perTarget: Map<string, number> }>()
  const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10)
  for (const [target, list] of byTarget) {
    list.sort((a, b) => a.at - b.at)
    for (let i = 0; i < list.length; i++) {
      const d = dayOf(list[i].at)
      const entry = days.get(d) ?? { conflicts: new Set<string>(), perTarget: new Map<string, number>() }
      days.set(d, entry)
      entry.perTarget.set(target, (entry.perTarget.get(target) ?? 0) + 1)
      if (parseActor(list[i].actor).source !== 'automation') continue
      for (let j = i - 1; j >= 0 && list[i].at - list[j].at <= DAY; j--) {
        if (parseActor(list[j].actor).source === 'automation' && list[j].actor !== list[i].actor) { entry.conflicts.add(target); break }
      }
    }
  }
  return new Map([...days].map(([d, e]) => {
    const counts = [...e.perTarget.values()]
    return [d, { conflicts: e.conflicts.size, writes: counts.reduce((a, b) => a + b, 0), targetsWritten: counts.length, maxWritesPerTarget: counts.length ? Math.max(...counts) : 0 }]
  }))
}

/** BB-6 — the brain's own bid writes per UTC day (actor automation:bid-brain). Pure. */
export function brainWritesByDay(writes: ReadonlyArray<{ userId: string | null; createdAt: Date }>): Map<string, number> {
  const out = new Map<string, number>()
  for (const w of writes) {
    if (w.userId !== BRAIN_ACTOR) continue
    const day = w.createdAt.toISOString().slice(0, 10)
    out.set(day, (out.get(day) ?? 0) + 1)
  }
  return out
}

/** BB-6 — the campaigns the brain owns now (none under a non-live ceiling). */
async function ownedNow(): Promise<string[]> {
  return [...(await brainOwnedCampaignIds())].sort()
}

/** One decision against today's bid: agree (the brain leaves it), higher, lower, held by an override, braked. */
export function compareWord(d: { action: string; layer: string; currentCents: number; decidedCents: number }): 'agree' | 'higher' | 'lower' | 'hold' | 'brake' {
  if (d.action === 'brake') return 'brake'
  if (d.action === 'write') return d.decidedCents > d.currentCents ? 'higher' : 'lower'
  return d.layer === 'band' || d.layer === 'goal' ? 'agree' : 'hold'
}

async function diffView(args: BrainReadArgs) {
  const scope = await scopeTargets(args)
  if (scope.error) return { error: scope.error }
  const days = Math.min(30, Math.max(1, args.days ?? 7))
  const since = new Date(Date.now() - days * DAY)
  const marketFilter = scope.ids ? Prisma.empty : Prisma.sql`AND d.marketplace = ANY(${scope.markets}::text[])`
  const idFilter = scope.ids ? Prisma.sql`AND d."targetId" = ANY(${scope.ids}::text[])` : Prisma.empty
  const latest = scope.ids && !scope.ids.length ? [] : await prisma.$queryRaw<Array<{ targetId: string; day: string; action: string; layer: string; currentCents: number; decidedCents: number }>>(Prisma.sql`
    SELECT DISTINCT ON (d."targetId", d."createdAt"::date) d."targetId", to_char(d."createdAt"::date, 'YYYY-MM-DD') AS day,
           d.action, d.layer, d."currentCents", d."decidedCents"
      FROM "BidBrainDecision" d
     WHERE d."createdAt" >= ${since} ${idFilter} ${marketFilter}
     ORDER BY d."targetId", d."createdAt"::date, d."createdAt" DESC`)
  const targetIds = [...new Set(latest.map((r) => r.targetId))]
  const writes = targetIds.length ? await prisma.advertisingActionLog.findMany({
    where: { entityType: 'AD_TARGET', actionType: 'AD_BID_UPDATE', entityId: { in: targetIds }, createdAt: { gte: new Date(since.getTime() - DAY) } },
    select: { entityId: true, userId: true, createdAt: true },
  }) : []
  const stats = writeStats(writes)
  const byDay = new Map<string, { decided: number; agree: number; higher: number; lower: number; hold: number; brake: number }>()
  for (const r of latest) {
    const e = byDay.get(r.day) ?? { decided: 0, agree: 0, higher: 0, lower: 0, hold: 0, brake: 0 }
    e.decided++
    e[compareWord(r)]++
    byDay.set(r.day, e)
  }
  const dayList = [...new Set([...byDay.keys(), ...[...stats.keys()].filter((d) => d >= since.toISOString().slice(0, 10))])].sort().reverse()
  const brain = brainWritesByDay(writes)
  const rows = dayList.map((day) => ({ day, ...(byDay.get(day) ?? { decided: 0, agree: 0, higher: 0, lower: 0, hold: 0, brake: 0 }), ...(stats.get(day) ?? { conflicts: 0, writes: 0, targetsWritten: 0, maxWritesPerTarget: 0 }), brainWrites: brain.get(day) ?? 0 }))
  const owned = await ownedNow()
  return {
    data: {
      view: 'diff', mode: bidBrainMode(), markets: scope.markets, owned, days: rows,
      note: rows.length
        ? `Per UTC day, each keyword's last decision against the bid today's writers set: agree (the brain leaves it), higher / lower (the brain would move it), hold (a stop, pin, stock or other override decides), brake. conflicts: keywords two different automatic writers changed within 24 hours (the goal is 0); writes and maxWritesPerTarget: bid writes that day (churn); brainWrites: the brain's own (only on the campaigns it owns — ${owned.length ? `${owned.length} now` : 'none now, so it wrote nothing'}).`
        : `No decision in the last ${days} days: ${SCHEDULE_WORDS}.`,
    },
  }
}

/** BB-15 — one stored curve as the calibration view shows it (shares in percent, ages 0..14). Pure. */
export function curveView(c: StoredCurve, now: Date) {
  const p = (x: number) => Math.round(x * 1000) / 10
  const ageDays = Math.floor((now.getTime() - c.fittedAt.getTime()) / DAY)
  const seed = c.basis?.seed
  return {
    scope: c.scopeId === MARKET_SCOPE ? 'market' : 'product',
    ...(c.scopeId === MARKET_SCOPE ? {} : { productId: c.scopeId }),
    words: curveWords(c),
    source: c.source,
    usable: c.usable,
    fittedAt: c.fittedAt.toISOString(),
    stale: ageDays > CURVE_MAX_AGE_DAYS,
    sharesPct: {
      ages: Array.from({ length: LAG_AGES }, (_, a) => a),
      orders: c.shares.orders.map(p),
      sales: c.shares.sales.map(p),
    },
    basis: {
      vintageDays: c.basis?.vintageDays ?? 0,
      campaignDays: c.basis?.campaignDays ?? 0,
      finalOrders: c.basis?.finalOrders ?? 0,
      seed: seed ? { ordersSharePct: p(seed.ordersShare), salesSharePct: p(seed.salesShare), days: seed.days, orders7d: seed.orders7d } : null,
      pooledToward: c.basis?.priorFrom ?? 'prior',
      priorOrders: c.basis?.priorOrders ?? 0,
    },
    calibration: c.calibration,
  }
}

/** The product family of a product (a variation's parent), or the product itself. */
async function familyOf(productId: string): Promise<string | null> {
  const p = await prisma.product.findUnique({ where: { id: productId }, select: { id: true, parentId: true } })
  return p ? p.parentId ?? p.id : null
}

async function calibrationView(args: BrainReadArgs) {
  const scope = await scopeTargets(args)
  if (scope.error) return { error: scope.error }
  const now = new Date()
  const curves = await storedCurves(scope.markets)
  const family = args.productId ? await familyOf(args.productId) : null
  const markets = scope.markets.map((market) => {
    const own = curves.find((c) => c.market === market && c.scopeId === MARKET_SCOPE)
    const products = curves.filter((c) => c.market === market && c.scopeId !== MARKET_SCOPE && (!family || c.scopeId === family))
    return {
      market,
      curve: own ? curveView(own, now) : null,
      products: products.map((c) => curveView(c, now)),
      ...(!own ? { missing: 'no curve fitted for this market yet (the nightly fit has not run, or there are no Sponsored Products vintages and settled rows): the nowcast ignores young days here' } : {}),
      ...(family && own && !products.length ? { productNote: `product ${family} has no curve of its own (too few final orders behind it): its keywords read the market's curve` } : {}),
    }
  })
  const mode = nowcastMode()
  return {
    data: {
      view: 'calibration', mode: bidBrainMode(), nowcast: mode, markets,
      note: `L(a) is the share of a day's final 7-day orders (and sales) that a copy of the day pulled at age a days already holds (age 0 = asked the morning after). `
        + `It is fitted each night from the kept copies of every campaign day (seeded from the settled 1-day ÷ 7-day ratio, pooled to the market for a product with few orders), monotone and at most 100 %. `
        + `Calibration: a curve fitted WITHOUT the newest ${CALIBRATION_DAYS} settled days nowcasts each of them from its young copies (copy ÷ L(a)); maeOrders is the mean absolute error in orders per day, maeOrdersRaw the error of reading the young copy as final (no nowcast); errorPct and salesErrorPct are Σ|error| ÷ Σ final. `
        + `The brain's nowcast (NEXUS_BID_BRAIN_NOWCAST: ${mode}${mode === 'shadow' ? ' — decisions stay on settled days; differences are written in the why' : mode === 'on' ? ' — decisions use it' : ' — not computed'}) weights every keyword-day by L(the age its copy was pulled at): its clicks count L(a), its orders as observed, `
        + `a copy below ${Math.round(MIN_MATURITY * 100)} % is left out (its numbers would be multiplied by more than ${NOWCAST_MAX_FACTOR}), and the days newer than the settled window carry at most ${Math.round(YOUNG_SHARE_MAX * 100)} % of a keyword's clicks. `
        + 'A curve that is not usable (only the prior) or older than two weeks is not used: young days are then ignored, as before.',
    },
  }
}

export async function readBidBrain(args: BrainReadArgs): Promise<{ data: unknown } | { error: string }> {
  const view = args.view ?? 'why'
  if (view === 'what-if') return whatIfView(args)
  if (view === 'diff') return diffView(args)
  if (view === 'calibration') return calibrationView(args)
  if (view === 'hour-factors') return (await import('./hour-factors-read.js')).hourFactorsView(args)
  if (view === 'probes') {
    const scope = await scopeTargets(args)
    return scope.error ? { error: scope.error } : readProbes(scope, { limit: args.limit })
  }
  return whyView(args)
}
