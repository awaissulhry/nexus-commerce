/**
 * VR.6 — Per-variant pricing & inventory deltas.
 *
 * One row per variant. Operator sees, in one strip:
 *
 *   - Master price (variant's Product.basePrice)
 *   - Δ vs parent: percent diff against the parent's basePrice,
 *     color-coded. Catches "Red-XS is €5 below typical XS — typo?"
 *     class of bugs.
 *   - Master stock (variant's Product.totalStock)
 *   - Effective per-channel price (one chip per active listing).
 *     Click chip → opens that listing's live marketplace page when
 *     known; otherwise the variant's hub.
 *   - Effective per-channel quantity (compact).
 *   - Outlier flag (⚠) when the variant's master price is more than
 *     OUTLIER_PCT below or above the parent base.
 *
 * "Effective" follows the same rule as ATM.4 and VR.4: when
 * followMasterPrice=true (the SSOT default) the channel uses the
 * mirrored master value; otherwise the explicit override.
 *
 * Heatmap thresholds:
 *   |Δ| < 2 %                    no tone
 *   2 % ≤ |Δ| < OUTLIER_PCT      amber
 *   |Δ| ≥ OUTLIER_PCT            red + outlier flag
 *
 * OUTLIER_PCT is intentionally generous (12 %) so that legitimate
 * "XS smaller, XXL bigger" tier pricing doesn't pollute the
 * worklist. Operators set their own per-axis tier rules in
 * /pricing/rules; this is the spot-the-typo lens, not the
 * pricing-engine UI.
 */

import Link from 'next/link'
import { AlertTriangle } from 'lucide-react'
import {
  amazonTld,
  prettyChannelMarketplace,
} from '@/lib/marketplace-code'
import type { getServerT } from '@/lib/i18n/server'

const OUTLIER_PCT = 12

export interface PricingListing {
  channel: string
  marketplace: string
  externalListingId: string | null
  price: { toString(): string } | null
  priceOverride: { toString(): string } | null
  followMasterPrice: boolean
  quantity: number | null
  quantityOverride: number | null
  followMasterQuantity: boolean
  isPublished: boolean
  listingStatus: string
}

export interface PricingVariant {
  id: string
  sku: string
  name: string
  basePrice: { toString(): string } | null
  totalStock: number
  listings: PricingListing[]
}

interface VariantPricingPanelProps {
  parentBasePrice: number | null
  variants: PricingVariant[]
  locale: 'en' | 'it'
  t: Awaited<ReturnType<typeof getServerT>>
}

export default function VariantPricingPanel({
  parentBasePrice,
  variants,
  locale,
  t,
}: VariantPricingPanelProps) {
  if (variants.length === 0) return null

  const numLocale = locale === 'it' ? 'it-IT' : 'en-GB'
  const fmtCurrency = (v: number | null) =>
    v == null
      ? '—'
      : new Intl.NumberFormat(numLocale, {
          style: 'currency',
          currency: 'EUR',
        }).format(v)
  const fmtPct = (v: number) =>
    new Intl.NumberFormat(numLocale, {
      style: 'percent',
      maximumFractionDigits: 1,
      signDisplay: 'exceptZero',
    }).format(v / 100)
  const fmtNum = (v: number) =>
    new Intl.NumberFormat(numLocale).format(v)

  // Per-variant delta calculation against the parent base. Returns
  // null when either value is missing — operator sees "—" rather
  // than a misleading "+100%".
  function computeDelta(childBase: number | null): number | null {
    if (parentBasePrice == null || childBase == null || parentBasePrice === 0)
      return null
    return ((childBase - parentBasePrice) / parentBasePrice) * 100
  }

  // Bucket totals for the summary line.
  let outliers = 0
  let amber = 0
  let zeroStockVariants = 0
  const variantData = variants.map((v) => {
    const base = v.basePrice == null ? null : Number(v.basePrice)
    const delta = computeDelta(base)
    let tone: 'flat' | 'amber' | 'red' = 'flat'
    if (delta != null) {
      const abs = Math.abs(delta)
      if (abs >= OUTLIER_PCT) tone = 'red'
      else if (abs >= 2) tone = 'amber'
    }
    if (tone === 'red') outliers++
    else if (tone === 'amber') amber++
    if (v.totalStock <= 0) zeroStockVariants++
    return { v, base, delta, tone }
  })

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
          {t('products.datasheetHub.pricing.title')}
        </div>
        <div className="flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
          <span>
            {t('products.datasheetHub.pricing.parentBase')}:{' '}
            <span className="font-mono tabular-nums text-slate-700 dark:text-slate-200">
              {fmtCurrency(parentBasePrice)}
            </span>
          </span>
          {outliers > 0 && (
            <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400">
              <AlertTriangle className="w-3 h-3" />
              {t('products.datasheetHub.pricing.outliers', { count: outliers })}
            </span>
          )}
          {amber > 0 && (
            <span className="text-amber-600 dark:text-amber-400">
              {t('products.datasheetHub.pricing.warnings', { count: amber })}
            </span>
          )}
          {zeroStockVariants > 0 && (
            <span className="text-slate-500">
              {t('products.datasheetHub.pricing.zeroStock', {
                count: zeroStockVariants,
              })}
            </span>
          )}
        </div>
      </div>
      <div className="border border-default dark:border-slate-800 rounded bg-white dark:bg-slate-900 overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 dark:bg-slate-800/40 border-b border-default dark:border-slate-800">
            <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
              <th className="py-2 px-3 font-medium sticky left-0 z-10 bg-slate-50 dark:bg-slate-800/40">
                {t('products.col.sku')}
              </th>
              <th className="py-2 px-3 font-medium text-right">
                {t('products.datasheetHub.pricing.col.masterPrice')}
              </th>
              <th className="py-2 px-3 font-medium text-right">
                {t('products.datasheetHub.pricing.col.delta')}
              </th>
              <th className="py-2 px-3 font-medium text-right">
                {t('products.datasheetHub.pricing.col.stock')}
              </th>
              <th className="py-2 px-3 font-medium">
                {t('products.datasheetHub.pricing.col.channels')}
              </th>
            </tr>
          </thead>
          <tbody>
            {variantData.map(({ v, base, delta, tone }) => {
              const channelChips = buildChannelChips(
                v.listings,
                fmtCurrency,
                fmtNum,
              )
              return (
                <tr
                  key={v.id}
                  className="border-b border-subtle dark:border-slate-800 last:border-b-0 hover:bg-slate-50 dark:hover:bg-slate-800/30"
                >
                  <td className="py-2 px-3 sticky left-0 z-10 bg-white dark:bg-slate-900 align-middle">
                    <Link
                      href={`/products/${v.id}/datasheet`}
                      className="font-mono text-xs text-slate-700 dark:text-slate-200 hover:underline"
                      title={v.name}
                    >
                      {v.sku}
                    </Link>
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums text-slate-900 dark:text-slate-100 align-middle">
                    {fmtCurrency(base)}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums align-middle">
                    {delta == null ? (
                      <span className="text-slate-300">—</span>
                    ) : (
                      <span
                        className={
                          'inline-flex items-center gap-1 ' +
                          (tone === 'red'
                            ? 'text-red-600 dark:text-red-400 font-semibold'
                            : tone === 'amber'
                              ? 'text-amber-600 dark:text-amber-400'
                              : 'text-slate-500 dark:text-slate-400')
                        }
                      >
                        {tone === 'red' && (
                          <AlertTriangle className="w-3 h-3" />
                        )}
                        {fmtPct(delta)}
                      </span>
                    )}
                  </td>
                  <td
                    className={
                      'py-2 px-3 text-right tabular-nums align-middle ' +
                      (v.totalStock <= 0
                        ? 'text-amber-600 dark:text-amber-400'
                        : 'text-slate-700 dark:text-slate-200')
                    }
                  >
                    {fmtNum(v.totalStock)}
                  </td>
                  <td className="py-2 px-3 align-middle">
                    {channelChips.length === 0 ? (
                      <span className="text-slate-300 text-xs">—</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {channelChips.map((c) => (
                          <ChannelChip
                            key={c.key}
                            chip={c}
                            base={base}
                            t={t}
                            fmtPct={fmtPct}
                          />
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

interface ChannelChip {
  key: string
  label: string
  liveUrl: string | null
  effectivePrice: number | null
  effectiveQty: number | null
  isOverride: boolean
  isPublished: boolean
  listingStatus: string
  priceDisplay: string
  qtyDisplay: string
}

function buildChannelChips(
  listings: PricingListing[],
  fmtCurrency: (v: number | null) => string,
  fmtNum: (v: number) => string,
): ChannelChip[] {
  return listings
    .filter((l) => l.isPublished && l.listingStatus === 'ACTIVE')
    .map((l) => {
      const effectivePrice = l.followMasterPrice
        ? l.price == null
          ? null
          : Number(l.price)
        : l.priceOverride == null
          ? null
          : Number(l.priceOverride)
      const effectiveQty = l.followMasterQuantity
        ? l.quantity
        : l.quantityOverride
      const isOverride = !l.followMasterPrice && l.priceOverride != null
      const url =
        l.externalListingId && l.channel === 'AMAZON'
          ? `https://www.amazon.${amazonTld(l.marketplace)}/dp/${l.externalListingId}`
          : l.externalListingId && l.channel === 'EBAY'
            ? `https://www.ebay.com/itm/${l.externalListingId}`
            : null
      return {
        key: `${l.channel}|${l.marketplace}`,
        label: prettyChannelMarketplace(l.channel, l.marketplace),
        liveUrl: url,
        effectivePrice,
        effectiveQty,
        isOverride,
        isPublished: l.isPublished,
        listingStatus: l.listingStatus,
        priceDisplay: fmtCurrency(effectivePrice),
        qtyDisplay: effectiveQty == null ? '—' : fmtNum(effectiveQty),
      }
    })
    .sort((a, b) => a.label.localeCompare(b.label))
}

function ChannelChip({
  chip,
  base,
  t,
  fmtPct,
}: {
  chip: ChannelChip
  base: number | null
  t: Awaited<ReturnType<typeof getServerT>>
  fmtPct: (v: number) => string
}) {
  // Per-channel delta against the variant's master price (not the
  // parent). Catches the second class of bugs: variant master is
  // €99 but Amazon DE charges €110.
  const channelDelta =
    base != null && chip.effectivePrice != null && base !== 0
      ? ((chip.effectivePrice - base) / base) * 100
      : null
  const channelTone: 'flat' | 'amber' | 'red' =
    channelDelta == null
      ? 'flat'
      : Math.abs(channelDelta) >= OUTLIER_PCT
        ? 'red'
        : Math.abs(channelDelta) >= 2
          ? 'amber'
          : 'flat'

  const baseClass =
    'inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] tabular-nums '
  const toneClass =
    channelTone === 'red'
      ? 'border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300'
      : channelTone === 'amber'
        ? 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300'
        : chip.isOverride
          ? 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-300'
          : 'border-default bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200'

  const tooltipParts = [chip.label, chip.priceDisplay]
  if (chip.qtyDisplay !== '—')
    tooltipParts.push(
      `${t('products.datasheetHub.pricing.col.stock')} ${chip.qtyDisplay}`,
    )
  if (channelDelta != null && Math.abs(channelDelta) >= 2)
    tooltipParts.push(fmtPct(channelDelta))
  if (chip.isOverride)
    tooltipParts.push(t('products.datasheetHub.expansion.source.override'))
  const tooltip = tooltipParts.join(' · ')

  const content = (
    <span className={baseClass + toneClass} title={tooltip}>
      <span className="font-medium">{chip.label}</span>
      <span>{chip.priceDisplay}</span>
      {chip.qtyDisplay !== '—' && chip.qtyDisplay !== '0' && (
        <span className="text-[9px] opacity-70">×{chip.qtyDisplay}</span>
      )}
    </span>
  )
  if (chip.liveUrl) {
    return (
      <Link
        href={chip.liveUrl}
        target="_blank"
        rel="noopener"
        className="hover:opacity-80"
      >
        {content}
      </Link>
    )
  }
  return content
}
