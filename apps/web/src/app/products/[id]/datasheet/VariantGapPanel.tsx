/**
 * VR.5 — Variant gap panel.
 *
 * VR.3's coverage matrix shows every cell — live, staged, held,
 * missing — in one grid. That's the audit view. This panel
 * complements it with the focused worklist: only the gaps, grouped
 * by variant, with deep-links to the surfaces where the operator
 * actually creates the missing listings.
 *
 * Scope is read-side. Bulk "create stub listings" via
 * OutboundSyncQueue is intentionally deferred to VR.9 (bulk
 * variant operations) so the write path lands once with shared
 * confirmation + audit substrate, not split across phases.
 *
 * What counts as a gap:
 *   - A (variant, channel, marketplace) combination where at least
 *     one OTHER variant of the parent has a ChannelListing on that
 *     marketplace, but THIS variant does not.
 *   - We don't flag markets where the parent has zero presence at
 *     all — those aren't "gaps", they're "not in scope". Operators
 *     launch a new market via /listings/<channel>, not from this
 *     drill-down.
 *
 * Outputs three views:
 *   1. Summary stats: total gaps + variants affected + markets affected
 *   2. Top-N variants by gap count, each linking to its hub
 *   3. Per-market rollup with "fix on this marketplace" link to
 *      /listings/<channel>/<marketplace>
 */

import Link from 'next/link'
import { AlertTriangle, ArrowRight } from 'lucide-react'
import { prettyChannelMarketplace } from '@/lib/marketplace-code'
import type { getServerT } from '@/lib/i18n/server'

export interface GapVariant {
  id: string
  sku: string
  name: string
  listings: Array<{
    channel: string
    marketplace: string
  }>
}

interface VariantGapPanelProps {
  variants: GapVariant[]
  t: Awaited<ReturnType<typeof getServerT>>
}

export default function VariantGapPanel({ variants, t }: VariantGapPanelProps) {
  if (variants.length === 0) return null

  // Build the set of (channel, marketplace) pairs that the parent
  // is present on — the union across all variants. Anything outside
  // this set isn't a gap, it's out of scope.
  const allPairs = new Map<
    string,
    { channel: string; marketplace: string; label: string }
  >()
  for (const v of variants) {
    for (const l of v.listings) {
      const k = `${l.channel}|${l.marketplace}`
      if (!allPairs.has(k)) {
        allPairs.set(k, {
          channel: l.channel,
          marketplace: l.marketplace,
          label: prettyChannelMarketplace(l.channel, l.marketplace),
        })
      }
    }
  }

  // No active markets → nothing meaningful to flag yet. Operator
  // sees the empty state from the rest of the hub.
  if (allPairs.size === 0) {
    return null
  }

  // For each variant, compute which pairs it's MISSING.
  type Gap = { channel: string; marketplace: string; label: string }
  const gapsByVariant = new Map<string, Gap[]>()
  for (const v of variants) {
    const present = new Set(
      v.listings.map((l) => `${l.channel}|${l.marketplace}`),
    )
    const missing: Gap[] = []
    for (const [k, p] of allPairs) {
      if (!present.has(k)) missing.push(p)
    }
    if (missing.length > 0) gapsByVariant.set(v.id, missing)
  }

  if (gapsByVariant.size === 0) {
    return (
      <div className="border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950 rounded p-3 text-sm text-emerald-800 dark:text-emerald-200 inline-flex items-center gap-2">
        <span aria-hidden>✓</span>
        <span>{t('products.datasheetHub.gaps.noneTitle')}</span>
      </div>
    )
  }

  // Aggregate per market — how many variants are missing this market.
  type MarketGap = {
    key: string
    channel: string
    marketplace: string
    label: string
    affected: number
  }
  const gapsByMarket = new Map<string, MarketGap>()
  for (const gaps of gapsByVariant.values()) {
    for (const g of gaps) {
      const key = `${g.channel}|${g.marketplace}`
      const m = gapsByMarket.get(key)
      if (m) m.affected++
      else
        gapsByMarket.set(key, {
          key,
          channel: g.channel,
          marketplace: g.marketplace,
          label: g.label,
          affected: 1,
        })
    }
  }

  const totalGaps = [...gapsByVariant.values()].reduce(
    (acc, g) => acc + g.length,
    0,
  )
  const variantsAffected = gapsByVariant.size
  const marketsAffected = gapsByMarket.size

  // Top 10 by gap count to keep the variant rollup tight; "see all"
  // routes to the coverage matrix above where every gap is visible.
  const variantGapList = variants
    .map((v) => ({ v, gaps: gapsByVariant.get(v.id) ?? [] }))
    .filter((row) => row.gaps.length > 0)
    .sort((a, b) => b.gaps.length - a.gaps.length)
    .slice(0, 10)

  const marketGapList = [...gapsByMarket.values()]
    .sort((a, b) => b.affected - a.affected)
    .slice(0, 10)

  return (
    <div className="border border-amber-200 dark:border-amber-900 bg-amber-50/40 dark:bg-amber-950/20 rounded p-3 space-y-3">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 text-sm font-medium text-amber-900 dark:text-amber-200">
          <AlertTriangle className="w-4 h-4" />
          <span>{t('products.datasheetHub.gaps.title')}</span>
        </div>
        <div className="text-xs text-amber-800 dark:text-amber-300">
          {t('products.datasheetHub.gaps.summary', {
            total: totalGaps,
            variants: variantsAffected,
            markets: marketsAffected,
          })}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* By variant */}
        <div className="bg-white dark:bg-slate-900 border border-amber-200 dark:border-amber-900/50 rounded">
          <div className="px-3 py-2 border-b border-amber-200 dark:border-amber-900/50 text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-medium">
            {t('products.datasheetHub.gaps.byVariant')}
          </div>
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {variantGapList.map(({ v, gaps }) => (
              <li
                key={v.id}
                className="px-3 py-2 flex items-center justify-between gap-2 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/products/${v.id}/datasheet`}
                    className="font-mono text-xs text-slate-700 dark:text-slate-200 hover:underline"
                  >
                    {v.sku}
                  </Link>
                  <div
                    className="text-[10px] text-slate-500 line-clamp-1"
                    title={gaps.map((g) => g.label).join(', ')}
                  >
                    {gaps
                      .slice(0, 3)
                      .map((g) => g.label)
                      .join(' · ')}
                    {gaps.length > 3 &&
                      ` · +${gaps.length - 3} ${t('products.datasheetHub.gaps.more')}`}
                  </div>
                </div>
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 text-xs font-medium tabular-nums">
                  {gaps.length}
                </span>
              </li>
            ))}
          </ul>
        </div>

        {/* By market */}
        <div className="bg-white dark:bg-slate-900 border border-amber-200 dark:border-amber-900/50 rounded">
          <div className="px-3 py-2 border-b border-amber-200 dark:border-amber-900/50 text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-medium">
            {t('products.datasheetHub.gaps.byMarket')}
          </div>
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {marketGapList.map((m) => {
              const channelHref = listingsHrefFor(m.channel, m.marketplace)
              return (
                <li
                  key={m.key}
                  className="px-3 py-2 flex items-center justify-between gap-2 text-sm"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-slate-900 dark:text-slate-100">
                      {m.label}
                    </div>
                    <div className="text-[10px] text-slate-500">
                      {t(
                        m.affected === 1
                          ? 'products.datasheetHub.gaps.marketAffected.one'
                          : 'products.datasheetHub.gaps.marketAffected.other',
                        { count: m.affected },
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 text-xs font-medium tabular-nums">
                      {m.affected}
                    </span>
                    {channelHref && (
                      <Link
                        href={channelHref}
                        className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline"
                        title={t('products.datasheetHub.gaps.fixOn', {
                          channel: m.label,
                        })}
                      >
                        <span>{t('products.datasheetHub.gaps.fixOnShort')}</span>
                        <ArrowRight className="w-3 h-3" />
                      </Link>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      </div>

      <div className="text-[10px] text-amber-700 dark:text-amber-400 italic">
        {t('products.datasheetHub.gaps.bulkComingNote')}
      </div>
    </div>
  )
}

/**
 * Deep-link target for "fix this market" rows. Routes to the same
 * per-channel listings surfaces the rest of the app uses for
 * channel-scoped work.
 */
function listingsHrefFor(
  channel: string,
  marketplace: string,
): string | null {
  if (channel === 'AMAZON') return `/listings/amazon/${marketplace}`
  if (channel === 'EBAY') return `/listings/ebay/${marketplace}`
  if (channel === 'SHOPIFY') return `/listings/shopify`
  return null
}
