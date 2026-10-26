import type { ReactNode } from 'react'
import Link from '@/lib/workspaces/Link'
import { withoutWorkspace } from '@/lib/workspaces/paths'
import { reviewsCrumbTrail } from './reviews-nav'

/**
 * The crumbs for a Reviews page's PageHeader eyebrow: "Marketing › Reviews › [Requests | Insights] › page", from the
 * same source as the sub-sidebar (reviews-nav.ts). Same markup as the Listings pages' crumbs (ScopeCrumbs in
 * listings/_readiness/ListingReadinessClient.tsx); the page shown carries aria-current. Pass `usePathname()` from
 * `@/lib/workspaces/navigation`:
 *
 *   <PageHeader eyebrow={reviewsCrumbs(pathname)} title="Inbox" actions={<><ReviewsMenuButton />…</>} />
 */
export function reviewsCrumbs(pathname: string): ReactNode {
  return (
    <nav aria-label="Breadcrumb">
      {reviewsCrumbTrail(withoutWorkspace(pathname)).map((crumb, i) => (
        <span key={`${i}:${crumb.label}`}>
          {i > 0 && <span aria-hidden> › </span>}
          <Link href={crumb.href} aria-current={crumb.current ? 'page' : undefined}>{crumb.label}</Link>
        </span>
      ))}
    </nav>
  )
}
