/**
 * ATM.3 + ATM.4 — Master attribute matrix with per-channel expansion.
 *
 * ATM.3 shipped the master column (label / value preview /
 * completeness / edit pencil). ATM.4 adds the killer expansion:
 * click any attribute row and the per-channel × per-market value
 * breakdown drops down inline, sourced from ChannelListing.
 *
 * Layout switched from <table> to a grid <details> per row because
 * <details>/<summary> + table-tr don't compose cleanly. The grid
 * keeps columns aligned across rows and groups; the expansion body
 * is a child <table> hosted inside the <details> body.
 *
 * Master-managed attributes (sku, gtin, brand, weight, …) — fields
 * with no per-channel override schema — show a single
 * "Master-managed" line in their expansion instead of a fake
 * per-channel breakdown.
 *
 * The fetch is one Product findUnique with channelListings include;
 * both wrapped in .catch(() => null) so a schema/DB hiccup degrades
 * to a friendly panel rather than crashing the hub.
 */

import { prisma } from '@nexus/database'
import Link from 'next/link'
import { CheckCircle2, ChevronDown, Circle, Edit3 } from 'lucide-react'
import type { getServerT } from '@/lib/i18n/server'
import ChannelExpansion, {
  type ChannelListingForExpansion,
} from './ChannelExpansion'

interface AttributesTabProps {
  productId: string
  locale: 'en' | 'it'
  t: Awaited<ReturnType<typeof getServerT>>
}

type CompletenessTone = 'filled' | 'empty'

interface Attr {
  key: string
  label: string
  preview: string | null
  required?: boolean
  /** Subset of listings relevant for this attribute's per-channel
   *  expansion. For ID rows we pre-filter to the matching channel;
   *  for mapped attrs (name/description/price/quantity/bullets) we
   *  pass all listings; for master-only rows we pass []. */
  listings: ChannelListingForExpansion[]
}

interface AttrGroup {
  key: string
  label: string
  attrs: Attr[]
}

export default async function AttributesTab({
  productId,
  locale,
  t,
}: AttributesTabProps) {
  const product = await prisma.product
    .findUnique({
      where: { id: productId },
      select: {
        sku: true,
        name: true,
        description: true,
        brand: true,
        manufacturer: true,
        productType: true,
        basePrice: true,
        fulfillmentMethod: true,
        totalStock: true,
        lowStockThreshold: true,
        gtin: true,
        upc: true,
        ean: true,
        amazonAsin: true,
        ebayItemId: true,
        shopifyProductId: true,
        weightValue: true,
        weightUnit: true,
        dimLength: true,
        dimWidth: true,
        dimHeight: true,
        dimUnit: true,
        bulletPoints: true,
        keywords: true,
        hsCode: true,
        countryOfOrigin: true,
        ppeCategory: true,
        hazmatClass: true,
        hazmatUnNumber: true,
        categoryAttributes: true,
        family: { select: { label: true, code: true } },
        workflowStage: {
          select: { label: true, workflow: { select: { label: true } } },
        },
        // ATM.4 — per-channel values for the expansion. Filtered to
        // ACTIVE + published rows so the expansion mirrors the
        // "Markets active" count in the pulse strip.
        channelListings: {
          where: { isPublished: true, listingStatus: 'ACTIVE' },
          orderBy: [{ channel: 'asc' }, { marketplace: 'asc' }],
          select: {
            id: true,
            channel: true,
            marketplace: true,
            listingStatus: true,
            externalListingId: true,
            lastSyncedAt: true,
            validationStatus: true,
            isPublished: true,
            title: true,
            titleOverride: true,
            followMasterTitle: true,
            masterTitle: true,
            description: true,
            descriptionOverride: true,
            followMasterDescription: true,
            masterDescription: true,
            price: true,
            priceOverride: true,
            followMasterPrice: true,
            masterPrice: true,
            quantity: true,
            quantityOverride: true,
            followMasterQuantity: true,
            masterQuantity: true,
            bulletPointsOverride: true,
            followMasterBulletPoints: true,
            masterBulletPoints: true,
          },
        },
      },
    })
    .catch((e: unknown) => {
      console.error('[atm.4] product master + listings fetch failed', e)
      return null
    })

  if (!product) {
    return (
      <div className="border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950 rounded p-4 text-sm text-amber-800 dark:text-amber-200">
        {t('products.datasheetHub.attributes.fetchFailed')}
      </div>
    )
  }

  const allListings = product.channelListings as ChannelListingForExpansion[]
  const amazonListings = allListings.filter((l) => l.channel === 'AMAZON')
  const ebayListings = allListings.filter((l) => l.channel === 'EBAY')
  const shopifyListings = allListings.filter((l) => l.channel === 'SHOPIFY')

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

  const countryName = (() => {
    if (!product.countryOfOrigin) return null
    try {
      const region = new Intl.DisplayNames(
        [locale === 'it' ? 'it' : 'en'],
        { type: 'region' },
      )
      return (
        region.of(product.countryOfOrigin.toUpperCase()) ??
        product.countryOfOrigin
      )
    } catch {
      return product.countryOfOrigin
    }
  })()

  const truncate = (s: string | null | undefined, max = 80) => {
    if (!s) return null
    if (s.length <= max) return s
    return s.slice(0, max - 1) + '…'
  }

  const arrayPreview = (arr: string[] | null | undefined) => {
    if (!arr || arr.length === 0) return null
    if (arr.length === 1) return truncate(arr[0], 60)
    return `${arr.length}× — ${truncate(arr[0], 50)}`
  }

  const weightPreview = (() => {
    if (product.weightValue == null) return null
    return `${product.weightValue} ${product.weightUnit ?? ''}`.trim()
  })()
  const dimsPreview = (() => {
    const { dimLength: l, dimWidth: w, dimHeight: h, dimUnit: u } = product
    if (l == null && w == null && h == null) return null
    return `${l ?? '?'} × ${w ?? '?'} × ${h ?? '?'} ${u ?? ''}`.trim()
  })()
  const hazmatPreview = (() => {
    if (!product.hazmatClass && !product.hazmatUnNumber) return null
    const parts = []
    if (product.hazmatUnNumber) parts.push(product.hazmatUnNumber)
    if (product.hazmatClass) parts.push(`Class ${product.hazmatClass}`)
    return parts.join(' · ')
  })()
  const categoryAttrsPreview = (() => {
    const obj = product.categoryAttributes as Record<string, unknown> | null
    if (!obj || typeof obj !== 'object') return null
    const keys = Object.keys(obj)
    if (keys.length === 0) return null
    return t('products.datasheetHub.attributes.customAttrsCount', {
      count: keys.length,
      first: keys[0],
    })
  })()

  const groups: AttrGroup[] = [
    {
      key: 'identity',
      label: t('products.datasheetHub.attributes.group.identity'),
      attrs: [
        {
          key: 'sku',
          label: t('products.col.sku'),
          preview: product.sku,
          required: true,
          listings: [],
        },
        {
          key: 'name',
          label: t('products.col.name'),
          preview: truncate(product.name, 100),
          required: true,
          listings: allListings,
        },
        {
          key: 'description',
          label: t('products.col.description'),
          preview: truncate(product.description, 120),
          listings: allListings,
        },
        {
          key: 'brand',
          label: t('products.col.brand'),
          preview: product.brand,
          listings: [],
        },
        {
          key: 'manufacturer',
          label: t('products.datasheet.specs.manufacturer'),
          preview: product.manufacturer,
          listings: [],
        },
        {
          key: 'productType',
          label: t('products.col.productType'),
          preview: product.productType,
          listings: [],
        },
        {
          key: 'family',
          label: t('products.col.family'),
          preview: product.family
            ? `${product.family.label} (${product.family.code})`
            : null,
          listings: [],
        },
        {
          key: 'workflowStage',
          label: t('products.col.workflowStage'),
          preview: product.workflowStage
            ? `${product.workflowStage.label} · ${product.workflowStage.workflow.label}`
            : null,
          listings: [],
        },
      ],
    },
    {
      key: 'pricing',
      label: t('products.datasheetHub.attributes.group.pricing'),
      attrs: [
        {
          key: 'basePrice',
          label: t('products.col.price'),
          preview: fmtCurrency(
            product.basePrice == null ? null : Number(product.basePrice),
          ),
          required: true,
          listings: allListings,
        },
        {
          key: 'fulfillmentMethod',
          label: t('products.col.fulfillment'),
          preview: product.fulfillmentMethod,
          listings: [],
        },
        {
          key: 'totalStock',
          label: t('products.col.stock'),
          preview: fmtNum(product.totalStock),
          listings: allListings,
        },
        {
          key: 'lowStockThreshold',
          label: t('products.datasheet.specs.lowStockAt'),
          preview:
            product.lowStockThreshold > 0
              ? fmtNum(product.lowStockThreshold)
              : null,
          listings: [],
        },
      ],
    },
    {
      key: 'identifiers',
      label: t('products.datasheetHub.attributes.group.identifiers'),
      attrs: [
        { key: 'gtin', label: 'GTIN', preview: product.gtin, listings: [] },
        { key: 'upc', label: 'UPC', preview: product.upc, listings: [] },
        { key: 'ean', label: 'EAN', preview: product.ean, listings: [] },
        {
          key: 'amazonAsin',
          label: t('products.datasheet.specs.amazonAsin'),
          preview: product.amazonAsin,
          listings: amazonListings,
        },
        {
          key: 'ebayItemId',
          label: t('products.datasheet.specs.ebayId'),
          preview: product.ebayItemId,
          listings: ebayListings,
        },
        {
          key: 'shopifyProductId',
          label: t('products.datasheet.specs.shopifyId'),
          preview: product.shopifyProductId,
          listings: shopifyListings,
        },
      ],
    },
    {
      key: 'physical',
      label: t('products.datasheetHub.attributes.group.physical'),
      attrs: [
        {
          key: 'weight',
          label: t('products.datasheet.specs.weight'),
          preview: weightPreview,
          listings: [],
        },
        {
          key: 'dimensions',
          label: t('products.datasheet.specs.dimensions'),
          preview: dimsPreview,
          listings: [],
        },
      ],
    },
    {
      key: 'content',
      label: t('products.datasheetHub.attributes.group.content'),
      attrs: [
        {
          key: 'bulletPoints',
          label: t('products.datasheet.section.bullets'),
          preview: arrayPreview(product.bulletPoints as string[] | null),
          listings: allListings,
        },
        {
          key: 'keywords',
          label: t('products.datasheet.section.keywords'),
          preview: arrayPreview(product.keywords as string[] | null),
          listings: [],
        },
      ],
    },
    {
      key: 'compliance',
      label: t('products.datasheetHub.attributes.group.compliance'),
      attrs: [
        {
          key: 'hsCode',
          label: t('products.datasheet.specs.hsCode'),
          preview: product.hsCode,
          listings: [],
        },
        {
          key: 'countryOfOrigin',
          label: t('products.datasheet.specs.countryOfOrigin'),
          preview: countryName,
          listings: [],
        },
        {
          key: 'ppeCategory',
          label: t('products.datasheet.specs.ppeCategory'),
          preview: product.ppeCategory,
          listings: [],
        },
        {
          key: 'hazmat',
          label: t('products.datasheet.specs.hazmat'),
          preview: hazmatPreview,
          listings: [],
        },
      ],
    },
    {
      key: 'custom',
      label: t('products.datasheetHub.attributes.group.custom'),
      attrs: [
        {
          key: 'categoryAttributes',
          label: t('products.datasheetHub.attributes.customAttrs'),
          preview: categoryAttrsPreview,
          listings: [],
        },
      ],
    },
  ]

  return (
    <div className="space-y-3">
      {groups.map((g) => (
        <AttributeGroupCard
          key={g.key}
          group={g}
          productId={productId}
          locale={locale}
          t={t}
        />
      ))}
    </div>
  )
}

function AttributeGroupCard({
  group,
  productId,
  locale,
  t,
}: {
  group: AttrGroup
  productId: string
  locale: 'en' | 'it'
  t: Awaited<ReturnType<typeof getServerT>>
}) {
  const filled = group.attrs.filter((a) => isFilled(a.preview)).length
  const total = group.attrs.length
  const allFilled = filled === total
  const summaryTone = allFilled
    ? 'text-emerald-700 dark:text-emerald-400'
    : filled === 0
      ? 'text-slate-500'
      : 'text-amber-700 dark:text-amber-400'

  return (
    <details
      open
      className="border border-default dark:border-slate-800 rounded bg-white dark:bg-slate-900 group/grp"
    >
      <summary className="flex items-center gap-3 px-3 py-2 cursor-pointer select-none hover:bg-slate-50 dark:hover:bg-slate-800/50 rounded">
        <ChevronDown className="w-3.5 h-3.5 text-tertiary transition-transform group-open/grp:rotate-0 -rotate-90" />
        <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
          {group.label}
        </span>
        <span className={`text-xs font-mono tabular-nums ${summaryTone}`}>
          {t('products.datasheetHub.attributes.groupCount', {
            filled,
            total,
          })}
        </span>
      </summary>
      <div className="border-t border-default dark:border-slate-800">
        {group.attrs.map((attr) => (
          <AttributeRow
            key={attr.key}
            attr={attr}
            productId={productId}
            locale={locale}
            t={t}
          />
        ))}
      </div>
    </details>
  )
}

function AttributeRow({
  attr,
  productId,
  locale,
  t,
}: {
  attr: Attr
  productId: string
  locale: 'en' | 'it'
  t: Awaited<ReturnType<typeof getServerT>>
}) {
  const filled = isFilled(attr.preview)
  const tone: CompletenessTone = filled ? 'filled' : 'empty'
  return (
    <details className="border-b border-subtle dark:border-slate-800 last:border-b-0 group/row">
      <summary
        className={
          'grid grid-cols-[1rem_12rem_1fr_5rem_1.5rem] items-start gap-2 px-3 py-2 cursor-pointer select-none hover:bg-slate-50 dark:hover:bg-slate-800/50 text-sm'
        }
      >
        <ChevronDown className="w-3.5 h-3.5 text-tertiary transition-transform group-open/row:rotate-0 -rotate-90 mt-0.5" />
        <div className="text-slate-600 dark:text-slate-400 flex items-center gap-1.5">
          <span>{attr.label}</span>
          {attr.required && (
            <span
              className="text-red-500 text-xs"
              title={t('products.datasheetHub.attributes.required')}
              aria-label={t('products.datasheetHub.attributes.required')}
            >
              *
            </span>
          )}
        </div>
        <div className="text-slate-900 dark:text-slate-100 min-w-0">
          {filled ? (
            <span className="block break-words">{attr.preview}</span>
          ) : (
            <span className="text-tertiary italic">
              {t('products.datasheetHub.attributes.empty')}
            </span>
          )}
        </div>
        <div>
          <CompletenessChip tone={tone} t={t} />
        </div>
        <div className="text-right">
          {/* Edit pencil — clicking it both navigates (Link) and
              toggles the parent summary (browser default). Acceptable
              since the operator ends up on /edit either way; stopping
              propagation would require a client component. */}
          <Link
            href={`/products/${productId}/edit`}
            className="inline-flex items-center justify-center w-6 h-6 rounded text-tertiary hover:text-slate-700 hover:bg-slate-100 dark:hover:text-slate-200 dark:hover:bg-slate-800"
            title={t('products.datasheetHub.attributes.editAria', {
              field: attr.label,
            })}
            aria-label={t('products.datasheetHub.attributes.editAria', {
              field: attr.label,
            })}
          >
            <Edit3 className="w-3 h-3" />
          </Link>
        </div>
      </summary>
      <div className="bg-slate-50/60 dark:bg-slate-950/30 border-t border-subtle dark:border-slate-800">
        <ChannelExpansion
          attrKey={attr.key}
          listings={attr.listings}
          masterPreview={attr.preview}
          locale={locale}
          t={t}
        />
      </div>
    </details>
  )
}

function CompletenessChip({
  tone,
  t,
}: {
  tone: CompletenessTone
  t: Awaited<ReturnType<typeof getServerT>>
}) {
  if (tone === 'filled') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400">
        <CheckCircle2 className="w-3.5 h-3.5" />
        <span>{t('products.datasheetHub.attributes.filled')}</span>
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-tertiary">
      <Circle className="w-3.5 h-3.5" />
      <span>{t('products.datasheetHub.attributes.emptyChip')}</span>
    </span>
  )
}

function isFilled(v: string | null | undefined): v is string {
  return v != null && v.trim().length > 0
}
