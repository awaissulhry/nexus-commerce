'use client'

// O.4 — /fulfillment/outbound is now a tab host. Pending (the new
// cornerstone — orders that need a shipment) is the default; Shipments
// preserves the prior pipeline view (DRAFT → DELIVERED). URL ?tab=
// preserves operator state across refresh / bookmark / link share.
//
// O.5 — Per-order drawer mounted at this level so ?drawer=<orderId>
// works regardless of which tab the operator is on.
//
// Future tabs (post-Wave 2):
//   • Returns coordination summary (link-out only — full UI in /fulfillment/returns)
//   • Late-shipment risk dashboard (O.19)

import { useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import PageHeader from '@/components/layout/PageHeader'
import { Tabs, type Tab } from '@/components/ui/Tabs'
import PendingShipmentsClient from './PendingShipmentsClient'
import ShipmentsClient from './ShipmentsClient'
import OutboundOrderDrawer from './OutboundOrderDrawer'

type TabId = 'pending' | 'shipments'

export default function OutboundWorkspace() {
  const router = useRouter()
  const params = useSearchParams()
  const activeTab: TabId = (params.get('tab') as TabId) === 'shipments' ? 'shipments' : 'pending'
  const drawerOrderId = params.get('drawer')

  const setTab = useCallback(
    (id: string) => {
      const next = new URLSearchParams(params.toString())
      // The Pending tab's own filters (channel, urgency, q, sort) are
      // tab-scoped — clear them when switching to Shipments to avoid
      // surprising state bleed.
      if (id === 'pending') next.delete('tab')
      else next.set('tab', id)
      if (id !== 'pending') {
        for (const k of ['channel', 'urgency', 'q', 'sort']) next.delete(k)
      }
      router.replace(`?${next.toString()}`, { scroll: false })
    },
    [params, router],
  )

  const closeDrawer = useCallback(() => {
    const next = new URLSearchParams(params.toString())
    next.delete('drawer')
    router.replace(`?${next.toString()}`, { scroll: false })
  }, [params, router])

  const tabs: Tab[] = [
    { id: 'pending', label: 'Pending' },
    { id: 'shipments', label: 'Shipments' },
  ]

  return (
    <div className="space-y-5">
      <PageHeader
        title="Outbound"
        description="Pick, pack, and ship orders across all channels. Pending = needs a shipment created. Shipments = mid-flight or done."
        breadcrumbs={[{ label: 'Fulfillment', href: '/fulfillment' }, { label: 'Outbound' }]}
      />
      <Tabs tabs={tabs} activeTab={activeTab} onChange={setTab} />
      {activeTab === 'pending' ? <PendingShipmentsClient /> : <ShipmentsClient />}
      <OutboundOrderDrawer orderId={drawerOrderId} onClose={closeDrawer} />
    </div>
  )
}
