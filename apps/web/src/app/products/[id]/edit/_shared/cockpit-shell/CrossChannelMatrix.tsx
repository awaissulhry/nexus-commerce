'use client'

// T3.3 — cross-channel matrix (read-only comparison).
//
// A drawer showing one product's key field values across every channel
// × market (Amazon + eBay) at once, so an operator can compare Title /
// Price / status side by side without tab-hopping. Complements the
// separate per-channel cockpit tabs — it does not replace them.
//
// Read-only in this increment; diff-then-apply cross-channel propagation
// (reusing the existing propagate-preview / applyPropagation contract)
// layers on in T3.3b.

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import CockpitDrawer from './CockpitDrawer'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'

interface ListingRow {
  channel: string
  marketplace: string
  status: string | null
  title: string | null
  hasDescription: boolean
  price: number | null
  lastSyncedAt: string | null
}

export interface CrossChannelMatrixProps {
  productId: string
  open: boolean
  onClose: () => void
}

function currencyFor(mp: string): string {
  const m = mp.toUpperCase()
  if (m === 'UK' || m === 'GB') return 'GBP'
  if (m === 'US') return 'USD'
  if (m === 'JP') return 'JPY'
  return 'EUR'
}

function fmtPrice(v: number | null, mp: string): string {
  if (v == null) return '—'
  const c = currencyFor(mp)
  const sym = c === 'EUR' ? '€' : c === 'GBP' ? '£' : c === 'USD' ? '$' : c === 'JPY' ? '¥' : `${c} `
  return `${sym}${v.toFixed(2)}`
}

export default function CrossChannelMatrix({ productId, open, onClose }: CrossChannelMatrixProps) {
  const { t } = useTranslations()
  const [rows, setRows] = useState<ListingRow[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`${getBackendUrl()}/api/products/${productId}/listings`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((j: { listings: ListingRow[] }) => {
        if (!cancelled) setRows(j.listings ?? [])
      })
      .catch(() => {
        if (!cancelled) setError(t('products.edit.cockpit.xchannel.loadError'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, productId, t])

  return (
    <CockpitDrawer
      open={open}
      onClose={onClose}
      width="lg"
      title={t('products.edit.cockpit.xchannel.title')}
    >
      <div className="p-4">
        <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
          {t('products.edit.cockpit.xchannel.subtitle')}
        </p>

        {loading && (
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
            {t('products.edit.cockpit.xchannel.loading')}
          </div>
        )}
        {error && <div className="text-sm text-rose-600 dark:text-rose-400">{error}</div>}
        {rows && rows.length === 0 && !loading && (
          <div className="text-sm text-slate-400">{t('products.edit.cockpit.xchannel.empty')}</div>
        )}

        {rows && rows.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs text-slate-500 dark:bg-slate-900/40 dark:text-slate-400">
                <tr>
                  <th className="px-3 py-2 font-medium">{t('products.edit.cockpit.xchannel.colChannel')}</th>
                  <th className="px-3 py-2 font-medium">{t('products.edit.cockpit.xchannel.colMarket')}</th>
                  <th className="px-3 py-2 font-medium">{t('products.edit.cockpit.xchannel.colStatus')}</th>
                  <th className="px-3 py-2 font-medium">{t('products.edit.cockpit.xchannel.colTitle')}</th>
                  <th className="px-3 py-2 font-medium text-right">{t('products.edit.cockpit.xchannel.colPrice')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {rows.map((r) => (
                  <tr key={`${r.channel}:${r.marketplace}`} className="text-slate-700 dark:text-slate-300">
                    <td className="px-3 py-1.5 font-medium">{r.channel}</td>
                    <td className="px-3 py-1.5">{r.marketplace}</td>
                    <td className="px-3 py-1.5 text-xs text-slate-500 dark:text-slate-400">{r.status ?? '—'}</td>
                    <td className="px-3 py-1.5 max-w-[280px] truncate" title={r.title ?? undefined}>
                      {r.title ?? '—'}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{fmtPrice(r.price, r.marketplace)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </CockpitDrawer>
  )
}
