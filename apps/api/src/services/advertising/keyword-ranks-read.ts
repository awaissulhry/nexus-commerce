/**
 * The Keyword Tracker table's two hand routes, as pure parts (2026-10-10, honest numbers — AUDIT K1, K2, B5):
 *
 *   · `cleanKeywordRankImport` — what `POST /advertising/keyword-ranks` stores. A rank below 1 used to become #1
 *     (`Math.max(1, …)`) and a reading with no `capturedAt` was dated "now": both made a reading up. Now such an import
 *     is refused, whole, with the row and the reason.
 *   · `collapseKeywordRanks` — what `GET /advertising/keyword-ranks` answers. One item per keyword × market × ASIN (a
 *     delta across two ASINs is not a rank change), a reading that carries a rank represents the item over one that
 *     does not (the weekly Brand Analytics feed writes search volume only, rank null — it must not hide a hand-imported
 *     rank), and every item says how old it is and whether it is past KEYWORD_RANK_MAX_AGE_DAYS — the same rules
 *     `buildKeywordRankBidContexts` (advertising-rule-evaluator.job.ts) applies before a reading may move a bid.
 *
 * Pure: no database, no clock (the caller passes `now`).
 */
import { KEYWORD_RANK_MAX_AGE_DAYS } from './keyword-rank-feed.service.js'

const DAY_MS = 86_400_000

export interface KeywordRankImportRow {
  keyword?: string; marketplace?: string; asin?: string
  organicRank?: number; sponsoredRank?: number; searchVolume?: number
  capturedAt?: string; source?: string
}
export interface CleanKeywordRank {
  keyword: string; marketplace: string; asin: string | null
  organicRank: number | null; sponsoredRank: number | null; searchVolume: number | null
  capturedAt: Date; source: string
}
export interface KeywordRankImportRefusal { index: number; keyword: string | null; reason: string }

/**
 * A rank is Amazon's 1-based position: a value below 1, or one that is not a number, is not a reading — refused, never
 * turned into #1. Absent stays absent (null). Whole numbers as before (a fraction rounds).
 */
function rankOf(v: unknown, label: string): { value: number | null } | { reason: string } {
  if (v == null) return { value: null }
  const n = Number(v)
  if (!Number.isFinite(n)) return { reason: `${label} is not a number` }
  if (n < 1) return { reason: `${label} ${n} is below 1 — Amazon's positions start at 1` }
  return { value: Math.round(n) }
}

/**
 * The rows an import stores, or why it is refused. Rows with no keyword or market are skipped, as before (they name
 * nothing); a row with a rank below 1, a rank that is not a number, or no valid `capturedAt` (when it was observed)
 * refuses the WHOLE import — nothing is half-stored, and the caller fixes and resends.
 */
export function cleanKeywordRankImport(list: readonly KeywordRankImportRow[]): { rows: CleanKeywordRank[]; refused: KeywordRankImportRefusal[]; skipped: number } {
  const rows: CleanKeywordRank[] = []
  const refused: KeywordRankImportRefusal[] = []
  let skipped = 0
  list.forEach((r, index) => {
    if (!r || typeof r.keyword !== 'string' || !r.keyword.trim() || typeof r.marketplace !== 'string' || !r.marketplace.trim()) { skipped += 1; return }
    const keyword = r.keyword.trim()
    const reasons: string[] = []
    const organic = rankOf(r.organicRank, 'organicRank')
    const sponsored = rankOf(r.sponsoredRank, 'sponsoredRank')
    if ('reason' in organic) reasons.push(organic.reason)
    if ('reason' in sponsored) reasons.push(sponsored.reason)
    const at = typeof r.capturedAt === 'string' && r.capturedAt.trim() ? new Date(r.capturedAt) : null
    if (!at) reasons.push('capturedAt is required: when the rank was observed (an ISO date-time)')
    else if (Number.isNaN(at.getTime())) reasons.push(`capturedAt "${String(r.capturedAt).slice(0, 40)}" is not a date`)
    if (reasons.length) { refused.push({ index, keyword, reason: reasons.join('; ') }); return }
    rows.push({
      keyword,
      marketplace: r.marketplace.trim().toUpperCase(),
      asin: r.asin?.trim() || null,
      organicRank: (organic as { value: number | null }).value,
      sponsoredRank: (sponsored as { value: number | null }).value,
      searchVolume: r.searchVolume != null && Number.isFinite(Number(r.searchVolume)) ? Math.max(0, Math.round(Number(r.searchVolume))) : null,
      capturedAt: at!,
      source: (r.source?.trim() || 'manual').slice(0, 64),
    })
  })
  return { rows, refused, skipped }
}

/** A stored KeywordRank row as the GET reads it. */
export interface StoredKeywordRank {
  id: string; keyword: string; marketplace: string; asin: string | null
  organicRank: number | null; sponsoredRank: number | null; searchVolume: number | null
  capturedAt: Date; source: string
}

export interface KeywordRankItem {
  id: string; keyword: string; marketplace: string; asin: string | null
  organicRank: number | null; sponsoredRank: number | null
  /** The newest search-volume reading of this keyword × market × ASIN (searches per Brand Analytics week), with its date. */
  searchVolume: number | null; searchVolumeCapturedAt: Date | null
  /** When the reading that represents the item (the newest one carrying a rank, else the newest) was observed. */
  capturedAt: Date; source: string
  /** Whole days since `capturedAt`. */
  ageDays: number
  /** True past KEYWORD_RANK_MAX_AGE_DAYS: no engine acts on it (the Keyword Tracker rule ignores it). */
  stale: boolean
  /** The rank reading before, of the same ASIN; null when there is none. */
  priorCapturedAt: Date | null
  /** prior organic − latest organic (positive = moved toward #1); null without two ranks, or when the prior is stale. */
  rankDelta: number | null
}

const carriesRank = (r: StoredKeywordRank) => r.organicRank != null || r.sponsoredRank != null

/**
 * Latest + prior per keyword × market × ASIN, newest first in the input or not (it sorts). Ordered by keyword, market,
 * ASIN; `limit` items at most. Pure.
 */
export function collapseKeywordRanks(rows: readonly StoredKeywordRank[], now: Date, limit = 500): KeywordRankItem[] {
  const maxAgeMs = KEYWORD_RANK_MAX_AGE_DAYS * DAY_MS
  const sorted = [...rows].sort((a, b) => b.capturedAt.getTime() - a.capturedAt.getTime())
  const groups = new Map<string, StoredKeywordRank[]>()
  for (const r of sorted) {
    const k = `${r.keyword.trim().toLowerCase()}\u001f${r.marketplace}\u001f${r.asin ?? ''}`
    const g = groups.get(k)
    if (g) g.push(r); else groups.set(k, [r])
  }
  const items: KeywordRankItem[] = []
  for (const list of groups.values()) {
    const ranked = list.filter(carriesRank)
    const latest = ranked[0] ?? list[0]
    const prior = ranked.length ? ranked[1] : undefined
    const volume = list.find((r) => r.searchVolume != null)
    const age = now.getTime() - latest.capturedAt.getTime()
    const priorFresh = prior ? now.getTime() - prior.capturedAt.getTime() <= maxAgeMs : false
    items.push({
      id: latest.id, keyword: latest.keyword, marketplace: latest.marketplace, asin: latest.asin,
      organicRank: latest.organicRank, sponsoredRank: latest.sponsoredRank,
      searchVolume: volume?.searchVolume ?? null, searchVolumeCapturedAt: volume?.capturedAt ?? null,
      capturedAt: latest.capturedAt, source: latest.source,
      ageDays: Math.max(0, Math.floor(age / DAY_MS)),
      stale: age > maxAgeMs,
      priorCapturedAt: prior?.capturedAt ?? null,
      /**
       * KT-P3 — `null`, never `0`: a `0` means "rank did not change". And a change against a reading older than the
       * limit is not a recent change, so it is null then too (as the engine treats it).
       */
      rankDelta: prior && priorFresh && prior.organicRank != null && latest.organicRank != null ? prior.organicRank - latest.organicRank : null,
    })
  }
  items.sort((a, b) => a.keyword.localeCompare(b.keyword) || a.marketplace.localeCompare(b.marketplace) || (a.asin ?? '').localeCompare(b.asin ?? ''))
  return items.slice(0, Math.max(0, limit))
}

export { KEYWORD_RANK_MAX_AGE_DAYS }
