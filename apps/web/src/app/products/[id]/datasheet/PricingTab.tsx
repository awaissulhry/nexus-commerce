/**
 * ATM.8 — Per-market pricing grid.
 *
 * One row per ChannelListing. Surfaces the operator's pricing
 * decision surface in one screen:
 *
 *   - Channel / market label + currency it operates in
 *   - Effective price (followMasterPrice resolved) — formatted in
 *     the market's native currency (GBP for UK, USD for US, EUR
 *     elsewhere; VAT-inclusive per EU + UK marketplace convention)
 *   - Sale price when set (G.3)
 *   - Pricing rule chip (FIXED / MATCH_AMAZON / PERCENT_OF_MASTER)
 *     + the percentage adjustment when applicable (Phase 28)
 *   - Lowest competitor price + fetched-when stamp (G.3)
 *   - FBA fee per unit + referral fee % (G.3, Amazon only)
 *   - Best-offer floor (G.3, eBay only)
 *
 * The grid is read-only audit — operators edit pricing in the
 * existing /pricing surface. Footer links over there. Per-cell
 * editing earns its place only if operators actually ask for it
 * inline.
 *
 * Currency model: Amazon's per-marketplace currency is well-known;
 * eBay defaults follow Amazon's mapping for the same market code;
 * Shopify uses the brand's configured currency (we default to EUR
 * since BrandSettings doesn't carry one yet). The numbers stored
 * in ChannelListing.price are already in the market's native
 * currency, so we just format with the right Intl locale +
 * currency code.
 */

import { prisma } from '@nexus/database'
import Link from 'next/link'
import { Activity, AlertTriangle } from 'lucide-react'
import { prettyChannelMarketplace } from '@/lib/marketplace-code'
import type { getServerT } from '@/lib/i18n/server'

interface PricingTabProps {
  productId: string
  locale: 'en' | 'it'
  t: Awaited<ReturnType<typeof getServerT>>
}

// VAT rates per marketplace. EU standard rates as of 2026 — VAT
// applies on consumer-facing prices in EU + UK marketplaces; US/CA
// list prices are pre-tax, so the flag shows accordingly.
const VAT_BY_MARKET: Record<string, { rate: number; included: boolean }> = {
  IT: { rate: 22, included: true },
  DE: { rate: 19, included: true },
  FR: { rate: 20, included: true },
  ES: { rate: 21, included: true },
  NL: { rate: 21, included: true },
  BE: { rate: 21, included: true },
  PL: { rate: 23, included: true },
  CZ: { rate: 21, included: true },
  SE: { rate: 25, included: true },
  UK: { rate: 20, included: true },
  TR: { rate: 18, included: true },
  EG: { rate: 14, included: true },
  AE: { rate: 5, included: true },
  SA: { rate: 15, included: true },
  IN: { rate: 18, included: true },
  US: { rate: 0, included: false },
  CA: { rate: 0, included: false },
  MX: { rate: 16, included: true },
  BR: { rate: 17, included: true },
  JP: { rate: 10, included: true },
  AU: { rate: 10, included: true },
  SG: { rate: 9, included: true },
}

// Currency per marketplace. Amazon defines this; eBay + Shopify
// follow the same mapping for the same market code. Unknown
// markets fall back to EUR.
const CURRENCY_BY_MARKET: Record<string, string> = {
  IT: 'EUR', DE: 'EUR', FR: 'EUR', ES: 'EUR', NL: 'EUR',
  BE: 'EUR', PL: 'PLN', CZ: 'CZK', SE: 'SEK', UK: 'GBP',
  TR: 'TRY', EG: 'EGP', AE: 'AED', SA: 'SAR', IN: 'INR',
  US: 'USD', CA: 'CAD', MX: 'MXN', BR: 'BRL',
  JP: 'JPY', AU: 'AUD', SG: 'SGD',
  GLOBAL: 'EUR', DEFAULT: 'EUR',
}

function currencyFor(marketplace: string): string {
  return CURRENCY_BY_MARKET[marketplace] ?? 'EUR'
}

export default async function PricingTab({
  productId,
  locale,
  t,
}: PricingTabProps) {
  const [master, listings] = await Promise.all([
    prisma.product
      .findUnique({
        where: { id: productId },
        select: { basePrice: true },
      })
      .catch((e: unknown) => {
        console.error('[atm.8] master basePrice fetch failed', e)
        return null
      }),
    prisma.channelListing
      .findMany({
        where: { productId },
        orderBy: [{ channel: 'asc' }, { marketplace: 'asc' }],
        select: {
          id: true,
          channel: true,
          marketplace: true,
          isPublished: true,
          listingStatus: true,
          price: true,
          priceOverride: true,
          followMasterPrice: true,
          masterPrice: true,
          salePrice: true,
          pricingRule: true,
          priceAdjustmentPercent: true,
          estimatedFbaFee: true,
          referralFeePercent: true,
          lowestCompetitorPrice: true,
          competitorFetchedAt: true,
          feeFetchedAt: true,
          bestOfferFloor: true,
        },
      })
      .catch((e: unknown) => {
        console.error('[atm.8] channelListings fetch failed', e)
        return [] as never[]
      }),
  ])

  if (listings.length === 0) {
    return (
      <div className="border border-slate-200 dark:border-slate-800 rounded p-6 text-center text-sm text-slate-500">
        <div className="font-medium text-slate-700 dark:text-slate-300">
          {t('products.datasheetHub.pricing.tab.empty.title')}
        </div>
        <p className="text-xs mt-1">
          {t('products.datasheetHub.pricing.tab.empty.body')}
        </p>
      </div>
    )
  }

  const numLocale = locale === 'it' ? 'it-IT' : 'en-GB'
  const rtf = new Intl.RelativeTimeFormat(numLocale, { numeric: 'auto' })
  const relAge = (d: Date | null) => {
    if (!d) return null
    const diffSec = Math.round((d.getTime() - Date.now()) / 1000)
    const abs = Math.abs(diffSec)
    if (abs < 60) return rtf.format(diffSec, 'second')
    if (abs < 3600) return rtf.format(Math.round(diffSec / 60), 'minute')
    if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), 'hour')
    return rtf.format(Math.round(diffSec / 86400), 'day')
  }

  const masterBase = master?.basePrice == null ? null : Number(master.basePrice)

  const fmtCurrency = (v: number | null, marketplace: string) => {
    if (v == null) return '—'
    return new Intl.NumberFormat(numLocale, {
      style: 'currency',
      currency: currencyFor(marketplace),
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(v)
  }

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-3 flex-wrap text-xs text-slate-500 dark:text-slate-400">
        <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
          {t('products.datasheetHub.pricing.tab.title', {
            count: listings.length,
          })}
        </div>
        <div>
          {t('products.datasheetHub.pricing.tab.masterBase')}:{' '}
          <span className="font-mono tabular-nums text-slate-700 dark:text-slate-200">
            {masterBase == null
              ? '—'
              : new Intl.NumberFormat(numLocale, {
                  style: 'currency',
                  currency: 'EUR',
                }).format(masterBase)}
          </span>
        </div>
      </div>

      <div className="border border-slate-200 dark:border-slate-800 rounded bg-white dark:bg-slate-900 overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 dark:bg-slate-800/40 border-b border-slate-200 dark:border-slate-800">
            <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
              <th className="py-2 px-3 font-medium sticky left-0 z-10 bg-slate-50 dark:bg-slate-800/40 min-w-[140px]">
                {t('products.datasheetHub.pricing.tab.col.market')}
              </th>
              <th className="py-2 px-3 font-medium text-right">
                {t('products.datasheetHub.pricing.tab.col.price')}
              </th>
              <th className="py-2 px-3 font-medium text-right">
                {t('products.datasheetHub.pricing.tab.col.sale')}
              </th>
              <th className="py-2 px-3 font-medium">
                {t('products.datasheetHub.pricing.tab.col.rule')}
              </th>
              <th className="py-2 px-3 font-medium text-right">
                {t('products.datasheetHub.pricing.tab.col.competitor')}
              </th>
              <th className="py-2 px-3 font-medium text-right">
                {t('products.datasheetHub.pricing.tab.col.fees')}
              </th>
              <th className="py-2 px-3 font-medium">
                {t('products.datasheetHub.pricing.tab.col.vat')}
              </th>
            </tr>
          </thead>
          <tbody>
            {listings.map((l) => {
              const effective = l.followMasterPrice
                ? l.masterPrice == null
                  ? null
                  : Number(l.masterPrice)
                : l.priceOverride == null
                  ? l.price == null
                    ? null
                    : Number(l.price)
                  : Number(l.priceOverride)
              const sale =
                l.salePrice == null ? null : Number(l.salePrice)
              const competitor =
                l.lowestCompetitorPrice == null
                  ? null
                  : Number(l.lowestCompetitorPrice)
              const fbaFee =
                l.estimatedFbaFee == null
                  ? null
                  : Number(l.estimatedFbaFee)
              const referralPct =
                l.referralFeePercent == null
                  ? null
                  : Number(l.referralFeePercent)
              const bestOffer =
                l.bestOfferFloor == null
                  ? null
                  : Number(l.bestOfferFloor)
              const adjPct =
                l.priceAdjustmentPercent == null
                  ? null
                  : Number(l.priceAdjustmentPercent)
              const vatInfo = VAT_BY_MARKET[l.marketplace] ?? null
              const competitorBelow =
                effective != null &&
                competitor != null &&
                competitor < effective
              const inactive = !l.isPublished || l.listingStatus !== 'ACTIVE'
              return (
                <tr
                  key={l.id}
                  className={
                    'border-b border-slate-100 dark:border-slate-800 last:border-b-0 ' +
                    (inactive ? 'opacity-60' : '')
                  }
                >
                  <td className="py-2 px-3 sticky left-0 z-10 bg-white dark:bg-slate-900 align-middle">
                    <div className="text-slate-900 dark:text-slate-100 font-medium">
                      {prettyChannelMarketplace(l.channel, l.marketplace)}
                    </div>
                    <div className="text-[10px] text-slate-500 font-mono">
                      {currencyFor(l.marketplace)}
                      {!l.isPublished && ` · ${t('products.datasheetHub.pricing.tab.unpublished')}`}
                    </div>
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums align-middle">
                    <span className="text-slate-900 dark:text-slate-100 font-semibold">
                      {fmtCurrency(effective, l.marketplace)}
                    </span>
                    {!l.followMasterPrice && (
                      <span
                        className="block text-[10px] text-blue-600 dark:text-blue-400 uppercase tracking-wider"
                        title={t(
                          'products.datasheetHub.expansion.source.override',
                        )}
                      >
                        {t('products.datasheetHub.expansion.source.override')}
                      </span>
                    )}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums align-middle">
                    {sale == null ? (
                      <span className="text-slate-300">—</span>
                    ) : (
                      <span className="text-red-600 dark:text-red-400 font-medium">
                        {fmtCurrency(sale, l.marketplace)}
                      </span>
                    )}
                  </td>
                  <td className="py-2 px-3 align-middle">
                    <span
                      className={
                        'inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ' +
                        (l.pricingRule === 'FIXED'
                          ? 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
                          : 'bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300')
                      }
                    >
                      {l.pricingRule}
                      {adjPct != null && adjPct !== 0 && (
                        <span className="ml-0.5 tabular-nums">
                          {adjPct > 0 ? '+' : ''}
                          {adjPct}%
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums align-middle">
                    {competitor == null ? (
                      <span className="text-slate-300">—</span>
                    ) : (
                      <span
                        className={
                          competitorBelow
                            ? 'inline-flex items-center gap-1 text-red-600 dark:text-red-400 font-medium'
                            : 'text-slate-700 dark:text-slate-300'
                        }
                        title={
                          competitorBelow
                            ? t(
                                'products.datasheetHub.pricing.tab.competitorBelow',
                              )
                            : undefined
                        }
                      >
                        {competitorBelow && (
                          <AlertTriangle className="w-3 h-3" />
                        )}
                        {fmtCurrency(competitor, l.marketplace)}
                      </span>
                    )}
                    {l.competitorFetchedAt && (
                      <span className="block text-[10px] text-slate-400">
                        {relAge(l.competitorFetchedAt)}
                      </span>
                    )}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums align-middle">
                    {l.channel === 'AMAZON' &&
                    (fbaFee != null || referralPct != null) ? (
                      <span className="text-slate-700 dark:text-slate-300">
                        {fbaFee != null && (
                          <span title="FBA fee">
                            {fmtCurrency(fbaFee, l.marketplace)}
                          </span>
                        )}
                        {fbaFee != null && referralPct != null && ' · '}
                        {referralPct != null && (
                          <span title="Referral fee %">{referralPct}%</span>
                        )}
                      </span>
                    ) : l.channel === 'EBAY' && bestOffer != null ? (
                      <span
                        className="text-slate-700 dark:text-slate-300"
                        title={t(
                          'products.datasheetHub.pricing.tab.bestOfferFloor',
                        )}
                      >
                        ≥ {fmtCurrency(bestOffer, l.marketplace)}
                      </span>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                    {l.feeFetchedAt && (
                      <span className="block text-[10px] text-slate-400">
                        {relAge(l.feeFetchedAt)}
                      </span>
                    )}
                  </td>
                  <td className="py-2 px-3 align-middle">
                    {vatInfo == null ? (
                      <span className="text-slate-300">—</span>
                    ) : vatInfo.included ? (
                      <span
                        className="inline-block px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 text-[10px]"
                        title={t(
                          'products.datasheetHub.pricing.tab.vatIncludedTip',
                          { rate: vatInfo.rate },
                        )}
                      >
                        {t('products.datasheetHub.pricing.tab.vatIncluded', {
                          rate: vatInfo.rate,
                        })}
                      </span>
                    ) : (
                      <span
                        className="inline-block px-1.5 py-0.5 rounded bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-300 text-[10px]"
                        title={t(
                          'products.datasheetHub.pricing.tab.vatExclusiveTip',
                        )}
                      >
                        {t('products.datasheetHub.pricing.tab.vatExclusive')}
                      </span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between gap-3 text-[10px] text-slate-500 dark:text-slate-400">
        <div className="italic">
          {t('products.datasheetHub.pricing.tab.editNote')}
        </div>
        <Link
          href="/pricing"
          className="inline-flex items-center gap-1 text-slate-600 dark:text-slate-300 hover:underline"
        >
          <Activity className="w-3 h-3" />
          {t('products.datasheetHub.pricing.tab.openPricingEngine')}
        </Link>
      </div>
    </div>
  )
}
