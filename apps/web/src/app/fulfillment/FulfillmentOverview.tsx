'use client'

// FULFILLMENT B.9 — index page. Dashboard tiles for every fulfillment lane,
// each tile linking into the relevant section with the right filter applied.

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  Truck, PackageCheck, Boxes, Undo2, TrendingDown, RefreshCw,
  Warehouse as WarehouseIcon, AlertTriangle, ArrowRight, ShoppingCart,
} from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { getBackendUrl } from '@/lib/backend-url'

type Overview = {
  outbound: { pendingShipments: number; readyToPick: number; inTransit: number; deliveredToday: number; overduePending?: number }
  inbound: { openInbound: number; receivingNow: number; openWorkOrders: number }
  stock: { lowStock: number; outOfStock: number }
  returns: { pending: number; inspecting: number }
  replenishment: { critical: number }
  /** Optional — present when /api/fulfillment/overview includes the
   *  active-PO count. Falls back to 0 when absent so the tile still
   *  renders without a backend roundtrip. */
  purchaseOrders?: { active: number }
  suppliers: { active: number }
  defaultWarehouse: { name: string; code: string; country: string } | null
}

export default function FulfillmentOverview() {
  const [data, setData] = useState<Overview | null>(null)
  const [loading, setLoading] = useState(true)

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/overview`, { cache: 'no-store' })
      if (res.ok) setData(await res.json())
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  return (
    <div className="space-y-5">
      <PageHeader
        title="Fulfillment"
        description={data?.defaultWarehouse ? `Operating from ${data.defaultWarehouse.name} · ${data.defaultWarehouse.country}` : 'Multi-channel inventory + shipments + returns + replenishment'}
        actions={
          <button onClick={fetchData} className="h-8 px-3 text-base border border-slate-200 rounded-md hover:bg-slate-50 inline-flex items-center gap-1.5">
            <RefreshCw size={12} /> Refresh
          </button>
        }
      />

      {loading && !data ? (
        <Card><div className="text-md text-slate-500 py-8 text-center">Loading…</div></Card>
      ) : data ? (
        <>
          {/* Top alerts row */}
          {(data.replenishment.critical > 0 || data.stock.outOfStock > 0 || (data.outbound.overduePending ?? 0) > 0) && (
            <Card>
              <div className="flex items-center gap-3 flex-wrap">
                <AlertTriangle size={18} className="text-rose-600" />
                {/* O.81: overdue pending orders — past ship-by with no
                    shipment yet. Highest-priority operator action. */}
                {(data.outbound.overduePending ?? 0) > 0 && (
                  <Link href="/fulfillment/outbound?urgency=OVERDUE" className="text-md text-rose-700 hover:underline font-medium">
                    {data.outbound.overduePending} order{data.outbound.overduePending === 1 ? '' : 's'} past ship-by →
                  </Link>
                )}
                {data.replenishment.critical > 0 && (
                  <Link href="/fulfillment/replenishment" className="text-md text-rose-700 hover:underline font-medium">
                    {data.replenishment.critical} SKU{data.replenishment.critical === 1 ? '' : 's'} need urgent reorder →
                  </Link>
                )}
                {data.stock.outOfStock > 0 && (
                  <Link href="/fulfillment/stock?outOfStock=true" className="text-md text-rose-700 hover:underline font-medium ml-auto">
                    {data.stock.outOfStock} out of stock →
                  </Link>
                )}
              </div>
            </Card>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <SectionCard
              icon={Truck}
              title="Outbound"
              tone="bg-blue-50 text-blue-600"
              href="/fulfillment/outbound"
              stats={[
                { label: 'Pending', value: data.outbound.pendingShipments },
                { label: 'In transit', value: data.outbound.inTransit },
                { label: 'Delivered today', value: data.outbound.deliveredToday },
              ]}
              cta="Pick + pack + ship"
            />

            <SectionCard
              icon={PackageCheck}
              title="Inbound"
              tone="bg-emerald-50 text-emerald-600"
              href="/fulfillment/inbound"
              stats={[
                { label: 'Open', value: data.inbound.openInbound },
                { label: 'Receiving', value: data.inbound.receivingNow },
                { label: 'Work orders', value: data.inbound.openWorkOrders },
              ]}
              cta="Receive into warehouse · Send to FBA"
            />

            <SectionCard
              icon={Boxes}
              title="Stock"
              tone="bg-amber-50 text-amber-600"
              href="/fulfillment/stock"
              stats={[
                { label: 'Low stock', value: data.stock.lowStock, tone: data.stock.lowStock > 0 ? 'warning' : 'default' },
                { label: 'Out of stock', value: data.stock.outOfStock, tone: data.stock.outOfStock > 0 ? 'danger' : 'default' },
              ]}
              cta="View levels + audit log"
            />

            <SectionCard
              icon={Undo2}
              title="Returns"
              tone="bg-rose-50 text-rose-600"
              href="/fulfillment/returns"
              stats={[
                { label: 'Pending', value: data.returns.pending },
                { label: 'Inspecting', value: data.returns.inspecting },
              ]}
              cta="Inspect · refund · restock"
            />

            <SectionCard
              icon={TrendingDown}
              title="Replenishment"
              tone="bg-violet-50 text-violet-600"
              href="/fulfillment/replenishment"
              stats={[
                { label: 'Critical', value: data.replenishment.critical, tone: data.replenishment.critical > 0 ? 'danger' : 'default' },
              ]}
              cta="Velocity-driven reorder"
            />

            <SectionCard
              icon={ShoppingCart}
              title="Purchase Orders"
              tone="bg-amber-50 text-amber-600"
              href="/fulfillment/purchase-orders"
              stats={[
                { label: 'Active', value: data.purchaseOrders?.active ?? 0, tone: 'default' },
              ]}
              cta="Approval workflow"
            />

            <SectionCard
              icon={WarehouseIcon}
              title="Carriers"
              tone="bg-slate-50 text-slate-600"
              href="/fulfillment/carriers"
              stats={[
                { label: 'Suppliers', value: data.suppliers.active },
              ]}
              cta="Sendcloud · Buy Shipping"
            />
          </div>
        </>
      ) : null}
    </div>
  )
}

function SectionCard({
  icon: Icon, title, tone, href, stats, cta,
}: {
  icon: any
  title: string
  tone: string
  href: string
  stats: Array<{ label: string; value: number; tone?: 'default' | 'warning' | 'danger' }>
  cta: string
}) {
  return (
    <Link href={href} className="block group">
      <Card className="group-hover:border-slate-300 transition-colors h-full">
        <div className="flex items-start justify-between mb-3">
          <div className={`w-10 h-10 rounded-md inline-flex items-center justify-center ${tone}`}>
            <Icon size={18} />
          </div>
          <ArrowRight size={14} className="text-slate-400 group-hover:translate-x-0.5 transition-transform" />
        </div>
        <div className="text-lg font-semibold text-slate-900">{title}</div>
        <div className="text-sm text-slate-500 mb-3">{cta}</div>
        <div className="grid grid-cols-3 gap-3">
          {stats.map((s, i) => {
            const valueTone = s.tone === 'danger' ? 'text-rose-600' : s.tone === 'warning' ? 'text-amber-600' : 'text-slate-900'
            return (
              <div key={i}>
                <div className={`text-[20px] font-semibold tabular-nums ${valueTone}`}>{s.value}</div>
                <div className="text-xs uppercase tracking-wider text-slate-500">{s.label}</div>
              </div>
            )
          })}
        </div>
      </Card>
    </Link>
  )
}
