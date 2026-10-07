/**
 * The Keyword Tracker's feed — `KeywordRank` rows written on a clock, from data Nexus already holds.
 *
 * The KEYWORD_RANK_BID rule (Keyword Tracker) reads `KeywordRank`. Until this feed, the only writer was the manual
 * `POST /advertising/keyword-ranks`, nothing called it, and the table held 0 rows — so every Keyword Tracker rule
 * matched nothing on every run, and the builder refused to save one.
 *
 * ── What each column gets, and from where (researched 2026-10-07) ─────────────────────────────────────────────────
 *
 * | column          | source                                                                                     |
 * |-----------------|--------------------------------------------------------------------------------------------|
 * | `searchVolume`  | Amazon Brand Analytics, Search Query Performance (`SearchQueryPerformance.searchQueryVolume`): |
 * |                 | how many times shoppers searched the keyword in that market in ONE week. Already ingested     |
 * |                 | through the gateway by sqp-ingest / sqp-collect; this feed makes no Amazon call of its own.   |
 * | `organicRank`   | NULL — no source. Neither the SP-API nor the Ads API returns an organic search position, and  |
 * |                 | Nexus does not scrape the search page (Amazon's terms forbid it).                            |
 * | `sponsoredRank` | NULL — no source. Amazon's "search term impression rank" is in the advertising console only:  |
 * |                 | the Ads API v3 refuses `searchTermImpressionRank` / `searchTermImpressionShare` (amzn/        |
 * |                 | ads-advanced-tools-docs discussion #244, open since 2024-04, still open in 2026), and one      |
 * |                 | refused column fails the WHOLE report, so they are not requested.                            |
 * | `asin`          | NULL — the volume is the keyword's, in its market, not one product's.                       |
 * | `capturedAt`    | the END of the Brand Analytics week the volume covers (its Sunday start + 7 days), so the     |
 * |                 | evaluator's 14-day freshness limit measures the age of the data, not of this feed's run.     |
 *
 * Rank Change (`rankDelta`) stays organic-only, as the evaluator defines it, so it is absent too.
 *
 * Only keywords Nexus bids on (positive keyword targets, enabled or paused, in a campaign of that market) are written:
 * a rule can only change the bid of a keyword it bids on, and the table stays a few hundred rows per week.
 * Append-only and idempotent: a (market, keyword, week) already written by this feed is never written twice.
 */
import prisma from '../../db.js'

/** The `KeywordRank.source` this feed writes. */
export const KEYWORD_RANK_FEED_SOURCE = 'brand-analytics-sqp'

/**
 * 4m (review 3.13) — a reading older than this is not used by a Keyword Tracker rule. The evaluator's own constant
 * (`advertising-rule-evaluator.job.ts` re-exports it and carries the reasoning); kept here so the feed's census and
 * the preview read it without loading the evaluator.
 */
export const KEYWORD_RANK_MAX_AGE_DAYS = 14

/**
 * How far back the feed looks for Brand Analytics weeks: the weeks that END within these many days. Two weeks past
 * the freshness limit, so a reading always has the week before it on record, and a few missed nights fill themselves.
 */
export const KEYWORD_RANK_FEED_LOOKBACK_DAYS = 28

const DAY_MS = 86_400_000

/** How the evaluator matches a keyword to a target: trimmed and lower-cased. */
export const normKeyword = (s: string): string => s.trim().toLowerCase()

/** The end of a Brand Analytics week (Sunday → Saturday): its start + 7 days. */
export const sqpWeekEnd = (startDate: Date): Date => new Date(startDate.getTime() + 7 * DAY_MS)

/** One (market, week, search query) of SearchQueryPerformance, with the week's search volume. */
export interface SqpVolumeCell {
  marketplace: string
  startDate: Date
  searchQuery: string
  volume: number | null
}

/** A keyword Nexus bids on, in the market of its campaign. */
export interface FeedTargetKeyword {
  marketplace: string | null
  keyword: string | null
}

/** A row this feed already wrote. */
export interface ExistingFeedRow {
  marketplace: string
  keyword: string
  capturedAt: Date
}

/** What the feed writes into `KeywordRank`: search volume only, every rank NULL. */
export interface KeywordRankFeedRow {
  keyword: string
  marketplace: string
  asin: null
  organicRank: null
  sponsoredRank: null
  searchVolume: number
  capturedAt: Date
  source: typeof KEYWORD_RANK_FEED_SOURCE
}

export interface KeywordRankFeedPlan {
  rows: KeywordRankFeedRow[]
  /** (market, keyword, week) cells already written by an earlier run. */
  alreadyWritten: number
  /** Cells with a volume whose keyword Nexus does not bid on in that market. */
  notBidOn: number
  /** Cells Amazon reported no volume for (0 or missing): nothing to write, never a zero. */
  noVolume: number
  /** Per market: the newest week end with any volume, and how many of its bid-on keywords it covers. */
  markets: Array<{ marketplace: string; newestWeekEnd: string | null; keywordsInNewestWeek: number }>
}

/**
 * PURE — which `KeywordRank` rows to write.
 *
 * A cell becomes a row when Amazon reported a volume above 0 for it, its keyword is one Nexus bids on in that market,
 * its week has ended, and this feed has not written that (market, keyword, week) before. Two SearchQueryPerformance
 * spellings that match the same keyword (case, spaces) are one row, with the larger volume.
 */
export function planKeywordRankFeedRows(args: {
  cells: readonly SqpVolumeCell[]
  targets: readonly FeedTargetKeyword[]
  existing: readonly ExistingFeedRow[]
  now: Date
}): KeywordRankFeedPlan {
  const sep = '\u001f'
  const bidOn = new Set<string>()
  for (const t of args.targets) {
    if (!t.marketplace || !t.keyword || !t.keyword.trim()) continue
    bidOn.add(`${t.marketplace}${sep}${normKeyword(t.keyword)}`)
  }
  const written = new Set(args.existing.map((e) => `${e.marketplace}${sep}${normKeyword(e.keyword)}${sep}${e.capturedAt.getTime()}`))

  const byCell = new Map<string, { marketplace: string; keyword: string; weekEnd: Date; volume: number }>()
  let notBidOn = 0
  let noVolume = 0
  for (const c of args.cells) {
    const keyword = normKeyword(c.searchQuery ?? '')
    if (!keyword || !c.marketplace) continue
    const weekEnd = sqpWeekEnd(c.startDate)
    if (weekEnd.getTime() > args.now.getTime()) continue // a week that has not ended has no complete volume
    if (c.volume == null || !Number.isFinite(c.volume) || c.volume <= 0) { noVolume += 1; continue }
    if (!bidOn.has(`${c.marketplace}${sep}${keyword}`)) { notBidOn += 1; continue }
    const k = `${c.marketplace}${sep}${keyword}${sep}${weekEnd.getTime()}`
    const held = byCell.get(k)
    if (!held || c.volume > held.volume) byCell.set(k, { marketplace: c.marketplace, keyword, weekEnd, volume: Math.round(c.volume) })
  }

  const rows: KeywordRankFeedRow[] = []
  let alreadyWritten = 0
  const newest = new Map<string, { end: number; keywords: Set<string> }>()
  for (const [k, cell] of byCell) {
    const end = cell.weekEnd.getTime()
    const m = newest.get(cell.marketplace)
    if (!m || end > m.end) newest.set(cell.marketplace, { end, keywords: new Set([cell.keyword]) })
    else if (end === m.end) m.keywords.add(cell.keyword)
    if (written.has(k)) { alreadyWritten += 1; continue }
    rows.push({
      keyword: cell.keyword,
      marketplace: cell.marketplace,
      asin: null,
      organicRank: null,
      sponsoredRank: null,
      searchVolume: cell.volume,
      capturedAt: cell.weekEnd,
      source: KEYWORD_RANK_FEED_SOURCE,
    })
  }
  rows.sort((a, b) => a.marketplace.localeCompare(b.marketplace) || a.capturedAt.getTime() - b.capturedAt.getTime() || a.keyword.localeCompare(b.keyword))

  const marketCodes = [...new Set(args.targets.map((t) => t.marketplace).filter((m): m is string => !!m))].sort()
  const markets = marketCodes.map((marketplace) => {
    const m = newest.get(marketplace)
    return { marketplace, newestWeekEnd: m ? new Date(m.end).toISOString().slice(0, 10) : null, keywordsInNewestWeek: m ? m.keywords.size : 0 }
  })
  return { rows, alreadyWritten, notBidOn, noVolume, markets }
}

/** PURE — the run's one summary line, as the cron run records it. */
export function keywordRankFeedSummaryLine(plan: KeywordRankFeedPlan, created: number, now: Date): string {
  const perMarket = plan.markets.map((m) => {
    if (!m.newestWeekEnd) return `${m.marketplace} no Brand Analytics week in ${KEYWORD_RANK_FEED_LOOKBACK_DAYS}d`
    const age = Math.floor((now.getTime() - Date.parse(m.newestWeekEnd)) / DAY_MS)
    const stale = age > KEYWORD_RANK_MAX_AGE_DAYS ? ` — older than ${KEYWORD_RANK_MAX_AGE_DAYS}d, rules ignore it` : ''
    return `${m.marketplace} week to ${m.newestWeekEnd} (${age}d) ${m.keywordsInNewestWeek} kw${stale}`
  })
  return `created=${created} alreadyWritten=${plan.alreadyWritten} notBidOn=${plan.notBidOn} noVolume=${plan.noVolume} · ` +
    `searchVolume only (organic/sponsored rank: no source) · ${perMarket.join(' · ') || 'no market with a bid-on keyword'}`
}

/**
 * The feed's run, inside one business (the clustered cron visits each; RLS scopes every read and write). Reads
 * SearchQueryPerformance, the keyword targets and its own earlier rows; writes the new `KeywordRank` rows. No
 * marketplace call.
 */
export async function runKeywordRankFeed(now = new Date()): Promise<{ plan: KeywordRankFeedPlan; created: number; summary: string }> {
  const weekEndSince = new Date(now.getTime() - KEYWORD_RANK_FEED_LOOKBACK_DAYS * DAY_MS)
  const startSince = new Date(weekEndSince.getTime() - 7 * DAY_MS)

  const [targets, grouped, existing] = await Promise.all([
    prisma.adTarget.findMany({
      where: { kind: 'KEYWORD', isNegative: false, status: { in: ['ENABLED', 'PAUSED'] } },
      select: { expressionValue: true, adGroup: { select: { campaign: { select: { marketplace: true } } } } },
    }),
    prisma.searchQueryPerformance.groupBy({
      by: ['marketplace', 'startDate', 'searchQuery'],
      where: { reportPeriod: 'WEEK', startDate: { gte: startSince } },
      _max: { searchQueryVolume: true },
    }),
    prisma.keywordRank.findMany({
      where: { source: KEYWORD_RANK_FEED_SOURCE, capturedAt: { gte: weekEndSince } },
      select: { marketplace: true, keyword: true, capturedAt: true },
    }),
  ])

  const plan = planKeywordRankFeedRows({
    targets: targets.map((t) => ({ marketplace: t.adGroup?.campaign?.marketplace ?? null, keyword: t.expressionValue })),
    cells: grouped.map((g) => ({ marketplace: g.marketplace, startDate: g.startDate, searchQuery: g.searchQuery, volume: g._max.searchQueryVolume ?? null })),
    existing,
    now,
  })

  let created = 0
  for (let i = 0; i < plan.rows.length; i += 1000) {
    const res = await prisma.keywordRank.createMany({ data: plan.rows.slice(i, i + 1000) })
    created += res.count
  }
  return { plan, created, summary: keywordRankFeedSummaryLine(plan, created, now) }
}

/** How many readings younger than the freshness limit carry each field — what a Keyword Tracker rule can read now. */
export interface KeywordRankFieldCensus {
  maxAgeDays: number
  freshRows: number
  organicRank: number
  sponsoredRank: number
  searchVolume: number
}

export async function keywordRankFieldCensus(now = new Date()): Promise<KeywordRankFieldCensus> {
  const fresh = { capturedAt: { gte: new Date(now.getTime() - KEYWORD_RANK_MAX_AGE_DAYS * DAY_MS) } }
  const [freshRows, organicRank, sponsoredRank, searchVolume] = await Promise.all([
    prisma.keywordRank.count({ where: fresh }),
    prisma.keywordRank.count({ where: { ...fresh, organicRank: { not: null } } }),
    prisma.keywordRank.count({ where: { ...fresh, sponsoredRank: { not: null } } }),
    prisma.keywordRank.count({ where: { ...fresh, searchVolume: { not: null } } }),
  ])
  return { maxAgeDays: KEYWORD_RANK_MAX_AGE_DAYS, freshRows, organicRank, sponsoredRank, searchVolume }
}

/** The KEYWORD_RANK_BID fields no automatic source fills, the builder's name for each, and which count measures it. */
const NO_AUTOMATIC_SOURCE: Record<string, { metric: string; count: 'organicRank' | 'sponsoredRank' }> = {
  'adTarget.organicRank': { metric: 'Organic Rank', count: 'organicRank' },
  'adTarget.sponsoredRank': { metric: 'Sponsored Rank', count: 'sponsoredRank' },
  // Rank Change is organic-only (prior.organicRank − latest.organicRank), so it exists exactly when organic rank does.
  'adTarget.rankDelta': { metric: 'Rank Change', count: 'organicRank' },
}

/** Every `field` string anywhere in a condition payload — flat leaves, builder blocks or a tree. */
export function conditionFields(payload: unknown): string[] {
  const out = new Set<string>()
  const walk = (v: unknown) => {
    if (Array.isArray(v)) { v.forEach(walk); return }
    if (v == null || typeof v !== 'object') return
    const o = v as Record<string, unknown>
    if (typeof o.field === 'string') out.add(o.field)
    for (const x of Object.values(o)) if (x != null && typeof x === 'object') walk(x)
  }
  walk(payload)
  return [...out]
}

/**
 * PURE — why a Keyword Tracker rule that reads organic rank, sponsored rank or rank change cannot match, in words;
 * null when it reads none of them, or when a fresh reading of each one it reads exists (a hand import).
 */
export function unsourcedRankNote(fields: readonly string[], census: Pick<KeywordRankFieldCensus, 'organicRank' | 'sponsoredRank' | 'maxAgeDays'>): string | null {
  const hit = Object.entries(NO_AUTOMATIC_SOURCE).filter(([field, s]) => fields.includes(field) && census[s.count] === 0)
  if (!hit.length) return null
  const names = hit.map(([, s]) => s.metric)
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  const one = names.length === 1
  const organic = hit.some(([, s]) => s.count === 'organicRank')
  const sponsored = hit.some(([, s]) => s.count === 'sponsoredRank')
  const why = [
    organic ? 'Amazon publishes no organic search position' : null,
    sponsored ? `${organic ? 'its' : 'Amazon\'s'} search-term impression rank is in the advertising console only, not in its API` : null,
  ].filter(Boolean).join(', and ')
  return `${list} ${one ? 'has' : 'have'} no automatic source: ${why}, so Nexus's keyword feed (Amazon Brand Analytics) ` +
    `fills Search Volume only. ${one ? 'It comes' : 'They come'} only from a hand import, and no keyword has a reading of ` +
    `${one ? 'it' : 'them'} from the last ${census.maxAgeDays} days — a condition on ${one ? 'it' : 'them'} matches no keyword.`
}
