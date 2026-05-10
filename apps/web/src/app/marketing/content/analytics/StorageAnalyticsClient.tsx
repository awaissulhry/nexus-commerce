'use client'

// MC.13.5 — Storage analytics dashboard client.

import type { ReactNode } from 'react'
import {
  HardDrive,
  Layers,
  Trash2,
  AlertCircle,
  TrendingUp,
} from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { useTranslations } from '@/lib/i18n/use-translations'
import { formatBytes, formatCount } from '../_lib/format'
import type { OverviewPayload } from '../_lib/types'

interface AnalyticsPayload {
  totalAssets: number
  averageBytes: number
  orphanedCount: number
  cloudinaryDeletes: number
  topUsed: Array<{
    id: string
    label: string
    url: string
    type: string
    usageCount: number
  }>
  typeBreakdown: Array<{ type: string; count: number; bytes: number }>
  formatBreakdown: Array<{ format: string; count: number }>
  uploadVolume: {
    last7Days: number
    last30Days: number
    last90Days: number
  }
}

interface Props {
  analytics: AnalyticsPayload
  overview: OverviewPayload | null
  icon: ReactNode
}

export default function StorageAnalyticsClient({
  analytics,
  overview,
}: Props) {
  const { t } = useTranslations()

  const totalTypeBytes = analytics.typeBreakdown.reduce(
    (sum, row) => sum + row.bytes,
    0,
  )
  const totalFormatCount = analytics.formatBreakdown.reduce(
    (sum, row) => sum + row.count,
    0,
  )

  const usedBytes = overview?.storageBytes ?? totalTypeBytes
  const hardCap = overview?.storageQuota?.hardCapBytes ?? null
  const softCap = overview?.storageQuota?.softCapBytes ?? null
  const usagePercent = overview?.storageQuota?.usagePercent ?? null
  const atSoftCap = overview?.storageQuota?.atSoftCap ?? false
  const atHardCap = overview?.storageQuota?.atHardCap ?? false

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('marketingAnalytics.title')}
        description={t('marketingAnalytics.description')}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard
          icon={<Layers className="w-4 h-4" />}
          label={t('marketingAnalytics.kpi.total')}
          value={formatCount(analytics.totalAssets)}
        />
        <KpiCard
          icon={<HardDrive className="w-4 h-4" />}
          label={t('marketingAnalytics.kpi.avgSize')}
          value={formatBytes(analytics.averageBytes)}
        />
        <KpiCard
          icon={<AlertCircle className="w-4 h-4" />}
          label={t('marketingAnalytics.kpi.orphaned')}
          value={formatCount(analytics.orphanedCount)}
          tone={analytics.orphanedCount > 0 ? 'warn' : 'default'}
        />
        <KpiCard
          icon={<Trash2 className="w-4 h-4" />}
          label={t('marketingAnalytics.kpi.cloudinaryDeletes')}
          value={formatCount(analytics.cloudinaryDeletes)}
          tone={analytics.cloudinaryDeletes > 0 ? 'warn' : 'default'}
        />
      </div>

      {/* Storage usage bar */}
      <section className="rounded-md border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
        <header className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {t('marketingAnalytics.storage.title')}
          </h2>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {hardCap
              ? `${formatBytes(usedBytes)} / ${formatBytes(hardCap)} (${usagePercent ?? 0}%)`
              : formatBytes(usedBytes)}
          </span>
        </header>
        <div className="relative h-3 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
          {hardCap && (
            <div
              className={`h-full transition-all ${
                atHardCap
                  ? 'bg-rose-500'
                  : atSoftCap
                    ? 'bg-amber-500'
                    : 'bg-emerald-500'
              }`}
              style={{
                width: `${Math.min(100, ((usedBytes / hardCap) * 100) | 0)}%`,
              }}
            />
          )}
          {softCap && hardCap && (
            <div
              aria-hidden
              className="absolute top-0 h-full w-px bg-amber-700"
              style={{ left: `${(softCap / hardCap) * 100}%` }}
              title={`Soft cap: ${formatBytes(softCap)}`}
            />
          )}
        </div>
        {!hardCap && (
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
            {t('marketingAnalytics.storage.noCap')}
          </p>
        )}
      </section>

      {/* Two-column: type / format breakdown */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <BreakdownCard
          title={t('marketingAnalytics.types.title')}
          rows={analytics.typeBreakdown.map((row) => ({
            label: row.type,
            count: row.count,
            secondary: formatBytes(row.bytes),
            ratio: totalTypeBytes ? row.bytes / totalTypeBytes : 0,
          }))}
          emptyLabel={t('marketingAnalytics.types.empty')}
        />
        <BreakdownCard
          title={t('marketingAnalytics.formats.title')}
          rows={analytics.formatBreakdown.map((row) => ({
            label: row.format,
            count: row.count,
            secondary: formatCount(row.count),
            ratio: totalFormatCount ? row.count / totalFormatCount : 0,
          }))}
          emptyLabel={t('marketingAnalytics.formats.empty')}
        />
      </div>

      {/* Upload volume */}
      <section className="rounded-md border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
        <header className="mb-3 flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-slate-500 dark:text-slate-400" />
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {t('marketingAnalytics.uploads.title')}
          </h2>
        </header>
        <div className="grid grid-cols-3 gap-3">
          <UploadTile
            label={t('marketingAnalytics.uploads.last7')}
            value={analytics.uploadVolume.last7Days}
          />
          <UploadTile
            label={t('marketingAnalytics.uploads.last30')}
            value={analytics.uploadVolume.last30Days}
          />
          <UploadTile
            label={t('marketingAnalytics.uploads.last90')}
            value={analytics.uploadVolume.last90Days}
          />
        </div>
      </section>

      {/* Top used */}
      <section className="rounded-md border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
        <h2 className="mb-3 text-sm font-semibold text-slate-900 dark:text-slate-100">
          {t('marketingAnalytics.topUsed.title')}
        </h2>
        {analytics.topUsed.length === 0 ? (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {t('marketingAnalytics.topUsed.empty')}
          </p>
        ) : (
          <ol className="divide-y divide-slate-100 dark:divide-slate-800">
            {analytics.topUsed.map((row, idx) => (
              <li
                key={row.id}
                className="flex items-center gap-3 py-2 first:pt-0 last:pb-0"
              >
                <span className="w-5 flex-shrink-0 text-xs font-semibold text-slate-400 dark:text-slate-500">
                  #{idx + 1}
                </span>
                <div className="h-9 w-9 flex-shrink-0 overflow-hidden rounded bg-slate-100 dark:bg-slate-800">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={row.url}
                    alt={row.label}
                    className="h-full w-full object-cover"
                    loading="lazy"
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-slate-900 dark:text-slate-100">
                    {row.label}
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {row.type}
                  </p>
                </div>
                <span className="rounded bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
                  {formatCount(row.usageCount)}×
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  )
}

function KpiCard({
  icon,
  label,
  value,
  tone = 'default',
}: {
  icon: ReactNode
  label: string
  value: string
  tone?: 'default' | 'warn'
}) {
  return (
    <div
      className={`rounded-md border p-3 ${
        tone === 'warn'
          ? 'border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-900/20'
          : 'border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900'
      }`}
    >
      <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
        {icon}
        <span>{label}</span>
      </div>
      <p className="mt-1 text-xl font-semibold text-slate-900 dark:text-slate-100">
        {value}
      </p>
    </div>
  )
}

function BreakdownCard({
  title,
  rows,
  emptyLabel,
}: {
  title: string
  rows: Array<{
    label: string
    count: number
    secondary: string
    ratio: number
  }>
  emptyLabel: string
}) {
  return (
    <section className="rounded-md border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
      <h2 className="mb-3 text-sm font-semibold text-slate-900 dark:text-slate-100">
        {title}
      </h2>
      {rows.length === 0 ? (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {emptyLabel}
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li key={row.label} className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-slate-900 dark:text-slate-100">
                  {row.label}
                </span>
                <span className="text-slate-500 dark:text-slate-400">
                  {row.secondary}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                <div
                  className="h-full bg-blue-500"
                  style={{ width: `${Math.round(row.ratio * 100)}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function UploadTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-center dark:border-slate-700 dark:bg-slate-800">
      <p className="text-xs text-slate-500 dark:text-slate-400">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-slate-900 dark:text-slate-100">
        {formatCount(value)}
      </p>
    </div>
  )
}
