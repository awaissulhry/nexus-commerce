/**
 * BID BRAIN BB-19 — the response beside a run's decisions (response.ts): what it reads, and the words, evidence and run
 * line it adds. Nothing here changes a decision: the stored why gains " · profit-best …", `evidence.response` keeps the
 * numbers, the run's line counts them. A failure is logged and changes nothing — the goal's decisions stand.
 *
 *   moves      CampaignBidHistory of the market's keywords over the settled window: serving moves (both sides ≥ the 5¢
 *              engine floor) of ≥ 10 % with no other move of the keyword within 3 days either side — found in SQL with
 *              LAG / LEAD, so only those cross the wire; then the clicks (rows with clicks only) and the move days of
 *              their ad groups' keywords around them, for the matched days and the control (response.ts moveEventsOf)
 *   signals    per decided campaign: the top-of-search impression share of the last 14 settled days (the placement
 *              report's TOP rows — the copy on the daily rows was abandoned on 2026-08-19 — weighted by impressions) and
 *              the days of the last 7 settled whose spend reached 95 % of that day's budget (campaign rows)
 *
 * Called inside a business (the run's): row-level security keeps each to its own rows.
 */
import { Prisma } from '@prisma/client'
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import type { Decision, TargetFacts } from './decide.js'
import { MAX_WINDOW_DAYS } from './estimator.js'
import type { AdGroupRow, TargetRow } from './facts.js'
import { ENGINE_FLOOR_CENTS } from './recipe.js'
import {
  CAPPED_SPEND_SHARE, CAPPED_WINDOW_DAYS, MOVE_MAX_DAYS, MOVE_MIN_DAYS, MOVE_MIN_SHARE, TOS_WINDOW_DAYS,
  moveEventsOf, moveReading, productEps, responseFor, responseMode, summarizeResponse,
  type CampaignSignal, type EpsPosterior, type MoveEvent, type ResponseNote, type ResponseSummary,
} from './response.js'

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

/** Per campaign: its top-of-search share over the last 14 settled days and its budget-capped days of the last 7. */
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
}

/**
 * BB-19 — the response of a run's keywords: each product's ε from the market's moves, each keyword's profit-best bid
 * beside its goal bid. Pure past the two reads.
 */
export async function responseShadow(
  m: { dataDay: string; targets: readonly TargetRow[]; adGroups: ReadonlyMap<string, AdGroupRow> },
  facts: readonly TargetFacts[], decisions: readonly Decision[], campaignOf: (targetId: string) => string,
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
    if (!product) { product = productEps(byProduct, key); products.set(key, product) }
    const note = responseFor(f, decisions[i], product, signals.get(campaignOf(f.targetId)))
    if (!note) return
    notes.set(f.targetId, note)
    eps.set(f.targetId, note.eps)
  })
  return { notes, summary: summarizeResponse([...notes.values()], events.filter((e) => moveReading(e)).length), eps }
}

/** What BB-19 adds to one market's run. */
export interface UpgradesSummary { response?: ResponseSummary }
export interface Upgrades {
  /** The decisions to act on: always the goal's here (BB-19 is shadow only). */
  decisions: Decision[]
  /** Per keyword: the words its stored why gains. */
  notes: Map<string, string>
  /** Per keyword: what its stored evidence gains. */
  evidence: Map<string, Record<string, unknown>>
  summary: UpgradesSummary | null
}

/**
 * The run's hook (shadow.ts): with NEXUS_BID_BRAIN_RESPONSE off, nothing is read (null); in shadow, the notes. Never
 * fails the run: an error is logged and the goal's decisions stand.
 */
export async function upgradesShadow(
  m: { market: string; dataDay: string; targets: readonly TargetRow[]; adGroups: ReadonlyMap<string, AdGroupRow> },
  input: { facts: readonly TargetFacts[]; decisions: readonly Decision[]; campaignOf: (targetId: string) => string },
): Promise<Upgrades | null> {
  if (responseMode() === 'off' || !input.facts.length) return null
  try {
    const r = await responseShadow(m, input.facts, input.decisions, input.campaignOf)
    const notes = new Map<string, string>()
    const evidence = new Map<string, Record<string, unknown>>()
    for (const [id, n] of r.notes) {
      notes.set(id, n.words)
      const { words: _words, ...numbers } = n
      evidence.set(id, { response: numbers })
    }
    return { decisions: input.decisions as Decision[], notes, evidence, summary: { response: r.summary } }
  } catch (err) {
    logger.warn('[bid-brain] the response shadow failed — the goal\'s decisions stand, nothing changes', { market: m.market, error: err instanceof Error ? err.message : String(err) })
    return null
  }
}
