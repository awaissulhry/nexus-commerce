'use client'

// CARD.1 — Fulfilment card.
//
// Replaces the AC.1 "Soon" placeholder. Read-only summary of how this
// (product, marketplace) is fulfilled, backed by /channel-inventory
// (which resolves ChannelListing.platformAttributes.fulfillmentChannel
// to FBA/FBM per market + per variant):
//
//   • Method badge — FBA (managed by Amazon) / FBM (merchant) / not set.
//   • Condition — from the cockpit's composed conditionType.
//   • Stock line — FBM shows on-hand / listed / buffer; FBA shows
//     "managed by Amazon" + listed.
//   • Mixed-fulfilment warning — when child variants don't all share
//     the same method on this market (a real Amazon footgun), with a
//     per-method count breakdown.
//
// Deliberately read-only: changing fulfilment re-routes inventory, so
// edits happen in the classic field editor (jump button) / Stock app,
// not inline — consistent with "FBA offers can't edit quantity here".

import { useEffect, useState } from 'react'
import { Truck, Warehouse, AlertTriangle, Loader2, ExternalLink, RefreshCw } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'

type Method = 'FBA' | 'FBM' | null

interface MarketRow {
  marketplace: string
  channel: string
  listedQty: number | null
  buffer: number
  listingStatus: string | null
  lastSyncedAt: string | null
  fulfillmentChannel: Method
}
interface VariantRow {
  variantId: string
  sku: string
  attributes: Record<string, string>
  physicalStock: number
  markets: MarketRow[]
}
interface InventoryResponse {
  productId: string
  channel: string
  product: { physicalStock: number; markets: MarketRow[] }
  variants: VariantRow[]
}

interface Props {
  productId: string
  marketplace: string
  /** Seed values from the cockpit's composed listing (used until the
   *  inventory fetch resolves, and for condition which inventory
   *  doesn't carry). */
  seedFulfillment: Method
  /** Product-level fulfilment default (Product.fulfillmentMethod). Used
   *  as the last fallback when neither the per-market listing attribute
   *  nor the composed seed carry a method — many listings only set the
   *  catalogue-level method, not the per-marketplace attribute. */
  productFulfillment?: string | null
  conditionType: string | null
  onJumpToClassic?: () => void
}

function normalizeMethod(raw: string | null | undefined): Method {
  const v = (raw ?? '').toUpperCase()
  if (v === 'FBA' || v === 'AFN' || v === 'AMAZON') return 'FBA'
  if (v === 'FBM' || v === 'MFN' || v === 'MERCHANT' || v === 'SELLER') return 'FBM'
  return null
}

export default function FulfillmentCard({
  productId,
  marketplace,
  seedFulfillment,
  productFulfillment,
  conditionType,
  onJumpToClassic,
}: Props) {
  const { t } = useTranslations()
  const [data, setData] = useState<InventoryResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`${getBackendUrl()}/api/products/${productId}/channel-inventory?channel=AMAZON`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((j: InventoryResponse) => {
        if (!cancelled) setData(j)
      })
      .catch(() => {
        if (!cancelled) setError(t('products.edit.cockpit.amazon.fulfillment.loadError'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [productId, t, reloadKey])

  const productRow = data?.product.markets.find((m) => m.marketplace === marketplace) ?? null
  const method: Method =
    productRow?.fulfillmentChannel ?? seedFulfillment ?? normalizeMethod(productFulfillment)

  // Per-variant method counts on THIS market — surfaces mixed fulfilment.
  const variantMethods = (data?.variants ?? [])
    .map((v) => v.markets.find((m) => m.marketplace === marketplace)?.fulfillmentChannel ?? null)
    .filter((m): m is 'FBA' | 'FBM' => m != null)
  const fbaCount = variantMethods.filter((m) => m === 'FBA').length
  const fbmCount = variantMethods.filter((m) => m === 'FBM').length
  const isMixed = fbaCount > 0 && fbmCount > 0

  const physicalStock =
    data?.variants && data.variants.length > 0
      ? data.variants.reduce((sum, v) => sum + (v.physicalStock ?? 0), 0)
      : data?.product.physicalStock ?? null
  const listedQty = productRow?.listedQty ?? null
  const buffer = productRow?.buffer ?? 0

  const methodMeta =
    method === 'FBA'
      ? {
          label: t('products.edit.cockpit.amazon.fulfillment.byAmazon'),
          icon: <Truck aria-hidden className="w-3.5 h-3.5" />,
          cls: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900',
        }
      : method === 'FBM'
        ? {
            label: t('products.edit.cockpit.amazon.fulfillment.merchant'),
            icon: <Warehouse aria-hidden className="w-3.5 h-3.5" />,
            cls: 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-900',
          }
        : {
            label: t('products.edit.cockpit.amazon.fulfillment.notSet'),
            icon: <Truck aria-hidden className="w-3.5 h-3.5" />,
            cls: 'bg-slate-100 text-slate-500 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700',
          }

  return (
    <Card noPadding>
      <div
        data-jump-target="fulfillment"
        className="px-4 py-2.5 border-b border-slate-100 dark:border-slate-800 flex items-center gap-2"
      >
        <Truck aria-hidden className="w-4 h-4 text-blue-500" />
        <div className="text-md font-medium text-slate-900 dark:text-slate-100">
          {t('products.edit.cockpit.amazon.cards.fulfillment')}
        </div>
        {loading && (
          <Loader2 aria-hidden className="w-3.5 h-3.5 text-slate-400 animate-spin ml-auto" />
        )}
      </div>

      <div className="p-4 space-y-3">
        {error ? (
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-rose-600 dark:text-rose-400">{error}</span>
            <button
              type="button"
              onClick={() => setReloadKey((k) => k + 1)}
              className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              <RefreshCw aria-hidden className="w-3 h-3" />
              {t('products.edit.cockpit.amazon.fulfillment.retry')}
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3">
              <span
                className={cn(
                  'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-xs font-semibold',
                  methodMeta.cls,
                )}
              >
                {methodMeta.icon}
                {methodMeta.label}
              </span>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {t('products.edit.cockpit.amazon.fulfillment.condition')}:{' '}
                <span className="text-slate-700 dark:text-slate-300 font-medium">
                  {conditionType || '—'}
                </span>
              </span>
            </div>

            {/* Stock line */}
            <div className="text-xs text-slate-600 dark:text-slate-400 flex flex-wrap items-center gap-x-3 gap-y-1">
              {method === 'FBA' ? (
                <span>{t('products.edit.cockpit.amazon.fulfillment.managedByAmazon')}</span>
              ) : (
                <span>
                  {t('products.edit.cockpit.amazon.fulfillment.onHand')}:{' '}
                  <span className="font-medium text-slate-800 dark:text-slate-200 tabular-nums">
                    {physicalStock ?? '—'}
                  </span>
                </span>
              )}
              <span>
                {t('products.edit.cockpit.amazon.fulfillment.listed')}:{' '}
                <span className="font-medium text-slate-800 dark:text-slate-200 tabular-nums">
                  {listedQty ?? '—'}
                </span>
              </span>
              {method === 'FBM' && buffer > 0 && (
                <span>
                  {t('products.edit.cockpit.amazon.fulfillment.buffer')}:{' '}
                  <span className="font-medium text-slate-800 dark:text-slate-200 tabular-nums">
                    {buffer}
                  </span>
                </span>
              )}
            </div>

            {/* Mixed-fulfilment warning */}
            {isMixed && (
              <div className="flex items-start gap-2 rounded-md border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 px-2.5 py-2">
                <AlertTriangle aria-hidden className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
                <div className="text-[11px] text-amber-700 dark:text-amber-300">
                  <div className="font-medium">
                    {t('products.edit.cockpit.amazon.fulfillment.mixedWarning')}
                  </div>
                  <div className="opacity-90">
                    {fbaCount} FBA · {fbmCount} FBM
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        {onJumpToClassic && (
          <button
            type="button"
            onClick={onJumpToClassic}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-blue-600 dark:text-blue-400 hover:underline"
          >
            {t('products.edit.cockpit.amazon.fulfillment.manageStock')}
            <ExternalLink aria-hidden className="w-3 h-3" />
          </button>
        )}
      </div>
    </Card>
  )
}
