/**
 * VR.3 — Variant × channel-market coverage matrix.
 *
 * Sits below the main variant matrix (or flat table) in the
 * Variants tab. Rows = each child variant; columns = every active
 * (channel, marketplace) pair that any variant lives on. Each cell
 * tells the operator whether that variant is published on that
 * market.
 *
 * Cell vocabulary:
 *   ✓ green   isPublished AND listingStatus='ACTIVE'    — live
 *   ⚠ amber   isPublished AND status='DRAFT'/'PENDING'  — staged
 *   ✗ red     exists but isPublished=false OR ERROR     — held back
 *   · grey    no ChannelListing row for this combination — gap
 *
 * Hovering / focusing a cell surfaces a tooltip with the
 * externalListingId (ASIN / eBay ID / Shopify ID), the status,
 * and the last-sync timestamp. Click a populated cell to open the
 * variant's own datasheet hub.
 *
 * The summary line above the table tallies the four buckets so the
 * operator sees "145 live / 12 staged / 0 held / 8 missing" in one
 * glance and knows where to look. This is the audit lens that VR.5
 * builds on for one-click gap remediation.
 */

import Link from 'next/link'
import {
  AlertTriangle,
  Check,
  Minus,
  X,
} from 'lucide-react'
import {
  amazonTld,
  prettyChannelMarketplace,
} from '@/lib/marketplace-code'
import type { getServerT } from '@/lib/i18n/server'

export interface CoverageVariant {
  id: string
  sku: string
  name: string
  listings: CoverageListing[]
}

export interface CoverageListing {
  channel: string
  marketplace: string
  externalListingId: string | null
  listingStatus: string
  isPublished: boolean
  lastSyncedAt: Date | null
}

interface VariantChannelCoverageProps {
  variants: CoverageVariant[]
  locale: 'en' | 'it'
  t: Awaited<ReturnType<typeof getServerT>>
}

type CellStatus = 'live' | 'staged' | 'held' | 'gap'

export default function VariantChannelCoverage({
  variants,
  locale,
  t,
}: VariantChannelCoverageProps) {
  // Collect every (channel, marketplace) pair appearing on any
  // variant, deduped. We render a column per pair so the matrix
  // is honest about what's covered (vs blindly imposing all 11 EU
  // markets when only 5 are active).
  const pairKey = (channel: string, marketplace: string) =>
    `${channel}|${marketplace}`
  const allPairs = new Map<
    string,
    { channel: string; marketplace: string; label: string }
  >()
  for (const v of variants) {
    for (const l of v.listings) {
      const k = pairKey(l.channel, l.marketplace)
      if (!allPairs.has(k)) {
        allPairs.set(k, {
          channel: l.channel,
          marketplace: l.marketplace,
          label: prettyChannelMarketplace(l.channel, l.marketplace),
        })
      }
    }
  }

  // Sort: Amazon first (by marketplace), then eBay, then Shopify,
  // then anything else — alphabetical within group.
  const channelRank: Record<string, number> = {
    AMAZON: 0,
    EBAY: 1,
    SHOPIFY: 2,
  }
  const pairs = [...allPairs.values()].sort((a, b) => {
    const ra = channelRank[a.channel] ?? 99
    const rb = channelRank[b.channel] ?? 99
    if (ra !== rb) return ra - rb
    return a.marketplace.localeCompare(b.marketplace)
  })

  if (pairs.length === 0) {
    return (
      <div className="border border-default dark:border-slate-800 rounded p-4 text-center text-xs text-slate-500 italic">
        {t('products.datasheetHub.coverage.empty')}
      </div>
    )
  }

  // Pre-compute the lookup: variantId × pairKey → listing.
  const cellLookup = new Map<string, CoverageListing>()
  for (const v of variants) {
    for (const l of v.listings) {
      cellLookup.set(`${v.id}|${pairKey(l.channel, l.marketplace)}`, l)
    }
  }

  // Bucket totals for the summary line.
  let live = 0
  let staged = 0
  let held = 0
  let gap = 0
  for (const v of variants) {
    for (const p of pairs) {
      const l = cellLookup.get(`${v.id}|${pairKey(p.channel, p.marketplace)}`)
      const s = classify(l)
      if (s === 'live') live++
      else if (s === 'staged') staged++
      else if (s === 'held') held++
      else gap++
    }
  }
  const totalCells = variants.length * pairs.length

  const numLocale = locale === 'it' ? 'it-IT' : 'en-GB'
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
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
          {t('products.datasheetHub.coverage.title')}
        </div>
        <div className="flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
          <span>
            {t('products.datasheetHub.coverage.summary.cells', {
              total: totalCells,
              variants: variants.length,
              markets: pairs.length,
            })}
          </span>
          <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
            <Check className="w-3 h-3" /> {live}
          </span>
          <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
            <AlertTriangle className="w-3 h-3" /> {staged}
          </span>
          <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400">
            <X className="w-3 h-3" /> {held}
          </span>
          <span className="inline-flex items-center gap-1 text-tertiary">
            <Minus className="w-3 h-3" /> {gap}
          </span>
        </div>
      </div>

      <div className="border border-default dark:border-slate-800 rounded bg-white dark:bg-slate-900 overflow-x-auto">
        <table className="border-collapse text-xs">
          <thead>
            <tr className="border-b border-default dark:border-slate-800 bg-slate-50 dark:bg-slate-800/40">
              <th className="sticky left-0 z-10 bg-slate-50 dark:bg-slate-800/40 px-3 py-2 text-left font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider min-w-[140px]">
                {t('products.col.sku')}
              </th>
              {pairs.map((p) => (
                <th
                  key={pairKey(p.channel, p.marketplace)}
                  className="px-2 py-2 text-center font-medium text-slate-500 dark:text-slate-400 whitespace-nowrap min-w-[88px]"
                  title={p.label}
                >
                  <div className="text-[10px] uppercase tracking-wider">
                    {channelAbbr(p.channel)}
                  </div>
                  <div className="font-mono text-[11px]">
                    {p.marketplace}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {variants.map((v) => (
              <tr
                key={v.id}
                className="border-b border-subtle dark:border-slate-800 last:border-b-0"
              >
                <th
                  scope="row"
                  className="sticky left-0 z-10 bg-white dark:bg-slate-900 px-3 py-2 text-left align-middle"
                >
                  <Link
                    href={`/products/${v.id}/datasheet`}
                    className="hover:underline"
                    title={v.name}
                  >
                    <span className="font-mono text-xs text-slate-700 dark:text-slate-200">
                      {v.sku}
                    </span>
                  </Link>
                </th>
                {pairs.map((p) => {
                  const k = pairKey(p.channel, p.marketplace)
                  const l = cellLookup.get(`${v.id}|${k}`)
                  return (
                    <td
                      key={k}
                      className="px-1 py-1 text-center align-middle"
                    >
                      <CoverageCell
                        listing={l}
                        variantId={v.id}
                        channelLabel={p.label}
                        relSync={relSync}
                        t={t}
                      />
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function CoverageCell({
  listing,
  variantId,
  channelLabel,
  relSync,
  t,
}: {
  listing: CoverageListing | undefined
  variantId: string
  channelLabel: string
  relSync: (d: Date | null) => string | null
  t: Awaited<ReturnType<typeof getServerT>>
}) {
  const status = classify(listing)
  const externalId = listing?.externalListingId ?? null
  const sync = listing ? relSync(listing.lastSyncedAt) : null
  const liveUrl =
    listing && externalId && listing.channel === 'AMAZON'
      ? `https://www.amazon.${amazonTld(listing.marketplace)}/dp/${externalId}`
      : listing && externalId && listing.channel === 'EBAY'
        ? `https://www.ebay.com/itm/${externalId}`
        : null

  const tooltipParts: string[] = [channelLabel]
  if (externalId) tooltipParts.push(externalId)
  if (listing) tooltipParts.push(listing.listingStatus)
  if (sync) tooltipParts.push(t('products.datasheetHub.coverage.lastSync', { ago: sync }))
  const tooltip = tooltipParts.join(' · ')

  const inner = (
    <span
      className={
        'inline-flex items-center justify-center w-6 h-6 rounded ' +
        (status === 'live'
          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
          : status === 'staged'
            ? 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300'
            : status === 'held'
              ? 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300'
              : 'text-slate-300 dark:text-slate-700')
      }
      aria-label={t(`products.datasheetHub.coverage.status.${status}`)}
    >
      {status === 'live' && <Check className="w-3.5 h-3.5" />}
      {status === 'staged' && <AlertTriangle className="w-3.5 h-3.5" />}
      {status === 'held' && <X className="w-3.5 h-3.5" />}
      {status === 'gap' && <Minus className="w-3.5 h-3.5" />}
    </span>
  )

  // Three click targets in priority order: live marketplace listing
  // for green cells with a known live URL, otherwise the variant's
  // own datasheet hub (the operator's "fix this" entry point). Empty
  // cells stay non-interactive — VR.5's create-stub action turns
  // them clickable.
  if (liveUrl) {
    return (
      <Link
        href={liveUrl}
        target="_blank"
        rel="noopener"
        title={tooltip}
        className="inline-block hover:opacity-80"
      >
        {inner}
      </Link>
    )
  }
  if (status === 'gap') {
    return (
      <span title={tooltip} className="inline-block">
        {inner}
      </span>
    )
  }
  return (
    <Link
      href={`/products/${variantId}/datasheet`}
      title={tooltip}
      className="inline-block hover:opacity-80"
    >
      {inner}
    </Link>
  )
}

function classify(l: CoverageListing | undefined): CellStatus {
  if (!l) return 'gap'
  if (l.listingStatus === 'ERROR') return 'held'
  if (!l.isPublished) return 'held'
  if (l.listingStatus === 'ACTIVE') return 'live'
  return 'staged' // DRAFT / PENDING / INACTIVE / etc.
}

function channelAbbr(channel: string): string {
  if (channel === 'AMAZON') return 'AMZ'
  if (channel === 'EBAY') return 'eBay'
  if (channel === 'SHOPIFY') return 'Shop'
  if (channel === 'WOOCOMMERCE') return 'Woo'
  if (channel === 'ETSY') return 'Etsy'
  return channel.slice(0, 4)
}
