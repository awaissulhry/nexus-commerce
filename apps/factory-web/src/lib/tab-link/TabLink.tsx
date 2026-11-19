'use client'

import NextLink from 'next/link'
import type { TabLinkComponent } from '@nexus/ui/components'

/**
 * F-OP-210 (order page plan N4; 11-dock §4; review R-19) — the factory's link for a record page's link tabs (the DS `Tabs`' `linkAs`)
 * and its in-page tab links (the band's Money, the reapproval's Changes): Next's link that never prefetches. A tab's address carries
 * the dock's scope (`tabHref`), so a pick re-writes every tab's href; prefetching them would ask the server for seven pages on
 * each pick. A real link all the same: ⌘-click, middle-click and a copied address work.
 */
export const TabLink: TabLinkComponent = function TabLink({ href, children, ...rest }) {
  return (
    <NextLink href={href} prefetch={false} {...rest}>
      {children}
    </NextLink>
  )
}
