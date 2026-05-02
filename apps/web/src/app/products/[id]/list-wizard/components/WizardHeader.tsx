'use client'

import Link from 'next/link'
import { ArrowLeft, X } from 'lucide-react'
import { COUNTRY_NAMES } from '@/lib/country-names'

interface Props {
  productId: string
  productSku: string
  productName: string
  channel: string
  marketplace: string
  onClose: () => void
}

const CHANNEL_LABEL: Record<string, string> = {
  AMAZON: 'Amazon',
  EBAY: 'eBay',
  SHOPIFY: 'Shopify',
  WOOCOMMERCE: 'WooCommerce',
}

export default function WizardHeader({
  productId,
  productSku,
  productName,
  channel,
  marketplace,
  onClose,
}: Props) {
  const channelLabel = CHANNEL_LABEL[channel] ?? channel
  const marketLabel =
    marketplace === 'GLOBAL'
      ? ''
      : COUNTRY_NAMES[marketplace] ?? marketplace
  return (
    <div className="px-6 py-3 border-b border-slate-200 bg-white flex items-center justify-between gap-4 flex-shrink-0">
      <div className="flex items-center gap-3 min-w-0">
        <Link
          href={`/products/${productId}/edit`}
          className="text-slate-400 hover:text-slate-700 flex-shrink-0"
          aria-label="Back to product"
        >
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <div className="min-w-0">
          <div className="font-mono text-[13px] text-slate-700 truncate">
            {productSku}
          </div>
          <div className="text-[11px] text-slate-500 truncate">
            {productName}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-3 flex-shrink-0">
        <div className="text-[12px] text-slate-600">
          Listing on{' '}
          <span className="font-semibold text-slate-900">
            {channelLabel}
          </span>
          {marketLabel && (
            <>
              {' '}
              <span className="text-slate-500">·</span>{' '}
              <span className="font-mono text-[11px] bg-slate-100 px-1.5 py-0.5 rounded text-slate-700">
                {marketplace}
              </span>{' '}
              <span className="text-slate-700">{marketLabel}</span>
            </>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-slate-400 hover:text-slate-700 rounded p-1 hover:bg-slate-100"
          aria-label="Close wizard"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}
