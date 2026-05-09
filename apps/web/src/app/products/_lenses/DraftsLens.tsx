'use client'

/**
 * P.1c — extracted from ProductsWorkspace.tsx as part of the
 * file-decomposition sweep. Self-contained: takes no props, owns
 * its own channel-tab state, fetches /api/listings/drafts.
 *
 * Two cards per channel: drafts ready to publish + products
 * uncovered on that channel. Channel tabs (AMAZON / EBAY /
 * SHOPIFY) gate the fetch. WooCommerce + Etsy intentionally
 * excluded — active channel scope is Amazon + eBay + Shopify only.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Sparkles, CheckCircle2 } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { getBackendUrl } from '@/lib/backend-url'
import { CHANNEL_TONE } from '@/lib/products/theme'
import { useTranslations } from '@/lib/i18n/use-translations'

interface DraftRow {
  id: string
  productId: string
  channel: string
  marketplace: string
  product: { name: string; sku: string }
}

interface UncoveredRow {
  id: string
  name: string
  sku: string
}

interface DraftsData {
  draftCount: number
  drafts: DraftRow[]
  uncoveredCount: number
  uncovered: UncoveredRow[]
}

export function DraftsLens() {
  const { t } = useTranslations()
  const [channel, setChannel] = useState('AMAZON')
  const [data, setData] = useState<DraftsData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await fetch(
        `${getBackendUrl()}/api/listings/drafts?channel=${channel}`,
        { cache: 'no-store' },
      )
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const d = await r.json()
      setData(d)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [channel])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1">
        <span className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 mr-2">
          {t('products.lens.drafts.channelPicker')}
        </span>
        {['AMAZON', 'EBAY', 'SHOPIFY'].map((c) => (
          <button
            key={c}
            onClick={() => setChannel(c)}
            className={`h-7 px-3 text-sm border rounded inline-flex items-center transition-colors ${
              channel === c
                ? `${CHANNEL_TONE[c]} font-semibold`
                : 'bg-white text-slate-600 border-slate-200 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-800'
            }`}
          >
            {c}
          </button>
        ))}
      </div>
      {loading && (
        <Card>
          <div
            role="status"
            aria-live="polite"
            className="text-md text-slate-500 dark:text-slate-400 py-8 text-center"
          >
            {t('products.lens.drafts.loading')}
          </div>
        </Card>
      )}
      {!loading && error && (
        <Card>
          <div role="alert" className="py-8 text-center space-y-2">
            <div className="text-md text-rose-600 dark:text-rose-400">
              {t('products.lens.drafts.failed', { error })}
            </div>
            <button
              type="button"
              onClick={() => void refresh()}
              className="h-7 px-3 text-sm bg-slate-900 text-white rounded hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200 inline-flex items-center gap-1.5"
            >
              {t('products.lens.drafts.retry')}
            </button>
          </div>
        </Card>
      )}
      {!loading && !error && data && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card title={t('products.lens.drafts.title', { count: data.draftCount })}>
            {data.drafts.length === 0 ? (
              <div className="py-8 text-center text-base text-slate-500 dark:text-slate-400">
                <Sparkles className="w-6 h-6 mx-auto text-slate-300 dark:text-slate-600 mb-2" />
                {t('products.lens.drafts.empty', { channel })}
                <div className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                  {t('products.lens.drafts.emptyHint')}
                </div>
              </div>
            ) : (
              <ul className="space-y-1 -my-1">
                {data.drafts.slice(0, 30).map((d) => (
                  <li
                    key={d.id}
                    className="flex items-center justify-between gap-3 py-1.5 px-2 -mx-2 rounded hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-base text-slate-900 dark:text-slate-100 truncate">
                        {d.product.name}
                      </div>
                      <div className="text-sm text-slate-500 dark:text-slate-400 font-mono">
                        {d.product.sku} · {d.marketplace}
                      </div>
                    </div>
                    <Link
                      href={`/products/${d.productId}/list-wizard?channel=${d.channel}`}
                      className="h-7 px-3 text-sm bg-emerald-50 text-emerald-700 border border-emerald-200 rounded hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800 dark:hover:bg-emerald-900/40"
                    >
                      {t('products.lens.drafts.publish')}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title={t('products.lens.uncovered.title', { count: data.uncoveredCount })}>
            {data.uncovered.length === 0 ? (
              <div className="py-8 text-center text-base text-slate-500 dark:text-slate-400">
                <CheckCircle2 className="w-6 h-6 mx-auto text-emerald-500 dark:text-emerald-400 mb-2" />
                {t('products.lens.uncovered.empty', { channel })}
                <div className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                  {t('products.lens.uncovered.emptyHint')}
                </div>
              </div>
            ) : (
              <ul className="space-y-1 -my-1">
                {data.uncovered.slice(0, 30).map((p) => (
                  <li
                    key={p.id}
                    className="flex items-center justify-between gap-3 py-1.5 px-2 -mx-2 rounded hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-base text-slate-900 dark:text-slate-100 truncate">
                        {p.name}
                      </div>
                      <div className="text-sm text-slate-500 dark:text-slate-400 font-mono">
                        {p.sku}
                      </div>
                    </div>
                    <Link
                      href={`/products/${p.id}/list-wizard?channel=${channel}`}
                      className="h-7 px-3 text-sm bg-blue-50 text-blue-700 border border-blue-200 rounded hover:bg-blue-100 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800 dark:hover:bg-blue-900/40"
                    >
                      {t('products.lens.uncovered.list')}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </div>
  )
}
