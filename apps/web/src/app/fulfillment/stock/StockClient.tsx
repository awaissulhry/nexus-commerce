'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowDownUp, AlertTriangle } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Badge } from '@/components/ui/Badge'
import { Tabs } from '@/components/ui/Tabs'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'

export interface StockRow {
  id: string
  sku: string
  name: string
  totalStock: number
  lowStockThreshold: number
  fulfillmentChannel: 'FBA' | 'FBM' | null
  amazonAsin: string | null
  isParent: boolean
}

type LocationFilter = 'ALL' | 'FBA' | 'FBM'
type SortKey = 'stock-asc' | 'stock-desc' | 'sku' | 'name'

export function StockClient({ rows }: { rows: StockRow[] }) {
  const [search, setSearch] = useState('')
  const [location, setLocation] = useState<LocationFilter>('ALL')
  const [sort, setSort] = useState<SortKey>('stock-asc')

  const counts = useMemo(() => {
    const fba = rows.filter((r) => r.fulfillmentChannel === 'FBA').length
    const fbm = rows.filter((r) => r.fulfillmentChannel === 'FBM').length
    return { all: rows.length, fba, fbm }
  }, [rows])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    let out = rows.filter((r) => {
      if (location === 'FBA' && r.fulfillmentChannel !== 'FBA') return false
      if (location === 'FBM' && r.fulfillmentChannel !== 'FBM') return false
      if (q && !r.sku.toLowerCase().includes(q) && !r.name.toLowerCase().includes(q)) {
        return false
      }
      return true
    })
    switch (sort) {
      case 'stock-asc':
        out = [...out].sort((a, b) => a.totalStock - b.totalStock)
        break
      case 'stock-desc':
        out = [...out].sort((a, b) => b.totalStock - a.totalStock)
        break
      case 'sku':
        out = [...out].sort((a, b) => a.sku.localeCompare(b.sku))
        break
      case 'name':
        out = [...out].sort((a, b) => a.name.localeCompare(b.name))
        break
    }
    return out
  }, [rows, search, location, sort])

  const lowStockCount = filtered.filter((r) => r.totalStock <= r.lowStockThreshold).length

  const tabs = [
    { id: 'ALL', label: 'All', count: counts.all },
    { id: 'FBA', label: 'FBA', count: counts.fba },
    { id: 'FBM', label: 'FBM', count: counts.fbm },
  ]

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex-1 min-w-[240px] max-w-md">
            <Input
              placeholder="Search by SKU or product name"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="h-8 px-3 text-[13px] border border-slate-200 rounded-md bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
          >
            <option value="stock-asc">Stock: Low → High</option>
            <option value="stock-desc">Stock: High → Low</option>
            <option value="sku">SKU (A-Z)</option>
            <option value="name">Name (A-Z)</option>
          </select>
          <div className="text-[12px] text-slate-500 ml-auto tabular-nums flex items-center gap-2">
            {lowStockCount > 0 && (
              <Badge variant="warning" size="sm">
                <AlertTriangle className="w-3 h-3" />
                {lowStockCount} low stock
              </Badge>
            )}
            <span>
              {filtered.length} of {rows.length}
            </span>
          </div>
        </div>
      </Card>

      <Card noPadding>
        <Tabs
          tabs={tabs}
          activeTab={location}
          onChange={(id) => setLocation(id as LocationFilter)}
        />
      </Card>

      <Card noPadding>
        {filtered.length === 0 ? (
          <div className="px-4 py-8 text-center text-[12px] text-slate-500">
            No products match the current filters.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <Th>SKU</Th>
                  <Th>Product</Th>
                  <Th>Channel</Th>
                  <Th align="right">
                    <button
                      type="button"
                      onClick={() =>
                        setSort(sort === 'stock-asc' ? 'stock-desc' : 'stock-asc')
                      }
                      className="inline-flex items-center gap-1 hover:text-slate-900"
                    >
                      Stock
                      <ArrowDownUp className="w-3 h-3" />
                    </button>
                  </Th>
                  <Th align="right">Threshold</Th>
                  <Th align="right">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => {
                  const low = r.totalStock <= r.lowStockThreshold
                  return (
                    <tr
                      key={r.id}
                      className="border-b border-slate-100 hover:bg-slate-50 transition-colors"
                    >
                      <td className="px-4 py-2.5 font-mono text-[12px] text-slate-900">
                        {r.sku}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="text-[13px] text-slate-900 truncate max-w-md">
                          {r.name}
                        </div>
                        {r.amazonAsin && (
                          <div className="text-[11px] text-slate-500 font-mono">
                            {r.amazonAsin}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        {r.fulfillmentChannel ? (
                          <Badge variant="default" size="sm" mono>
                            {r.fulfillmentChannel}
                          </Badge>
                        ) : (
                          <span className="text-[11px] text-slate-400">—</span>
                        )}
                      </td>
                      <td
                        className={cn(
                          'px-4 py-2.5 text-right tabular-nums text-[13px]',
                          low ? 'text-amber-700 font-semibold' : 'text-slate-900'
                        )}
                      >
                        {low && <AlertTriangle className="w-3 h-3 inline mr-1 text-amber-500" />}
                        {r.totalStock}
                      </td>
                      <td className="px-4 py-2.5 text-right text-[12px] text-slate-500 tabular-nums">
                        {r.lowStockThreshold}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <Link href="/fulfillment/inbound">
                          <Button variant="secondary" size="sm">
                            Replenish
                          </Button>
                        </Link>
                      </td>
                    </tr>
                  )
                })}
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
