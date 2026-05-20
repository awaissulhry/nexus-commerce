'use client'

import Link from 'next/link'
import { Card } from '@/components/ui/Card'
import { TableWithSparkline, type TableColumn } from '@/components/insights'
import type { TopSKURow } from './useInsightsData'

export function TopSKUsWidget({
  rows,
  currency,
  loading,
}: {
  rows: TopSKURow[]
  currency: string
  loading: boolean
}) {
  if (loading && rows.length === 0) {
    return (
      <Card title="Top SKUs">
        <div className="h-[180px] flex items-center justify-center text-slate-400 text-sm">
          Loading…
        </div>
      </Card>
    )
  }

  const columns: TableColumn<TopSKURow>[] = [
    {
      key: 'sku',
      label: 'SKU',
      align: 'left',
      accessor: (r) => (
        <Link
          href={`/products/${encodeURIComponent(r.sku)}`}
          className="font-mono text-[11px] text-slate-900 dark:text-slate-100 hover:text-blue-600 dark:hover:text-blue-400"
        >
          {r.sku}
        </Link>
      ),
      format: 'text',
      width: '120px',
    },
    {
      key: 'name',
      label: 'Name',
      align: 'left',
      accessor: (r) => (
        <span
          className="block truncate max-w-[220px] text-slate-700 dark:text-slate-200"
          title={r.productName ?? ''}
        >
          {r.productName ?? '—'}
        </span>
      ),
      format: 'text',
    },
    {
      key: 'revenue',
      label: 'Revenue',
      align: 'right',
      accessor: (r) => r.revenue,
      format: 'currency',
    },
    {
      key: 'units',
      label: 'Units',
      align: 'right',
      accessor: (r) => r.units,
      format: 'number',
    },
    {
      key: 'delta',
      label: 'Δ',
      align: 'right',
      accessor: (r) => r.deltaPct,
      format: 'delta',
      width: '60px',
    },
    {
      key: 'trend',
      label: 'Trend',
      align: 'right',
      accessor: (r) => r.series,
      format: 'sparkline',
      width: '90px',
    },
  ]

  return (
    <Card
      title="Top SKUs"
      description="Revenue leaders this window"
      action={
        <Link
          href="/insights/products"
          className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
        >
          See all →
        </Link>
      }
    >
      <TableWithSparkline
        rows={rows}
        columns={columns}
        currency={currency}
        rowKey={(r) => r.sku}
        dense
        emptyLabel="No sales in this window"
      />
    </Card>
  )
}
