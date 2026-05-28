'use client'

// FCF.5b — eBay Fulfillment method card.
//
// Marks how this eBay listing is fulfilled:
//   • FBM (default) — you ship from your own warehouse. Published qty is
//     bound to the warehouse pool.
//   • MCF           — Amazon ships from your FBA stock (Multi-Channel
//     Fulfillment). Published qty is bound to the Amazon FBA SELLABLE pool;
//     an eBay order triggers an Amazon fulfillment order.
//
// Persisted as ChannelListing.fulfillmentMethod ('FBM' | 'FBA'=MCF on a
// merchant channel). Reads the resolved method + available-to-publish from
// /channel-inventory?channel=EBAY (FCF.4b) and writes through the shared
// PATCH /products/:id/fulfillment — one write path for the field.

import { useCallback, useEffect, useState } from 'react'
import { Truck, Warehouse, Loader2, Check, AlertTriangle, RefreshCw } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'

type Method = 'FBM' | 'MCF'

interface Props {
  productId: string
  marketplace: string
}

export default function FulfillmentMethodCard({ productId, marketplace }: Props) {
  const { t } = useTranslations()
  const backend = getBackendUrl()
  const [method, setMethod] = useState<Method | null>(null)
  const [available, setAvailable] = useState<number | null>(null)
  const [pool, setPool] = useState<'FBA' | 'FBM_WAREHOUSE' | null>(null)
  const [listedQty, setListedQty] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await fetch(`${backend}/api/products/${productId}/channel-inventory?channel=EBAY`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const j = await r.json()
      const markets: Array<Record<string, unknown>> = j.product?.markets ?? []
      const row =
        markets.find((m) => String(m.marketplace ?? '').toUpperCase() === marketplace.toUpperCase()) ?? markets[0]
      setMethod(row?.fulfillmentMethod === 'FBA' ? 'MCF' : 'FBM')
      setAvailable(typeof row?.availableToPublish === 'number' ? (row.availableToPublish as number) : null)
      setPool((row?.pool as 'FBA' | 'FBM_WAREHOUSE' | undefined) ?? null)
      setListedQty(typeof row?.listedQty === 'number' ? (row.listedQty as number) : null)
    } catch {
      setError(t('products.edit.cockpit.ebay.fulfillment.loadError'))
    } finally {
      setLoading(false)
    }
  }, [backend, productId, marketplace, t])

  useEffect(() => {
    void load()
  }, [load])

  const save = useCallback(
    async (next: Method) => {
      if (next === method || saving) return
      const prev = method
      setMethod(next)
      setSaving(true)
      setError(null)
      try {
        const r = await fetch(`${backend}/api/products/${productId}/fulfillment`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            updates: [{ marketplace, channel: 'EBAY', fulfillmentMethod: next === 'MCF' ? 'FBA' : 'FBM' }],
          }),
        })
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`)
        setSavedFlash(true)
        setTimeout(() => setSavedFlash(false), 1500)
        await load() // true up available-to-publish for the new pool
      } catch (e: unknown) {
        setMethod(prev)
        setError(e instanceof Error ? e.message : t('products.edit.cockpit.ebay.fulfillment.saveError'))
      } finally {
        setSaving(false)
      }
    },
    [backend, productId, marketplace, method, saving, load, t],
  )

  const options: Array<{ key: Method; label: string; hint: string; icon: React.ReactNode }> = [
    {
      key: 'FBM',
      label: t('products.edit.cockpit.ebay.fulfillment.fbm'),
      hint: t('products.edit.cockpit.ebay.fulfillment.fbmHint'),
      icon: <Warehouse aria-hidden className="w-4 h-4" />,
    },
    {
      key: 'MCF',
      label: t('products.edit.cockpit.ebay.fulfillment.mcf'),
      hint: t('products.edit.cockpit.ebay.fulfillment.mcfHint'),
      icon: <Truck aria-hidden className="w-4 h-4" />,
    },
  ]

  return (
    <Card noPadding>
      <div className="px-4 py-2.5 border-b border-slate-100 dark:border-slate-800 flex items-center gap-2">
        <Truck aria-hidden className="w-4 h-4 text-blue-500" />
        <div className="text-md font-medium text-slate-900 dark:text-slate-100">
          {t('products.edit.cockpit.ebay.fulfillment.cardTitle')}
        </div>
        {loading && <Loader2 aria-hidden className="w-3.5 h-3.5 text-slate-400 animate-spin ml-auto" />}
        {savedFlash && !loading && (
          <span className="ml-auto inline-flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
            <Check aria-hidden className="w-3.5 h-3.5" />
            {t('products.edit.cockpit.ebay.fulfillment.saved')}
          </span>
        )}
      </div>

      <div className="p-4 space-y-3">
        {error ? (
          <div className="flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-1.5 text-xs text-rose-600 dark:text-rose-400">
              <AlertTriangle aria-hidden className="w-3.5 h-3.5" />
              {error}
            </span>
            <button
              type="button"
              onClick={() => void load()}
              className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              <RefreshCw aria-hidden className="w-3 h-3" />
              {t('products.edit.cockpit.ebay.fulfillment.retry')}
            </button>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2" role="group" aria-label={t('products.edit.cockpit.ebay.fulfillment.cardTitle')}>
              {options.map((opt) => {
                const active = method === opt.key
                return (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => void save(opt.key)}
                    disabled={saving || loading}
                    aria-pressed={active}
                    className={cn(
                      'flex flex-col items-start gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors disabled:opacity-60',
                      active
                        ? opt.key === 'MCF'
                          ? 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40'
                          : 'border-sky-300 bg-sky-50 dark:border-sky-800 dark:bg-sky-950/40'
                        : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600',
                    )}
                  >
                    <span
                      className={cn(
                        'inline-flex items-center gap-1.5 text-sm font-semibold',
                        active
                          ? opt.key === 'MCF'
                            ? 'text-amber-700 dark:text-amber-300'
                            : 'text-sky-700 dark:text-sky-300'
                          : 'text-slate-600 dark:text-slate-300',
                      )}
                    >
                      {opt.icon}
                      {opt.label}
                    </span>
                    <span className="text-[11px] leading-snug text-slate-500 dark:text-slate-400">{opt.hint}</span>
                  </button>
                )
              })}
            </div>

            {/* Available-to-publish for the bound pool */}
            <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
              <span>{t('products.edit.cockpit.ebay.fulfillment.available')}:</span>
              <span className="font-medium text-slate-800 dark:text-slate-200 tabular-nums">
                {available ?? '—'}
              </span>
              {pool && (
                <span className="text-slate-400 dark:text-slate-500">
                  ·{' '}
                  {pool === 'FBA'
                    ? t('products.edit.cockpit.ebay.fulfillment.poolFba')
                    : t('products.edit.cockpit.ebay.fulfillment.poolWarehouse')}
                </span>
              )}
            </div>

            {/* FCF.6 — oversell warning: published more than the pool can back */}
            {available != null && listedQty != null && listedQty > available && (
              <div className="flex items-start gap-2 rounded-md border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 px-2.5 py-2">
                <AlertTriangle aria-hidden className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
                <div className="text-[11px] text-amber-700 dark:text-amber-300">
                  {t('products.edit.cockpit.ebay.fulfillment.oversold')
                    .replace('{listed}', String(listedQty))
                    .replace('{available}', String(available))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  )
}
