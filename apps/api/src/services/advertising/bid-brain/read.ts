/**
 * BID BRAIN BB-4 — what the shadow brain says, for the `bid-brain` read tool. Nothing here writes.
 *
 *   why      each keyword's newest decision with its one-line why (a keyword, a campaign, a product or a market)
 *   what-if  the same keywords decided again NOW with another target ACoS (and band): what the brain would set — not
 *            stored, not sent
 *   diff     per day: the brain against what today's writers set (agree, higher, lower, held by an override, braked)
 *            and, from the action log, conflicts (two automatic writers on one keyword within 24 hours) and churn
 *            (bid writes per keyword per day)
 */
import { Prisma } from '@prisma/client'
import prisma from '../../../db.js'
import { parseActor } from '../ads-changes.service.js'
import { strategyMarket } from '../ads-strategy/bids.js'
import { decide, type Decision } from './decide.js'
import { buildFacts } from './facts.js'
import { loadMarket, loadRun, SHADOW_MARKETS } from './load.js'
import { bidBrainMode } from './shadow.js'

export const BRAIN_VIEWS = ['why', 'what-if', 'diff'] as const
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
             d."goalBidCents", d.aim, d."bandLo", d."bandHi", d."expectedAcos", d.confidence, d."dataDay", d."createdAt", d."lastWriter", d.why
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
  }))
  return {
    data: {
      view: 'why', mode: bidBrainMode(), markets: scope.markets, decisions,
      note: decisions.length
        ? 'Shadow decisions: what the bid brain WOULD set, next to the bid today\'s writers set (currentCents). Nothing was sent.'
        : `No shadow decision for this scope yet: ${SCHEDULE_WORDS}.`,
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
    const { run } = await loadRun(rows, now)
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
  const rows = dayList.map((day) => ({ day, ...(byDay.get(day) ?? { decided: 0, agree: 0, higher: 0, lower: 0, hold: 0, brake: 0 }), ...(stats.get(day) ?? { conflicts: 0, writes: 0, targetsWritten: 0, maxWritesPerTarget: 0 }) }))
  return {
    data: {
      view: 'diff', mode: bidBrainMode(), markets: scope.markets, days: rows,
      note: rows.length
        ? 'Per UTC day, each keyword\'s last shadow decision against the bid today\'s writers set: agree (the brain leaves it), higher / lower (the brain would move it), hold (a stop, pin, stock or other override decides), brake. conflicts: keywords two different automatic writers changed within 24 hours (the goal is 0); writes and maxWritesPerTarget: bid writes that day (churn). The brain itself wrote nothing.'
        : `No shadow decision in the last ${days} days: ${SCHEDULE_WORDS}.`,
    },
  }
}

export async function readBidBrain(args: BrainReadArgs): Promise<{ data: unknown } | { error: string }> {
  const view = args.view ?? 'why'
  if (view === 'what-if') return whatIfView(args)
  if (view === 'diff') return diffView(args)
  return whyView(args)
}
