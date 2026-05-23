/**
 * ATM.4 — Per-channel × per-market value expansion.
 *
 * Rendered inside an AttributeRow's <details> body, this shows the
 * effective value of a single attribute across every active
 * ChannelListing for the product. The operator sees, at a glance,
 * which markets agree with master and which carry overrides.
 *
 * For each channel listing row:
 *   - "Amazon Italy" pretty label (DS.3 helper)
 *   - Effective value formatted by attribute type
 *   - Source badge:
 *       • Follows master      (green)  — followMaster*=true
 *       • Override            (amber)  — followMaster*=false +
 *                                        override is set
 *       • Drift               (red)    — channel's mirrored master
 *                                        value doesn't match the
 *                                        current Product master
 *                                        (legacy/sync skew; rare)
 *   - Channel external ID (for identifier rows)
 *   - Last-synced timestamp
 *   - Validation state pill if not VALID
 *
 * Attributes without a per-channel mapping (sku, gtin, brand, weight,
 * dims, compliance, …) render a single "Master-managed — same on all
 * channels" line. Honest signal beats fake per-channel breakdowns.
 *
 * The "effective" logic mirrors what the publish service uses:
 *   if (followMasterX === true)  → masterX mirror
 *   else                         → Xoverride (falls back to legacy
 *                                  field when override is null)
 */

import Link from 'next/link'
import { ExternalLink } from 'lucide-react'
import {
  amazonTld,
  prettyChannelMarketplace,
} from '@/lib/marketplace-code'
import type { getServerT } from '@/lib/i18n/server'

export interface ChannelListingForExpansion {
  id: string
  channel: string
  marketplace: string
  listingStatus: string
  externalListingId: string | null
  lastSyncedAt: Date | null
  validationStatus: string
  isPublished: boolean
  title: string | null
  titleOverride: string | null
  followMasterTitle: boolean
  masterTitle: string | null
  description: string | null
  descriptionOverride: string | null
  followMasterDescription: boolean
  masterDescription: string | null
  price: { toString(): string } | null
  priceOverride: { toString(): string } | null
  followMasterPrice: boolean
  masterPrice: { toString(): string } | null
  quantity: number | null
  quantityOverride: number | null
  followMasterQuantity: boolean
  masterQuantity: number | null
  bulletPointsOverride: string[]
  followMasterBulletPoints: boolean
  masterBulletPoints: string[]
}

/** Identifies which master attribute key a row is showing. Only the
 *  keys handled here render a real per-channel breakdown; the rest
 *  fall through to "Master-managed". */
export type ChannelMappedAttrKey =
  | 'name'
  | 'description'
  | 'basePrice'
  | 'totalStock'
  | 'bulletPoints'
  | 'amazonAsin'
  | 'ebayItemId'
  | 'shopifyProductId'

interface ChannelExpansionProps {
  attrKey: string
  listings: ChannelListingForExpansion[]
  /** Compact, locale-formatted form of the current master value;
   *  used in the "drift" check and the "matches master" tooltip. */
  masterPreview: string | null
  locale: 'en' | 'it'
  t: Awaited<ReturnType<typeof getServerT>>
}

export default function ChannelExpansion({
  attrKey,
  listings,
  masterPreview,
  locale,
  t,
}: ChannelExpansionProps) {
  const isMapped = isChannelMapped(attrKey)
  if (!isMapped) {
    return (
      <div className="px-3 py-2 text-xs text-slate-500 italic">
        {t('products.datasheetHub.expansion.masterManaged')}
      </div>
    )
  }

  if (listings.length === 0) {
    return (
      <div className="px-3 py-2 text-xs text-slate-500 italic">
        {t('products.datasheetHub.expansion.noListings')}
      </div>
    )
  }

  const numLocale = locale === 'it' ? 'it-IT' : 'en-GB'
  const fmtCurrency = (v: number | null) =>
    v == null
      ? null
      : new Intl.NumberFormat(numLocale, {
          style: 'currency',
          currency: 'EUR',
        }).format(v)
  const fmtNum = (v: number | null) =>
    v == null ? null : new Intl.NumberFormat(numLocale).format(v)
  const truncate = (s: string | null, max = 80) =>
    s == null
      ? null
      : s.length <= max
        ? s
        : s.slice(0, max - 1) + '…'

  const rtf = new Intl.RelativeTimeFormat(numLocale, { numeric: 'auto' })
  const relSync = (d: Date | null) => {
    if (!d) return null
    const diffSec = Math.round((d.getTime() - Date.now()) / 1000)
    const abs = Math.abs(diffSec)
    if (abs < 60) return rtf.format(diffSec, 'second')
    if (abs < 3600) return rtf.format(Math.round(diffSec / 60), 'minute')
    if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), 'hour')
    return rtf.format(Math.round(diffSec / 86400), 'day')
  }

  return (
    <table className="w-full text-xs">
      <thead className="bg-slate-50 dark:bg-slate-800/40 border-b border-slate-200 dark:border-slate-700">
        <tr className="text-left text-slate-500 dark:text-slate-400">
          <th className="py-1.5 px-3 font-medium">
            {t('products.datasheetHub.expansion.col.channel')}
          </th>
          <th className="py-1.5 px-3 font-medium">
            {t('products.datasheetHub.expansion.col.value')}
          </th>
          <th className="py-1.5 px-2 font-medium w-32">
            {t('products.datasheetHub.expansion.col.source')}
          </th>
          <th className="py-1.5 px-2 font-medium w-28 text-right">
            {t('products.datasheetHub.expansion.col.lastSync')}
          </th>
        </tr>
      </thead>
      <tbody>
        {listings.map((l) => {
          const cell = pickChannelCell(
            attrKey as ChannelMappedAttrKey,
            l,
            { fmtCurrency, fmtNum, truncate },
          )
          const driftFromMaster =
            cell.kind === 'master' &&
            masterPreview != null &&
            cell.value != null &&
            cell.value !== masterPreview
          const channelLabel = prettyChannelMarketplace(l.channel, l.marketplace)
          const liveUrl = buildLiveListingUrl(l)

          return (
            <tr
              key={l.id}
              className="border-b border-slate-100 dark:border-slate-800 last:border-b-0"
            >
              <td className="py-1.5 px-3 align-top">
                <span className="text-slate-700 dark:text-slate-200 font-medium">
                  {channelLabel}
                </span>
                {l.validationStatus !== 'VALID' && (
                  <span
                    className={
                      'ml-2 inline-block px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider font-semibold ' +
                      (l.validationStatus === 'ERROR'
                        ? 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300'
                        : 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300')
                    }
                  >
                    {l.validationStatus}
                  </span>
                )}
              </td>
              <td className="py-1.5 px-3 align-top text-slate-900 dark:text-slate-100">
                {cell.value ?? (
                  <span className="text-slate-400 italic">
                    {t('products.datasheetHub.expansion.empty')}
                  </span>
                )}
                {liveUrl && cell.value && (
                  <Link
                    href={liveUrl}
                    target="_blank"
                    rel="noopener"
                    className="ml-2 inline-flex items-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
                    title={t('products.datasheetHub.expansion.openLive')}
                    aria-label={t(
                      'products.datasheetHub.expansion.openLive',
                    )}
                  >
                    <ExternalLink className="w-3 h-3" />
                  </Link>
                )}
              </td>
              <td className="py-1.5 px-2 align-top">
                {cell.kind === 'master' && !driftFromMaster && (
                  <span className="inline-block px-1.5 py-0.5 rounded text-[10px] bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                    {t(
                      'products.datasheetHub.expansion.source.followsMaster',
                    )}
                  </span>
                )}
                {cell.kind === 'override' && (
                  <span className="inline-block px-1.5 py-0.5 rounded text-[10px] bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                    {t('products.datasheetHub.expansion.source.override')}
                  </span>
                )}
                {cell.kind === 'channelOnly' && (
                  <span className="inline-block px-1.5 py-0.5 rounded text-[10px] bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                    {t('products.datasheetHub.expansion.source.channelOnly')}
                  </span>
                )}
                {driftFromMaster && (
                  <span className="inline-block px-1.5 py-0.5 rounded text-[10px] bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300">
                    {t('products.datasheetHub.expansion.source.drift')}
                  </span>
                )}
              </td>
              <td className="py-1.5 px-2 align-top text-right text-slate-500 dark:text-slate-400 tabular-nums">
                {relSync(l.lastSyncedAt) ?? '—'}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function isChannelMapped(attrKey: string): attrKey is ChannelMappedAttrKey {
  return (
    attrKey === 'name' ||
    attrKey === 'description' ||
    attrKey === 'basePrice' ||
    attrKey === 'totalStock' ||
    attrKey === 'bulletPoints' ||
    attrKey === 'amazonAsin' ||
    attrKey === 'ebayItemId' ||
    attrKey === 'shopifyProductId'
  )
}

interface PickedCell {
  /** master = effective value mirrors current master (followMaster=true)
   *  override = channel-specific override is the effective value
   *  channelOnly = identifier exists only on the channel (no master) */
  kind: 'master' | 'override' | 'channelOnly'
  value: string | null
}

interface CellFormatters {
  fmtCurrency: (v: number | null) => string | null
  fmtNum: (v: number | null) => string | null
  truncate: (s: string | null, max?: number) => string | null
}

function pickChannelCell(
  attrKey: ChannelMappedAttrKey,
  l: ChannelListingForExpansion,
  fmt: CellFormatters,
): PickedCell {
  switch (attrKey) {
    case 'name': {
      if (l.followMasterTitle) {
        return { kind: 'master', value: fmt.truncate(l.masterTitle, 80) }
      }
      return {
        kind: 'override',
        value: fmt.truncate(l.titleOverride ?? l.title, 80),
      }
    }
    case 'description': {
      if (l.followMasterDescription) {
        return {
          kind: 'master',
          value: fmt.truncate(l.masterDescription, 100),
        }
      }
      return {
        kind: 'override',
        value: fmt.truncate(l.descriptionOverride ?? l.description, 100),
      }
    }
    case 'basePrice': {
      if (l.followMasterPrice) {
        return {
          kind: 'master',
          value: fmt.fmtCurrency(
            l.masterPrice == null ? null : Number(l.masterPrice),
          ),
        }
      }
      const v = l.priceOverride ?? l.price
      return {
        kind: 'override',
        value: fmt.fmtCurrency(v == null ? null : Number(v)),
      }
    }
    case 'totalStock': {
      if (l.followMasterQuantity) {
        return { kind: 'master', value: fmt.fmtNum(l.masterQuantity) }
      }
      return {
        kind: 'override',
        value: fmt.fmtNum(l.quantityOverride ?? l.quantity),
      }
    }
    case 'bulletPoints': {
      if (l.followMasterBulletPoints) {
        const arr = l.masterBulletPoints
        return {
          kind: 'master',
          value:
            arr.length === 0
              ? null
              : `${arr.length}× — ${fmt.truncate(arr[0], 60) ?? ''}`,
        }
      }
      const arr = l.bulletPointsOverride
      return {
        kind: 'override',
        value:
          arr.length === 0
            ? null
            : `${arr.length}× — ${fmt.truncate(arr[0], 60) ?? ''}`,
      }
    }
    case 'amazonAsin':
      // Identifier rows only show the channel-side value for the
      // matching channel; the row caller is expected to filter
      // listings to channel === 'AMAZON' before passing in, but if
      // not we still degrade safely.
      if (l.channel !== 'AMAZON') return { kind: 'channelOnly', value: null }
      return { kind: 'channelOnly', value: l.externalListingId }
    case 'ebayItemId':
      if (l.channel !== 'EBAY') return { kind: 'channelOnly', value: null }
      return { kind: 'channelOnly', value: l.externalListingId }
    case 'shopifyProductId':
      if (l.channel !== 'SHOPIFY') return { kind: 'channelOnly', value: null }
      return { kind: 'channelOnly', value: l.externalListingId }
  }
}

function buildLiveListingUrl(
  l: ChannelListingForExpansion,
): string | null {
  if (!l.externalListingId) return null
  if (l.channel === 'AMAZON') {
    return `https://www.amazon.${amazonTld(l.marketplace)}/dp/${l.externalListingId}`
  }
  if (l.channel === 'EBAY') {
    return `https://www.ebay.com/itm/${l.externalListingId}`
  }
  return null
}
