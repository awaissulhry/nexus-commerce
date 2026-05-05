'use client'

// FULFILLMENT B.8 — Replenishment. Velocity (last 30d) + days-of-stock-left
// + urgency tiers (CRITICAL/HIGH/MEDIUM/LOW). One-click "Draft PO" creates a
// supplier purchase order; manufactured items create WorkOrders instead.

import { useCallback, useEffect, useState, useMemo } from 'react'
import Link from 'next/link'
import {
  RefreshCw, Factory,
  ShoppingCart, Sparkles,
} from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { EmptyState } from '@/components/ui/EmptyState'
import { getBackendUrl } from '@/lib/backend-url'

type Suggestion = {
  productId: string
  sku: string
  name: string
  currentStock: number
  unitsSold30d: number
  velocity: number
  daysOfStockLeft: number | null
  reorderPoint: number
  reorderQuantity: number
  urgency: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'
  needsReorder: boolean
  isManufactured: boolean
  preferredSupplierId: string | null
  fulfillmentChannel: string | null
}

const URGENCY_TONE: Record<string, string> = {
  CRITICAL: 'bg-rose-50 text-rose-700 border-rose-300',
  HIGH: 'bg-amber-50 text-amber-700 border-amber-300',
  MEDIUM: 'bg-blue-50 text-blue-700 border-blue-300',
  LOW: 'bg-slate-50 text-slate-600 border-slate-200',
}

export default function ReplenishmentWorkspace() {
  const [data, setData] = useState<{ suggestions: Suggestion[]; counts: any; window: number } | null>(null)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'ALL' | 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'NEEDS_REORDER'>('NEEDS_REORDER')
  const [search, setSearch] = useState('')

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/replenishment?window=30`, { cache: 'no-store' })
      if (res.ok) setData(await res.json())
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  const filtered = useMemo(() => {
    if (!data) return []
    let rows = data.suggestions
    if (filter === 'CRITICAL') rows = rows.filter((s) => s.urgency === 'CRITICAL')
    else if (filter === 'HIGH') rows = rows.filter((s) => s.urgency === 'HIGH' || s.urgency === 'CRITICAL')
    else if (filter === 'MEDIUM') rows = rows.filter((s) => s.urgency === 'MEDIUM')
    else if (filter === 'NEEDS_REORDER') rows = rows.filter((s) => s.needsReorder)
    if (search.trim()) {
      const s = search.trim().toLowerCase()
      rows = rows.filter((r) => r.sku.toLowerCase().includes(s) || r.name.toLowerCase().includes(s))
    }
    return rows
  }, [data, filter, search])

  const draftPo = async (s: Suggestion) => {
    if (s.isManufactured) {
      // Create a WorkOrder instead
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/work-orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: s.productId, quantity: s.reorderQuantity, notes: 'Replenishment auto-suggestion' }),
      })
      if (res.ok) {
        alert(`Work order created for ${s.reorderQuantity} × ${s.sku}`)
        fetchData()
      } else { alert('Work order create failed') }
      return
    }
    const res = await fetch(`${getBackendUrl()}/api/fulfillment/replenishment/${s.productId}/draft-po`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quantity: s.reorderQuantity, supplierId: s.preferredSupplierId }),
    })
    if (res.ok) {
      const po = await res.json()
      alert(`Draft PO ${po.poNumber} created`)
      fetchData()
    } else {
      alert('Draft PO failed')
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Smart Replenishment"
        description="Velocity-driven reorder suggestions based on the last 30 days of sales. One click creates a draft purchase order or work order."
        breadcrumbs={[{ label: 'Fulfillment', href: '/fulfillment' }, { label: 'Replenishment' }]}
      />

      {data && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <UrgencyTile label="Critical" value={data.counts.critical} tone="CRITICAL" onClick={() => setFilter('CRITICAL')} />
          <UrgencyTile label="High" value={data.counts.high} tone="HIGH" onClick={() => setFilter('HIGH')} />
          <UrgencyTile label="Medium" value={data.counts.medium} tone="MEDIUM" onClick={() => setFilter('MEDIUM')} />
          <UrgencyTile label="Low / OK" value={data.counts.low} tone="LOW" onClick={() => setFilter('ALL')} />
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <div className="inline-flex items-center bg-slate-100 rounded-md p-0.5">
          {(['NEEDS_REORDER', 'CRITICAL', 'HIGH', 'MEDIUM', 'ALL'] as const).map((t) => (
            <button key={t} onClick={() => setFilter(t)} className={`h-7 px-3 text-[12px] font-medium rounded transition-colors ${filter === t ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}>
              {t === 'NEEDS_REORDER' ? 'Needs reorder' : t.charAt(0) + t.slice(1).toLowerCase()}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Input placeholder="Search SKU…" value={search} onChange={(e) => setSearch(e.target.value)} className="w-56" />
          <button onClick={fetchData} className="h-8 px-3 text-[12px] border border-slate-200 rounded-md hover:bg-slate-50 inline-flex items-center gap-1.5">
            <RefreshCw size={12} /> Refresh
          </button>
        </div>
      </div>

      {loading && !data ? (
        <Card><div className="text-[13px] text-slate-500 py-8 text-center">Computing velocity from last 30 days…</div></Card>
      ) : filtered.length === 0 ? (
        <EmptyState icon={Sparkles} title="Nothing to reorder" description="All products in this view have plenty of runway." />
      ) : (
        <Card noPadding>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="border-b border-slate-200 bg-slate-50">
                <tr>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-700">Product</th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-700">Urgency</th>
                  <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-700">Stock</th>
                  <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-700">Velocity</th>
                  <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-700">Days left</th>
                  <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-700">Reorder pt</th>
                  <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-700">Suggested qty</th>
                  <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-700"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((s) => (
                  <tr key={s.productId} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="px-3 py-2">
                      <Link href={`/products/${s.productId}/edit`} className="text-[13px] text-slate-900 hover:text-blue-600 truncate block max-w-md">
                        {s.name}
                      </Link>
                      <div className="text-[11px] text-slate-500 font-mono inline-flex items-center gap-1.5">
                        {s.sku}
                        {s.isManufactured && <Factory size={10} className="text-violet-600" />}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <span className={`inline-block text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded ${URGENCY_TONE[s.urgency]}`}>{s.urgency}</span>
                    </td>
                    <td className={`px-3 py-2 text-right tabular-nums font-semibold ${s.currentStock === 0 ? 'text-rose-600' : s.currentStock <= s.reorderPoint ? 'text-amber-600' : 'text-slate-900'}`}>{s.currentStock}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700">{s.velocity}/d</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700">{s.daysOfStockLeft != null ? `${s.daysOfStockLeft}d` : '∞'}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-500">{s.reorderPoint}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-semibold text-slate-900">{s.reorderQuantity}</td>
                    <td className="px-3 py-2 text-right">
                      {s.needsReorder ? (
                        <button onClick={() => draftPo(s)} className="h-7 px-2 text-[11px] bg-emerald-50 text-emerald-700 border border-emerald-200 rounded hover:bg-emerald-100 inline-flex items-center gap-1">
                          {s.isManufactured ? <><Factory size={11} /> WO</> : <><ShoppingCart size={11} /> Draft PO</>}
                        </button>
                      ) : (
                        <span className="text-[10px] text-slate-400">OK</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}

function UrgencyTile({ label, value, tone, onClick }: { label: string; value: number; tone: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="text-left">
      <Card>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[24px] font-semibold tabular-nums text-slate-900">{value}</div>
            <div className="text-[11px] uppercase tracking-wider text-slate-500 mt-1">{label}</div>
          </div>
          <span className={`inline-block text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded ${URGENCY_TONE[tone]}`}>{tone}</span>
        </div>
      </Card>
    </button>
  )
}
