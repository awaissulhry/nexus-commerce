import type { WorkspaceNavGroup } from '@/design-system/patterns/WorkspaceSubheader'
import { navPagePermission } from '@/lib/auth/nav-permissions'
import { withoutWorkspace, workspaceFromPath, workspaceHref } from '@/lib/workspaces/paths'
import { findReviewsNavItem, reviewsNav, type ReviewsChannelMarkets, type ReviewsNavItem } from './reviews-nav'

/** The Reviews counts the sub-sidebar shows (GET /api/sidebar/counts → `reviews`). */
export interface ReviewsNavCounts {
  needReply?: number
}

/**
 * May this person open the row? Its own permission (Settings: manage reviews) and the page permission of where it
 * goes: a row that points at a page outside Reviews is hidden from someone who cannot open that page, instead of
 * leading to "no access".
 */
export function reviewsNavItemAllowed(item: ReviewsNavItem, has: (permission: string) => boolean): boolean {
  const page = navPagePermission(item.href)
  return (!item.permission || has(item.permission)) && (page === null || has(page))
}

/**
 * The Reviews sub-sidebar for WorkspaceSubheader. Native links keep the business (`/w/<id>/…`) so a copied link or a
 * new tab opens the same business; exactly one row is the current page; rows a person may not open are dropped
 * before the links are scoped, and a group left empty is dropped with them. `markets` adds a row per channel market
 * under Amazon and eBay (the channel pages); a market page's own row is then the current one.
 */
export function buildReviewsNavigation(
  pathname: string,
  hasPermission?: (permission: string) => boolean,
  counts?: ReviewsNavCounts,
  markets?: ReviewsChannelMarkets,
): WorkspaceNavGroup[] {
  const workspaceId = workspaceFromPath(pathname)
  const active = findReviewsNavItem(withoutWorkspace(pathname), markets)
  const badge = (item: ReviewsNavItem) => {
    const n = item.badge === 'needReply' ? counts?.needReply : undefined
    return n != null && n > 0 ? n.toLocaleString('en') : undefined
  }

  return reviewsNav(markets).map(group => ({
    id: group.id.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    label: group.label,
    collapsible: group.collapsible,
    hideLabel: group.hideLabel,
    items: group.items
      .filter(item => !hasPermission || reviewsNavItemAllowed(item, hasPermission))
      .map(item => {
        const Icon = item.icon
        return {
          id: item.href,
          href: workspaceHref(workspaceId, item.href),
          label: item.label,
          icon: <Icon size={16} aria-hidden />,
          // By address: market rows are made per call, so the same row is a new object each time.
          active: active?.href === item.href,
          badge: badge(item),
        }
      }),
  })).filter(group => group.items.length > 0)
}
