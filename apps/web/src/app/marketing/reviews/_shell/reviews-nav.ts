/**
 * Reviews area — the one source for every Reviews page: the sub-sidebar (reviews-navigation.tsx), the crumbs each
 * page shows in its PageHeader (ReviewsShell.tsx `reviewsCrumbs`) and the page a path belongs to. Add or move a page
 * here and the sub-sidebar and crumbs follow.
 *
 * TEMPORARY TARGETS (Phase 1, build spec §1.2): a row whose new page is not built yet points at the page doing that
 * job today, and owns its old address through `match`. The coordinator swaps the row's `href` (one line) when the PR
 * that builds the page lands: Inbox (done, PR B); Rules → `/marketing/reviews/requests/rules`
 * and Timing → `/marketing/reviews/requests/timing` (PR C); the Insights rows → `/marketing/reviews/insights/<page>`
 * (PR E). The Channels group (PR F / PR I) and the Settings row (PR D, `permission: 'reviews.manage'`) are absent until
 * their pages exist, so no row names a page it is not.
 *
 * Framework-free (no React): the tests import it in Node.
 */
import {
  Bell,
  Clock,
  FileText,
  Inbox,
  LayoutDashboard,
  ListChecks,
  MessageSquareText,
  Package,
  Send,
  Wrench,
  type LucideIcon,
} from 'lucide-react'

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
}

export interface ReviewsNavGroup {
  id: string
  label: string
  /** Its label opens and closes it (Requests, Insights); the top group is always open. */
  collapsible?: boolean
  /** The label stays for screen readers but is not drawn (the top group sits under the column title). */
  hideLabel?: boolean
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
      // Same address before and after PR C; today it also owns the package-inserts and e-mail test pages.
      { label: 'Queue', href: `${REVIEWS_ROOT}/requests`, icon: Send, match: [`${REVIEWS_ROOT}/inserts`] },
      // TEMPORARY until PR C: the rules pages under Orders. `match` keeps their new addresses (under Queue's) on Rules and Timing.
      { label: 'Rules', href: '/orders/reviews/rules', icon: ListChecks, match: [`${REVIEWS_ROOT}/requests/rules`] },
      { label: 'Timing', href: '/orders/reviews/rules/timing', icon: Clock, match: [`${REVIEWS_ROOT}/requests/timing`] },
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

/** The ONE row a (workspace-free) path belongs to: the longest matching address wins. None → undefined. */
export function findReviewsNavItem(path: string): ReviewsNavItem | undefined {
  const clean = path.split(/[?#]/)[0].replace(/\/+$/, '') || '/'
  let best: ReviewsNavItem | undefined
  let bestLength = -1
  for (const group of REVIEWS_NAV) {
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
  if (group?.collapsible) trail.push({ label: group.label, href: group.items[0].href, current: false })
  const onItsPage = clean === item.href || (item.match ?? []).includes(clean)
  trail.push({ label: item.label, href: item.href, current: onItsPage })
  return trail
}
