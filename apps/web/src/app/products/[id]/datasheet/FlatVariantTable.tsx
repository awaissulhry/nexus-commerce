/**
 * VR.1 (extracted in VR.2) — Flat variant table.
 *
 * One row per child variant: hero + SKU + axis chips + identifiers +
 * locale-aware price + stock + markets-active count + status. Used
 * when no axes are detected, or when the operator opts out of the
 * 2-D matrix via ?layout=flat.
 *
 * Kept read-only by design; the Variants tab orchestrator
 * (VariantsTab) decides which view to render based on axis
 * detection + the layout querystring.
 */

import Link from 'next/link'
import { ExternalLink, ImageOff } from 'lucide-react'
import type { getServerT } from '@/lib/i18n/server'

export interface FlatChildRow {
  id: string
  sku: string
  name: string
  status: string
  basePrice: { toString(): string } | null
  totalStock: number
  gtin: string | null
  amazonAsin: string | null
  categoryAttributes: unknown
  heroUrl: string | null
  heroAlt: string | null
  marketsActive: number
}

interface FlatVariantTableProps {
  rows: FlatChildRow[]
  sharedAxisKeys: string[]
  locale: 'en' | 'it'
  t: Awaited<ReturnType<typeof getServerT>>
}

export default function FlatVariantTable({
  rows,
  sharedAxisKeys,
  locale,
  t,
}: FlatVariantTableProps) {
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

  return (
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
          {rows.map((c) => {
            const attrs = (c.categoryAttributes ?? {}) as Record<
              string,
              unknown
            >
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
                    {c.heroUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={c.heroUrl}
                        alt={c.heroAlt ?? c.name}
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
                  const display =
                    typeof v === 'string' ? v : v == null ? '' : String(v)
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
                  {c.marketsActive > 0 ? (
                    <span className="inline-block px-1.5 py-0.5 rounded bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 text-xs font-medium tabular-nums">
                      {t(
                        c.marketsActive === 1
                          ? 'products.datasheetHub.variants.markets.one'
                          : 'products.datasheetHub.variants.markets.other',
                        { count: c.marketsActive },
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
