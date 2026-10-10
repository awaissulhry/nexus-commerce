/**
 * LANE 5 (2026-10-10) — the share layer's reads (share.ts decides the reading, decide.ts the bid). Like intraday-load.ts:
 * a fixed set of small queries for one market whatever the number of keywords (no N+1), nothing written.
 *
 *   target    the Owner's tosTargetPct (brain/settings.ts resolveKeywordValue): the keyword's own VALUE override (ref
 *             target:<AdTarget.id>) > its campaign's > its product's (the one family every ad group of the campaign
 *             advertises; a shared campaign has none, D2) > the default (empty = off). One query; with no override set
 *             anywhere in the market nothing else is read and the run is exactly as before (shadow-safe)
 *   readings  for the keywords with a target only: their AD_TARGET rows (the keyword-grain share the TOS ingest's
 *             keyword pass writes) and their campaigns' CAMPAIGN rows (the campaign share, the day's impressions, spend
 *             and budget) of AmazonAdsDailyPerformance, the 14 days before today (UTC)
 *   lastMove  each keyword's last share move, from the newest BidBrainDecision that stored one (evidence.share.lastMove)
 * A failed read is logged and leaves the layer out (the run decides as without a target): never a move on data that
 * could not be read.
 */
import { Prisma } from '@prisma/client'
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { resolveKeywordValue, type KeywordResolved, type OverrideRow } from '../brain/settings.js'
import type { MarketRows } from './facts.js'
import { campaignProducts } from './intraday-load.js'
import { BUDGET_CAPPED_SHARE, readLastMove, SHARE_LOOKBACK_DAYS, shareReadingOf, type ShareDay, type ShareFacts, type ShareMove } from './share.js'

const DAY_MS = 86_400_000
const SP = 'SPONSORED_PRODUCTS'
const SETTING = 'tosTargetPct'
const OVERRIDE_SELECT = { id: true, productId: true, marketplace: true, scope: true, campaignId: true, kind: true, key: true, ref: true, value: true, by: true, reason: true, createdAt: true, endedAt: true } as const
const isoDay = (d: Date) => d.toISOString().slice(0, 10)
const num = (v: unknown): number | null => {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Who set a keyword's target, in words: "the Owner's keyword override (user:x, 2026-10-09)". Pure. */
export function targetWords(r: Pick<KeywordResolved, 'grain' | 'by' | 'at'>): string {
  const whose = r.grain === 'keyword' ? 'keyword' : r.grain === 'campaign' ? 'campaign' : r.grain === 'product' ? 'product' : 'default'
  return `the Owner's ${whose} override${r.by ? ` (${r.by}${r.at ? `, ${r.at.slice(0, 10)}` : ''})` : ''}`
}

/**
 * One market's share facts at `now`, per keyword with a target. Undefined: a between-slots tick, no target anywhere in the
 * market, or the read failed (logged).
 */
export async function loadShare(m: Pick<MarketRows, 'market' | 'campaigns' | 'adGroups' | 'targets' | 'light'>, now: Date): Promise<Map<string, ShareFacts> | undefined> {
  if (m.light || !m.targets.length) return undefined
  try {
    return await readShare(m, now)
  } catch (err) {
    logger.warn('[bid-brain] the top-of-search share facts could not be read — the run decides without the share layer', { market: m.market, error: err instanceof Error ? err.message : String(err) })
    return undefined
  }
}

async function readShare(m: Pick<MarketRows, 'market' | 'campaigns' | 'adGroups' | 'targets'>, now: Date): Promise<Map<string, ShareFacts> | undefined> {
  const campaignOf = (adGroupId: string) => m.adGroups.get(adGroupId)?.campaignId ?? null
  const targets = m.targets.flatMap((t) => {
    const campaignId = campaignOf(t.adGroupId)
    return campaignId && m.campaigns.get(campaignId)?.allowlisted ? [{ id: t.id, campaignId }] : []
  })
  if (!targets.length) return undefined
  const campaignIds = [...new Set(targets.map((t) => t.campaignId))].sort()
  const productOf = campaignProducts(m, campaignIds)
  const products = [...new Set([...productOf.values()].filter((p): p is string => !!p))]
  const overrides = await prisma.adsBrainOverride.findMany({
    where: {
      endedAt: null, kind: 'VALUE', key: SETTING,
      OR: [{ scope: 'CAMPAIGN', campaignId: { in: campaignIds } }, ...(products.length ? [{ scope: 'PRODUCT', marketplace: m.market, productId: { in: products } }] : [])],
    },
    select: OVERRIDE_SELECT,
  }) as OverrideRow[]
  if (!overrides.length) return undefined

  const wanted = new Map<string, { campaignId: string; pct: number; by: string }>()
  for (const t of targets) {
    const r = resolveKeywordValue({ productId: productOf.get(t.campaignId) ?? '', market: m.market, campaignId: t.campaignId, targetId: t.id, overrides }, SETTING)
    if (typeof r.value === 'number' && Number.isFinite(r.value)) wanted.set(t.id, { campaignId: t.campaignId, pct: r.value, by: targetWords(r) })
  }
  if (!wanted.size) return undefined

  const ids = [...wanted.keys()].sort()
  const cids = [...new Set([...wanted.values()].map((w) => w.campaignId))].sort()
  const today = isoDay(now)
  const todayDate = new Date(`${today}T00:00:00Z`)
  const since = new Date(todayDate.getTime() - SHARE_LOOKBACK_DAYS * DAY_MS)
  const [kwRows, campRows, moves] = await Promise.all([
    prisma.amazonAdsDailyPerformance.findMany({
      where: { entityType: 'AD_TARGET', adProduct: SP, localEntityId: { in: ids }, date: { gte: since, lt: todayDate } },
      select: { localEntityId: true, date: true, impressions: true, topOfSearchIS: true },
    }),
    prisma.amazonAdsDailyPerformance.findMany({
      where: { entityType: 'CAMPAIGN', adProduct: SP, localEntityId: { in: cids }, date: { gte: since, lt: todayDate } },
      select: { localEntityId: true, date: true, impressions: true, costMicros: true, campaignBudgetCents: true, campaignRuleBasedBudgetCents: true, topOfSearchIS: true },
    }),
    lastMoves(ids, now),
  ])

  const kw = sumDays(kwRows.map((r) => ({ id: r.localEntityId, day: isoDay(r.date), impressions: r.impressions, share: num(r.topOfSearchIS), spendCents: null, budgetCents: null })))
  const camp = sumDays(campRows.map((r) => {
    const rule = r.campaignRuleBasedBudgetCents ?? null
    const budget = rule != null && rule > 0 ? rule : r.campaignBudgetCents ?? null
    return { id: r.localEntityId, day: isoDay(r.date), impressions: r.impressions, share: num(r.topOfSearchIS), spendCents: Number(r.costMicros) / 10_000, budgetCents: budget != null && budget > 0 ? budget : null }
  }))

  const out = new Map<string, ShareFacts>()
  for (const [id, w] of wanted) {
    const days = new Set<string>([...(kw.byId.get(id)?.keys() ?? []), ...(camp.byId.get(w.campaignId)?.keys() ?? [])])
    const list: ShareDay[] = [...days].sort().map((day) => {
      const k = kw.byId.get(id)?.get(day)
      const c = camp.byId.get(w.campaignId)?.get(day)
      return {
        day,
        keyword: k ? { impressions: k.impressions, share: k.share } : null,
        campaign: c ? { impressions: c.impressions, share: c.share, capped: c.budgetCents != null && c.spendCents != null ? c.spendCents >= BUDGET_CAPPED_SHARE * c.budgetCents : null } : null,
      }
    })
    const lastMove = moves.get(id) ?? null
    const r = shareReadingOf(list, { today, lastMove })
    out.set(id, { targetPct: w.pct, targetBy: w.by, reading: r.reading, held: r.held, waiting: r.waiting, lastMove })
  }
  return out
}

/** Rows summed per entity and day (one per profile is the rule; a second is added in, its share impression-weighted). Pure. */
function sumDays(rows: ReadonlyArray<{ id: string | null; day: string; impressions: number; share: number | null; spendCents: number | null; budgetCents: number | null }>) {
  type Cell = { impressions: number; share: number | null; shareWeight: number; spendCents: number | null; budgetCents: number | null }
  const byId = new Map<string, Map<string, Cell>>()
  for (const r of rows) {
    if (!r.id) continue
    const days = byId.get(r.id) ?? new Map<string, Cell>()
    byId.set(r.id, days)
    const c = days.get(r.day) ?? { impressions: 0, share: null, shareWeight: 0, spendCents: null, budgetCents: null }
    c.impressions += r.impressions
    if (r.share != null && r.impressions > 0) {
      c.share = ((c.share ?? 0) * c.shareWeight + r.share * r.impressions) / (c.shareWeight + r.impressions)
      c.shareWeight += r.impressions
    } else if (r.share != null && c.share == null) c.share = r.share
    if (r.spendCents != null) c.spendCents = (c.spendCents ?? 0) + r.spendCents
    if (r.budgetCents != null) c.budgetCents = (c.budgetCents ?? 0) + r.budgetCents
    days.set(r.day, c)
  }
  return { byId }
}

/** Each keyword's last share move (the newest decision that stored one in the 30 days kept). */
async function lastMoves(ids: readonly string[], now: Date): Promise<Map<string, ShareMove>> {
  if (!ids.length) return new Map()
  const rows = await prisma.$queryRaw<Array<{ targetId: string; lastMove: unknown }>>(Prisma.sql`
    SELECT DISTINCT ON (d."targetId") d."targetId", d.evidence -> 'share' -> 'lastMove' AS "lastMove"
      FROM "BidBrainDecision" d
     WHERE d."targetId" = ANY(${[...ids]}::text[]) AND d."createdAt" >= ${new Date(now.getTime() - 30 * DAY_MS)}
       AND jsonb_typeof(d.evidence -> 'share' -> 'lastMove') = 'object'
     ORDER BY d."targetId", d."createdAt" DESC`)
  const out = new Map<string, ShareMove>()
  for (const r of rows) {
    const m = readLastMove(r.lastMove)
    if (m) out.set(r.targetId, m)
  }
  return out
}
