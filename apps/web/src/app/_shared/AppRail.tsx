'use client'

/**
 * AppRail — the design system's rail (`@nexus/ui` patterns/shell) with this app's router.
 *
 * The rail, its row types and its stylesheet live in the design system since 2026-10-28 (so the factory app can draw
 * the same rail with its own router). This wrapper passes the workspace `Link`, which keeps the `/w/<id>` prefix, and
 * the workspace-free pathname the rows' hrefs are matched against. It adds no element: the markup is the pattern's.
 *
 * Imported from `patterns/shell`, not the patterns barrel: this file is in every page's chrome, and the full barrel
 * reaches the grid and its stylesheets.
 */

import Link from '@/lib/workspaces/Link'
import { usePathname } from '@/lib/workspaces/navigation'
import { AppRail as ShellRail, type AppRailProps as ShellRailProps } from '@/design-system/patterns/shell'

export type { RailMarketItem, RailNavItem, RailSubItem } from '@/design-system/patterns/shell'

export type AppRailProps = Omit<ShellRailProps, 'LinkComponent' | 'pathname'>

export function AppRail(props: AppRailProps) {
  const pathname = usePathname() || ''
  return <ShellRail {...props} pathname={pathname} LinkComponent={Link} />
}
