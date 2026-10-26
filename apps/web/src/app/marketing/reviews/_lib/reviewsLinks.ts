/**
 * Reviews area — the ONLY place a Reviews page builds a link to another Reviews page (or to the page that does that
 * job today). Each function returns a page that exists NOW: while the new page is still being built, it points at the
 * page doing that job today (the "today" lines below), and the coordinator switches the one function when the PR that
 * builds the new page lands. So no PR ships a link to a page that does not exist yet (scripts/check-link-targets.mjs),
 * and no page has to change when a link moves.
 *
 * Paths are workspace-free: render them with `Link` from `@/lib/workspaces/Link` (or `useRouter` from
 * `@/lib/workspaces/navigation`), which adds the business. Tested in reviewsLinks.vitest.test.ts, which also checks
 * that every target is a real page.
 */

import { REQUESTS_PATH, rulePath } from '../requests/requestsPaths'

type ParamValue = string | number | boolean | readonly (string | number)[] | null | undefined
export type LinkParams = Record<string, ParamValue>

/** `path?a=b&c=d` — empty, null, undefined and false values are left out; true is `1`; a list is comma-joined. */
export function withQuery(path: string, params: LinkParams = {}): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === '' || value === false) continue
    if (Array.isArray(value)) {
      if (value.length) query.set(key, value.join(','))
    } else query.set(key, value === true ? '1' : String(value))
  }
  const text = query.toString()
  return text ? `${path}?${text}` : path
}

/** The channel + market filter every page of today's Reviews screens reads (their shared filter bar). */
function scopeOnly(params: { channel?: string | null; market?: string | null }): LinkParams {
  return { channel: params.channel, market: params.market }
}

export interface InboxLinkParams {
  period?: string | null
  channel?: string | null
  market?: string | null
  kind?: 'product' | 'seller' | null
  stars?: readonly number[] | number | null
  status?: string | null
  theme?: string | null
  family?: string | null
  /** Open the Import window. */
  import?: boolean | 1 | null
}

/** The Inbox, `/marketing/reviews/inbox`, with every filter it reads (inbox/inboxQuery.ts) and the Import window. */
export function inboxHref(params: InboxLinkParams = {}): string {
  const { kind, period, status, channel, market, stars, theme, family } = params
  return withQuery('/marketing/reviews/inbox', { kind, period, status, channel, market, stars, theme, family, import: params.import ? 1 : null })
}

export interface RequestsLinkParams {
  period?: string | null
  channel?: string | null
  market?: string | null
  status?: string | null
  /** Open Package inserts. */
  inserts?: boolean | 1 | null
  /** Open Preview email. */
  preview?: boolean | 1 | null
}

/**
 * The request queue: `/marketing/reviews/requests` with its status, channel and market filters, and `inserts=1` /
 * `preview=1` to open Package inserts or Preview email once (the Queue reads them: `requests/_queue/queueQuery.ts`).
 */
export function requestsHref(params: RequestsLinkParams = {}): string {
  return withQuery(REQUESTS_PATH, {
    status: params.status,
    channel: params.channel,
    market: params.market,
    inserts: params.inserts ? 1 : null,
    preview: params.preview ? 1 : null,
  })
}

/** One review-request rule: its editor under Reviews › Requests › Rules. */
export function ruleHref(id: string): string {
  return rulePath(id)
}

export type InsightsPage = 'themes' | 'products' | 'alerts' | 'fixes' | 'brief'

export interface InsightsLinkParams {
  period?: string | null
  channel?: string | null
  market?: string | null
  sort?: string | null
  theme?: string | null
  /** One product's reviews. */
  product?: string | null
}

const INSIGHTS_TODAY: Record<InsightsPage, string> = {
  themes: '/marketing/reviews/heatmap',
  products: '/marketing/reviews/by-product',
  alerts: '/marketing/reviews/spikes',
  fixes: '/marketing/reviews/actions',
  brief: '/marketing/reviews/spotlight',
}

/**
 * An Insights page. New: `/marketing/reviews/insights/<page>` (PR E). Today: the old Heatmap, By product, Spikes,
 * Actions and Spotlight pages, which read only the channel and market; one product's reviews are their own page.
 */
export function insightsHref(page: InsightsPage, params: InsightsLinkParams = {}): string {
  if (page === 'products' && params.product) return productReviewsHref(params.product)
  return withQuery(INSIGHTS_TODAY[page], scopeOnly(params))
}

export type ReviewsSettingsSection = 'sources' | 'emails' | 'templates' | 'alerts' | 'automations' | 'pipeline'

/** Reviews settings. New: `/marketing/reviews/settings?section=…` (PR D). Today: Settings › Channels. */
export function reviewsSettingsHref(_section?: ReviewsSettingsSection): string {
  return '/settings/channels'
}

/** One product's reviews. New: the product pop-up on Insights › Products (PR E). Today: the old product page. */
export function productReviewsHref(productId: string): string {
  return `/marketing/reviews/products/${encodeURIComponent(productId)}`
}
