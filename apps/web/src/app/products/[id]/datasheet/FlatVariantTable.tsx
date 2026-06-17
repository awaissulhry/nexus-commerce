'use client'

/**
 * VR.1 (extracted in VR.2, made selectable in VR.9) — Flat variant
 * table with multi-select + bulk status toggle.
 *
 * One row per child variant: checkbox + hero + SKU + axis chips +
 * identifiers + locale-aware price + stock + markets-active count +
 * status. Used when no axes are detected, or when the operator
 * opts out of the 2-D matrix via ?layout=flat.
 *
 * Selection model: simple Set<string> of variant IDs. A header
 * checkbox selects/deselects all visible rows. Shift-click range
 * selection is intentionally NOT implemented yet — single click +
 * "Select all" covers the operator's "mass-deactivate end of
 * season" use case; range selection is a follow-up if it earns
 * its place.
 *
 * Bulk action toolbar appears above the table when ≥1 row is
 * selected. Today it ships one action — Mark inactive / Mark
 * active — chosen for reversibility. Bulk pricing + bulk create-
 * stub-listings are tracked as VR.9 follow-ups.
 *
 * Component is fully client because every cell carries a
 * checkbox handler and we need state for the selection + the
 * confirmation step. Server-rendering 30 static rows isn't worth
 * the extra wrapper complexity at this catalog scale.
 */

import { useCallback, useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  AlertTriangle,
  Check,
  ExternalLink,
  ImageOff,
  Loader2,
  X,
} from 'lucide-react'
import { useTranslations } from '@/lib/i18n/use-translations'
import {
  bulkSetVariantStatus,
  type BulkStatus,
  type BulkStatusResult,
} from './variantBulkActions'

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
  parentId: string
  rows: FlatChildRow[]
  sharedAxisKeys: string[]
  locale: 'en' | 'it'
}

type PendingState =
  | { kind: 'idle' }
  | { kind: 'confirm'; newStatus: BulkStatus }
  | { kind: 'running' }
  | { kind: 'done'; result: BulkStatusResult }

export default function FlatVariantTable({
  parentId,
  rows,
  sharedAxisKeys,
  locale,
}: FlatVariantTableProps) {
  const { t } = useTranslations()
  const router = useRouter()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [pendingState, setPendingState] = useState<PendingState>({
    kind: 'idle',
  })
  const [isTransitioning, startTransition] = useTransition()

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

  const allSelected = useMemo(
    () => rows.length > 0 && rows.every((r) => selected.has(r.id)),
    [rows, selected],
  )
  const someSelected = selected.size > 0 && !allSelected

  const toggleOne = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleAll = useCallback(() => {
    setSelected((prev) => {
      if (rows.every((r) => prev.has(r.id))) return new Set()
      return new Set(rows.map((r) => r.id))
    })
  }, [rows])

  const clearSelection = useCallback(() => setSelected(new Set()), [])

  const onConfirm = useCallback(
    async (newStatus: BulkStatus) => {
      setPendingState({ kind: 'running' })
      const result = await bulkSetVariantStatus(
        parentId,
        [...selected],
        newStatus,
      )
      setPendingState({ kind: 'done', result })
      if (result.ok) {
        // Clear selection + refresh server data so the new status
        // chips are reflected on the row.
        setSelected(new Set())
        startTransition(() => router.refresh())
        // Auto-dismiss the success notice after 4s so the toolbar
        // collapses back to its idle state without a click.
        setTimeout(() => setPendingState({ kind: 'idle' }), 4000)
      }
    },
    [parentId, selected, router],
  )

  const selectedCount = selected.size

  return (
    <div className="space-y-2">
      {/* Bulk action toolbar */}
      {selectedCount > 0 && pendingState.kind === 'idle' && (
        <div className="flex items-center justify-between gap-3 px-3 py-2 rounded border border-blue-200 dark:border-blue-900 bg-blue-50/60 dark:bg-blue-950/30">
          <div className="text-sm text-blue-900 dark:text-blue-200 font-medium">
            {t('products.datasheetHub.variants.bulk.nSelected', {
              count: selectedCount,
            })}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() =>
                setPendingState({ kind: 'confirm', newStatus: 'INACTIVE' })
              }
              className="inline-flex items-center gap-1 h-7 px-2.5 text-xs font-medium rounded border border-amber-300 dark:border-amber-700 bg-white dark:bg-slate-900 text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950"
            >
              {t('products.datasheetHub.variants.bulk.markInactive')}
            </button>
            <button
              type="button"
              onClick={() =>
                setPendingState({ kind: 'confirm', newStatus: 'ACTIVE' })
              }
              className="inline-flex items-center gap-1 h-7 px-2.5 text-xs font-medium rounded border border-emerald-300 dark:border-emerald-700 bg-white dark:bg-slate-900 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-950"
            >
              {t('products.datasheetHub.variants.bulk.markActive')}
            </button>
            <button
              type="button"
              onClick={clearSelection}
              className="inline-flex items-center gap-1 h-7 px-2 text-xs text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
              title={t('products.datasheetHub.variants.bulk.clear')}
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        </div>
      )}

      {/* Confirmation step — inline rather than modal so the row
          context stays visible. */}
      {pendingState.kind === 'confirm' && (
        <div className="flex items-center justify-between gap-3 px-3 py-2 rounded border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40">
          <div className="text-sm text-amber-900 dark:text-amber-200 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" />
            <span>
              {t('products.datasheetHub.variants.bulk.confirm', {
                count: selectedCount,
                status: pendingState.newStatus,
              })}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onConfirm(pendingState.newStatus)}
              className="inline-flex items-center gap-1 h-7 px-3 text-xs font-medium rounded bg-amber-600 hover:bg-amber-700 text-white"
            >
              <Check className="w-3 h-3" />
              {t('products.datasheetHub.variants.bulk.confirmButton')}
            </button>
            <button
              type="button"
              onClick={() => setPendingState({ kind: 'idle' })}
              className="inline-flex items-center gap-1 h-7 px-2 text-xs text-slate-700 dark:text-slate-200 border border-slate-300 dark:border-slate-700 rounded hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              {t('products.datasheetHub.variants.bulk.cancel')}
            </button>
          </div>
        </div>
      )}

      {pendingState.kind === 'running' && (
        <div className="flex items-center gap-2 px-3 py-2 rounded border border-default dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-xs text-slate-700 dark:text-slate-200">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          <span>{t('products.datasheetHub.variants.bulk.running')}</span>
        </div>
      )}

      {pendingState.kind === 'done' && pendingState.result.ok && (
        <div className="flex items-center gap-2 px-3 py-2 rounded border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950 text-xs text-emerald-800 dark:text-emerald-200">
          <Check className="w-3.5 h-3.5" />
          <span>
            {t('products.datasheetHub.variants.bulk.success', {
              count: pendingState.result.affected,
            })}
          </span>
        </div>
      )}

      {pendingState.kind === 'done' && !pendingState.result.ok && (
        <div className="flex items-center gap-2 px-3 py-2 rounded border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 text-xs text-red-800 dark:text-red-200">
          <AlertTriangle className="w-3.5 h-3.5" />
          <span>
            {pendingState.result.error ??
              t('products.datasheetHub.variants.bulk.failGeneric')}
          </span>
          <button
            type="button"
            onClick={() => setPendingState({ kind: 'idle' })}
            className="ml-auto text-red-600 dark:text-red-300 hover:text-red-800 dark:hover:text-red-100"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      <div className="border border-default dark:border-slate-800 rounded bg-white dark:bg-slate-900 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-800/40 border-b border-default dark:border-slate-800">
            <tr className="text-left text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
              <th className="py-2 px-3 font-medium w-8">
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someSelected
                  }}
                  onChange={toggleAll}
                  aria-label={t('products.datasheetHub.variants.bulk.selectAll')}
                  className="cursor-pointer"
                  disabled={isTransitioning || pendingState.kind === 'running'}
                />
              </th>
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
              const isSelected = selected.has(c.id)
              return (
                <tr
                  key={c.id}
                  className={
                    'border-b border-subtle dark:border-slate-800 last:border-b-0 hover:bg-slate-50 dark:hover:bg-slate-800/30 ' +
                    (isSelected ? 'bg-blue-50/40 dark:bg-blue-950/20' : '')
                  }
                >
                  <td className="py-2 px-3 align-middle">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleOne(c.id)}
                      aria-label={t(
                        'products.datasheetHub.variants.bulk.selectRow',
                        { sku: c.sku },
                      )}
                      className="cursor-pointer"
                      disabled={pendingState.kind === 'running'}
                    />
                  </td>
                  <td className="py-2 px-3">
                    <Link
                      href={`/products/${c.id}/datasheet`}
                      className="block w-9 h-9 border border-default dark:border-slate-700 rounded overflow-hidden bg-slate-50 dark:bg-slate-800"
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
                          <span className="inline-block px-1.5 py-0.5 rounded border border-default dark:border-slate-700 text-xs">
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
                      className="inline-flex items-center justify-center w-6 h-6 rounded text-tertiary hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
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
