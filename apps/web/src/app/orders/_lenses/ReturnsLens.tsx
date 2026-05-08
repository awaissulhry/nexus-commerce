'use client'

/**
 * O.8c — extracted from OrdersWorkspace.tsx. Shows the recent
 * Return ledger across channels (Amazon FBM/FBA mirror, eBay
 * cases, Shopify refunds/create webhook mirrors). Each row links
 * out to /fulfillment/returns?id=… where the inspection +
 * disposition workflow lives.
 *
 * Self-contained: own fetch against /api/fulfillment/returns, no
 * props from parent. The fulfillment surface is the canonical
 * place to act on a return; this lens is read-only context for the
 * /orders operator.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Undo2 } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { Skeleton } from '@/components/ui/Skeleton'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'
import { channelTone } from '../_lib/tone'

type ReturnRow = {
  id: string
  rmaNumber: string | null
  channel: string
  status: string
  orderId: string | null
  refundCents: number | null
}

export function ReturnsLens() {
  const { t } = useTranslations()
  const [items, setItems] = useState<ReturnRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    fetch(`${getBackendUrl()}/api/fulfillment/returns`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((data) => setItems(data.items ?? []))
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <Card>
        <Skeleton lines={6} />
      </Card>
    )
  }
  if (items.length === 0) {
    return (
      <EmptyState
        icon={Undo2}
        title={t('orders.empty.returns.title')}
        description={t('orders.empty.returns.description')}
      />
    )
  }

  return (
    <Card noPadding>
      <div className="overflow-x-auto">
        <table className="w-full text-md">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr>
              <th className="px-3 py-2 text-left text-sm font-semibold uppercase text-slate-700">
                {t('orders.table.header.rma')}
              </th>
              <th className="px-3 py-2 text-left text-sm font-semibold uppercase text-slate-700">
                {t('orders.table.header.channel')}
              </th>
              <th className="px-3 py-2 text-left text-sm font-semibold uppercase text-slate-700">
                {t('orders.table.header.status')}
              </th>
              <th className="px-3 py-2 text-left text-sm font-semibold uppercase text-slate-700">
                {t('orders.table.header.order')}
              </th>
              <th className="px-3 py-2 text-right text-sm font-semibold uppercase text-slate-700">
                {t('orders.table.header.refund')}
              </th>
              <th className="px-3 py-2 text-right text-sm font-semibold uppercase text-slate-700"></th>
            </tr>
          </thead>
          <tbody>
            {items.map((r) => (
              <tr
                key={r.id}
                className="border-b border-slate-100 hover:bg-slate-50"
              >
                <td className="px-3 py-2 font-mono text-base text-slate-700">
                  {r.rmaNumber ?? '—'}
                </td>
                <td className="px-3 py-2">
                  <span
                    className={`inline-block text-xs font-semibold uppercase px-1.5 py-0.5 border rounded ${channelTone(r.channel)}`}
                  >
                    {r.channel}
                  </span>
                </td>
                <td className="px-3 py-2">
                  <Badge variant="warning" size="sm">
                    {r.status.replace(/_/g, ' ')}
                  </Badge>
                </td>
                <td className="px-3 py-2">
                  {r.orderId ? (
                    <Link
                      href={`/orders/${r.orderId}`}
                      className="text-base text-blue-600 hover:underline"
                    >
                      {t('orders.table.viewOrder')}
                    </Link>
                  ) : (
                    <span className="text-slate-400 text-sm">—</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-base text-slate-700">
                  {r.refundCents != null
                    ? `€${(r.refundCents / 100).toFixed(2)}`
                    : '—'}
                </td>
                <td className="px-3 py-2 text-right">
                  <Link
                    href={`/fulfillment/returns?id=${r.id}`}
                    className="text-sm text-blue-600 hover:underline"
                  >
                    {t('orders.table.manage')}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}
