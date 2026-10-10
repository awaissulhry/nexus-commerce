/**
 * BID BRAIN BB-19 / BB-20 — the response (response.ts) and exploration (explore.ts) beside a run's decisions: what they
 * read, and the words, evidence and run line they add. The response changes no decision: the stored why gains
 * " · profit-best …", `evidence.response` keeps the numbers, the run's line counts them. Exploration plans the day's
 * explore and revive bids in the same way, and only with NEXUS_BID_BRAIN_EXPLORE=on are the picked decisions replaced.
 * A failure is logged and changes nothing — the goal's decisions stand.
 *
 *   moves      CampaignBidHistory of the market's keywords over the settled window: serving moves (both sides ≥ the 5¢
 *              engine floor) of ≥ 10 % with no other move of the keyword within 3 days either side — found in SQL with
 *              LAG / LEAD, so only those cross the wire; then the clicks (rows with clicks only) and the move days of
 *              their ad groups' keywords around them, for the matched days and the control (response.ts moveEventsOf)
 *   signals    per decided campaign: the top-of-search impression share of the last 14 settled days (the placement
 *              report's TOP rows — the copy on the daily rows was abandoned on 2026-08-19 — weighted by impressions) and
 *              the days of the last 7 settled whose spend reached 95 % of that day's budget (campaign rows)
 *   activity   BB-20, per keyword, in one grouped read: impressions and clicks of the last 14 days and impressions of the
 *              last 90 to yesterday (they need no attribution wait), orders of the 90 settled days; its newest revive
 *              memory (evidence.revive of the decisions kept, 30 days); its last bid write (the run's); the shortest
 *              stock cover of its ad group's products (ads-stock-risk.service.ts, read for the candidates only, with a
 *              14-day line); the market's explore budget (the strategy's market row, else the Owner's default)
 *   plan       made over the WHOLE market's keywords (a product cycle's run and the full run make the same one), applied
 *              to the run's own: the picks of all runs of a day never add up past the budget
 *   probes     BB-21 (probe.ts, probe-store.ts) — the switchback probes' ledger, read once: the DONE live probes' readings
 *              join each product's ε (productEps), the running probes are stepped, measured and planned over the run's own
 *              keywords after exploration; under NEXUS_BID_BRAIN_PROBES=on a LIVE probe's arm is the decision, and the
 *              keywords in a LIVE probe are not explored (their bids are the probe's)
 *
 * Called inside a business (the run's): row-level security keeps each to its own rows.
 */
import { Prisma } from '@prisma/client'
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { decide, type Decision, type TargetFacts } from './decide.js'
import { MAX_WINDOW_DAYS } from './estimator.js'
import type { AdGroupRow, TargetRow } from './facts.js'
import { ENGINE_FLOOR_CENTS } from './recipe.js'
import {
  CAPPED_SPEND_SHARE, CAPPED_WINDOW_DAYS, MOVE_MAX_DAYS, MOVE_MIN_DAYS, MOVE_MIN_SHARE, TOS_WINDOW_DAYS,
  moveEventsOf, moveReading, productEps, responseFor, responseMode, summarizeResponse,
  type CampaignSignal, type EpsPosterior, type MoveEvent, type ResponseNote, type ResponseSummary,
} from './response.js'
import {
  DEFAULT_EPS, MIN_COVER_DAYS, REVIVE_QUIET_DAYS, applyExplore, exploreBudgetOf, exploreExclusion, exploreMode, exploreOption,
  exploreWords, planExplore, summarizeExplore, type ExploreSummary, type ReviveMemory, type TargetActivity,
} from './explore.js'
import { readStockAdGroups } from '../ads-stock-risk.service.js'
import { openStrategy } from '../ads-strategy/effective.js'
import { probeMode, type ProbeSummary } from './probe.js'
import { loadProbeLedger, loadProbeReadings, probesShadow, type LoadedLedger } from './probe-store.js'
import type { EpsReading } from './response.js'

const DAY_MS = 86_400_000
const isoDay = (d: Date) => d.toISOString().slice(0, 10)
const dayOf = (s: string) => new Date(`${s}T00:00:00Z`)
const shift = (s: string, n: number) => isoDay(new Date(dayOf(s).getTime() + n * DAY_MS))
/** The product key of an ad group, as facts.ts pools it (its families, sorted and joined); null: none known. */
const productKeyOf = (g: Pick<AdGroupRow, 'families'> | undefined) => (g?.families.length ? g.families.join('|') : null)

/** The market's clean bid moves as events (response.ts), over the settled window ending on `dataDay`. */
export async function loadMoveEvents(m: { dataDay: string; targets: readonly TargetRow[]; adGroups: ReadonlyMap<string, AdGroupRow> }): Promise<MoveEvent[]> {
  if (!m.targets.length) return []
  const until = m.dataDay
  const since = shift(until, -(MAX_WINDOW_DAYS - 1))
  const ids = m.targets.map((t) => t.id)
  const found = await prisma.$queryRaw<Array<{ id: string; day: string; old: number; new: number; prev: string | null; next: string | null }>>(Prisma.sql`
    SELECT m.id, to_char(m.at, 'YYYY-MM-DD') AS day, m.old, m.new,
           to_char(m.prev_at, 'YYYY-MM-DD') AS prev, to_char(m.next_at, 'YYYY-MM-DD') AS next
      FROM (SELECT h."entityId" AS id, h."changedAt" AS at,
                   CASE WHEN h."oldValue" ~ '^[0-9]{1,6}$' THEN h."oldValue"::int END AS old,
                   CASE WHEN h."newValue" ~ '^[0-9]{1,6}$' THEN h."newValue"::int END AS new,
                   LAG(h."changedAt") OVER w AS prev_at, LEAD(h."changedAt") OVER w AS next_at
              FROM "CampaignBidHistory" h
             WHERE h."entityType" = 'AD_TARGET' AND h.field = 'bid' AND h."entityId" = ANY(${ids}::text[])
               AND h."changedAt" >= ${dayOf(shift(since, -(MOVE_MAX_DAYS + 1)))} AND h."changedAt" < ${dayOf(shift(until, MOVE_MAX_DAYS + 2))}
            WINDOW w AS (PARTITION BY h."entityId" ORDER BY h."changedAt")) m
     WHERE m.at >= ${dayOf(since)} AND m.at < ${dayOf(shift(until, 1))}
       AND m.old >= ${ENGINE_FLOOR_CENTS}::int AND m.new >= ${ENGINE_FLOOR_CENTS}::int
       AND abs(ln(m.new::float8 / m.old::float8)) >= ${Math.log(1 + MOVE_MIN_SHARE) - 1e-9}::float8
       AND (m.prev_at IS NULL OR m.at::date - m.prev_at::date > ${MOVE_MIN_DAYS}::int)
       AND (m.next_at IS NULL OR m.next_at::date - m.at::date > ${MOVE_MIN_DAYS}::int)`)
  if (!found.length) return []
  const groupOf = new Map(m.targets.map((t) => [t.id, t.adGroupId]))
  const groups = new Map<string, string[]>()
  for (const t of m.targets) groups.set(t.adGroupId, [...(groups.get(t.adGroupId) ?? []), t.id])
  const wanted = [...new Set(found.map((c) => groupOf.get(c.id)).filter((g): g is string => !!g))].flatMap((g) => groups.get(g) ?? [])
  const days = found.map((c) => c.day).sort()
  const from = shift(days[0], -(MOVE_MAX_DAYS + 1))
  const to = shift(days[days.length - 1], MOVE_MAX_DAYS + 1)
  const [clickRows, movedRows] = await Promise.all([
    prisma.$queryRaw<Array<{ id: string; day: string; clicks: number }>>(Prisma.sql`
      SELECT p."localEntityId" AS id, to_char(p.date, 'YYYY-MM-DD') AS day, SUM(p.clicks)::int AS clicks
        FROM "AmazonAdsDailyPerformance" p
       WHERE p."entityType" = 'AD_TARGET' AND p."adProduct" = 'SPONSORED_PRODUCTS' AND p."localEntityId" = ANY(${wanted}::text[])
         AND p.clicks > 0 AND p.date BETWEEN ${from}::date AND ${to}::date
       GROUP BY 1, 2`),
    prisma.$queryRaw<Array<{ id: string; day: string }>>(Prisma.sql`
      SELECT DISTINCT h."entityId" AS id, to_char(h."changedAt", 'YYYY-MM-DD') AS day
        FROM "CampaignBidHistory" h
       WHERE h."entityType" = 'AD_TARGET' AND h.field = 'bid' AND h."entityId" = ANY(${wanted}::text[])
         AND h."changedAt" >= ${dayOf(from)} AND h."changedAt" < ${dayOf(shift(to, 1))}`),
  ])
  const clicks = new Map<string, Map<string, number>>()
  for (const r of clickRows) clicks.set(r.id, (clicks.get(r.id) ?? new Map()).set(r.day, Number(r.clicks)))
  const moved = new Map<string, Set<string>>()
  for (const r of movedRows) moved.set(r.id, (moved.get(r.id) ?? new Set()).add(r.day))
  return moveEventsOf(
    found.map((c) => ({ targetId: c.id, adGroupId: groupOf.get(c.id) ?? '', day: c.day, fromCents: Number(c.old), toCents: Number(c.new), prevDay: c.prev, nextDay: c.next })),
    clicks, moved, groups, (adGroupId) => productKeyOf(m.adGroups.get(adGroupId)), { since, until },
  )
}

/**
 * Per campaign: its top-of-search IS (Amazon's, per campaign and day) impression-weighted over the last 14 settled days,
 * the days of them that carry a reading (A5: under 7, it leans nothing), and its budget-capped days of the last 7.
 */
export async function loadCampaignSignals(campaignIds: readonly string[], dataDay: string): Promise<Map<string, CampaignSignal>> {
  const out = new Map<string, CampaignSignal>()
  if (!campaignIds.length) return out
  const ids = [...campaignIds]
  const [tos, capped] = await Promise.all([
    prisma.$queryRaw<Array<{ id: string; share: number | null; days: number }>>(Prisma.sql`
      SELECT c.id,
             COALESCE(SUM(p."topOfSearchIS"::float8 * p.impressions) / NULLIF(SUM(p.impressions), 0), AVG(p."topOfSearchIS"::float8))::float8 AS share,
             COUNT(DISTINCT p.date)::int AS days
        FROM "AmazonAdsPlacementReport" p
        JOIN "Campaign" c ON c."externalCampaignId" = p."campaignId"
       WHERE c.id = ANY(${ids}::text[]) AND p."topOfSearchIS" IS NOT NULL
         AND p.date BETWEEN ${shift(dataDay, -(TOS_WINDOW_DAYS - 1))}::date AND ${dataDay}::date
       GROUP BY c.id`),
    prisma.$queryRaw<Array<{ id: string; capped: number }>>(Prisma.sql`
      SELECT d."localEntityId" AS id,
             COUNT(DISTINCT d.date) FILTER (WHERE d."campaignBudgetCents" > 0 AND d."costMicros"::float8 / 10000 >= ${CAPPED_SPEND_SHARE}::float8 * d."campaignBudgetCents")::int AS capped
        FROM "AmazonAdsDailyPerformance" d
       WHERE d."entityType" = 'CAMPAIGN' AND d."adProduct" = 'SPONSORED_PRODUCTS' AND d."localEntityId" = ANY(${ids}::text[])
         AND d.date BETWEEN ${shift(dataDay, -(CAPPED_WINDOW_DAYS - 1))}::date AND ${dataDay}::date
       GROUP BY d."localEntityId"`),
  ])
  const signal = (id: string): CampaignSignal => out.get(id) ?? { tosShare: null, tosDays: 0, cappedDays: 0 }
  for (const r of tos) out.set(r.id, { ...signal(r.id), tosShare: r.share != null ? Number(r.share) : null, tosDays: Number(r.days) })
  for (const r of capped) out.set(r.id, { ...signal(r.id), cappedDays: Number(r.capped) })
  return out
}

/** What the response adds to one run: per keyword its note, the market's summary, and each keyword's ε. */
export interface ResponseShadow {
  notes: Map<string, ResponseNote>
  summary: ResponseSummary
  eps: Map<string, number>
  /** BB-21 — each product's ε as found, and the campaigns' signals (the probes' plan reads them). */
  posteriors?: Map<string | null, EpsPosterior>
  signals?: Map<string, CampaignSignal>
}

/**
 * BB-19 — the response of a run's keywords: each product's ε from the market's moves, each keyword's profit-best bid
 * beside its goal bid. Pure past the two reads.
 */
export async function responseShadow(
  m: { dataDay: string; targets: readonly TargetRow[]; adGroups: ReadonlyMap<string, AdGroupRow> },
  facts: readonly TargetFacts[], decisions: readonly Decision[], campaignOf: (targetId: string) => string,
  /** BB-21 — the DONE live probes' readings per product (none: the moves alone, as before). */
  probeReadings?: ReadonlyMap<string | null, readonly EpsReading[]>,
): Promise<ResponseShadow> {
  const campaignIds = [...new Set(facts.map((f) => campaignOf(f.targetId)).filter(Boolean))]
  const [events, signals] = await Promise.all([loadMoveEvents(m), loadCampaignSignals(campaignIds, m.dataDay)])
  const byProduct = new Map<string | null, MoveEvent[]>()
  for (const e of events) byProduct.set(e.productKey, [...(byProduct.get(e.productKey) ?? []), e])
  const groupOf = new Map(m.targets.map((t) => [t.id, t.adGroupId]))
  const products = new Map<string | null, EpsPosterior>()
  const notes = new Map<string, ResponseNote>()
  const eps = new Map<string, number>()
  facts.forEach((f, i) => {
    const key = productKeyOf(m.adGroups.get(groupOf.get(f.targetId) ?? ''))
    let product = products.get(key)
    if (!product) { product = productEps(byProduct, key, undefined, probeReadings); products.set(key, product) }
    const note = responseFor(f, decisions[i], product, signals.get(campaignOf(f.targetId)))
    if (!note) return
    notes.set(f.targetId, note)
    eps.set(f.targetId, note.eps)
  })
  return { notes, summary: summarizeResponse([...notes.values()], events.filter((e) => moveReading(e)).length), eps, posteriors: products, signals }
}

// ── BB-20 — exploration and revive ────────────────────────────────────────────────────────────────

/** Per keyword: impressions and clicks to yesterday, orders of the settled window (explore.ts TargetActivity). */
export async function loadActivity(targetIds: readonly string[], opts: { now: Date; dataDay: string }): Promise<Map<string, TargetActivity>> {
  const out = new Map<string, TargetActivity>()
  if (!targetIds.length) return out
  const yesterday = isoDay(new Date(Date.UTC(opts.now.getUTCFullYear(), opts.now.getUTCMonth(), opts.now.getUTCDate()) - DAY_MS))
  const since = shift(opts.dataDay, -(MAX_WINDOW_DAYS - 1))
  const from = [since, shift(yesterday, -89)].sort()[0]
  const rows = await prisma.$queryRaw<Array<{ id: string; imp14: number; imp90: number; clicks14: number; orders90: number }>>(Prisma.sql`
    SELECT p."localEntityId" AS id,
           SUM(CASE WHEN p.date > ${shift(yesterday, -REVIVE_QUIET_DAYS)}::date AND p.date <= ${yesterday}::date THEN p.impressions ELSE 0 END)::float8 AS imp14,
           SUM(CASE WHEN p.date > ${shift(yesterday, -90)}::date AND p.date <= ${yesterday}::date THEN p.impressions ELSE 0 END)::float8 AS imp90,
           SUM(CASE WHEN p.date > ${shift(yesterday, -REVIVE_QUIET_DAYS)}::date AND p.date <= ${yesterday}::date THEN p.clicks ELSE 0 END)::float8 AS clicks14,
           SUM(CASE WHEN p.date BETWEEN ${since}::date AND ${opts.dataDay}::date THEN COALESCE(p."orders7d", 0) ELSE 0 END)::float8 AS orders90
      FROM "AmazonAdsDailyPerformance" p
     WHERE p."entityType" = 'AD_TARGET' AND p."adProduct" = 'SPONSORED_PRODUCTS' AND p."localEntityId" = ANY(${[...targetIds]}::text[])
       AND p.date BETWEEN ${from}::date AND ${yesterday}::date
     GROUP BY p."localEntityId"`)
  for (const r of rows) out.set(r.id, { impressions14: Number(r.imp14), impressions90: Number(r.imp90), clicks14: Number(r.clicks14), orders90: Number(r.orders90) })
  return out
}

/** A stored `evidence.revive` read back, or null when it is not one. */
export function reviveMemoryOf(raw: unknown): ReviveMemory | null {
  const r = raw as Partial<ReviveMemory> | null
  const day = /^\d{4}-\d{2}-\d{2}$/
  if (!r || typeof r !== 'object' || typeof r.start !== 'string' || !day.test(r.start) || typeof r.dataDay !== 'string' || !day.test(r.dataDay)) return null
  if (typeof r.fromCents !== 'number' || !Number.isFinite(r.fromCents) || typeof r.step !== 'number' || (r.state !== 'step' && r.state !== 'silent')) return null
  return { start: r.start, fromCents: r.fromCents, step: r.step, state: r.state, dataDay: r.dataDay }
}

/** Each keyword's newest revive memory among the decisions kept (30 days). */
export async function loadReviveMemory(targetIds: readonly string[], now: Date): Promise<Map<string, ReviveMemory>> {
  const out = new Map<string, ReviveMemory>()
  if (!targetIds.length) return out
  const rows = await prisma.$queryRaw<Array<{ id: string; revive: unknown }>>(Prisma.sql`
    SELECT DISTINCT ON (d."targetId") d."targetId" AS id, d.evidence -> 'revive' AS revive
      FROM "BidBrainDecision" d
     WHERE d."targetId" = ANY(${[...targetIds]}::text[]) AND (d.evidence -> 'revive') IS NOT NULL
       AND d."createdAt" >= ${new Date(now.getTime() - 30 * DAY_MS)}
     ORDER BY d."targetId", d."createdAt" DESC`)
  for (const r of rows) {
    const memory = reviveMemoryOf(r.revive)
    if (memory) out.set(r.id, memory)
  }
  return out
}

/** Per ad group: the shortest stock cover in days of its products (judged on a 14-day line); absent: not known. */
export async function loadCover(adGroupIds: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (!adGroupIds.length) return out
  const { adGroups } = await readStockAdGroups({ adGroupIds: [...adGroupIds], lowBelowDays: MIN_COVER_DAYS })
  for (const g of adGroups) {
    const covers = g.products.map((p) => p.daysOfCover).filter((d): d is number => d != null && Number.isFinite(d))
    if (covers.length) out.set(g.id, Math.min(...covers))
  }
  return out
}

/** The market's explore budget a day: the strategy's market row, else the Owner's default (explore.ts). */
export async function loadExploreBudget(market: string): Promise<{ cents: number; from: 'strategy' | 'default' }> {
  const view = await openStrategy(market)
  const value = view.empty ? null : view.forMarket().resolved.fields.get('exploreBudgetCents')?.value
  return exploreBudgetOf(market, typeof value === 'number' ? value : null)
}

/**
 * BB-20 — the day's explore plan over the market's keywords (`facts` / `decisions`, the whole market), with each keyword's
 * ε (the response's; DEFAULT_EPS without it). Only the keywords that could be picked are read further.
 */
export async function exploreShadow(
  m: { market: string; dataDay: string; targets: readonly TargetRow[] },
  facts: readonly TargetFacts[], decisions: readonly Decision[],
  ctx: { now: Date; eps: ReadonlyMap<string, number>; lastWrites?: ReadonlyMap<string, { at: Date }> },
) {
  const budget = await loadExploreBudget(m.market)
  const open = facts.flatMap((f, i) => (exploreExclusion(f, decisions[i], undefined) ? [] : [i]))
  const ids = open.map((i) => facts[i].targetId)
  const groupOf = new Map(m.targets.map((t) => [t.id, t.adGroupId]))
  const [activity, memory, cover] = await Promise.all([
    loadActivity(ids, { now: ctx.now, dataDay: m.dataDay }),
    loadReviveMemory(ids, ctx.now),
    loadCover([...new Set(ids.map((id) => groupOf.get(id)).filter((g): g is string => !!g))]),
  ])
  const options = open.map((i) => {
    const f = facts[i]
    const write = ctx.lastWrites?.get(f.targetId)
    const a: TargetActivity = {
      ...(activity.get(f.targetId) ?? { impressions14: 0, impressions90: 0, clicks14: 0, orders90: 0 }),
      coverDays: cover.get(groupOf.get(f.targetId) ?? '') ?? null,
      daysSinceWrite: write ? Math.floor((ctx.now.getTime() - write.at.getTime()) / DAY_MS) : null,
      revive: memory.get(f.targetId) ?? null,
    }
    return exploreOption(f, decisions[i], a, ctx.eps.get(f.targetId) ?? DEFAULT_EPS)
  })
  return { plan: planExplore(options, budget), options }
}

/** What BB-19, BB-20 and BB-21 add to one market's run. */
export interface UpgradesSummary { response?: ResponseSummary; explore?: ExploreSummary; probes?: ProbeSummary }
export interface Upgrades {
  /** The decisions to act on: the goal's, except the explore and revive picks under NEXUS_BID_BRAIN_EXPLORE=on. */
  decisions: Decision[]
  /** Per keyword: the words its stored why gains. */
  notes: Map<string, string>
  /** Per keyword: what its stored evidence gains. */
  evidence: Map<string, Record<string, unknown>>
  summary: UpgradesSummary | null
}

const errorWords = (err: unknown) => (err instanceof Error ? err.message : String(err))

/**
 * The run's hook (shadow.ts). With NEXUS_BID_BRAIN_RESPONSE and NEXUS_BID_BRAIN_EXPLORE both off nothing is read (null).
 * `marketFacts`: the whole market's keywords when the run decides only some (a product cycle, or the full run leaving the
 * cycle's campaigns) — the plan and every ε are made over them, the words and the picks kept for the run's own. Never
 * fails the run: an error is logged and the goal's decisions stand.
 */
export async function upgradesShadow(
  m: { market: string; dataDay: string; targets: readonly TargetRow[]; adGroups: ReadonlyMap<string, AdGroupRow> },
  input: {
    facts: readonly TargetFacts[]; decisions: readonly Decision[]; campaignOf: (targetId: string) => string
    now: Date; lastWrites?: ReadonlyMap<string, { at: Date }>; marketFacts?: () => TargetFacts[]
    /** BB-21 — the campaigns the brain owns this run (a probe there is LIVE under `on`), and the run (the ledger's rows). */
    owned?: ReadonlySet<string>; runId?: string
  },
): Promise<Upgrades | null> {
  const response = responseMode()
  const explore = exploreMode()
  const probes = probeMode()
  if ((response === 'off' && explore === 'off' && probes === 'off') || !input.facts.length) return null
  const own = new Set(input.facts.map((f) => f.targetId))
  // Batch 3 review — the market's facts are only for the shadow layers: a throw means no upgrades this run, never a failed run.
  let all: TargetFacts[] | null = null
  try {
    all = input.marketFacts ? input.marketFacts() : null
  } catch (error) {
    logger.warn('[bid-brain] the market facts for the upgrades could not be built: no upgrades this run', { market: m.market, error: error instanceof Error ? error.message : String(error) })
    return null
  }
  const facts = all ?? input.facts
  const decisions = all ? all.map((f) => decide(f)) : input.decisions
  const notes = new Map<string, string>()
  const evidence = new Map<string, Record<string, unknown>>()
  const add = (id: string, words: string | undefined, more: Record<string, unknown> | undefined) => {
    if (!own.has(id)) return
    if (words) notes.set(id, notes.has(id) ? `${notes.get(id)} · ${words}` : words)
    if (more) evidence.set(id, { ...evidence.get(id), ...more })
  }
  const summary: UpgradesSummary = {}
  let eps: ReadonlyMap<string, number> = new Map()
  // BB-21 — the probes' ledger and their readings, read once (a failure: no probes this run, the response as before).
  let readings: ReadonlyMap<string | null, EpsReading[]> = new Map()
  let ledger: LoadedLedger | null = null
  try {
    if (response !== 'off' || probes !== 'off') readings = await loadProbeReadings(m.market, input.now)
    if (probes !== 'off') ledger = await loadProbeLedger(m.market, input.now)
  } catch (err) {
    logger.warn('[bid-brain] the probes\' ledger could not be read — no probe this run, nothing changes', { market: m.market, error: errorWords(err) })
  }
  let found: Awaited<ReturnType<typeof responseShadow>> | null = null
  if (response !== 'off') {
    try {
      const r = await responseShadow(m, facts, decisions, input.campaignOf, readings)
      found = r
      for (const [id, n] of r.notes) {
        const { words, ...numbers } = n
        add(id, words, { response: numbers })
      }
      summary.response = all ? summarizeResponse([...r.notes].filter(([id]) => own.has(id)).map(([, n]) => n), r.summary.moves) : r.summary
      eps = r.eps
    } catch (err) {
      logger.warn('[bid-brain] the response shadow failed — the goal\'s decisions stand, nothing changes', { market: m.market, error: errorWords(err) })
    }
  }
  let out = input.decisions as Decision[]
  // BB-21 — under `on`, a keyword in a LIVE probe is not explored: its bids are the probe's.
  const probing = probes === 'on' && ledger ? new Set(ledger.records.filter((p) => p.mode === 'LIVE' && (p.status === 'RUNNING' || p.status === 'MEASURING')).map((p) => p.targetId)) : null
  if (explore !== 'off') {
    try {
      const keep = probing?.size ? facts.flatMap((f, i) => (probing.has(f.targetId) ? [] : [i])) : null
      const { plan, options } = keep
        ? await exploreShadow(m, keep.map((i) => facts[i]), keep.map((i) => decisions[i]), { now: input.now, eps, lastWrites: input.lastWrites })
        : await exploreShadow(m, facts, decisions, { now: input.now, eps, lastWrites: input.lastWrites })
      const words = exploreWords(plan, explore, options)
      for (const id of new Set([...words.notes.keys(), ...words.evidence.keys()])) add(id, words.notes.get(id), words.evidence.get(id))
      summary.explore = summarizeExplore(plan, explore, options.filter((o) => 'say' in o && o.say).length)
      out = applyExplore(input.decisions, input.facts, plan, explore)
    } catch (err) {
      logger.warn('[bid-brain] the explore plan failed — the goal\'s decisions stand, nothing changes', { market: m.market, error: errorWords(err) })
    }
  }
  // BB-21 — the probes, over the run's own keywords and their decisions after exploration.
  if (probes !== 'off' && ledger) {
    try {
      const p = await probesShadow(m, {
        facts: input.facts, decisions: out, campaignOf: input.campaignOf, now: input.now, mode: probes, owned: input.owned ?? new Set(),
        runId: input.runId ?? 'bid-brain', ledger, readings, posteriors: found?.posteriors, signals: found?.signals,
        loadClicks: async (ids) => new Map([...(await loadActivity(ids, { now: input.now, dataDay: m.dataDay }))].map(([id, a]) => [id, a.clicks14])),
        loadSignals: (ids) => loadCampaignSignals(ids, m.dataDay),
      })
      for (const id of new Set([...p.notes.keys(), ...p.evidence.keys()])) add(id, p.notes.get(id), p.evidence.get(id))
      if (p.summary) summary.probes = p.summary
      out = p.decisions
    } catch (err) {
      logger.warn('[bid-brain] the probes failed — the decisions stand, nothing changes', { market: m.market, error: errorWords(err) })
    }
  }
  if (!summary.response && !summary.explore && !summary.probes) return null
  return { decisions: out, notes, evidence, summary }
}
