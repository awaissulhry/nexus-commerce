'use client'

import Link from 'next/link'
import { ArrowLeft, X } from 'lucide-react'
import { COUNTRY_NAMES } from '@/lib/country-names'
import type { ChannelTuple } from '../ListWizardClient'

interface Props {
  productId: string
  productSku: string
  productName: string
  channels: ChannelTuple[]
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
  channels,
  onClose,
}: Props) {
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
        <ChannelsSummary channels={channels} />
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

function ChannelsSummary({ channels }: { channels: ChannelTuple[] }) {
  if (channels.length === 0) {
    return (
      <span className="text-[12px] text-slate-400 italic">
        No channels picked yet
      </span>
    )
  }

  if (channels.length === 1) {
    const c = channels[0]!
    const channelLabel = CHANNEL_LABEL[c.platform] ?? c.platform
    const marketLabel =
      c.marketplace === 'GLOBAL' ? '' : COUNTRY_NAMES[c.marketplace] ?? c.marketplace
    return (
      <div className="text-[12px] text-slate-600">
        Listing on{' '}
        <span className="font-semibold text-slate-900">{channelLabel}</span>
        {marketLabel && (
          <>
            {' '}
            <span className="text-slate-500">·</span>{' '}
            <span className="font-mono text-[11px] bg-slate-100 px-1.5 py-0.5 rounded text-slate-700">
              {c.marketplace}
            </span>{' '}
            <span className="text-slate-700">{marketLabel}</span>
          </>
        )}
      </div>
    )
  }

  // Multi-channel: group by platform → list markets per platform.
  const grouped = new Map<string, string[]>()
  for (const c of channels) {
    const list = grouped.get(c.platform) ?? []
    list.push(c.marketplace)
    grouped.set(c.platform, list)
  }
  const summary = Array.from(grouped.entries())
    .map(([platform, markets]) => {
      const label = CHANNEL_LABEL[platform] ?? platform
      return `${label} ${markets.join(', ')}`
    })
    .join(' · ')

  return (
    <div
      className="text-[12px] text-slate-600 max-w-[400px] truncate"
      title={summary}
    >
      Publishing to{' '}
      <span className="font-semibold text-slate-900">
        {channels.length} channels
      </span>{' '}
      <span className="text-slate-500">— {summary}</span>
    </div>
  )
}
