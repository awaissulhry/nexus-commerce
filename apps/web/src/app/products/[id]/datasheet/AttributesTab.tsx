/**
 * ATM.3 — Master attribute matrix.
 *
 * Renders every master attribute on the Attributes tab as a single
 * dense table organised into collapsible groups. Each row carries:
 *
 *   - Label (i18n)
 *   - Compact value preview (formatted for type — text truncated,
 *     numbers locale-aware, arrays show count + first item, JSON
 *     shows key count)
 *   - Completeness chip (filled / empty)
 *   - Required flag — visual asterisk + tooltip
 *
 * Per-attribute "last modified" + "source" badges are surfaced for
 * fields where we have the data; today the schema only carries one
 * Product.updatedAt (no per-field audit), so the header strip's
 * "Updated Xh ago" is the global signal and rows omit a per-row
 * timestamp. ATM.12 (audit timeline) will add per-field history
 * once we have the ChangeLog substrate; this component is designed
 * to extend by adding fields to the Attr type without restructuring.
 *
 * The next phase (ATM.4) attaches per-channel × per-market value
 * expansion to each row: click to drill down. For now each row is
 * read-only display; deep-link to the matching field on /edit by
 * clicking the value cell.
 *
 * Collapsible groups use native <details>/<summary> so no client
 * runtime is needed and the page stays a server component.
 */

import { prisma } from '@nexus/database'
import Link from 'next/link'
import { CheckCircle2, Circle, Edit3 } from 'lucide-react'
import type { getServerT } from '@/lib/i18n/server'

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
  /** Optional deep-link target on the edit page (uses a tab + hash
   *  the edit-page client handles). Falls back to plain /edit. */
  editHash?: string
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
  // Full master fetch. Defensive .catch so a stale Prisma client
  // doesn't crash the whole hub — render a degraded view instead.
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
      },
    })
    .catch((e: unknown) => {
      console.error('[atm.3] product master fetch failed', e)
      return null
    })

  if (!product) {
    return (
      <div className="border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950 rounded p-4 text-sm text-amber-800 dark:text-amber-200">
        {t('products.datasheetHub.attributes.fetchFailed')}
      </div>
    )
  }

  // Locale-aware number / currency formatters reused across rows.
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

  // Country code → display name. Falls back to the code itself when
  // Intl.DisplayNames doesn't recognise the value (e.g. legacy free-
  // form entries that aren't ISO-2).
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

  // Truncate long display strings so a single row's value cell
  // never blows out the column. Operator can click into /edit to
  // see the full value.
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
        },
        {
          key: 'name',
          label: t('products.col.name'),
          preview: truncate(product.name, 100),
          required: true,
        },
        {
          key: 'description',
          label: t('products.col.description'),
          preview: truncate(product.description, 120),
        },
        {
          key: 'brand',
          label: t('products.col.brand'),
          preview: product.brand,
        },
        {
          key: 'manufacturer',
          label: t('products.datasheet.specs.manufacturer'),
          preview: product.manufacturer,
        },
        {
          key: 'productType',
          label: t('products.col.productType'),
          preview: product.productType,
        },
        {
          key: 'family',
          label: t('products.col.family'),
          preview: product.family
            ? `${product.family.label} (${product.family.code})`
            : null,
        },
        {
          key: 'workflowStage',
          label: t('products.col.workflowStage'),
          preview: product.workflowStage
            ? `${product.workflowStage.label} · ${product.workflowStage.workflow.label}`
            : null,
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
        },
        {
          key: 'fulfillmentMethod',
          label: t('products.col.fulfillment'),
          preview: product.fulfillmentMethod,
        },
        {
          key: 'totalStock',
          label: t('products.col.stock'),
          preview: fmtNum(product.totalStock),
        },
        {
          key: 'lowStockThreshold',
          label: t('products.datasheet.specs.lowStockAt'),
          preview:
            product.lowStockThreshold > 0
              ? fmtNum(product.lowStockThreshold)
              : null,
        },
      ],
    },
    {
      key: 'identifiers',
      label: t('products.datasheetHub.attributes.group.identifiers'),
      attrs: [
        {
          key: 'gtin',
          label: 'GTIN',
          preview: product.gtin,
        },
        { key: 'upc', label: 'UPC', preview: product.upc },
        { key: 'ean', label: 'EAN', preview: product.ean },
        {
          key: 'amazonAsin',
          label: t('products.datasheet.specs.amazonAsin'),
          preview: product.amazonAsin,
        },
        {
          key: 'ebayItemId',
          label: t('products.datasheet.specs.ebayId'),
          preview: product.ebayItemId,
        },
        {
          key: 'shopifyProductId',
          label: t('products.datasheet.specs.shopifyId'),
          preview: product.shopifyProductId,
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
        },
        {
          key: 'dimensions',
          label: t('products.datasheet.specs.dimensions'),
          preview: dimsPreview,
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
        },
        {
          key: 'keywords',
          label: t('products.datasheet.section.keywords'),
          preview: arrayPreview(product.keywords as string[] | null),
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
        },
        {
          key: 'countryOfOrigin',
          label: t('products.datasheet.specs.countryOfOrigin'),
          preview: countryName,
        },
        {
          key: 'ppeCategory',
          label: t('products.datasheet.specs.ppeCategory'),
          preview: product.ppeCategory,
        },
        {
          key: 'hazmat',
          label: t('products.datasheet.specs.hazmat'),
          preview: hazmatPreview,
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
          t={t}
        />
      ))}
    </div>
  )
}

function AttributeGroupCard({
  group,
  productId,
  t,
}: {
  group: AttrGroup
  productId: string
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
      className="border border-slate-200 dark:border-slate-800 rounded bg-white dark:bg-slate-900"
    >
      <summary className="flex items-center gap-3 px-3 py-2 cursor-pointer select-none hover:bg-slate-50 dark:hover:bg-slate-800/50 rounded">
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
      <table className="w-full border-t border-slate-200 dark:border-slate-800 text-sm">
        <tbody>
          {group.attrs.map((attr) => (
            <AttributeRow
              key={attr.key}
              attr={attr}
              productId={productId}
              t={t}
            />
          ))}
        </tbody>
      </table>
    </details>
  )
}

function AttributeRow({
  attr,
  productId,
  t,
}: {
  attr: Attr
  productId: string
  t: Awaited<ReturnType<typeof getServerT>>
}) {
  const filled = isFilled(attr.preview)
  const tone: CompletenessTone = filled ? 'filled' : 'empty'
  return (
    <tr className="border-b border-slate-100 dark:border-slate-800 last:border-b-0">
      <td className="py-2 pl-3 pr-2 w-48 text-slate-600 dark:text-slate-400 align-top">
        <div className="flex items-center gap-1.5">
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
      </td>
      <td className="py-2 px-2 text-slate-900 dark:text-slate-100 align-top">
        {filled ? (
          <span className="block break-words">{attr.preview}</span>
        ) : (
          <span className="text-slate-400 italic">
            {t('products.datasheetHub.attributes.empty')}
          </span>
        )}
      </td>
      <td className="py-2 px-2 w-24 align-top">
        <CompletenessChip tone={tone} t={t} />
      </td>
      <td className="py-2 px-3 w-10 align-top text-right">
        <Link
          href={`/products/${productId}/edit`}
          className="inline-flex items-center justify-center w-6 h-6 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100 dark:hover:text-slate-200 dark:hover:bg-slate-800"
          title={t('products.datasheetHub.attributes.editAria', {
            field: attr.label,
          })}
          aria-label={t('products.datasheetHub.attributes.editAria', {
            field: attr.label,
          })}
        >
          <Edit3 className="w-3 h-3" />
        </Link>
      </td>
    </tr>
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
    <span className="inline-flex items-center gap-1 text-xs text-slate-400">
      <Circle className="w-3.5 h-3.5" />
      <span>{t('products.datasheetHub.attributes.emptyChip')}</span>
    </span>
  )
}

function isFilled(v: string | null | undefined): v is string {
  return v != null && v.trim().length > 0
}
