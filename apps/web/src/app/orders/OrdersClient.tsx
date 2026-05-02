'use client'

import { useMemo, useState } from 'react'
import { ShoppingBag } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { Tabs } from '@/components/ui/Tabs'

export interface Order {
  id: string
  channel: 'AMAZON' | 'EBAY' | 'SHOPIFY'
  channelOrderId: string
  status: 'PENDING' | 'SHIPPED' | 'CANCELLED' | 'DELIVERED'
  totalPrice: number | string
  customerName: string
  customerEmail: string
  itemCount: number
  createdAt: string
}

const STATUS_VARIANT: Record<
  Order['status'],
  'success' | 'warning' | 'danger' | 'info' | 'default'
> = {
  PENDING: 'warning',
  SHIPPED: 'info',
  CANCELLED: 'danger',
  DELIVERED: 'success',
}

interface Props {
  orders: Order[]
  stats: {
    total: number
    pending: number
    shipped: number
    cancelled: number
    delivered: number
  }
}

export function OrdersClient({ orders, stats }: Props) {
  const [tab, setTab] = useState<'ALL' | Order['status']>('ALL')

  const filtered = useMemo(() => {
    if (tab === 'ALL') return orders
    return orders.filter((o) => o.status === tab)
  }, [orders, tab])

  const tabs = [
    { id: 'ALL', label: 'All', count: stats.total },
    { id: 'PENDING', label: 'Pending', count: stats.pending },
    { id: 'SHIPPED', label: 'Shipped', count: stats.shipped },
    { id: 'DELIVERED', label: 'Delivered', count: stats.delivered },
    { id: 'CANCELLED', label: 'Cancelled', count: stats.cancelled },
  ]

  if (orders.length === 0) {
    return (
      <EmptyState
        icon={ShoppingBag}
        title="No orders yet"
        description="Orders synced from Amazon, eBay, and Shopify will appear here. Connect a channel or trigger a manual ingest to get started."
        action={{ label: 'Manage Connections', href: '/settings/channels' }}
      />
    )
  }

  return (
    <div className="space-y-4">
      <Card noPadding>
        <Tabs tabs={tabs} activeTab={tab} onChange={(id) => setTab(id as typeof tab)} />
      </Card>

      <Card noPadding>
        {filtered.length === 0 ? (
          <div className="px-4 py-8 text-center text-[12px] text-slate-500">
            No {tab.toLowerCase()} orders.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <Th>Order</Th>
                  <Th>Channel</Th>
                  <Th>Customer</Th>
                  <Th align="right">Items</Th>
                  <Th align="right">Total</Th>
                  <Th>Status</Th>
                  <Th>Date</Th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((o) => (
                  <tr
                    key={o.id}
                    className="border-b border-slate-100 hover:bg-slate-50 transition-colors"
                  >
                    <td className="px-4 py-2.5">
                      <div className="font-mono text-[12px] text-slate-900">
                        {o.channelOrderId.length > 20
                          ? `${o.channelOrderId.slice(0, 20)}…`
                          : o.channelOrderId}
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge variant="default" size="sm" mono>
                        {o.channel}
                      </Badge>
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="text-[13px] text-slate-900">{o.customerName}</div>
                      <div className="text-[11px] text-slate-500 truncate max-w-[220px]">
                        {o.customerEmail}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-right text-[13px] tabular-nums text-slate-700">
                      {o.itemCount}
                    </td>
                    <td className="px-4 py-2.5 text-right text-[13px] tabular-nums font-medium text-slate-900">
                      €{Number(o.totalPrice).toFixed(2)}
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge variant={STATUS_VARIANT[o.status]} size="sm">
                        {o.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-2.5 text-[12px] text-slate-500">
                      {new Date(o.createdAt).toLocaleDateString('en-GB', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}

function Th({
  children,
  align = 'left',
}: {
  children: React.ReactNode
  align?: 'left' | 'right'
}) {
  return (
    <th
      className={`px-4 py-2 text-[11px] font-semibold text-slate-700 uppercase tracking-wider ${
        align === 'right' ? 'text-right' : 'text-left'
      }`}
    >
      {children}
    </th>
  )
}
