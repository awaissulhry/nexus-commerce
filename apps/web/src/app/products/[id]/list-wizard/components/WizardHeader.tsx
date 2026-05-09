'use client'

import Link from 'next/link'
import { ArrowLeft, X } from 'lucide-react'
import { COUNTRY_NAMES } from '@/lib/country-names'
import { CHANNEL_TONE } from '@/lib/theme'
import { cn } from '@/lib/utils'
import { useTranslations } from '@/lib/i18n/use-translations'
import type { ChannelTuple } from '../ListWizardClient'
import AiCompleteWizardButton from './AiCompleteWizardModal'

interface Props {
  productId: string
  productSku: string
  productName: string
  channels: ChannelTuple[]
  onClose: () => void
  /** AI-4.8 — wizard id is needed by the AI orchestrator button.
   *  Optional so legacy callers (none today, but keeping the door
   *  open) don't break; when missing, the button doesn't render. */
  wizardId?: string
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
  wizardId,
}: Props) {
  const { t } = useTranslations()
  return (
    <div className="px-6 py-3 border-b border-slate-200 bg-white flex items-center justify-between gap-4 flex-shrink-0 dark:border-slate-800 dark:bg-slate-950">
      <div className="flex items-center gap-3 min-w-0">
        <Link
          href={`/products/${productId}/edit`}
          className="text-slate-400 hover:text-slate-700 flex-shrink-0 dark:text-slate-500 dark:hover:text-slate-300"
          aria-label={t('listWizard.header.backToProduct')}
        >
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <div className="min-w-0">
          {/* U.10 — name promoted to text-md so it reads as the
              primary identifier; SKU drops to text-sm secondary. The
              header is the only place in the wizard that names what
              you're listing, so it earns the visual weight. */}
          <div className="text-md font-semibold text-slate-900 truncate dark:text-slate-100">
            {productName}
          </div>
          <div className="font-mono text-sm text-slate-500 truncate dark:text-slate-400">
            {productSku}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-3 flex-shrink-0">
        <ChannelsSummary channels={channels} />
        {/* AI-4.8 — bulk orchestrator trigger. Disabled until at
            least one channel is picked (matches the orchestrator's
            409 floor). Hidden entirely when the host doesn't pass
            wizardId (defensive — happens if future callers reuse
            this header outside the wizard surface). */}
        {wizardId && (
          <AiCompleteWizardButton
            wizardId={wizardId}
            channelsPicked={channels.length > 0}
          />
        )}
        <button
          type="button"
          onClick={onClose}
          className="text-slate-400 hover:text-slate-700 rounded p-1 hover:bg-slate-100 dark:text-slate-500 dark:hover:text-slate-300 dark:hover:bg-slate-800"
          aria-label={t('listWizard.header.closeWizard')}
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}

function ChannelsSummary({ channels }: { channels: ChannelTuple[] }) {
  const { t } = useTranslations()
  if (channels.length === 0) {
    return (
      <span className="text-base text-slate-400 italic dark:text-slate-500">
        {t('listWizard.header.noChannels')}
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
      <span className="text-sm text-slate-500 dark:text-slate-400">
        {channels.length === 1
          ? t('listWizard.header.listingOn')
          : t('listWizard.header.channelsCount', { n: channels.length })}
      </span>
      {visibleChannels.map((c, i) => {
        const tone =
          CHANNEL_TONE[c.platform] ??
          'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700'
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
          className="inline-flex items-center h-5 px-1.5 rounded text-xs font-medium border border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400"
          title={summary}
        >
          {t('listWizard.header.overflow', { n: overflow })}
        </span>
      )}
    </div>
  )
}
