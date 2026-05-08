'use client'

// G.4.2 — Outlier alerts page. Reads /api/pricing/alerts (PricingSnapshot
// rows where source=FALLBACK, isClamped=true, or warnings non-empty).

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw,
} from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Button } from '@/components/ui/Button'
import { Tabs, type Tab } from '@/components/ui/Tabs'
import { useTranslations } from '@/lib/i18n/use-translations'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

interface AlertRow {
  id: string
  sku: string
  channel: string
  marketplace: string
  fulfillmentMethod: string | null
  computedPrice: string
  currency: string
  source: string
  warnings: string[]
  isClamped: boolean
  clampedFrom: string | null
  computedAt: string
}

interface DriftRow {
  id: string
  kind: 'DRIFT'
  sku: string
  channel: string
  marketplace: string
  masterPrice: string | null
  listingPrice: string | null
  message: string
  createdAt: string
}

interface LowMarginRow {
  id: string
  sku: string
  channel: string
  marketplace: string
  fulfillmentMethod: string | null
  computedPrice: string
  currency: string
  marginPct: number
  netProfit: number
}

interface AlertsResponse {
  total: number
  counts: {
    fallback: number
    clamped: number
    warnings: number
    drift: number
    lowMargin: number
  }
  thresholds: { lowMarginPct: number }
  rows: AlertRow[]
  driftRows: DriftRow[]
  lowMarginRows: LowMarginRow[]
}

type AlertTab = 'all' | 'drift' | 'lowMargin' | 'engine'

export default function PricingAlertsClient() {
  const { t } = useTranslations()
  const [data, setData] = useState<AlertsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<AlertTab>('all')

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/pricing/alerts`, {
        cache: 'no-store',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setData(await res.json())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  if (loading && !data) {
    return (
      <Card>
        <div className="text-md text-slate-500 dark:text-slate-400 py-8 text-center inline-flex items-center justify-center gap-2 w-full">
          <Loader2 className="w-4 h-4 animate-spin" />{' '}
          {t('pricing.alerts.loading')}
        </div>
      </Card>
    )
  }

  if (error) {
    return (
      <div className="border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950 rounded px-3 py-2 text-base text-rose-700 dark:text-rose-300 inline-flex items-start gap-1.5">
        <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
        <span>{error}</span>
      </div>
    )
  }

  const empty =
    !data ||
    (data.rows.length === 0 &&
      data.driftRows.length === 0 &&
      data.lowMarginRows.length === 0)

  if (empty) {
    return (
      <EmptyState
        icon={CheckCircle2}
        title={t('pricing.alerts.empty')}
        description={t('pricing.alerts.emptyHint')}
      />
    )
  }

  return (
    <div className="space-y-4">
      {/* Counts banner — drift first (customer-visible), low margin second
          (silent revenue leak), engine-resolution buckets last. */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <CountTile
          label={t('pricing.alerts.bucket.drift')}
          value={data.counts.drift}
          tone="rose"
          hint={t('pricing.alerts.bucket.driftHint')}
        />
        <CountTile
          label={t('pricing.alerts.bucket.lowMargin', {
            pct: data.thresholds.lowMarginPct,
          })}
          value={data.counts.lowMargin}
          tone="rose"
          hint={t('pricing.alerts.bucket.lowMarginHint')}
        />
        <CountTile
          label={t('pricing.alerts.bucket.fallback')}
          value={data.counts.fallback}
          tone="rose"
          hint={t('pricing.alerts.bucket.fallbackHint')}
        />
        <CountTile
          label={t('pricing.alerts.bucket.clamped')}
          value={data.counts.clamped}
          tone="amber"
          hint={t('pricing.alerts.bucket.clampedHint')}
        />
        <CountTile
          label={t('pricing.alerts.bucket.warnings')}
          value={data.counts.warnings}
          tone="blue"
          hint={t('pricing.alerts.bucket.warningsHint')}
        />
      </div>

      {/* UI.9 — Sub-tabs for the three severity buckets. The count tiles
          above always show all 5 figures; tabs filter the tables below. */}
      <Tabs
        tabs={[
          {
            id: 'all',
            label: t('pricing.alerts.tab.all'),
            count:
              data.driftRows.length +
              data.lowMarginRows.length +
              data.rows.length,
          },
          {
            id: 'drift',
            label: t('pricing.alerts.tab.drift'),
            count: data.driftRows.length,
          },
          {
            id: 'lowMargin',
            label: t('pricing.alerts.tab.lowMargin'),
            count: data.lowMarginRows.length,
          },
          {
            id: 'engine',
            label: t('pricing.alerts.tab.engine'),
            count: data.rows.length,
          },
        ] as Tab[]}
        activeTab={activeTab}
        onChange={(id) => setActiveTab(id as AlertTab)}
        trailing={
          <Button
            variant="secondary"
            size="sm"
            onClick={fetchData}
            icon={<RefreshCw size={12} />}
          >
            {t('pricing.action.refresh')}
          </Button>
        }
      />

      {/* B.2 — Drift table. Shown above engine alerts because drift means
          actual customer-visible prices are wrong, while engine alerts are
          materialization-time warnings only. */}
      {(activeTab === 'all' || activeTab === 'drift') && data.driftRows.length > 0 && (
        <div className="space-y-2">
          <div className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
            {t('pricing.alerts.section.driftTable', {
              n: data.driftRows.length,
            })}
          </div>
          <Card noPadding>
            <div className="overflow-x-auto">
              <table className="w-full text-md">
                <thead className="border-b border-slate-200 dark:border-slate-800 bg-rose-50 dark:bg-rose-950">
                  <tr>
                    <th scope="col" className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-rose-800 dark:text-rose-200">
                      {t('pricing.alerts.col.severity')}
                    </th>
                    <th scope="col" className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-rose-800 dark:text-rose-200">
                      {t('pricing.alerts.col.sku')}
                    </th>
                    <th scope="col" className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-rose-800 dark:text-rose-200">
                      {t('pricing.alerts.col.where')}
                    </th>
                    <th scope="col" className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-rose-800 dark:text-rose-200">
                      {t('pricing.alerts.col.master')}
                    </th>
                    <th scope="col" className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-rose-800 dark:text-rose-200">
                      {t('pricing.alerts.col.listing')}
                    </th>
                    <th scope="col" className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-rose-800 dark:text-rose-200">
                      {t('pricing.alerts.col.detected')}
                    </th>
                    <th scope="col" className="px-3 py-2 w-24"></th>
                  </tr>
                </thead>
                <tbody>
                  {data.driftRows.map((d) => (
                    <tr
                      key={d.id}
                      className="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800"
                    >
                      <td className="px-3 py-2">
                        <SeverityChip tone="rose" label={t('pricing.alerts.severity.drift')} />
                      </td>
                      <td className="px-3 py-2 font-mono text-base text-slate-800 dark:text-slate-200">
                        {d.sku}
                      </td>
                      <td className="px-3 py-2 text-slate-700 dark:text-slate-300">
                        {d.channel}{' '}
                        <span className="text-slate-400 dark:text-slate-500">·</span>{' '}
                        <span className="font-mono text-sm">
                          {d.marketplace}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-800 dark:text-slate-200">
                        {d.masterPrice
                          ? Number(d.masterPrice).toFixed(2)
                          : '—'}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-rose-700 dark:text-rose-300 font-semibold">
                        {d.listingPrice
                          ? Number(d.listingPrice).toFixed(2)
                          : '—'}
                      </td>
                      <td className="px-3 py-2 text-sm text-slate-500 dark:text-slate-400">
                        {new Date(d.createdAt).toLocaleString()}
                      </td>
                      <td className="px-3 py-2">
                        <Link
                          href={`/pricing?search=${encodeURIComponent(d.sku)}`}
                          className="text-sm text-blue-600 hover:underline"
                        >
                          {t('pricing.alerts.openInPricing')}
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      {/* C.2 — Low-margin table. Below drift (customer-facing) but above
          engine-resolution alerts (materialization-time only). Ordered by
          marginPct ascending so the worst SKUs are at the top. */}
      {(activeTab === 'all' || activeTab === 'lowMargin') && data.lowMarginRows.length > 0 && (
        <div className="space-y-2">
          <div className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
            {t('pricing.alerts.section.lowMargin', {
              n: data.lowMarginRows.length,
            })}
            <span className="ml-2 normal-case font-normal text-slate-400 dark:text-slate-500">
              {t('pricing.alerts.section.lowMarginSuffix', {
                pct: data.thresholds.lowMarginPct,
              })}
            </span>
          </div>
          <Card noPadding>
            <div className="overflow-x-auto">
              <table className="w-full text-md">
                <thead className="border-b border-slate-200 dark:border-slate-800 bg-rose-50 dark:bg-rose-950">
                  <tr>
                    <th scope="col" className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-rose-800 dark:text-rose-200">
                      {t('pricing.alerts.col.severity')}
                    </th>
                    <th scope="col" className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-rose-800 dark:text-rose-200">
                      {t('pricing.alerts.col.sku')}
                    </th>
                    <th scope="col" className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-rose-800 dark:text-rose-200">
                      {t('pricing.alerts.col.where')}
                    </th>
                    <th scope="col" className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-rose-800 dark:text-rose-200">
                      {t('pricing.alerts.col.price')}
                    </th>
                    <th scope="col" className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-rose-800 dark:text-rose-200">
                      {t('pricing.alerts.col.netProfit')}
                    </th>
                    <th scope="col" className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-rose-800 dark:text-rose-200">
                      {t('pricing.alerts.col.margin')}
                    </th>
                    <th scope="col" className="px-3 py-2 w-24"></th>
                  </tr>
                </thead>
                <tbody>
                  {data.lowMarginRows.map((m) => {
                    const negative = m.netProfit < 0
                    return (
                      <tr
                        key={m.id}
                        className="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800"
                      >
                        <td className="px-3 py-2">
                          <SeverityChip
                            tone="rose"
                            label={
                              negative
                                ? t('pricing.alerts.severity.loss')
                                : t('pricing.alerts.severity.thin')
                            }
                          />
                        </td>
                        <td className="px-3 py-2 font-mono text-base text-slate-800 dark:text-slate-200">
                          {m.sku}
                        </td>
                        <td className="px-3 py-2 text-slate-700 dark:text-slate-300">
                          {m.channel}{' '}
                          <span className="text-slate-400 dark:text-slate-500">·</span>{' '}
                          <span className="font-mono text-sm">
                            {m.marketplace}
                          </span>
                          {m.fulfillmentMethod && (
                            <span className="ml-1 text-xs text-slate-500 dark:text-slate-400">
                              {m.fulfillmentMethod}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-slate-800 dark:text-slate-200">
                          {Number(m.computedPrice).toFixed(2)}{' '}
                          <span className="text-sm text-slate-500 dark:text-slate-400">
                            {m.currency}
                          </span>
                        </td>
                        <td
                          className={cn(
                            'px-3 py-2 text-right tabular-nums',
                            negative ? 'text-rose-700 dark:text-rose-300 font-semibold' : 'text-slate-700 dark:text-slate-300',
                          )}
                        >
                          {m.netProfit.toFixed(2)}{' '}
                          <span className="text-sm text-slate-500 dark:text-slate-400">
                            {m.currency}
                          </span>
                        </td>
                        <td
                          className={cn(
                            'px-3 py-2 text-right tabular-nums font-semibold',
                            negative ? 'text-rose-700 dark:text-rose-300' : 'text-amber-700 dark:text-amber-300',
                          )}
                        >
                          {m.marginPct.toFixed(1)}%
                        </td>
                        <td className="px-3 py-2">
                          <Link
                            href={`/pricing?search=${encodeURIComponent(m.sku)}`}
                            className="text-sm text-blue-600 hover:underline"
                          >
                            {t('pricing.alerts.openInPricing')}
                          </Link>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      {/* Engine-time alerts (clamped / fallback / warnings) */}
      {(activeTab === 'all' || activeTab === 'engine') && data.rows.length > 0 && (
        <div className="space-y-2">
          {(data.driftRows.length > 0 || data.lowMarginRows.length > 0) && (
            <div className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
              {t('pricing.alerts.section.engine', { n: data.rows.length })}
            </div>
          )}
      <Card noPadding>
        <div className="overflow-x-auto">
          <table className="w-full text-md">
            <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800">
              <tr>
                <th scope="col" className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                  {t('pricing.alerts.col.severity')}
                </th>
                <th scope="col" className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                  {t('pricing.alerts.col.sku')}
                </th>
                <th scope="col" className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                  {t('pricing.alerts.col.where')}
                </th>
                <th scope="col" className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                  {t('pricing.alerts.col.price')}
                </th>
                <th scope="col" className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                  {t('pricing.alerts.col.reason')}
                </th>
                <th scope="col" className="px-3 py-2 w-24"></th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => {
                const severity =
                  r.source === 'FALLBACK'
                    ? { tone: 'rose', label: t('pricing.alerts.severity.fallback') }
                    : r.isClamped
                    ? { tone: 'amber', label: t('pricing.alerts.severity.clamped') }
                    : { tone: 'blue', label: t('pricing.alerts.severity.warning') }
                const reason =
                  r.source === 'FALLBACK'
                    ? t('pricing.alerts.fallbackReason')
                    : r.isClamped
                    ? t('pricing.alerts.clampedReason', {
                        from: r.clampedFrom ?? '?',
                        to: r.computedPrice,
                        currency: r.currency,
                      })
                    : r.warnings.join('; ') || '—'
                return (
                  <tr
                    key={r.id}
                    className="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    <td className="px-3 py-2">
                      <SeverityChip tone={severity.tone} label={severity.label} />
                    </td>
                    <td className="px-3 py-2 font-mono text-base text-slate-800 dark:text-slate-200">
                      {r.sku}
                    </td>
                    <td className="px-3 py-2 text-slate-700 dark:text-slate-300">
                      {r.channel}{' '}
                      <span className="text-slate-400 dark:text-slate-500">·</span>{' '}
                      <span className="font-mono text-sm">{r.marketplace}</span>
                      {r.fulfillmentMethod && (
                        <span className="ml-1 text-xs text-slate-500 dark:text-slate-400">
                          {r.fulfillmentMethod}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-800 dark:text-slate-200">
                      {Number(r.computedPrice).toFixed(2)}{' '}
                      <span className="text-sm text-slate-500 dark:text-slate-400">{r.currency}</span>
                    </td>
                    <td className="px-3 py-2 text-base text-slate-700 dark:text-slate-300">
                      {reason}
                    </td>
                    <td className="px-3 py-2">
                      <Link
                        href={`/pricing?search=${encodeURIComponent(r.sku)}`}
                        className="text-sm text-blue-600 hover:underline"
                      >
                        {t('pricing.alerts.openInPricing')}
                      </Link>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>
        </div>
      )}
    </div>
  )
}

function CountTile({
  label,
  value,
  tone,
  hint,
}: {
  label: string
  value: number
  tone: 'rose' | 'amber' | 'blue'
  hint: string
}) {
  const toneClasses = {
    rose: 'border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950',
    amber: 'border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950',
    blue: 'border-blue-200 dark:border-blue-900 bg-blue-50 dark:bg-blue-950',
  }[tone]
  const textTone = {
    rose: 'text-rose-700 dark:text-rose-300',
    amber: 'text-amber-700 dark:text-amber-300',
    blue: 'text-blue-700 dark:text-blue-300',
  }[tone]
  return (
    <Card noPadding className={toneClasses}>
      <div className="flex items-start gap-3 px-4 py-3">
        <AlertTriangle size={16} className={textTone} />
        <div>
          <div className={cn('text-[24px] font-semibold tabular-nums', textTone)}>
            {value}
          </div>
          <div className="text-base text-slate-700 dark:text-slate-300 font-medium">{label}</div>
          <div className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">{hint}</div>
        </div>
      </div>
    </Card>
  )
}

function SeverityChip({ tone, label }: { tone: string; label: string }) {
  const cls =
    tone === 'rose'
      ? 'bg-rose-50 dark:bg-rose-950 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-900'
      : tone === 'amber'
      ? 'bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-900'
      : 'bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-900'
  return (
    <span
      className={cn(
        'inline-block text-xs font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded',
        cls,
      )}
    >
      {label}
    </span>
  )
}
