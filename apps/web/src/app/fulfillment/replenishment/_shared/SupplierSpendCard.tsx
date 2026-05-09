'use client'

/**
 * W9.3 — Supplier spend dashboard.
 *
 * Closes the audit's Brightpearl-tier "per-supplier spend analytics"
 * gap. Aggregates PurchaseOrder by supplierId across 30/90/365 day
 * windows + open-commitment column.
 *
 * Hides itself when no suppliers have PO history. Otherwise renders
 * a compact table sorted by 90d spend desc.
 *
 * Loaded on mount; PO data changes slowly enough that auto-refresh
 * isn't worth the round trips.
 */

import { useEffect, useState } from 'react'
import { Building2, Clock } from 'lucide-react'
import { useTranslations } from '@/lib/i18n/use-translations'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

interface SupplierSpend {
  supplierId: string
  supplierName: string
  country: string | null
  leadTimeDays: number | null
  paymentTerms: string | null
  defaultCurrency: string | null
  openPoCount: number
  openCommitmentCents: number
  spend30dCents: number
  spend90dCents: number
  spend365dCents: number
  currencies: string[]
}

interface SupplierSpendResponse {
  totals: {
    suppliers: number
    openCommitmentCents: number
    spend30dCents: number
    spend90dCents: number
    spend365dCents: number
  }
  suppliers: SupplierSpend[]
}

import { formatEur } from './format'

export function SupplierSpendCard() {
  const { t } = useTranslations()
  const [data, setData] = useState<SupplierSpendResponse | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(
      `${getBackendUrl()}/api/fulfillment/replenishment/suppliers/spend-summary?limit=50`,
      { cache: 'no-store' },
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (!cancelled) setData(json)
      })
      .catch(() => {
        if (!cancelled) setData(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (loading && !data) {
    return (
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md px-3 py-2 text-xs text-slate-500">
        {t('replenishment.supplierSpend.loading')}
      </div>
    )
  }

  // Hide when there's no PO history at all.
  if (!data || data.suppliers.length === 0) return null

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md">
      <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2 flex-wrap">
        <Building2
          className="h-4 w-4 text-slate-500 dark:text-slate-400"
          aria-hidden="true"
        />
        <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
          {t('replenishment.supplierSpend.header.title')}
        </div>
        <div className="text-xs text-slate-500 dark:text-slate-400">
          {t('replenishment.supplierSpend.header.summary', {
            n: data.suppliers.length,
            open: formatEur(data.totals.openCommitmentCents),
            spend90: formatEur(data.totals.spend90dCents),
          })}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
            <tr>
              <th className="text-left px-3 py-1.5 font-semibold">
                {t('replenishment.supplierSpend.col.supplier')}
              </th>
              <th className="text-left px-3 py-1.5 font-semibold">
                {t('replenishment.supplierSpend.col.terms')}
              </th>
              <th className="text-right px-3 py-1.5 font-semibold">
                {t('replenishment.supplierSpend.col.openPos')}
              </th>
              <th className="text-right px-3 py-1.5 font-semibold">
                {t('replenishment.supplierSpend.col.openCommitment')}
              </th>
              <th className="text-right px-3 py-1.5 font-semibold">
                {t('replenishment.supplierSpend.col.spend30')}
              </th>
              <th className="text-right px-3 py-1.5 font-semibold">
                {t('replenishment.supplierSpend.col.spend90')}
              </th>
              <th className="text-right px-3 py-1.5 font-semibold">
                {t('replenishment.supplierSpend.col.spend365')}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
            {data.suppliers.map((s) => {
              const multiCurrency = s.currencies.length > 1
              return (
                <tr
                  key={s.supplierId}
                  className="hover:bg-slate-50 dark:hover:bg-slate-950/50"
                >
                  <td className="px-3 py-1.5">
                    <div className="font-medium text-slate-900 dark:text-slate-100">
                      {s.supplierName}
                    </div>
                    <div className="text-[10px] text-slate-500 dark:text-slate-400 inline-flex items-center gap-1">
                      {s.country && <span>{s.country}</span>}
                      {s.leadTimeDays != null && (
                        <>
                          <span className="text-slate-400">·</span>
                          <Clock className="h-2.5 w-2.5" aria-hidden="true" />
                          <span>
                            {t('replenishment.supplierSpend.cell.leadTime', {
                              d: s.leadTimeDays,
                            })}
                          </span>
                        </>
                      )}
                      {multiCurrency && (
                        <>
                          <span className="text-slate-400">·</span>
                          <span
                            className="text-amber-700 dark:text-amber-400 font-medium"
                            title={t('replenishment.supplierSpend.cell.currencyMixTooltip', {
                              list: s.currencies.join(', '),
                            })}
                          >
                            {s.currencies.length}{' '}
                            {t('replenishment.supplierSpend.cell.currencies')}
                          </span>
                        </>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-1.5 text-slate-600 dark:text-slate-400">
                    <div>{s.paymentTerms ?? '—'}</div>
                    <div className="text-[10px] text-slate-500 dark:text-slate-500">
                      {s.defaultCurrency ?? 'EUR'}
                    </div>
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-slate-900 dark:text-slate-100">
                    {s.openPoCount}
                  </td>
                  <td
                    className={cn(
                      'px-3 py-1.5 text-right tabular-nums font-medium',
                      s.openCommitmentCents > 0
                        ? 'text-slate-900 dark:text-slate-100'
                        : 'text-slate-400 dark:text-slate-600',
                    )}
                  >
                    {formatEur(s.openCommitmentCents)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-slate-600 dark:text-slate-400">
                    {formatEur(s.spend30dCents)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums font-medium text-slate-900 dark:text-slate-100">
                    {formatEur(s.spend90dCents)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-slate-600 dark:text-slate-400">
                    {formatEur(s.spend365dCents)}
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
