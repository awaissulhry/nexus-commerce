'use client'

import { useEffect, useState, type MouseEvent, type RefObject } from 'react'
import { useSearchParams } from 'next/navigation'
import { usePathname, useRouter } from '@/lib/workspaces/navigation'
import { WorkspaceSubheader, type WorkspaceNavItem, type WorkspaceSubheaderProps } from '@/design-system/patterns'
import { useStudioScope } from './contracts'
import { visibleTabs } from './scopes'
import { STUDIO_TAB_ICONS, STUDIO_TAB_LABELS } from './navigation'
import { studioChannelViewHref, studioViewHref } from './navigationHref'
import type { StudioTabId } from './types'
import { StudioHeader } from './StudioHeader'
import { StudioBar } from './StudioBar'

export function StudioSubheader({ frameRef }: { frameRef: RefObject<HTMLDivElement> }) {
  const pathname = usePathname()
  const search = useSearchParams()
  const router = useRouter()
  const { scope, tab, market, options, setTab } = useStudioScope()
  const [chrome, setChrome] = useState<WorkspaceSubheaderProps['chrome']>()
  useEffect(() => {
    setChrome({
      header: document.querySelector<HTMLElement>('.nds-topbar'),
      primaryNavigation: frameRef.current?.closest('.h10-shell')?.querySelector<HTMLElement>('.h10-rail') ?? null,
    })
  }, [frameRef])

  // THIS PRODUCT holds the shared tasks; a channel's own tasks live in its own group below.
  const views = visibleTabs(scope).filter(id => !['presentation', 'variation-order', 'shopify-family', 'shopify-metafields'].includes(id)).map(id => ({
    id, label: STUDIO_TAB_LABELS[id], icon: STUDIO_TAB_ICONS[id], active: tab === id,
    href: studioViewHref(pathname, search.toString(), id),
  }))
  const channelGroups = options.channels.filter(channel => ['AMAZON', 'EBAY', 'SHOPIFY', 'ETSY'].includes(channel.id)).map(channel => {
    // 🔴 No per-channel Variants item (variants spec §1.2). A channel's projection IS the Variants page under
    // THIS PRODUCT with this channel's scope chip selected — a second way in would make the drawer bigger
    // rather than the page more capable (layout doc D9). The Owner restored eBay's separate Variation order
    // task on 2026-09-12; it uses the existing alias-scoped presentation editor.
    const tasks: Array<{ tab: StudioTabId; label: string }> = [{ tab: 'sheet', label: 'Listing information' }]
    if (channel.id === 'EBAY') tasks.push(
      { tab: 'presentation', label: STUDIO_TAB_LABELS.presentation },
      { tab: 'variation-order', label: STUDIO_TAB_LABELS['variation-order'] },
    )
    // Shopify keeps Product family: deleting a capability with no replacement fails the parity rule, and
    // the Relationships task that might one day have replaced it was removed (Owner, 2026-09-12).
    if (channel.id === 'SHOPIFY') tasks.push({ tab: 'shopify-family', label: 'Product family' })
    return { id: channel.id, label: channel.label, collapsible: true, items: tasks.map(task => ({
      id: `${channel.id}:${task.tab}`, label: task.label, icon: STUDIO_TAB_ICONS[task.tab],
      active: scope === channel.id && tab === task.tab, channel: channel.id, tab: task.tab,
      href: studioChannelViewHref(pathname, search.toString(), scope, market, channel, task.tab),
    })) }
  })
  const navigate = (event: MouseEvent<HTMLAnchorElement>, item: WorkspaceNavItem) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    const view = views.find(view => view.id === item.id)
    const channelView = channelGroups.flatMap(group => group.items).find(view => view.id === item.id)
    if (view) setTab(view.id)
    else if (channelView) setTab(channelView.tab, channelView.channel)
    else router.push(item.href)
  }

  return <>
    <WorkspaceSubheader
      header={<StudioHeader />}
      chrome={chrome}
      navigationLabel="Product navigation"
      groups={[
        { id: 'workspace', label: 'THIS PRODUCT', items: views },
        ...channelGroups,
        { id: 'context', label: 'CATALOG', items: [
          { id: 'products', label: 'Return to Products', href: '/products' },
        ] },
      ]}
      onNavigate={navigate}
    />
    <StudioBar />
  </>
}
