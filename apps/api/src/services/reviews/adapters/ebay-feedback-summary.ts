/**
 * Reviews › eBay page (2026-10-26, build spec §3.5 / B18) — eBay's own feedback summary for one seller account, read
 * from the Trading API `GetFeedback` answer: the feedback score, positive / neutral / negative counts per period
 * (`FeedbackSummary.*FeedbackPeriodArray`, typically 30, 180 and 365 days) and the four detailed seller ratings
 * (`SellerRatingSummaryArray.AverageRatingSummary`, FiftyTwoWeeks preferred over ThirtyDays).
 * https://developer.ebay.com/devzone/xml/docs/reference/ebay/GetFeedback.html
 *
 * eBay counts feedback per seller ACCOUNT, not per site: one account that sells on eBay Italy and eBay Germany has one
 * score. GetFeedback has no "% positive" field; eBay's own figure is positive ÷ (positive + negative) over 12 months,
 * which `positivePercent` computes from the 365-day counts.
 *
 * Pure — no network, no database (the call is `fetchEbayFeedbackSummary` in ebay-feedback.adapter.ts; the hourly
 * cache is ebay-feedback-summary.service.ts). Tested in ebay-feedback-summary.vitest.test.ts.
 */
import { XMLParser } from 'fast-xml-parser'

/** The four detailed seller ratings, in eBay's order, in the words the page shows. */
export const EBAY_DSR: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'ItemAsDescribed', label: 'Item as described' },
  { key: 'Communication', label: 'Communication' },
  { key: 'ShippingTime', label: 'Shipping time' },
  { key: 'ShippingAndHandlingCharges', label: 'Shipping charges' },
]

export interface EbayFeedbackPeriod {
  days: number
  positive: number
  neutral: number
  negative: number
}

export interface EbayDetailedRating {
  key: string
  label: string
  /** 1–5, eBay's average; null when eBay gave none. */
  rating: number | null
  count: number
}

export interface EbayFeedbackSummary {
  /** eBay's feedback score; null when the answer had none. */
  score: number | null
  /** Shortest period first. */
  periods: EbayFeedbackPeriod[]
  dsr: EbayDetailedRating[]
  /** Which window the detailed ratings cover. */
  dsrPeriod: 'FiftyTwoWeeks' | 'ThirtyDays' | null
}

/**
 * The request: the summary comes with any GetFeedback answer that has details, so it asks for the received-as-seller
 * feedback with ONE entry per page (the summary is the point; the 30-minute review read pulls the entries).
 */
export function ebayFeedbackSummaryRequest(): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<GetFeedbackRequest xmlns="urn:ebay:apis:eBLBaseComponents">` +
    `<DetailLevel>ReturnAll</DetailLevel>` +
    `<FeedbackType>FeedbackReceivedAsSeller</FeedbackType>` +
    `<Pagination><EntriesPerPage>1</EntriesPerPage><PageNumber>1</PageNumber></Pagination>` +
    `</GetFeedbackRequest>`
  )
}

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return []
  return Array.isArray(v) ? v : [v]
}

function int(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n) : null
}

function periodCounts(wrap: unknown): Map<number, number> {
  const out = new Map<number, number>()
  const list = asArray((wrap as { FeedbackPeriod?: unknown } | undefined)?.FeedbackPeriod as Record<string, unknown> | Record<string, unknown>[])
  for (const p of list) {
    const days = int(p?.PeriodInDays)
    const count = int(p?.Count)
    if (days != null && days > 0 && count != null && count >= 0) out.set(days, count)
  }
  return out
}

export type ParsedSummary = { ok: true; summary: EbayFeedbackSummary } | { ok: false; error: string }

/** eBay's GetFeedback answer → the summary, or eBay's own short message when it refused. */
export function parseEbayFeedbackSummary(xml: string): ParsedSummary {
  let doc: Record<string, unknown>
  try {
    doc = new XMLParser({ ignoreAttributes: true, parseTagValue: false }).parse(xml) as Record<string, unknown>
  } catch {
    return { ok: false, error: 'eBay sent an answer Nexus could not read.' }
  }
  const resp = (doc.GetFeedbackResponse ?? null) as Record<string, unknown> | null
  if (!resp) return { ok: false, error: 'eBay sent an answer Nexus could not read.' }
  if (String(resp.Ack ?? '') === 'Failure') {
    const error = asArray(resp.Errors as Record<string, unknown> | Record<string, unknown>[])[0]
    const words = typeof error?.ShortMessage === 'string' ? error.ShortMessage.trim() : ''
    return { ok: false, error: words ? `eBay refused the read: ${words.replace(/\.$/, '')}.` : 'eBay refused the read.' }
  }

  const summary = (resp.FeedbackSummary ?? {}) as Record<string, unknown>
  const positive = periodCounts(summary.PositiveFeedbackPeriodArray)
  const neutral = periodCounts(summary.NeutralFeedbackPeriodArray)
  const negative = periodCounts(summary.NegativeFeedbackPeriodArray)
  const days = [...new Set([...positive.keys(), ...neutral.keys(), ...negative.keys()])].sort((a, b) => a - b)
  const periods = days.map(d => ({ days: d, positive: positive.get(d) ?? 0, neutral: neutral.get(d) ?? 0, negative: negative.get(d) ?? 0 }))

  const summaries = asArray((summary.SellerRatingSummaryArray as { AverageRatingSummary?: unknown } | undefined)?.AverageRatingSummary as Record<string, unknown> | Record<string, unknown>[])
  const pick = summaries.find(s => s?.FeedbackSummaryPeriod === 'FiftyTwoWeeks') ?? summaries.find(s => s?.FeedbackSummaryPeriod === 'ThirtyDays') ?? null
  const details = asArray(pick?.AverageRatingDetails as Record<string, unknown> | Record<string, unknown>[])
  const dsr = EBAY_DSR.map(({ key, label }) => {
    const d = details.find(x => x?.RatingDetail === key)
    const rating = Number(d?.Rating)
    return {
      key,
      label,
      rating: d && Number.isFinite(rating) && rating > 0 ? Math.round(rating * 10) / 10 : null,
      count: int(d?.RatingCount) ?? 0,
    }
  })

  return {
    ok: true,
    summary: {
      score: int(resp.FeedbackScore),
      periods,
      dsr,
      dsrPeriod: pick ? (pick.FeedbackSummaryPeriod as 'FiftyTwoWeeks' | 'ThirtyDays') : null,
    },
  }
}

/** eBay's measure: positive ÷ (positive + negative), percent with one decimal; nothing counted → null. */
export function positivePercent(p: Pick<EbayFeedbackPeriod, 'positive' | 'negative'> | null | undefined): number | null {
  if (!p) return null
  const total = p.positive + p.negative
  return total > 0 ? Math.round((p.positive / total) * 1000) / 10 : null
}

/** The 12-month counts (365 days, or the longest period eBay sent). */
export function yearPeriod(summary: Pick<EbayFeedbackSummary, 'periods'>): EbayFeedbackPeriod | null {
  return summary.periods.find(p => p.days === 365) ?? summary.periods[summary.periods.length - 1] ?? null
}

/**
 * Several accounts on one page (eBay "All markets" with an account per market): scores and counts add up, each
 * detailed rating is the average weighted by its number of ratings. One account → itself.
 */
export function combineSummaries(list: readonly EbayFeedbackSummary[]): EbayFeedbackSummary | null {
  if (list.length === 0) return null
  if (list.length === 1) return list[0]
  const scores = list.map(s => s.score).filter((n): n is number => n != null)
  const byDays = new Map<number, EbayFeedbackPeriod>()
  for (const s of list) {
    for (const p of s.periods) {
      const slot = byDays.get(p.days) ?? { days: p.days, positive: 0, neutral: 0, negative: 0 }
      slot.positive += p.positive
      slot.neutral += p.neutral
      slot.negative += p.negative
      byDays.set(p.days, slot)
    }
  }
  const dsr = EBAY_DSR.map(({ key, label }) => {
    let sum = 0
    let count = 0
    for (const s of list) {
      const d = s.dsr.find(x => x.key === key)
      if (d?.rating == null || d.count <= 0) continue
      sum += d.rating * d.count
      count += d.count
    }
    return { key, label, rating: count > 0 ? Math.round((sum / count) * 10) / 10 : null, count }
  })
  const periods = list.map(s => s.dsrPeriod)
  return {
    score: scores.length ? scores.reduce((a, b) => a + b, 0) : null,
    periods: [...byDays.values()].sort((a, b) => a.days - b.days),
    dsr,
    dsrPeriod: periods.every(p => p === 'FiftyTwoWeeks') ? 'FiftyTwoWeeks' : periods.find(p => p != null) ?? null,
  }
}
