/**
 * Reviews area — the one source for every Reviews page: the sub-sidebar (reviews-navigation.tsx), the crumbs each
 * page shows in its PageHeader (ReviewsShell.tsx `reviewsCrumbs`) and the page a path belongs to. Add or move a page
 * here and the sub-sidebar and crumbs follow.
 *
 * TEMPORARY TARGETS (Phase 1, build spec §1.2): a row whose new page is not built yet points at the page doing that
 * job today, and owns its old address through `match`. The coordinator swaps the row's `href` (one line) when the PR
 * that builds the page lands. The Inbox (PR B), the Requests rows — Queue, Rules, Timing (PR C) — and Settings (PR D,
 * `permission: 'reviews.manage'`, at the bottom as the design draws it) are on their own pages; the Insights rows wait
 * for theirs (`/marketing/reviews/insights/<page>`, PR E). The Channels group (PR F): Amazon and eBay, each "all
 * markets" plus one row per market the business sells on (`reviewsNav(markets)`; the markets come from
 * GET /api/reviews/area/channel-markets). Shopify and Etsy rows join with their pages (PR I).
 *
 * Framework-free (no React): the tests import it in Node.
 */
import {
  Bell,
  Clock,
  CornerDownRight,
  FileText,
  Inbox,
  LayoutDashboard,
  ListChecks,
  MessageSquareText,
  Package,
  Send,
  Settings,
  ShoppingBag,
  Store,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { marketOfSegment, marketWord, type ReviewsChannel } from '../_channel/reviewsScope'

export const REVIEWS_ROOT = '/marketing/reviews'

export interface ReviewsNavItem {
  label: string
  /** Where the row goes (workspace-free). */
  href: string
  icon: LucideIcon
  /** `href` is this row's page only, never an ancestor of other pages (Overview). */
  exact?: boolean
  /** Other paths (and the pages under them) this row owns: old addresses of its page, its records. */
  match?: readonly string[]
  /** A count from GET /api/sidebar/counts (`reviews`), shown when above 0. */
  badge?: 'needReply'
  /** A permission the row needs beyond seeing Reviews (the API's own rule for that page). */
  permission?: string
  /** `href/<market>` (two letters) is this page for one market: the crumbs add the market (the channel pages). */
  marketPages?: boolean
}

export interface ReviewsNavGroup {
  id: string
  label: string
  /** Its label opens and closes it (Requests, Insights); the top group is always open. */
  collapsible?: boolean
  /** The label stays for screen readers but is not drawn (the top group sits under the column title). */
  hideLabel?: boolean
  /** The group is not a crumb: "Marketing › Reviews › Amazon › Italy", not "… › Channels › Amazon". */
  noCrumb?: boolean
  items: readonly ReviewsNavItem[]
}

/** Render order, top to bottom. */
export const REVIEWS_NAV: readonly ReviewsNavGroup[] = [
  {
    id: 'reviews',
    label: 'Reviews',
    hideLabel: true,
    items: [
      { label: 'Overview', href: REVIEWS_ROOT, icon: LayoutDashboard, exact: true, match: [`${REVIEWS_ROOT}/advanced`] },
      { label: 'Inbox', href: `${REVIEWS_ROOT}/inbox`, icon: Inbox, badge: 'needReply' },
    ],
  },
  {
    id: 'requests',
    label: 'Requests',
    collapsible: true,
    items: [
      // Package inserts and Preview email are windows of the Queue (their old pages redirect to it: next.config.js).
      { label: 'Queue', href: `${REVIEWS_ROOT}/requests`, icon: Send },
      // Under Queue's address: the longer address wins, so a rule's editor (`/requests/rules/<id>`) stays on Rules.
      { label: 'Rules', href: `${REVIEWS_ROOT}/requests/rules`, icon: ListChecks },
      { label: 'Timing', href: `${REVIEWS_ROOT}/requests/timing`, icon: Clock },
    ],
  },
  {
    id: 'insights',
    label: 'Insights',
    collapsible: true,
    items: [
      // TEMPORARY until PR E: the old Heatmap, By product (and its product pages), Spikes, Actions and Spotlight pages.
      { label: 'Themes', href: `${REVIEWS_ROOT}/heatmap`, icon: MessageSquareText },
      { label: 'Products', href: `${REVIEWS_ROOT}/by-product`, icon: Package, match: [`${REVIEWS_ROOT}/products`] },
      { label: 'Alerts', href: `${REVIEWS_ROOT}/spikes`, icon: Bell },
      { label: 'Fixes', href: `${REVIEWS_ROOT}/actions`, icon: Wrench },
      { label: 'Brief', href: `${REVIEWS_ROOT}/spotlight`, icon: FileText },
    ],
  },
  {
    id: 'channels',
    label: 'Channels',
    collapsible: true,
    noCrumb: true,
    items: [
      // Each channel's "all markets" page; reviewsNav(markets) adds a row per market under it.
      { label: 'Amazon', href: `${REVIEWS_ROOT}/amazon`, icon: Store, marketPages: true },
      { label: 'eBay', href: `${REVIEWS_ROOT}/ebay`, icon: ShoppingBag, marketPages: true },
    ],
  },
  {
    id: 'settings',
    label: 'Reviews settings',
    hideLabel: true,
    items: [
      // The old Automation page redirects here (next.config.js: `?section=automations`).
      { label: 'Settings', href: `${REVIEWS_ROOT}/settings`, icon: Settings, match: [`${REVIEWS_ROOT}/automation`], permission: 'reviews.manage' },
    ],
  },
]

/** `path` is `prefix` or a page under it. Never a bare prefix: `/marketing/reviews` does not own `/marketing/reviewsx`. */
function under(prefix: string, path: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`)
}

/** How strongly `item` owns `path` (the length of its longest matching address), or -1. */
function claim(item: ReviewsNavItem, path: string): number {
  let best = -1
  if (item.exact ? path === item.href : under(item.href, path)) best = item.href.length
  for (const prefix of item.match ?? []) if (under(prefix, path) && prefix.length > best) best = prefix.length
  return best
}

/** The markets each channel page exists for (GET /api/reviews/area/channel-markets), as two-letter codes. */
export type ReviewsChannelMarkets = Partial<Record<ReviewsChannel, readonly string[]>>

const CHANNEL_OF_HREF: Record<string, ReviewsChannel> = { [`${REVIEWS_ROOT}/amazon`]: 'AMAZON', [`${REVIEWS_ROOT}/ebay`]: 'EBAY' }

/**
 * The navigation with a row per market under each channel ("Amazon Italy" under "Amazon"). The label names the channel
 * too: the sub-sidebar has no nesting, and "Italy" twice (Amazon and eBay) would be two links of the same name.
 */
export function reviewsNav(markets?: ReviewsChannelMarkets): readonly ReviewsNavGroup[] {
  if (!markets) return REVIEWS_NAV
  return REVIEWS_NAV.map(group => group.id !== 'channels' ? group : {
    ...group,
    items: group.items.flatMap(item => {
      const channel = CHANNEL_OF_HREF[item.href]
      const codes = [...new Set((channel ? markets[channel] ?? [] : []).map(code => marketOfSegment(code)).filter((c): c is string => !!c))]
      return [item, ...codes.map(code => ({
        label: `${item.label} ${marketWord(code)}`,
        href: `${item.href}/${code.toLowerCase()}`,
        icon: CornerDownRight,
        // `…/gb` is the UK's page too (marketOfSegment): its row stays current there.
        ...(code === 'UK' ? { match: [`${item.href}/gb`] } : {}),
      }))]
    }),
  })
}

/** The ONE row a (workspace-free) path belongs to: the longest matching address wins. None → undefined. */
export function findReviewsNavItem(path: string, markets?: ReviewsChannelMarkets): ReviewsNavItem | undefined {
  const clean = path.split(/[?#]/)[0].replace(/\/+$/, '') || '/'
  let best: ReviewsNavItem | undefined
  let bestLength = -1
  for (const group of reviewsNav(markets)) {
    for (const item of group.items) {
      const length = claim(item, clean)
      if (length > bestLength) {
        best = item
        bestLength = length
      }
    }
  }
  return best
}

/** The group of the row a path belongs to. */
export function findReviewsNavGroup(path: string): ReviewsNavGroup | undefined {
  const item = findReviewsNavItem(path)
  return item ? REVIEWS_NAV.find(group => group.items.includes(item)) : undefined
}

export interface ReviewsCrumb {
  label: string
  href: string
  /** This crumb is the page shown (aria-current). */
  current: boolean
}

/**
 * The crumbs for a (workspace-free) path: Marketing › Reviews › [Requests | Insights] › page. The Overview is
 * "Marketing › Reviews"; a group crumb opens the group's first page; a record under a page (a rule) ends on that page,
 * which is then a link, not the current page.
 */
export function reviewsCrumbTrail(path: string): ReviewsCrumb[] {
  const clean = path.split(/[?#]/)[0].replace(/\/+$/, '') || '/'
  const item = findReviewsNavItem(clean)
  const group = findReviewsNavGroup(clean)
  const isOverview = item?.href === REVIEWS_ROOT
  const trail: ReviewsCrumb[] = [
    { label: 'Marketing', href: '/marketing', current: false },
    { label: 'Reviews', href: REVIEWS_ROOT, current: clean === REVIEWS_ROOT },
  ]
  if (!item || isOverview) return trail
  if (group?.collapsible && !group.noCrumb) trail.push({ label: group.label, href: group.items[0].href, current: false })
  const onItsPage = clean === item.href || (item.match ?? []).includes(clean)
  trail.push({ label: item.label, href: item.href, current: onItsPage })
  // A channel's market page: "… › Amazon › Italy".
  const market = item.marketPages && clean.startsWith(`${item.href}/`) ? marketOfSegment(clean.slice(item.href.length + 1)) : null
  if (market) trail.push({ label: marketWord(market), href: clean, current: true })
  return trail
}
