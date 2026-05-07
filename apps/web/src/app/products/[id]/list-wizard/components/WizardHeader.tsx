'use client'

import Link from 'next/link'
import { ArrowLeft, X } from 'lucide-react'
import { COUNTRY_NAMES } from '@/lib/country-names'
import { CHANNEL_TONE } from '@/lib/theme'
import { cn } from '@/lib/utils'
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
          {/* U.10 — name promoted to text-md so it reads as the
              primary identifier; SKU drops to text-sm secondary. The
              header is the only place in the wizard that names what
              you're listing, so it earns the visual weight. */}
          <div className="text-md font-semibold text-slate-900 truncate">
            {productName}
          </div>
          <div className="font-mono text-sm text-slate-500 truncate">
            {productSku}
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
      <span className="text-base text-slate-400 italic">
        No channels picked yet
      </span>
    )
  }

  // U.10 — channel chips use CHANNEL_TONE per platform so AMAZON,
  // EBAY, etc. read at a glance instead of as bare grey labels.
  // Matches the chip vocabulary on /products/drafts (U.7). The
  // `title` attribute on each chip surfaces the full marketplace
  // name (e.g. "Italy") on hover for ambiguous codes.
  const summary = channels
    .map((c) => {
      const platformLabel = CHANNEL_LABEL[c.platform] ?? c.platform
      const marketLabel =
        c.marketplace === 'GLOBAL'
          ? ''
          : COUNTRY_NAMES[c.marketplace] ?? c.marketplace
      return marketLabel ? `${platformLabel} ${c.marketplace}` : platformLabel
    })
    .join(' · ')

  // Cap visible chips so a 10-channel selection doesn't push the
  // close button off-screen on narrow viewports. Overflow rolls into
  // a "+N more" pill that tooltips the full list.
  const VISIBLE = 4
  const visibleChannels = channels.slice(0, VISIBLE)
  const overflow = channels.length - visibleChannels.length

  return (
    <div className="flex items-center gap-1.5 flex-wrap" title={summary}>
      <span className="text-sm text-slate-500">
        {channels.length === 1 ? 'Listing on' : `${channels.length} channels:`}
      </span>
      {visibleChannels.map((c, i) => {
        const tone =
          CHANNEL_TONE[c.platform] ?? 'bg-slate-100 text-slate-700 border-slate-200'
        const platformLabel = CHANNEL_LABEL[c.platform] ?? c.platform
        const marketLabel =
          c.marketplace === 'GLOBAL'
            ? null
            : COUNTRY_NAMES[c.marketplace] ?? c.marketplace
        return (
          <span
            key={`${c.platform}:${c.marketplace}:${i}`}
            className={cn(
              'inline-flex items-center h-5 px-1.5 rounded text-xs font-medium border',
              tone,
            )}
            title={marketLabel ? `${platformLabel} · ${marketLabel}` : platformLabel}
          >
            <span className="font-mono">{platformLabel}</span>
            {c.marketplace !== 'GLOBAL' && (
              <>
                <span className="opacity-50 mx-0.5">·</span>
                <span>{c.marketplace}</span>
              </>
            )}
          </span>
        )
      })}
      {overflow > 0 && (
        <span
          className="inline-flex items-center h-5 px-1.5 rounded text-xs font-medium border border-slate-200 bg-slate-50 text-slate-600"
          title={summary}
        >
          +{overflow} more
        </span>
      )}
    </div>
  )
}
