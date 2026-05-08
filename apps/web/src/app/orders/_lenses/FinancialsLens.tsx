'use client'

/**
 * O.8b — extracted from OrdersWorkspace.tsx. Aggregates totals from
 * the page already loaded by GridLens (no extra fetch — the parent
 * passes `orders`). Per-order detail clicks through to
 * /orders/[id]/financials, which is where channel-fee breakdown
 * + tax + transactions live.
 *
 * Channel-level fee aggregation will land on the dashboard once
 * FinancialTransaction rows are seeded by the SP-API + eBay sync;
 * for now this lens is intentionally minimal — gross-only, no
 * computed net. The detail page already shows fees + net per row.
 */

import Link from 'next/link'
import { Card } from '@/components/ui/Card'
import { useTranslations } from '@/lib/i18n/use-translations'
import { channelTone } from '../_lib/tone'

type FinancialsOrder = {
  id: string
  channel: string
  channelOrderId: string
  totalPrice: number
  itemCount: number
}

export function FinancialsLens({ orders }: { orders: FinancialsOrder[] }) {
  const { t } = useTranslations()
  const totals = orders.reduce(
    (acc, o) => {
      acc.gross += o.totalPrice
      return acc
    },
    { gross: 0 },
  )

  return (
    <div className="space-y-3">
      <Card>
        <div className="flex items-center gap-6">
          <div>
            <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold">
              {t('orders.financials.pageTotal')}
            </div>
            <div className="text-[24px] font-semibold tabular-nums text-slate-900">
              €{totals.gross.toFixed(2)}
            </div>
          </div>
          <div className="text-base text-slate-500">
            {t('orders.financials.note')}
          </div>
        </div>
      </Card>
      <Card noPadding>
        <div className="overflow-x-auto">
          <table className="w-full text-md">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="px-3 py-2 text-left text-sm font-semibold uppercase text-slate-700">
                  {t('orders.table.header.order')}
                </th>
                <th className="px-3 py-2 text-left text-sm font-semibold uppercase text-slate-700">
                  {t('orders.table.header.channel')}
                </th>
                <th className="px-3 py-2 text-right text-sm font-semibold uppercase text-slate-700">
                  {t('orders.table.header.gross')}
                </th>
                <th className="px-3 py-2 text-left text-sm font-semibold uppercase text-slate-700">
                  {t('orders.table.header.txCount')}
                </th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr
                  key={o.id}
                  className="border-b border-slate-100 hover:bg-slate-50"
                >
                  <td className="px-3 py-2">
                    <Link
                      href={`/orders/${o.id}`}
                      className="font-mono text-base text-blue-600 hover:underline"
                    >
                      {o.channelOrderId}
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-block text-xs font-semibold uppercase px-1.5 py-0.5 border rounded ${channelTone(
                        o.channel,
                      )}`}
                    >
                      {o.channel}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    €{o.totalPrice.toFixed(2)}
                  </td>
                  <td className="px-3 py-2 text-base text-slate-700">
                    <Link
                      href={`/orders/${o.id}#financials`}
                      className="text-blue-600 hover:underline"
                    >
                      {o.itemCount} items
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
