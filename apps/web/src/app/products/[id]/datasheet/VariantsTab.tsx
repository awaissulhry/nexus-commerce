/**
 * VR.1 + VR.2 — Variants tab orchestrator.
 *
 * Mounts under the hub's 9th tab (parent SKUs only). Renders one
 * of two views:
 *
 *   matrix (default)  2-D Color × Size cross-tab (VR.2) — when
 *                     axis detection succeeds. Operator sees the
 *                     full variation grid and gaps at a glance.
 *   flat              Single-row-per-variant table (VR.1) — used
 *                     when no axes are detected, or when the
 *                     operator opts into it via ?layout=flat.
 *
 * The matrix is the headline view because it matches the operator's
 * mental model for apparel/gear (Color × Size). The flat list stays
 * available for axis-less parents and ID/audit work.
 *
 * Axis detection draws on three signals (variantAxes.ts):
 *   1. ChannelListing.variationTheme (highest trust)
 *   2. ChannelListing.variationMapping JSON keys
 *   3. categoryAttributes ≥60% shared-key heuristic
 *
 * Read-only. VR.3 wires per-cell channel coverage; VR.5 turns empty
 * matrix cells into a "create stub listing" action.
 */

import { prisma } from '@nexus/database'
import type { getServerT } from '@/lib/i18n/server'
import {
  detectVariantAxes,
  type VariantChild,
} from './variantAxes'
import VariantMatrix, {
  type VariantCellData,
} from './VariantMatrix'
import FlatVariantTable, {
  type FlatChildRow,
} from './FlatVariantTable'
import VariantsLayoutToggle, {
  type VariantsLayout,
} from './VariantsLayoutToggle'
import VariantChannelCoverage, {
  type CoverageListing,
  type CoverageVariant,
} from './VariantChannelCoverage'
import VariantIdentifiers, {
  type IdentifierVariant,
} from './VariantIdentifiers'
import VariantGapPanel, { type GapVariant } from './VariantGapPanel'
import VariantPricingPanel, {
  type PricingVariant,
  type PricingListing,
} from './VariantPricingPanel'
import VariantCompliancePanel, {
  type ComplianceVariant,
} from './VariantCompliancePanel'
import { Package } from 'lucide-react'

interface VariantsTabProps {
  parentId: string
  layout: VariantsLayout
  locale: 'en' | 'it'
  t: Awaited<ReturnType<typeof getServerT>>
}

export default async function VariantsTab({
  parentId,
  layout,
  locale,
  t,
}: VariantsTabProps) {
  // VR.6 — Parent's basePrice is needed as the reference for the
  // per-variant pricing-delta heatmap. Fetched in parallel with the
  // children list to keep the page's TTFB unchanged. Defensive
  // .catch so a stale parent fetch doesn't take down the children
  // view — the panel just hides if the parent is unreachable.
  const [parent, children] = await Promise.all([
    prisma.product
      .findUnique({
        where: { id: parentId },
        // VR.6 — basePrice for pricing-delta heatmap.
        // VR.7 — compliance fields for the variant-compliance
        // diff panel. All optional on schema; defensive .catch
        // keeps the panel hidden on stale-client failure.
        select: {
          basePrice: true,
          hsCode: true,
          countryOfOrigin: true,
          ppeCategory: true,
          hazmatClass: true,
          hazmatUnNumber: true,
        },
      })
      .catch((e: unknown) => {
        console.error('[vr.6+7] parent compliance fetch failed', e)
        return null
      }),
    prisma.product
    .findMany({
      where: { parentId },
      orderBy: { sku: 'asc' },
      select: {
        id: true,
        sku: true,
        name: true,
        status: true,
        basePrice: true,
        totalStock: true,
        gtin: true,
        upc: true,
        ean: true,
        amazonAsin: true,
        ebayItemId: true,
        shopifyProductId: true,
        // VR.7 — compliance fields per child for the variant
        // compliance diff panel.
        hsCode: true,
        countryOfOrigin: true,
        ppeCategory: true,
        hazmatClass: true,
        hazmatUnNumber: true,
        categoryAttributes: true,
        // VR.2 — axis detection inputs.
        // VR.3 — coverage matrix needs channel + marketplace +
        // externalListingId + listingStatus + isPublished + lastSyncedAt
        // per listing. Single query keeps the page fast; the join is
        // already happening on the parent fetch.
        channelListings: {
          select: {
            variationTheme: true,
            variationMapping: true,
            channel: true,
            marketplace: true,
            externalListingId: true,
            listingStatus: true,
            isPublished: true,
            lastSyncedAt: true,
            // VR.6 — per-channel pricing + stock for the variant
            // delta heatmap.
            price: true,
            priceOverride: true,
            followMasterPrice: true,
            quantity: true,
            quantityOverride: true,
            followMasterQuantity: true,
          },
        },
        images: {
          select: { url: true, alt: true, type: true, sortOrder: true },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
          take: 2,
        },
        _count: {
          select: {
            channelListings: {
              where: { isPublished: true, listingStatus: 'ACTIVE' },
            },
          },
        },
      },
    })
    .catch((e: unknown) => {
      console.error('[vr.2] children fetch failed', e)
      return null
    }),
  ])

  // VR.7 — Per-child certificate counts + nearest expiry. Fetched
  // AFTER children resolve (we need the child IDs); kept as a
  // separate query and wrapped in .catch so a missing
  // ProductCertificate table on a stale DB never crashes the tab
  // (lesson from the DS hotfix-1 / ATM.4 saga).
  const childIds = children?.map((c) => c.id) ?? []
  const childCerts =
    childIds.length === 0
      ? []
      : await prisma.productCertificate
          .findMany({
            where: { productId: { in: childIds } },
            select: {
              productId: true,
              certType: true,
              expiresAt: true,
            },
          })
          .catch((e: unknown) => {
            console.error('[vr.7] child certificates fetch failed', e)
            return [] as Array<{
              productId: string
              certType: string
              expiresAt: Date | null
            }>
          })

  // Aggregate certs per child for the panel.
  const certsByChild = new Map<
    string,
    { total: number; expired: number; expiringSoonAt: Date | null; types: Set<string> }
  >()
  const now = Date.now()
  const SOON_MS = 90 * 24 * 60 * 60 * 1000 // 90 days
  for (const cert of childCerts) {
    let entry = certsByChild.get(cert.productId)
    if (!entry) {
      entry = {
        total: 0,
        expired: 0,
        expiringSoonAt: null,
        types: new Set<string>(),
      }
      certsByChild.set(cert.productId, entry)
    }
    entry.total++
    entry.types.add(cert.certType)
    if (cert.expiresAt) {
      const dt = cert.expiresAt.getTime()
      if (dt < now) {
        entry.expired++
      } else if (dt - now < SOON_MS) {
        if (entry.expiringSoonAt == null || dt < entry.expiringSoonAt.getTime())
          entry.expiringSoonAt = cert.expiresAt
      }
    }
  }

  if (children == null) {
    return (
      <div className="border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950 rounded p-4 text-sm text-amber-800 dark:text-amber-200">
        {t('products.datasheetHub.variants.fetchFailed')}
      </div>
    )
  }

  if (children.length === 0) {
    return (
      <div className="border border-slate-200 dark:border-slate-800 rounded p-6 text-center text-sm text-slate-500">
        <Package className="w-6 h-6 mx-auto mb-2 text-slate-300" />
        <div className="font-medium text-slate-700 dark:text-slate-300">
          {t('products.datasheetHub.variants.empty.title')}
        </div>
        <p className="text-xs mt-1">
          {t('products.datasheetHub.variants.empty.body')}
        </p>
      </div>
    )
  }

  // VR.2 — Detect axes via variationTheme → variationMapping →
  // categoryAttributes heuristic. cellByKey maps "Color Size"
  // tuples to children for fast matrix lookup.
  const axisInputs: VariantChild[] = children.map((c) => ({
    id: c.id,
    categoryAttributes: c.categoryAttributes,
    channelListings: c.channelListings,
  }))
  const axes = detectVariantAxes(axisInputs)

  // Decide effective layout: if operator asked for flat OR no axes
  // resolved, render the flat table; otherwise the matrix.
  const effectiveLayout: VariantsLayout =
    layout === 'flat' || axes.axes.length === 0 ? 'flat' : 'matrix'

  return (
    <div className="space-y-3">
      {/* Summary strip + layout toggle */}
      <div className="flex items-center justify-between gap-3 flex-wrap text-xs">
        <div className="text-slate-500 dark:text-slate-400 flex items-center gap-3 flex-wrap">
          <span>
            {t(
              children.length === 1
                ? 'products.datasheetHub.variants.summary.one'
                : 'products.datasheetHub.variants.summary.other',
              { count: children.length },
            )}
          </span>
          {axes.axes.length > 0 ? (
            <span className="font-mono">
              {t('products.datasheetHub.variants.summary.axes', {
                axes: axes.axes.join(' × '),
              })}
              {!axes.highConfidence && (
                <span
                  className="ml-1 text-amber-600 dark:text-amber-400"
                  title={t(
                    'products.datasheetHub.variants.summary.lowConfidence',
                  )}
                >
                  ⚠
                </span>
              )}
            </span>
          ) : (
            <span className="italic text-amber-700 dark:text-amber-400">
              {t('products.datasheetHub.variants.summary.noAxes')}
            </span>
          )}
        </div>
        {axes.axes.length > 0 && (
          <VariantsLayoutToggle
            current={effectiveLayout}
            parentId={parentId}
          />
        )}
      </div>

      {/* Body — main variant view (matrix or flat) */}
      {effectiveLayout === 'matrix' ? (
        <VariantMatrix
          axes={axes}
          locale={locale}
          t={t}
          children={children.map<VariantCellData>((c) => {
            const hero =
              c.images.find((i) => i.type === 'MAIN') ?? c.images[0] ?? null
            return {
              id: c.id,
              sku: c.sku,
              name: c.name,
              basePrice: c.basePrice,
              totalStock: c.totalStock,
              status: c.status,
              marketsActive: c._count.channelListings,
              heroUrl: hero?.url ?? null,
              heroAlt: hero?.alt ?? null,
            }
          })}
        />
      ) : (
        <FlatVariantTable
          rows={children.map<FlatChildRow>((c) => {
            const hero =
              c.images.find((i) => i.type === 'MAIN') ?? c.images[0] ?? null
            return {
              id: c.id,
              sku: c.sku,
              name: c.name,
              status: c.status,
              basePrice: c.basePrice,
              totalStock: c.totalStock,
              gtin: c.gtin,
              amazonAsin: c.amazonAsin,
              categoryAttributes: c.categoryAttributes,
              heroUrl: hero?.url ?? null,
              heroAlt: hero?.alt ?? null,
              marketsActive: c._count.channelListings,
            }
          })}
          sharedAxisKeys={axes.axes}
          locale={locale}
          t={t}
        />
      )}

      {/* VR.4 — Variant identifier audit table. Single row per
          variant: master GTIN/UPC/EAN + per-channel distinct
          ASINs / eBay IDs / Shopify IDs. Surfaces sync skew via
          ⚠ when master Product.amazonAsin etc. doesn't appear in
          the channel-side listings. */}
      <VariantIdentifiers
        variants={children.map<IdentifierVariant>((c) => ({
          id: c.id,
          sku: c.sku,
          name: c.name,
          gtin: c.gtin,
          upc: c.upc,
          ean: c.ean,
          amazonAsin: c.amazonAsin,
          ebayItemId: c.ebayItemId,
          shopifyProductId: c.shopifyProductId,
          listings: c.channelListings.map((l) => ({
            channel: l.channel,
            marketplace: l.marketplace,
            externalListingId: l.externalListingId,
          })),
        }))}
        t={t}
      />

      {/* VR.6 — Per-variant pricing & inventory delta panel.
          Mounted above the gap panel because pricing typos block
          publishing — operator's "fix this first" eye-track. */}
      <VariantPricingPanel
        parentBasePrice={
          parent?.basePrice == null ? null : Number(parent.basePrice)
        }
        variants={children.map<PricingVariant>((c) => ({
          id: c.id,
          sku: c.sku,
          name: c.name,
          basePrice: c.basePrice,
          totalStock: c.totalStock,
          listings: c.channelListings.map<PricingListing>((l) => ({
            channel: l.channel,
            marketplace: l.marketplace,
            externalListingId: l.externalListingId,
            price: l.price,
            priceOverride: l.priceOverride,
            followMasterPrice: l.followMasterPrice,
            quantity: l.quantity,
            quantityOverride: l.quantityOverride,
            followMasterQuantity: l.followMasterQuantity,
            isPublished: l.isPublished,
            listingStatus: l.listingStatus,
          })),
        }))}
        locale={locale}
        t={t}
      />

      {/* VR.7 — Per-variant compliance diff panel. Each variant's
          country / HSCode / PPE / hazmat is shown with a "same as
          parent" or "≠" indicator vs the parent's values; per-child
          certificate counts include expired + expiring-soon flags. */}
      <VariantCompliancePanel
        parent={
          parent
            ? {
                hsCode: parent.hsCode,
                countryOfOrigin: parent.countryOfOrigin,
                ppeCategory: parent.ppeCategory,
                hazmatClass: parent.hazmatClass,
                hazmatUnNumber: parent.hazmatUnNumber,
              }
            : null
        }
        variants={children.map<ComplianceVariant>((c) => {
          const stats = certsByChild.get(c.id) ?? {
            total: 0,
            expired: 0,
            expiringSoonAt: null,
            types: new Set<string>(),
          }
          return {
            id: c.id,
            sku: c.sku,
            name: c.name,
            hsCode: c.hsCode,
            countryOfOrigin: c.countryOfOrigin,
            ppeCategory: c.ppeCategory,
            hazmatClass: c.hazmatClass,
            hazmatUnNumber: c.hazmatUnNumber,
            certs: {
              total: stats.total,
              expired: stats.expired,
              expiringSoonAt: stats.expiringSoonAt,
              types: [...stats.types],
            },
          }
        })}
        locale={locale}
        t={t}
      />

      {/* VR.5 — Variant gap panel. Sibling lens to the coverage
          matrix: rather than show every cell color-coded, this
          surfaces ONLY the missing (variant, channel, marketplace)
          combinations grouped by variant + by market. Deep-links
          go to /listings/<channel>/<marketplace>. Write actions
          (bulk stub creation) defer to VR.9. */}
      <VariantGapPanel
        variants={children.map<GapVariant>((c) => ({
          id: c.id,
          sku: c.sku,
          name: c.name,
          listings: c.channelListings.map((l) => ({
            channel: l.channel,
            marketplace: l.marketplace,
          })),
        }))}
        t={t}
      />

      {/* VR.3 — Per-variant channel coverage matrix. Renders below
          the main view so the operator sees the variant grid AND
          the publish-coverage cross-tab without switching views. */}
      <VariantChannelCoverage
        variants={children.map<CoverageVariant>((c) => ({
          id: c.id,
          sku: c.sku,
          name: c.name,
          listings: c.channelListings.map<CoverageListing>((l) => ({
            channel: l.channel,
            marketplace: l.marketplace,
            externalListingId: l.externalListingId,
            listingStatus: l.listingStatus,
            isPublished: l.isPublished,
            lastSyncedAt: l.lastSyncedAt,
          })),
        }))}
        locale={locale}
        t={t}
      />
    </div>
  )
}
