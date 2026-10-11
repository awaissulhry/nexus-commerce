'use client'

import { usePathname } from 'next/navigation'

import { Tabs, activeTabFromPath, type TabItem } from '../components'

/*
 * 2026-10-10 — bid page DS lane: link tabs. The tabs are real links in a <nav>: ⌘/Ctrl-click or the context menu's
 * "Open link in new tab" opens a route in a new tab; the active tab comes from the route (`activeTabFromPath`), so on
 * this page "Design system" is current (aria-current="page"). Verify: Tab reaches each link, ←/→/Home/End move the
 * focus between them, Enter follows; "Hourly plan" goes nowhere and stays focusable (held). Light and dark, 390 px.
 */
const TABS: TabItem[] = [
  { id: 'catalog', label: 'Design system', href: '/design-system' },
  { id: 'grid-lab', label: 'Grid lab', href: '/design/grid-lab', count: 12 },
  { id: 'plan', label: 'Hourly plan (not built yet)', disabled: true },
]

export function LinkTabsExample() {
  const active = activeTabFromPath(TABS, usePathname()) ?? 'catalog'
  return (
    <div id="link-tabs-example">
      <Tabs ariaLabel="Example pages" tabs={TABS} active={active} size="lg" overflow="scroll" />
    </div>
  )
}
