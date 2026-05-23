/**
 * VR.2 — 2-D Color × Size variant matrix.
 *
 * Renders a cross-tab grid where rows are the primary axis values
 * (e.g. Color) and columns are the secondary axis values (e.g.
 * Size). Each cell holds the matching child variant: hero thumb +
 * SKU + price + stock + market count chip.
 *
 * When only one axis is detected, the matrix degenerates to a
 * single-column list — one row per axis value. The caller decides
 * whether to fall back to FlatVariantTable when zero axes are
 * detected; this component requires at least one.
 *
 * Empty cells (axis combo with no matching child) render a dashed-
 * border placeholder so the gap stays visible. That's the "Red-XS
 * is missing" signal — VR.5 turns these gaps into a one-click
 * create-stub action.
 */

import Link from 'next/link'
import { ImageOff, Plus } from 'lucide-react'
import type { getServerT } from '@/lib/i18n/server'
import { cellKey, type AxisResolution } from './variantAxes'

interface VariantMatrixProps {
  axes: AxisResolution
  /** Per-child render data, keyed by the same id as cellByKey. */
  children: VariantCellData[]
  locale: 'en' | 'it'
  t: Awaited<ReturnType<typeof getServerT>>
}

export interface VariantCellData {
  id: string
  sku: string
  name: string
  basePrice: { toString(): string } | null
  totalStock: number
  status: string
  marketsActive: number
  heroUrl: string | null
  heroAlt: string | null
  /** VR.8 — Amazon MAIN image publish status, worst-of-best across
   *  the variant's marketplaces. Null when no ListingImage row
   *  exists for AMAZON/MAIN on this variant. */
  amazonMain: {
    tone: 'live' | 'staged' | 'drift' | 'error'
    publishedAt: Date | null
    marketplace: string | null
  } | null
}

export default function VariantMatrix({
  axes,
  children,
  locale,
  t,
}: VariantMatrixProps) {
  const currencyLocale = locale === 'it' ? 'it-IT' : 'en-GB'
  const fmtCurrency = (v: number | null) =>
    v == null
      ? '—'
      : new Intl.NumberFormat(currencyLocale, {
          style: 'currency',
          currency: 'EUR',
          // Compact: prices on the grid get cramped fast, drop the
          // decimals when they're zero (€129 vs €129,00).
          minimumFractionDigits: Number.isInteger(v) ? 0 : 2,
          maximumFractionDigits: 2,
        }).format(v)
  const fmtNum = (v: number) =>
    new Intl.NumberFormat(currencyLocale).format(v)

  // Index children by id for fast cell lookup via the axis map.
  const childById = new Map(children.map((c) => [c.id, c]))

  const primary = axes.axes[0]
  const secondary = axes.axes[1] ?? null
  const primaryValues = axes.values[primary] ?? []
  const secondaryValues = secondary != null ? axes.values[secondary] : []

  return (
    <div className="border border-slate-200 dark:border-slate-800 rounded bg-white dark:bg-slate-900 overflow-x-auto">
      <table className="border-collapse w-full">
        <thead>
          <tr className="border-b border-slate-200 dark:border-slate-800">
            <th className="px-3 py-2 text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 text-left bg-slate-50 dark:bg-slate-800/40 sticky left-0 z-10">
              {primary} {secondary ? `\\ ${secondary}` : ''}
            </th>
            {secondary != null ? (
              secondaryValues.map((sv) => (
                <th
                  key={sv}
                  className="px-2 py-2 text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 text-center bg-slate-50 dark:bg-slate-800/40 font-medium min-w-[88px]"
                >
                  {sv}
                </th>
              ))
            ) : (
              <th className="px-2 py-2 text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 text-left bg-slate-50 dark:bg-slate-800/40 font-medium">
                {t('products.datasheetHub.variants.col.variant')}
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {primaryValues.map((pv) => (
            <tr
              key={pv}
              className="border-b border-slate-100 dark:border-slate-800 last:border-b-0"
            >
              <th
                scope="row"
                className="px-3 py-2 text-left bg-slate-50/60 dark:bg-slate-800/20 sticky left-0 z-10 align-middle"
              >
                <span className="inline-block px-1.5 py-0.5 rounded border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200">
                  {pv}
                </span>
              </th>
              {secondary != null ? (
                secondaryValues.map((sv) => {
                  const ax = axes.cellByKey.get(cellKey([pv, sv]))
                  const data = ax ? childById.get(ax.id) : null
                  return (
                    <td
                      key={sv}
                      className="border-l border-slate-100 dark:border-slate-800 p-1.5 align-top"
                    >
                      {data ? (
                        <FilledCell
                          data={data}
                          fmtCurrency={fmtCurrency}
                          fmtNum={fmtNum}
                          t={t}
                        />
                      ) : (
                        <EmptyCell t={t} />
                      )}
                    </td>
                  )
                })
              ) : (
                <td className="border-l border-slate-100 dark:border-slate-800 p-1.5 align-top">
                  {(() => {
                    const ax = axes.cellByKey.get(cellKey([pv]))
                    const data = ax ? childById.get(ax.id) : null
                    if (!data) return <EmptyCell t={t} />
                    return (
                      <FilledCell
                        data={data}
                        fmtCurrency={fmtCurrency}
                        fmtNum={fmtNum}
                        t={t}
                      />
                    )
                  })()}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function FilledCell({
  data,
  fmtCurrency,
  fmtNum,
  t,
}: {
  data: VariantCellData
  fmtCurrency: (v: number | null) => string
  fmtNum: (v: number) => string
  t: Awaited<ReturnType<typeof getServerT>>
}) {
  const draft = data.status === 'DRAFT'
  const inactive = data.status === 'INACTIVE'
  // VR.8 — Per-cell Amazon MAIN publish-status pip. Small dot on
  // the hero thumb's bottom-right corner. Tone follows VariantsTab's
  // worst-of-best aggregation; tooltip surfaces the published
  // marketplace + last-publish time.
  const amzPipTone =
    data.amazonMain?.tone === 'live'
      ? 'bg-emerald-500'
      : data.amazonMain?.tone === 'staged'
        ? 'bg-slate-400'
        : data.amazonMain?.tone === 'drift'
          ? 'bg-amber-500'
          : data.amazonMain?.tone === 'error'
            ? 'bg-red-500'
            : null
  const amzPipTitle = data.amazonMain
    ? amzPipTooltip(data.amazonMain, t)
    : t('products.datasheetHub.variants.amzMain.none')
  return (
    <Link
      href={`/products/${data.id}/datasheet`}
      className="block rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-1.5 hover:border-blue-400 dark:hover:border-blue-500 hover:shadow-sm transition min-w-[84px]"
      title={data.name}
    >
      <div className="flex items-center gap-1.5 mb-1">
        <div className="relative w-8 h-8 flex-shrink-0 rounded border border-slate-200 dark:border-slate-700 overflow-hidden bg-slate-50 dark:bg-slate-800">
          {data.heroUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={data.heroUrl}
              alt={data.heroAlt ?? data.name}
              className="w-full h-full object-cover"
              loading="lazy"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-slate-300">
              <ImageOff className="w-3 h-3" />
            </div>
          )}
          {amzPipTone && (
            <span
              className={
                'absolute bottom-0 right-0 w-2 h-2 rounded-full ring-1 ring-white dark:ring-slate-900 ' +
                amzPipTone
              }
              aria-label={amzPipTitle}
              title={amzPipTitle}
            />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[10px] text-slate-600 dark:text-slate-400 truncate">
            {data.sku}
          </div>
          <div className="text-xs font-semibold text-slate-900 dark:text-slate-100 tabular-nums">
            {fmtCurrency(
              data.basePrice == null ? null : Number(data.basePrice),
            )}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between gap-1 text-[10px]">
        <span
          className={
            'inline-block px-1 py-0.5 rounded tabular-nums ' +
            (data.totalStock > 0
              ? 'bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300'
              : 'bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-300')
          }
        >
          {fmtNum(data.totalStock)}
        </span>
        <span
          className={
            'inline-block px-1 py-0.5 rounded ' +
            (data.marketsActive > 0
              ? 'bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300'
              : 'bg-slate-100 dark:bg-slate-800 text-slate-500')
          }
          title={t('products.datasheetHub.variants.col.markets')}
        >
          {data.marketsActive}m
        </span>
        {(draft || inactive) && (
          <span
            className={
              'inline-block px-1 py-0.5 rounded uppercase tracking-wider font-semibold ' +
              (draft
                ? 'bg-amber-100 dark:bg-amber-950 text-amber-700 dark:text-amber-300'
                : 'bg-slate-200 dark:bg-slate-800 text-slate-600')
            }
          >
            {data.status}
          </span>
        )}
      </div>
    </Link>
  )
}

function amzPipTooltip(
  amzMain: NonNullable<VariantCellData['amazonMain']>,
  t: Awaited<ReturnType<typeof getServerT>>,
): string {
  const toneKey = `products.datasheetHub.variants.amzMain.${amzMain.tone}`
  const statusLabel = t(toneKey)
  const parts = [statusLabel]
  if (amzMain.marketplace) parts.push(amzMain.marketplace)
  if (amzMain.publishedAt) parts.push(amzMain.publishedAt.toISOString().slice(0, 10))
  return parts.join(' · ')
}

function EmptyCell({
  t,
}: {
  t: Awaited<ReturnType<typeof getServerT>>
}) {
  return (
    <div
      className="flex items-center justify-center min-h-[58px] min-w-[84px] border border-dashed border-slate-200 dark:border-slate-700 rounded text-slate-300 dark:text-slate-600"
      title={t('products.datasheetHub.variants.cell.empty')}
      aria-label={t('products.datasheetHub.variants.cell.empty')}
    >
      <Plus className="w-3 h-3" />
    </div>
  )
}
