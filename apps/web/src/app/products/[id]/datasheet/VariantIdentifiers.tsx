/**
 * VR.4 — Variant identifier audit table.
 *
 * Sits below the VR.3 channel-coverage matrix in the Variants tab.
 * Where the coverage matrix answers "is this variant on this
 * market?" (presence), the identifier audit answers "what is the
 * actual ASIN / eBay ID / Shopify ID for this variant on each
 * channel?" (identity).
 *
 * Single row per variant. Columns:
 *
 *   SKU       master SKU (links to variant hub)
 *   GTIN/UPC/EAN  master barcode identifiers
 *   Amazon    distinct ASINs across all the variant's Amazon
 *             listings, with a "× N" multiplier when one ASIN is
 *             shared across multiple marketplaces (the common case
 *             for parent-grouped catalogs)
 *   eBay      distinct eBay item IDs (similar)
 *   Shopify   single Shopify product ID (Shopify is one-store)
 *
 * Discrepancy badge: when a variant's master amazonAsin field on
 * Product doesn't match any of the channel-side ASINs, that's
 * usually sync skew — display an amber "?" next to the master cell.
 * Same check for ebayItemId and shopifyProductId.
 *
 * Read-only. The view is for audit + cross-system mapping; edits
 * happen on the variant's own datasheet hub (one click away via
 * the SKU link).
 */

import Link from 'next/link'
import { AlertTriangle } from 'lucide-react'
import type { getServerT } from '@/lib/i18n/server'

export interface IdentifierVariant {
  id: string
  sku: string
  name: string
  gtin: string | null
  upc: string | null
  ean: string | null
  /** Master-level identifiers — the legacy "primary" ASIN/eBay/Shopify
   *  IDs that historically sat on Product before per-channel listings.
   *  Kept for diff detection against the channel-side values. */
  amazonAsin: string | null
  ebayItemId: string | null
  shopifyProductId: string | null
  /** Per-channel external IDs — collected from channelListings. */
  listings: Array<{
    channel: string
    marketplace: string
    externalListingId: string | null
  }>
}

interface VariantIdentifiersProps {
  variants: IdentifierVariant[]
  t: Awaited<ReturnType<typeof getServerT>>
}

export default function VariantIdentifiers({
  variants,
  t,
}: VariantIdentifiersProps) {
  if (variants.length === 0) return null

  return (
    <div className="space-y-2">
      <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
        {t('products.datasheetHub.identifiers.title')}
      </div>
      <div className="border border-slate-200 dark:border-slate-800 rounded bg-white dark:bg-slate-900 overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 dark:bg-slate-800/40 border-b border-slate-200 dark:border-slate-800">
            <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
              <th className="py-2 px-3 font-medium sticky left-0 z-10 bg-slate-50 dark:bg-slate-800/40">
                {t('products.col.sku')}
              </th>
              <th className="py-2 px-3 font-medium">GTIN</th>
              <th className="py-2 px-3 font-medium">UPC</th>
              <th className="py-2 px-3 font-medium">EAN</th>
              <th className="py-2 px-3 font-medium">
                {t('products.datasheet.specs.amazonAsin')}
              </th>
              <th className="py-2 px-3 font-medium">
                {t('products.datasheet.specs.ebayId')}
              </th>
              <th className="py-2 px-3 font-medium">
                {t('products.datasheet.specs.shopifyId')}
              </th>
            </tr>
          </thead>
          <tbody>
            {variants.map((v) => {
              const amazon = collectIds(v.listings, 'AMAZON')
              const ebay = collectIds(v.listings, 'EBAY')
              const shopify = collectIds(v.listings, 'SHOPIFY')
              return (
                <tr
                  key={v.id}
                  className="border-b border-slate-100 dark:border-slate-800 last:border-b-0 hover:bg-slate-50 dark:hover:bg-slate-800/30"
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
                  <IdCell value={v.gtin} t={t} />
                  <IdCell value={v.upc} t={t} />
                  <IdCell value={v.ean} t={t} />
                  <ChannelIdCell
                    masterValue={v.amazonAsin}
                    grouped={amazon}
                    t={t}
                  />
                  <ChannelIdCell
                    masterValue={v.ebayItemId}
                    grouped={ebay}
                    t={t}
                  />
                  <ChannelIdCell
                    masterValue={v.shopifyProductId}
                    grouped={shopify}
                    t={t}
                  />
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function IdCell({
  value,
  t,
}: {
  value: string | null
  t: Awaited<ReturnType<typeof getServerT>>
}) {
  return (
    <td className="py-2 px-3 font-mono text-xs text-slate-700 dark:text-slate-300 align-middle">
      {value ?? (
        <span
          className="text-slate-300 dark:text-slate-600"
          title={t('products.datasheetHub.identifiers.notSet')}
        >
          —
        </span>
      )}
    </td>
  )
}

/**
 * Channel ID cell renders the distinct external IDs across the
 * variant's listings on that channel. When the master-level ID
 * (legacy Product.amazonAsin etc.) doesn't appear among the
 * channel-side IDs, we tag the cell with an amber ⚠ indicating
 * sync skew worth investigating.
 */
function ChannelIdCell({
  masterValue,
  grouped,
  t,
}: {
  masterValue: string | null
  grouped: Array<{ id: string; markets: string[] }>
  t: Awaited<ReturnType<typeof getServerT>>
}) {
  if (grouped.length === 0 && !masterValue) {
    return (
      <td className="py-2 px-3 text-slate-300 dark:text-slate-600 align-middle">
        —
      </td>
    )
  }

  // Detect master/channel mismatch. If master is set AND grouped
  // doesn't contain it, the master is stale.
  const masterMatchesChannel =
    masterValue == null ||
    grouped.some((g) => g.id === masterValue)
  const driftFlag = masterValue != null && !masterMatchesChannel

  return (
    <td className="py-2 px-3 align-middle">
      <div className="flex flex-col gap-0.5">
        {grouped.map((g) => (
          <span
            key={g.id}
            className="inline-flex items-center gap-1 font-mono text-xs text-slate-900 dark:text-slate-100"
          >
            <span>{g.id}</span>
            {g.markets.length > 1 && (
              <span
                className="text-[10px] text-slate-500"
                title={g.markets.join(', ')}
              >
                ×{g.markets.length}
              </span>
            )}
          </span>
        ))}
        {/* Master-only case: legacy Product.amazonAsin set but no
            channel listing carries it. Surface as a single line
            (no multiplier) with the ⚠ drift flag. */}
        {grouped.length === 0 && masterValue && (
          <span className="inline-flex items-center gap-1 font-mono text-xs text-slate-500 italic">
            {masterValue}
            <span
              className="text-[10px] text-slate-400"
              title={t('products.datasheetHub.identifiers.masterOnly')}
            >
              (master)
            </span>
          </span>
        )}
        {driftFlag && (
          <span
            className="inline-flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400"
            title={t('products.datasheetHub.identifiers.drift', {
              master: masterValue,
            })}
          >
            <AlertTriangle className="w-3 h-3" />
            <span>{t('products.datasheetHub.identifiers.driftShort')}</span>
          </span>
        )}
      </div>
    </td>
  )
}

/**
 * Collects distinct external IDs for a channel + the marketplaces
 * each ID appears on. Used to render "B08XYZ ×3 (IT, DE, FR)".
 */
function collectIds(
  listings: IdentifierVariant['listings'],
  channel: string,
): Array<{ id: string; markets: string[] }> {
  const byId = new Map<string, Set<string>>()
  for (const l of listings) {
    if (l.channel !== channel) continue
    if (!l.externalListingId) continue
    if (!byId.has(l.externalListingId)) byId.set(l.externalListingId, new Set())
    byId.get(l.externalListingId)!.add(l.marketplace)
  }
  return [...byId.entries()]
    .map(([id, m]) => ({ id, markets: [...m].sort() }))
    .sort((a, b) => b.markets.length - a.markets.length)
}

