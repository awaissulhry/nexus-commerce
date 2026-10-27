/**
 * Reviews area — the ONLY place a Reviews page builds a link to another Reviews page. Each function returns a page that
 * exists (scripts/check-link-targets.mjs), so no page has to change when a link moves.
 *
 * Paths are workspace-free: render them with `Link` from `@/lib/workspaces/Link` (or `useRouter` from
 * `@/lib/workspaces/navigation`), which adds the business. Tested in reviewsLinks.vitest.test.ts, which also checks
 * that every target is a real page.
 */

import { REQUESTS_PATH, RULES_PATH, rulePath, timingPath } from '../requests/requestsPaths'

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

export interface InboxLinkParams {
  period?: string | null
  channel?: string | null
  market?: string | null
  kind?: 'product' | 'seller' | null
  stars?: readonly number[] | number | null
  status?: string | null
  theme?: string | null
  family?: string | null
  /** Only the reviews that need a reply (the badges' number: `needsReplyHref`). */
  reply?: 'needed' | null
  /** One product's reviews (and its variants'). */
  product?: string | null
  mood?: string | null
  /** Search text: the review, the buyer or the SKU (a product's reviews: its SKU). */
  q?: string | null
  /** Open the Import window. */
  import?: boolean | 1 | null
  /** Open this review's pop-up (the Inbox reads `?review=<id>` once on load). */
  review?: string | null
}

/**
 * The Inbox, `/marketing/reviews/inbox`, with every filter it reads (inbox/inboxQuery.ts), the Import window and one
 * review's pop-up.
 */
export function inboxHref(params: InboxLinkParams = {}): string {
  const { kind, period, status, channel, market, stars, mood, theme, family, reply, product, q, review } = params
  return withQuery('/marketing/reviews/inbox', { kind, period, status, channel, market, stars, mood, theme, family, reply, product, q, import: params.import ? 1 : null, review })
}

/**
 * The reviews that need a reply (the rail and sub-sidebar badges, the Overview's "Needs a reply" tile, a channel page's
 * tile): every date (`period=all`) and only the reviews the one needs-a-reply rule counts, so the Inbox shows the same
 * number the badge shows.
 */
export function needsReplyHref(scope: { channel?: string | null; market?: string | null } = {}): string {
  return inboxHref({ reply: 'needed', period: 'all', channel: scope.channel, market: scope.market })
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
 * The request queue: `/marketing/reviews/requests` with its status, channel, market and period (a link from a page keeps
 * that page's period: 7d, 30d — the Queue's default, left out —, 90d, 12m or all), and `inserts=1` / `preview=1` to open
 * Package inserts or Preview email once (the Queue reads them: `requests/_queue/queueQuery.ts`).
 */
export function requestsHref(params: RequestsLinkParams = {}): string {
  return withQuery(REQUESTS_PATH, {
    period: params.period === '30d' ? null : params.period,
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

/** Reviews › Requests › Rules (every rule). */
export function rulesHref(): string {
  return RULES_PATH
}

/** Reviews › Requests › Timing. */
export function timingHref(): string {
  return timingPath()
}

export type InsightsPage = 'themes' | 'products' | 'alerts' | 'fixes' | 'brief'

export interface InsightsLinkParams {
  /** The shared Insights scope (insights/_shared/insightsScope.ts): 30 days is the default and leaves the address. */
  period?: string | null
  channel?: string | null
  market?: string | null
  /** Themes: Mentions / Star impact / Change. */
  sort?: string | null
  /** Products: the top complaint filter. */
  theme?: string | null
  /** Products: open this product's pop-up; Fixes: only this product's fixes. */
  product?: string | null
  /** Alerts: Open / Acknowledged / Resolved. Fixes: Open / Sent / Applied / Dismissed. */
  status?: string | null
  /** Fixes: the kinds shown (BULLETS, APLUS, SIZE_GUIDE, RECALL_FLAG, TASK). */
  kind?: string | readonly string[] | null
  /** Brief: one earlier brief, read-only. */
  brief?: string | null
}

/**
 * An Insights page, `/marketing/reviews/insights/<page>` (PR E), with the shared scope and the page's own values. Each
 * page reads them back once (`insightsScope.ts` and its own `*Query`/`*Model`).
 */
export function insightsHref(page: InsightsPage, params: InsightsLinkParams = {}): string {
  const { channel, market, sort, theme, product, status, kind, brief } = params
  return withQuery(`/marketing/reviews/insights/${page}`, {
    channel,
    market,
    period: params.period === '30d' ? null : params.period,
    sort,
    theme,
    product,
    status,
    kind: typeof kind === 'string' ? kind : kind ?? null,
    brief,
  })
}

export type ReviewsSettingsSection = 'sources' | 'emails' | 'templates' | 'alerts' | 'automations' | 'pipeline'

/** Reviews › Settings, `/marketing/reviews/settings`; `section` scrolls to that section once (settingsModel.ts). */
export function reviewsSettingsHref(section?: ReviewsSettingsSection | null): string {
  return withQuery('/marketing/reviews/settings', { section })
}

/** One product's reviews: the product pop-up over Insights › Products (`?product=<id>`). */
export function productReviewsHref(productId: string, scope: { channel?: string | null; market?: string | null; period?: string | null } = {}): string {
  return insightsHref('products', { ...scope, product: productId })
}

/**
 * A channel's Reviews page (PR F): `/marketing/reviews/amazon`, `/marketing/reviews/amazon/it`, `/marketing/reviews/ebay/de`
 * (`GB` is the UK's `uk`). Shopify and Etsy pages come later (PR I): until then their reviews open in the Inbox, scoped.
 */
export function channelHref(channel: string, market?: string | null): string {
  const c = channel.trim().toUpperCase()
  if (c !== 'AMAZON' && c !== 'EBAY') return inboxHref({ channel: c, market })
  const code = market?.trim().toUpperCase()
  const segment = code && /^[A-Z]{2}$/.test(code) ? (code === 'GB' ? 'uk' : code.toLowerCase()) : null
  return `/marketing/reviews/${c.toLowerCase()}${segment ? `/${segment}` : ''}`
}
