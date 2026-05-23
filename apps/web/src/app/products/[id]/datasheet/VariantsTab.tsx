/**
 * VR.1 — Variants tab.
 *
 * Shows up as a 9th hub tab when the SKU is a parent. Lists every
 * child variant in a flat table with the operator's first-pass
 * audit needs: SKU, identifiers, channel IDs per platform, price,
 * stock, status, active-markets count, hero image.
 *
 * VR.2 will swap this flat list for a 2-D Color × Size cross-tab
 * once axis detection is wired. The flat list stays available as a
 * fallback for parents with no clear variation theme.
 *
 * Each row links to the child's own datasheet hub — that's the
 * primary navigation pattern for variant-level work. Drilling into
 * a child gives access to that variant's own attributes / channels
 * / pricing / compliance / images / history tabs, all of which
 * already exist for it (child SKUs are full Product rows).
 *
 * Read-only by design. Bulk edits and create-stub-listing actions
 * land in VR.5 / VR.9 once the matrix is in place.
 */

import { prisma } from '@nexus/database'
import Link from 'next/link'
import { ExternalLink, ImageOff, Package } from 'lucide-react'
import type { getServerT } from '@/lib/i18n/server'

interface VariantsTabProps {
  parentId: string
  locale: 'en' | 'it'
  t: Awaited<ReturnType<typeof getServerT>>
}

export default async function VariantsTab({
  parentId,
  locale,
  t,
}: VariantsTabProps) {
  const children = await prisma.product
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
        amazonAsin: true,
        ebayItemId: true,
        shopifyProductId: true,
        categoryAttributes: true,
        // Hero thumb — first MAIN image, fall back to first by
        // sortOrder. Two-image fetch keeps the query light.
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
      console.error('[vr.1] children fetch failed', e)
      return null
    })

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

  // Locale-aware currency for the price column. Numbers go through
  // Intl.NumberFormat so IT renders €1.234,56 vs EN's €1,234.56.
  const currencyLocale = locale === 'it' ? 'it-IT' : 'en-GB'
  const fmtCurrency = (v: number | null) =>
    v == null
      ? '—'
      : new Intl.NumberFormat(currencyLocale, {
          style: 'currency',
          currency: 'EUR',
        }).format(v)
  const fmtNum = (v: number) =>
    new Intl.NumberFormat(currencyLocale).format(v)

  // Detect any axis values across children. Each child's
  // categoryAttributes may carry Color / Size / Material. Surface
  // up to two axis chips per row so the operator scans the column
  // structure even before VR.2 ships the 2-D matrix.
  const sharedAxisKeys = detectSharedAxisKeys(
    children.map((c) => c.categoryAttributes as Record<string, unknown> | null),
  )

  return (
    <div className="space-y-3">
      {/* Summary strip — children count + axis hint */}
      <div className="flex items-center justify-between gap-3 text-xs text-slate-500 dark:text-slate-400">
        <div>
          {t(
            children.length === 1
              ? 'products.datasheetHub.variants.summary.one'
              : 'products.datasheetHub.variants.summary.other',
            { count: children.length },
          )}
        </div>
        {sharedAxisKeys.length > 0 ? (
          <div className="font-mono">
            {t('products.datasheetHub.variants.summary.axes', {
              axes: sharedAxisKeys.join(' × '),
            })}
          </div>
        ) : (
          <div className="italic">
            {t('products.datasheetHub.variants.summary.noAxes')}
          </div>
        )}
      </div>

      {/* Variant table */}
      <div className="border border-slate-200 dark:border-slate-800 rounded bg-white dark:bg-slate-900 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-800/40 border-b border-slate-200 dark:border-slate-800">
            <tr className="text-left text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
              <th className="py-2 px-3 font-medium w-12"></th>
              <th className="py-2 px-3 font-medium">
                {t('products.col.sku')}
              </th>
              <th className="py-2 px-3 font-medium">
                {t('products.col.name')}
              </th>
              {sharedAxisKeys.map((k) => (
                <th key={k} className="py-2 px-3 font-medium">
                  {k}
                </th>
              ))}
              <th className="py-2 px-3 font-medium">GTIN</th>
              <th className="py-2 px-3 font-medium">ASIN</th>
              <th className="py-2 px-3 font-medium text-right">
                {t('products.col.price')}
              </th>
              <th className="py-2 px-3 font-medium text-right">
                {t('products.col.stock')}
              </th>
              <th className="py-2 px-3 font-medium">
                {t('products.datasheetHub.variants.col.markets')}
              </th>
              <th className="py-2 px-3 font-medium">
                {t('products.col.status')}
              </th>
              <th className="py-2 px-3 font-medium w-8"></th>
            </tr>
          </thead>
          <tbody>
            {children.map((c) => {
              const hero =
                c.images.find((i) => i.type === 'MAIN') ?? c.images[0] ?? null
              const attrs = (c.categoryAttributes ??
                {}) as Record<string, unknown>
              return (
                <tr
                  key={c.id}
                  className="border-b border-slate-100 dark:border-slate-800 last:border-b-0 hover:bg-slate-50 dark:hover:bg-slate-800/30"
                >
                  <td className="py-2 px-3">
                    <Link
                      href={`/products/${c.id}/datasheet`}
                      className="block w-9 h-9 border border-slate-200 dark:border-slate-700 rounded overflow-hidden bg-slate-50 dark:bg-slate-800"
                    >
                      {hero ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={hero.url}
                          alt={hero.alt ?? c.name}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-slate-300">
                          <ImageOff className="w-4 h-4" />
                        </div>
                      )}
                    </Link>
                  </td>
                  <td className="py-2 px-3 font-mono text-xs text-slate-700 dark:text-slate-200 align-middle">
                    <Link
                      href={`/products/${c.id}/datasheet`}
                      className="hover:underline"
                    >
                      {c.sku}
                    </Link>
                  </td>
                  <td className="py-2 px-3 text-slate-900 dark:text-slate-100 align-middle">
                    <span className="line-clamp-1 max-w-xs">{c.name}</span>
                  </td>
                  {sharedAxisKeys.map((k) => {
                    const v = attrs[k]
                    const display = typeof v === 'string' ? v : v == null ? '' : String(v)
                    return (
                      <td
                        key={k}
                        className="py-2 px-3 text-slate-700 dark:text-slate-300 align-middle"
                      >
                        {display ? (
                          <span className="inline-block px-1.5 py-0.5 rounded border border-slate-200 dark:border-slate-700 text-xs">
                            {display}
                          </span>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                    )
                  })}
                  <td className="py-2 px-3 font-mono text-xs text-slate-600 dark:text-slate-400 align-middle">
                    {c.gtin ?? <span className="text-slate-300">—</span>}
                  </td>
                  <td className="py-2 px-3 font-mono text-xs text-slate-600 dark:text-slate-400 align-middle">
                    {c.amazonAsin ?? (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums text-slate-900 dark:text-slate-100 align-middle">
                    {fmtCurrency(
                      c.basePrice == null ? null : Number(c.basePrice),
                    )}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums text-slate-700 dark:text-slate-200 align-middle">
                    {fmtNum(c.totalStock)}
                  </td>
                  <td className="py-2 px-3 align-middle">
                    {c._count.channelListings > 0 ? (
                      <span className="inline-block px-1.5 py-0.5 rounded bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 text-xs font-medium tabular-nums">
                        {t(
                          c._count.channelListings === 1
                            ? 'products.datasheetHub.variants.markets.one'
                            : 'products.datasheetHub.variants.markets.other',
                          { count: c._count.channelListings },
                        )}
                      </span>
                    ) : (
                      <span className="inline-block px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 text-xs">
                        {t('products.datasheetHub.variants.markets.none')}
                      </span>
                    )}
                  </td>
                  <td className="py-2 px-3 align-middle">
                    <StatusChip status={c.status} />
                  </td>
                  <td className="py-2 px-3 align-middle">
                    <Link
                      href={`/products/${c.id}/datasheet`}
                      className="inline-flex items-center justify-center w-6 h-6 rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                      title={t('products.datasheetHub.variants.openVariant')}
                      aria-label={t(
                        'products.datasheetHub.variants.openVariant',
                      )}
                    >
                      <ExternalLink className="w-3 h-3" />
                    </Link>
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

function StatusChip({ status }: { status: string }) {
  const tone =
    status === 'ACTIVE'
      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
      : status === 'DRAFT'
        ? 'bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300'
        : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
  return (
    <span
      className={`inline-block px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider font-semibold ${tone}`}
    >
      {status}
    </span>
  )
}

/**
 * Find the categoryAttributes keys that appear in at least 60 % of
 * the children. That's the heuristic for "this is a variation axis"
 * before VR.2's proper variationMapping-driven detection lands.
 *
 * 60 % threshold balances false positives (a one-off attribute on
 * a single child) against false negatives (an axis that's missing
 * on 1-2 stale rows). Returns up to 3 keys so the table doesn't
 * grow uncontrollably wide.
 */
function detectSharedAxisKeys(
  attrsList: Array<Record<string, unknown> | null>,
): string[] {
  if (attrsList.length === 0) return []
  const counts = new Map<string, number>()
  for (const a of attrsList) {
    if (!a || typeof a !== 'object') continue
    for (const k of Object.keys(a)) {
      const v = a[k]
      if (typeof v !== 'string' || v.length === 0) continue
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
  }
  const threshold = Math.max(1, Math.floor(attrsList.length * 0.6))
  return [...counts.entries()]
    .filter(([, n]) => n >= threshold)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k]) => k)
}
