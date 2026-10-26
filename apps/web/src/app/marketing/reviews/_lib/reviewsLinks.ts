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

/**
 * The Inbox. New: `/marketing/reviews/inbox` with every filter (PR B). Today: the Respond page, which reads only the
 * channel and market; Import is its own page.
 */
export function inboxHref(params: InboxLinkParams = {}): string {
  if (params.import) return '/marketing/reviews/import'
  return withQuery('/marketing/reviews/desk', scopeOnly(params))
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
 * The request queue. New: `/marketing/reviews/requests` with filters and the inserts / e-mail preview windows
 * (PR C). Today: the same address shows the old requests page; Package inserts and the e-mail preview are their own
 * pages.
 */
export function requestsHref(params: RequestsLinkParams = {}): string {
  if (params.inserts) return '/marketing/reviews/inserts'
  if (params.preview) return '/marketing/reviews/requests/test/preview'
  return '/marketing/reviews/requests'
}

/** One review-request rule. New: `/marketing/reviews/requests/rules/<id>` (PR C). Today: the rules page under Orders. */
export function ruleHref(_id: string): string {
  return '/orders/reviews/rules'
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
