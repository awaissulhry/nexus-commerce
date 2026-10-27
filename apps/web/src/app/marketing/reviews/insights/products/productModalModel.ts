/**
 * Reviews › Insights › Products — the product pop-up's words (build spec §3.4, the product-detail board): the header,
 * the tabs, rating per channel and market (eBay as "% positive"; Amazon only from imported reviews, else "No rating data
 * from Amazon — import reviews", ruling 5), the themes, the returns, the latest reviews, Prev / Next, and why "Suggest a
 * fix" is held. Pure, tested in productModalModel.vitest.test.ts. The numbers are the API's
 * (`GET /api/reviews/insights/products/:productId`).
 */
import { channelMarketWords, feedbackWords, starsWord } from '../../_lib/reviewWords'
import { inboxHref } from '../../_lib/reviewsLinks'
import type { InsightsScope } from '../_shared/insightsScope'
import { fitMentions, type ProductFit } from '../_shared/fitView'

// ── The API's answer ────────────────────────────────────────────────

export interface ReturnRateCell {
  rate: number | null
  returns: number
  orders: number
}

export interface ProductMarketRating {
  channel: string
  market: string | null
  label: string
  kind: 'stars' | 'positive'
  rating: number | null
  count: number
  change: number | null
  words: string
}

export interface ProductDetailTheme {
  key: string
  label: string
  mentions: number
  share: number | null
  starImpact: number | null
  starImpactFrom: 'reviews' | 'amazon_topic' | null
  quote: { text: string; english: string | null; from: string; source: 'amazon_topic' | 'review' } | null
}

export interface ProductDetailReview {
  id: string
  channel: string
  market: string | null
  where: string
  imported: boolean
  kind: 'stars' | 'feedback'
  rating: number | null
  text: string
  english: string | null
  language: string | null
  buyer: string | null
  postedAt: string
  themes: string[]
}

export interface ProductDetail {
  product: { id: string; name: string; sku: string; variant: string | null; family: { id: string; name: string } | null; isFamily: boolean; variants: number }
  scope: { channel: string | null; market: string | null; period: string }
  summary: { rating: number | null; ratingWords: string; change: number | null; reviews: number; reviewsAllTime: number; soldOn: string[] }
  openAlerts: Array<{ id: string; theme: string; market: string; status: string }>
  markets: ProductMarketRating[]
  spread: [number, number, number, number, number]
  themes: ProductDetailTheme[]
  /** Its family's fit per size and per variant (null only when the family is gone). */
  fit: ProductFit | null
  latest: ProductDetailReview[]
  returns: {
    windowDays: number
    rate: ReturnRateCell | null
    family: ReturnRateCell | null
    withReview: number
    topReason: { reason: string; share: number } | null
    reasons: Array<{ reason: string; count: number; share: number }>
  }
  topicsAt: string | null
  generatedAt: string
}

// ── Tabs ────────────────────────────────────────────────────────────

export const PRODUCT_TABS = ['summary', 'reviews', 'themes', 'returns', 'sizes'] as const
export type ProductTab = (typeof PRODUCT_TABS)[number]

export function parseProductTab(raw: string | null | undefined): ProductTab {
  return (PRODUCT_TABS as readonly string[]).includes(raw ?? '') ? (raw as ProductTab) : 'summary'
}

/** The tabs with their counts (Sizes: fit mentions placed on a size). */
export function productTabs(detail: ProductDetail | null): Array<{ id: ProductTab; label: string; count?: number | null; badge?: string }> {
  return [
    { id: 'summary', label: 'Summary' },
    { id: 'reviews', label: 'Reviews', count: detail ? detail.summary.reviews : null },
    { id: 'themes', label: 'Themes', count: detail ? detail.themes.length : null },
    { id: 'returns', label: 'Returns', count: detail ? detail.returns.reasons.reduce((n, r) => n + r.count, 0) : null },
    { id: 'sizes', label: 'Sizes', count: detail ? fitMentions(detail.fit) : null },
  ]
}

// ── Header ──────────────────────────────────────────────────────────

/** "Touring jacket — M · Black" (a variant), else the name. */
export function productTitle(p: Pick<ProductDetail['product'], 'name' | 'variant'>): string {
  return p.variant ? `${p.name} — ${p.variant}` : p.name
}

/** "Touring jacket family · 4 sizes and colours · SKU TJ-BLK · 188 reviews and feedback · sold on Amazon Italy, eBay Italy". */
export function productSubtitle(detail: ProductDetail): string {
  const p = detail.product
  const parts: string[] = []
  if (p.family) parts.push(`${p.family.name} family`)
  if (p.isFamily) parts.push(`${p.variants} ${p.variants === 1 ? 'size or colour' : 'sizes and colours'}`)
  parts.push(`SKU ${p.sku}`)
  const n = detail.summary.reviews
  parts.push(`${n.toLocaleString('en-IE')} ${n === 1 ? 'review or feedback' : 'reviews and feedback'} in the period`)
  if (detail.summary.soldOn.length) parts.push(`sold on ${detail.summary.soldOn.join(', ')}`)
  return parts.join(' · ')
}

export interface HeaderPill {
  text: string
  tone: 'neutral' | 'danger' | 'warning' | 'success'
}

/** "4.0 average" · "Down 0.3 in 30 days" · "1 open alert". */
export function headerPills(detail: ProductDetail, periodLabel: string): HeaderPill[] {
  const pills: HeaderPill[] = []
  const s = detail.summary
  pills.push(s.rating == null ? { text: s.ratingWords, tone: 'neutral' } : { text: `${s.rating.toFixed(1)} average`, tone: 'neutral' })
  if (s.change != null && s.change !== 0) {
    pills.push({ text: `${s.change < 0 ? 'Down' : 'Up'} ${Math.abs(s.change).toFixed(1)} in ${periodLabel.replace(/^last /, '')}`, tone: s.change < 0 ? 'danger' : 'success' })
  }
  const open = detail.openAlerts.length
  if (open) pills.push({ text: `${open} open ${open === 1 ? 'alert' : 'alerts'}`, tone: 'warning' })
  return pills
}

// ── Rating per channel and market ───────────────────────────────────

export interface MarketRow {
  key: string
  where: string
  /** Under the name: where the rating comes from (ruling 5). */
  note: string
  kind: 'stars' | 'positive' | 'none'
  value: string
  stars: number | null
  reviews: string
  change: string
}

/** One row per channel and market: stars, "% positive" (eBay), or no rating data (Amazon without imported reviews). */
export function marketRows(detail: ProductDetail): MarketRow[] {
  return detail.markets.map((m) => {
    const none = m.rating == null
    const kind = none ? 'none' : m.kind
    const value = none ? '—' : m.kind === 'positive' ? `${Math.round(m.rating as number)}%` : (m.rating as number).toFixed(1)
    const change = m.change == null || m.change === 0 ? (m.change === 0 ? 'Same' : '—') : m.kind === 'positive' ? `${m.change > 0 ? '+' : '−'}${Math.abs(m.change).toFixed(1)} pts` : `${m.change > 0 ? '+' : '−'}${Math.abs(m.change).toFixed(1)}`
    return {
      key: `${m.channel}|${m.market ?? ''}`,
      where: m.label || channelMarketWords(m.channel, m.market),
      note: m.words,
      kind,
      value,
      stars: m.kind === 'stars' ? m.rating : null,
      reviews: m.count.toLocaleString('en-IE'),
      change,
    }
  })
}

/** An Amazon row with no rating data offers the Inbox's Import window (the only way Amazon stars reach Nexus). */
export function needsImport(row: MarketRow): boolean {
  return row.kind === 'none' && /import reviews/i.test(row.note)
}

// ── Themes ──────────────────────────────────────────────────────────

/** "−0.8 ★" with its tone and words; none → too few. */
export function themeImpact(t: Pick<ProductDetailTheme, 'starImpact' | 'starImpactFrom'>): { text: string; tone: 'danger' | 'warning' | 'success' | 'neutral'; words: string } {
  const n = t.starImpact
  if (n == null) return { text: '—', tone: 'neutral', words: 'Too few mentions to measure its effect on stars' }
  const sign = n > 0 ? '+' : n < 0 ? '−' : ''
  const from = t.starImpactFrom === 'amazon_topic' ? ', from Amazon’s topics' : ''
  return {
    text: `${sign}${Math.abs(n).toFixed(1)} ★`,
    tone: n <= -0.5 ? 'danger' : n < 0 ? 'warning' : n > 0 ? 'success' : 'neutral',
    words: n === 0 ? `No effect on stars${from}` : `${Math.abs(n).toFixed(2)} stars ${n < 0 ? 'below' : 'above'} this product’s average${from}`,
  }
}

/** A theme's reviews of this product in the Inbox (its SKU in the search; Amazon's topics have no reviews to open). */
export function themeInboxHref(detail: ProductDetail, themeKey: string, scope: InsightsScope): string {
  return inboxHref({ theme: themeKey, q: detail.product.sku, channel: scope.channel, market: scope.market, period: scope.period })
}

/** Every review of this product in the Inbox: its SKU in the search (a family's variants carry it in theirs). */
export function allReviewsHref(detail: ProductDetail, scope: InsightsScope): string {
  return inboxHref({ q: detail.product.sku, channel: scope.channel, market: scope.market, period: scope.period })
}

/** One review's pop-up in the Inbox. */
export function reviewHref(reviewId: string): string {
  return inboxHref({ review: reviewId })
}

// ── Latest reviews ──────────────────────────────────────────────────

const LANGUAGE: Record<string, string> = { de: 'German', it: 'Italian', fr: 'French', es: 'Spanish', nl: 'Dutch', pl: 'Polish', sv: 'Swedish', en: 'English' }

/** "German"; unknown → its code; none → null. */
export function languageName(code: string | null | undefined): string | null {
  if (!code) return null
  return LANGUAGE[code.toLowerCase()] ?? code.toUpperCase()
}

/** "today", "yesterday", "3 days ago", "12 Oct". */
export function whenWords(iso: string, now: Date): string {
  const days = Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 14) return `${days} days ago`
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

/** eBay feedback in words — the one helper in _lib/reviewWords.ts. */
export { feedbackWords }

/** "Buyer K. · Amazon Germany · imported from a file". */
export function reviewByline(r: ProductDetailReview): string {
  return [r.buyer ?? 'Buyer not named', r.where, r.imported ? 'imported from a file' : null].filter(Boolean).join(' · ')
}

/** A star review's name for a reader. */
export function reviewStarsWords(r: ProductDetailReview): string {
  return r.kind === 'feedback' ? feedbackWords(r.rating).text : starsWord(r.rating)
}

// ── Returns ─────────────────────────────────────────────────────────

const rateText = (c: ReturnRateCell | null) => (c?.rate == null ? '—' : `${c.rate.toFixed(c.rate % 1 === 0 ? 0 : 1)}%`)

/** The three numbers at the top of Returns. */
export function returnsFacts(detail: ProductDetail): Array<{ label: string; value: string; hint: string }> {
  const r = detail.returns
  const rate = r.rate
  return [
    {
      label: 'Return rate',
      value: rateText(rate),
      hint: [r.family ? `family ${rateText(r.family)}` : null, rate ? `${rate.returns} of ${rate.orders} orders` : 'no orders in the window', `last ${r.windowDays} days`].filter(Boolean).join(' · '),
    },
    { label: 'Returns with a review', value: String(r.withReview), hint: 'the same order also has a review' },
    { label: 'Top reason', value: r.topReason?.reason ?? 'None', hint: r.topReason ? `${r.topReason.share}% of returns` : 'no return gave a reason' },
  ]
}

// ── Prev / Next and Suggest a fix ───────────────────────────────────

/** The products the pop-up walks with K / J: each family, then its sizes and colours, in the grid's order. */
export function navIds(families: ReadonlyArray<{ productId: string; variants: ReadonlyArray<{ productId: string }> }>): string[] {
  const ids: string[] = []
  for (const f of families) {
    ids.push(f.productId)
    for (const v of f.variants) if (!ids.includes(v.productId)) ids.push(v.productId)
  }
  return ids
}

export const MANAGE_FIX = "You need 'Manage reviews' to ask for fixes."

/** Why "Suggest a fix" is held (null = it can ask): the permission, then nothing to work from. */
export function suggestHeld(canManage: boolean, detail: ProductDetail | null): string | null {
  if (!canManage) return MANAGE_FIX
  if (!detail) return 'Wait until the product has loaded.'
  if (detail.summary.reviews === 0 && detail.themes.length === 0) return 'No reviews or Amazon topics in this period to suggest a fix from. Pick a longer period.'
  return null
}

/** The product studio for this product. */
export function studioHref(productId: string): string {
  return `/products/${encodeURIComponent(productId)}/edit/studio`
}

/** The toast after "Suggest a fix": how many fixes the AI wrote (the server's count). */
export function suggestResultWords(created: number, words?: string | null): string {
  if (created === 0) return words || 'The AI suggested no fix for this product. Nothing changed.'
  return `${created} ${created === 1 ? 'fix' : 'fixes'} suggested — opening Fixes. Nothing changes on a channel before a person approves.`
}
